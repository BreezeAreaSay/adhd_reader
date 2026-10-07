/*
 * Content script entry point (runs at document_start): loads settings and drives the features on
 * this page — bionic emphasis (every frame), typography (every frame) and the tint/dim/focus
 * overlay (top frame).
 *
 * Timing: typography only adds stylesheets, so it applies right away — before the first paint, no
 * font jump. Bionic emphasis and the overlay change the DOM, which is only safe once the page's own
 * framework is done with it. Plain pages get them as soon as the HTML is parsed. Server-rendered
 * apps hydrate first: for React and Vue the hydration probe (hydration-probe.js, page world) tells
 * us when that's done; for other frameworks we wait for their scripts and a quiet main thread.
 */
(() => {
  'use strict';

  const ADHDR = globalThis.ADHDR;

  const PROBE_TIMEOUT_MS = 9000; // the probe gives up after 8 s itself
  const SCRIPTS_TIMEOUT_MS = 2000;
  const QUIET_MS = 300;
  const QUIET_TIMEOUT_MS = 2000;

  const isTopFrame = window === window.top;
  const siteKey = topSiteKey();
  // Injected into a page that had already loaded (extension installed or updated): nothing is
  // hydrating any more, so there is nothing to wait for.
  const injectedLate = document.readyState === 'complete';

  const typography = ADHDR.createTypography(document);
  const engine = ADHDR.createBionicEngine({ onRoot: (shadowRoot) => typography.addRoot(shadowRoot) });
  // Without bionic emphasis the engine doesn't run, so this finds shadow roots for the page font.
  const shadowRoots = ADHDR.createShadowRootWatcher(document, (shadowRoot) => typography.addRoot(shadowRoot));
  const overlay = isTopFrame ? ADHDR.createOverlay(document) : null;

  let settings = null;
  let pageActive = false;
  let domReady = false; // the HTML has been parsed
  let domSafe = false; // the page is ready for DOM changes
  let retired = false;

  // A previous copy of this script may still be running in this tab (extension reloaded/updated,
  // or injected twice). Tell it to restore the page and retire before we start.
  document.dispatchEvent(new CustomEvent('adhdr-takeover'));
  document.addEventListener('adhdr-takeover', retire);
  document.addEventListener('copy', onCopy, true);

  // The reader view (injected on demand) asks us to re-position the focus spotlight on scroll.
  ADHDR.refreshOverlay = () => overlay?.refresh();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (retired || message?.type !== 'getStatus') return;
    sendResponse({ active: pageActive, siteKey, ready: domSafe && settings !== null });
  });

  const settingsLoaded = ADHDR.loadSettings()
    .then((loaded) => {
      if (retired) return;
      apply(loaded);
      ADHDR.onSettingsChanged((next) => {
        if (!retired) apply(next);
      });
    })
    .catch(() => {}); // extension context gone (reloaded/uninstalled) — nothing to do

  whenDomReady()
    .then(() => {
      domReady = true;
      if (settings && !retired) updateShadowRoots();
      return injectedLate ? null : waitForHydration();
    })
    .then(() => settingsLoaded)
    .then(() => {
      if (retired) return;
      domSafe = true;
      if (settings) apply(settings);
    });

  function topSiteKey() {
    if (isTopFrame) return ADHDR.siteKeyFromUrl(location.href);
    const origins = location.ancestorOrigins;
    if (origins && origins.length) return ADHDR.siteKeyFromUrl(origins[origins.length - 1]);
    return ADHDR.siteKeyFromUrl(location.href);
  }

  function isEligibleDocument() {
    return (
      document.documentElement?.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      document.designMode !== 'on'
    );
  }

  function apply(next) {
    settings = next;
    pageActive = next.enabled && ADHDR.isSiteActive(next, siteKey) && isEligibleDocument();
    typography.update(pageActive ? next : null);
    updateShadowRoots();
    if (!domSafe) return;
    engine.update(pageActive && next.bionic ? next : null);
    overlay?.update(pageActive ? next : null);
    reportStatus();
  }

  /** Looks for shadow roots for the page font and spacing while the bionic engine isn't doing it. */
  function updateShadowRoots() {
    const engineFindsThem = domSafe && settings.bionic;
    if (domReady && pageActive && !engineFindsThem && ADHDR.buildPageCss(settings)) shadowRoots.start();
    else shadowRoots.stop();
  }

  function retire() {
    if (retired) return;
    shadowRoots.stop();
    engine.update(null);
    typography.update(null);
    overlay?.destroy();
    retired = true;
    document.removeEventListener('adhdr-takeover', retire);
    document.removeEventListener('copy', onCopy, true);
  }

  function reportStatus() {
    if (!isTopFrame) return;
    try {
      chrome.runtime.sendMessage({ type: 'status', active: pageActive }).catch(() => {});
    } catch {
      // extension context invalidated
    }
  }

  function onCopy(event) {
    ADHDR.cleanCopy(event, document.getSelection(), document);
  }

  // --- When is it safe to change the DOM? -------------------------------------------------------

  function whenDomReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  async function waitForHydration() {
    const kind = ADHDR.hydrationKind(document);
    if (!kind) return; // plain server-rendered or static page: nothing will re-render it
    if (kind === 'react' || kind === 'vue') {
      const outcome = await askProbe(kind);
      if (outcome === 'hydrated' || outcome === 'partial') return;
    }
    await whenScriptsLoaded();
    await whenQuiet();
  }

  /**
   * Asks the page-world probe to report when React/Vue hydration is done. Resolves with 'hydrated',
   * 'partial' (React shell done, some <Suspense> boundaries still pending — those stay deferred in
   * the engine until the probe reports them done too), 'unknown' or 'timeout'.
   */
  function askProbe(kind) {
    return new Promise((resolve) => {
      const pending = [];
      let settled = false;
      const settle = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const stop = () => {
        clearTimeout(timer);
        document.removeEventListener('adhdr-pending-boundary', onPending, true);
        document.removeEventListener('adhdr-root-hydrated', onRootHydrated);
        document.removeEventListener('adhdr-hydrated', onDone);
        document.removeEventListener('adhdr-hydration-unknown', onUnknown);
      };
      const onPending = (event) => {
        pending.push(event.target);
        if (settled) engine.defer(boundaryNodes(event.target)); // streamed in after the shell
      };
      const onRootHydrated = () => {
        for (const comment of pending) engine.defer(boundaryNodes(comment));
        settle('partial');
      };
      const onDone = () => {
        stop();
        engine.release();
        settle('hydrated');
      };
      const onUnknown = () => {
        stop();
        engine.release();
        settle('unknown');
      };
      const timer = setTimeout(onUnknown, PROBE_TIMEOUT_MS);
      document.addEventListener('adhdr-pending-boundary', onPending, true);
      document.addEventListener('adhdr-root-hydrated', onRootHydrated);
      document.addEventListener('adhdr-hydrated', onDone);
      document.addEventListener('adhdr-hydration-unknown', onUnknown);
      document.dispatchEvent(new CustomEvent(`adhdr-wait-${kind}`));
    });
  }

  /** The nodes between a React <!--$--> boundary comment and its matching <!--/$-->. */
  function boundaryNodes(start) {
    const nodes = [];
    let depth = 1;
    for (let node = start.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === Node.COMMENT_NODE) {
        if (node.data === '/$' && --depth === 0) break;
        if (node.data.startsWith('$')) depth++;
        continue;
      }
      nodes.push(node);
    }
    return nodes;
  }

  /** Resolves once every external script of the page has been downloaded (or on load / timeout). */
  async function whenScriptsLoaded() {
    const started = performance.now();
    while (document.readyState !== 'complete' && performance.now() - started < SCRIPTS_TIMEOUT_MS) {
      const pending = [...document.scripts].some((s) => s.src && !s.noModule && performance.getEntriesByName(s.src).length === 0);
      if (!pending) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Resolves once the main thread has been idle for a while: hydration keeps it busy. */
  function whenQuiet() {
    if (typeof requestIdleCallback !== 'function') {
      // Safari/WebKit-based browsers have no idle callbacks: just give the page a moment.
      return new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    }
    return new Promise((resolve) => {
      const giveUp = setTimeout(resolve, QUIET_TIMEOUT_MS);
      let quietSince = performance.now();
      let lastCheck = quietSince;
      const check = (deadline) => {
        const now = performance.now();
        // A short idle period, or a long gap since the previous one, means the page was busy.
        if (deadline.timeRemaining() < 10 || now - lastCheck > 100) quietSince = now;
        lastCheck = now;
        if (now - quietSince >= QUIET_MS) {
          clearTimeout(giveUp);
          resolve();
        } else {
          requestIdleCallback(check);
        }
      };
      requestIdleCallback(check);
    });
  }
})();
