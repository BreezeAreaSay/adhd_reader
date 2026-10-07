/*
 * Content script entry point: loads settings and drives the features on this page —
 * bionic emphasis (every frame), typography (every frame) and the tint/dim/focus overlay (top frame).
 */
(() => {
  'use strict';

  const ADHDR = globalThis.ADHDR;

  // Before the first pass we wait for `load` and then for the main thread to go quiet: server-rendered
  // apps (Next.js, Nuxt…) hydrate after load, and changing their DOM mid-hydration makes React throw
  // away the page and re-render it.
  const LOAD_TIMEOUT_MS = 2000;
  const QUIET_MS = 400;
  const QUIET_TIMEOUT_MS = 3000;

  const isTopFrame = window === window.top;
  const siteKey = topSiteKey();

  const typography = ADHDR.createTypography(document);
  const engine = ADHDR.createBionicEngine({ onRoot: (shadowRoot) => typography.addRoot(shadowRoot) });
  const overlay = isTopFrame ? ADHDR.createOverlay(document) : null;

  let settings = null;
  let pageActive = false;
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
    sendResponse({ active: pageActive, siteKey, ready: settings !== null });
  });

  whenPageSettled()
    .then(() => ADHDR.loadSettings())
    .then((loaded) => {
      if (retired) return;
      apply(loaded);
      ADHDR.onSettingsChanged((next) => {
        if (!retired) apply(next);
      });
    })
    .catch(() => {}); // extension context gone (reloaded/uninstalled) — nothing to do

  function topSiteKey() {
    if (isTopFrame) return ADHDR.siteKeyFromUrl(location.href);
    const origins = location.ancestorOrigins;
    if (origins && origins.length) return ADHDR.siteKeyFromUrl(origins[origins.length - 1]);
    return ADHDR.siteKeyFromUrl(location.href);
  }

  // Let the page finish its own first render (and framework hydration) before we touch the DOM.
  async function whenPageSettled() {
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => {
        window.addEventListener('load', resolve, { once: true });
        setTimeout(resolve, LOAD_TIMEOUT_MS);
      });
    }
    if (typeof requestIdleCallback !== 'function') return;
    await new Promise((resolve) => {
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

  function isEligibleDocument() {
    return (
      document.documentElement?.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      document.designMode !== 'on'
    );
  }

  function apply(next) {
    settings = next;
    pageActive = next.enabled && ADHDR.isSiteActive(next, siteKey) && isEligibleDocument();
    engine.update(pageActive && next.bionic ? next : null);
    typography.update(pageActive ? next : null);
    overlay?.update(pageActive ? next : null);
    reportStatus();
  }

  function retire() {
    if (retired) return;
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
})();
