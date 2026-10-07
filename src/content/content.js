/*
 * ADHD Reader content script: applies bionic emphasis to every text node of the page — including
 * text added later, open and closed shadow roots and (via all_frames) iframes.
 *
 * How a text node T is transformed without breaking the page's own scripts:
 *   before:  … T("Reading text") …
 *   after:   … T("") W(<b>Rea</b>ding <b>te</b>xt) …
 * T stays in the DOM, just emptied, and our wrapper W is inserted right after it. Frameworks
 * (React, Vue, Svelte…) keep references to their text nodes: they can still update T.data, insert
 * before T or remove T. A MutationObserver sees those changes and re-renders, moves or removes W.
 * (Replacing T outright — what most similar extensions do — makes React throw on removeChild or
 * silently freezes updated text.)
 */
(() => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  const { Bionic } = ADHDR;
  const { TAGS } = Bionic;

  const TEXT_NODE = Node.TEXT_NODE;
  const ELEMENT_NODE = Node.ELEMENT_NODE;
  const FRAGMENT_NODE = Node.DOCUMENT_FRAGMENT_NODE;

  const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };
  const SKIP_TAGS = new Set([
    'head', 'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
    'optgroup', 'datalist', 'svg', 'math', 'canvas', 'iframe', 'frame', 'frameset', 'object',
    'embed', 'video', 'audio', 'title', 'xmp', 'plaintext',
    TAGS.wrapper, TAGS.bold, TAGS.rest,
  ]);
  const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'var', 'tt', 'listing']);
  // Code editors and terminals measure glyph widths to place the caret; never touch them.
  const EDITOR_CLASSES = ['monaco-editor', 'CodeMirror', 'cm-editor', 'ace_editor', 'xterm'];
  const OUR_SELECTOR = `${TAGS.wrapper},${TAGS.bold},${TAGS.rest}`;

  // Before the first pass we wait for `load` and then for the main thread to go quiet: server-rendered
  // apps (Next.js, Nuxt…) hydrate after load, and changing their DOM mid-hydration makes React throw
  // away the page and re-render it.
  const LOAD_TIMEOUT_MS = 2000;
  const QUIET_MS = 400;
  const QUIET_TIMEOUT_MS = 3000;
  const RESCAN_DELAYS_MS = [2000, 8000]; // catch shadow roots attached after the first pass
  const MIN_BUDGET_MS = 6;
  const MAX_BUDGET_MS = 30;
  const MAX_RENDERS = 12; // per text node within RENDER_WINDOW_MS; beyond that we leave it alone
  const RENDER_WINDOW_MS = 3000;

  const isTopFrame = window === window.top;
  // Chrome shows .txt files as <body><pre>…</pre></body>; that <pre> is prose, not code.
  const isPlainTextDocument = document.contentType === 'text/plain';
  const siteKey = topSiteKey();

  const wrapperOf = new WeakMap(); // page text node -> our wrapper
  const sourceOf = new WeakMap(); // our wrapper -> page text node
  const renderLog = new WeakMap(); // page text node -> { since, count }
  const leftAlone = new WeakSet(); // page text nodes we gave back because the page fought us

  const roots = new Set(); // document + every shadow root we observe
  const scanQueue = [];
  const scanQueued = new Set();
  const dirtyText = new Map(); // text node -> "its data was changed by the page"
  let textQueue = [];
  let textQueueHead = 0;

  let settings = null;
  let templates = null;
  let active = false;
  let retired = false;
  let scheduled = false;
  const rescanTimers = [];

  const observer = new MutationObserver(onMutations);

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  // A previous copy of this script may still be running in this tab (extension reloaded/updated,
  // or injected twice). Tell it to restore the page and retire before we start.
  document.dispatchEvent(new CustomEvent('adhdr-takeover'));
  document.addEventListener('adhdr-takeover', retire);
  document.addEventListener('copy', onCopy, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (retired || message?.type !== 'getStatus') return;
    sendResponse({ active, siteKey, ready: settings !== null });
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
    const prev = settings;
    settings = next;
    const shouldRun = next.enabled && !ADHDR.isSiteDisabled(next, siteKey) && isEligibleDocument();

    if (!shouldRun) {
      if (active) stop();
    } else if (!active) {
      start();
    } else if (prev.skipCode !== next.skipCode) {
      stop();
      start();
    } else if (prev.fixation !== next.fixation || prev.weight !== next.weight || prev.fade !== next.fade) {
      rerenderAll();
    }
    reportStatus();
  }

  function start() {
    active = true;
    templates = Bionic.createTemplates(document, settings);
    roots.add(document);
    observer.observe(document, OBSERVE_OPTIONS);
    enqueueScan(document);
    for (const delay of RESCAN_DELAYS_MS) rescanTimers.push(setTimeout(rescanAll, delay));
  }

  function stop() {
    active = false;
    observer.disconnect();
    for (const timer of rescanTimers.splice(0)) clearTimeout(timer);
    scanQueue.length = 0;
    scanQueued.clear();
    dirtyText.clear();
    textQueue = [];
    textQueueHead = 0;
    restoreAll();
    roots.clear();
  }

  function retire() {
    if (retired) return;
    if (active) stop();
    retired = true;
    document.removeEventListener('adhdr-takeover', retire);
    document.removeEventListener('copy', onCopy, true);
  }

  function reportStatus() {
    if (!isTopFrame) return;
    try {
      chrome.runtime.sendMessage({ type: 'status', active }).catch(() => {});
    } catch {
      // extension context invalidated
    }
  }

  function rescanAll() {
    if (!active) return;
    for (const root of roots) {
      if (root !== document && !root.isConnected) roots.delete(root);
    }
    enqueueScan(document);
  }

  // ---------------------------------------------------------------------------------------------
  // Work queue, processed in small idle-time chunks so the page stays responsive
  // ---------------------------------------------------------------------------------------------

  function schedule() {
    if (scheduled || !active) return;
    scheduled = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(runChunk, { timeout: 200 });
    else setTimeout(runChunk, 16);
  }

  function hasWork() {
    return dirtyText.size > 0 || textQueueHead < textQueue.length || scanQueue.length > 0;
  }

  function runChunk(deadline) {
    scheduled = false;
    if (!active) return;
    const idle = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
    const stopAt = performance.now() + Math.min(Math.max(idle, MIN_BUDGET_MS), MAX_BUDGET_MS);

    mutateQuietly(() => {
      while (performance.now() < stopAt) {
        if (dirtyText.size > 0) {
          const [node, dataChanged] = dirtyText.entries().next().value;
          dirtyText.delete(node);
          syncText(node, dataChanged, false);
        } else if (textQueueHead < textQueue.length) {
          syncText(textQueue[textQueueHead++], false, true);
        } else if (scanQueue.length > 0) {
          const node = scanQueue.shift();
          scanQueued.delete(node);
          scan(node);
        } else {
          break;
        }
      }
    });
    if (textQueueHead >= textQueue.length) {
      textQueue = [];
      textQueueHead = 0;
    }
    if (hasWork()) schedule();
  }

  /**
   * Runs our own DOM changes without feeding them back into the observer. Records queued before we
   * start are page changes and get handled; everything recorded during `fn` is ours and is dropped.
   * This is safe because nothing else runs in between (our nodes trigger no synchronous callbacks).
   */
  function mutateQuietly(fn) {
    const pending = observer.takeRecords();
    if (pending.length) onMutations(pending);
    try {
      fn();
    } finally {
      observer.takeRecords();
    }
  }

  function enqueueScan(node) {
    if (scanQueued.has(node)) return;
    scanQueued.add(node);
    scanQueue.push(node);
    schedule();
  }

  function markDirty(node, dataChanged) {
    dirtyText.set(node, dirtyText.get(node) === true || dataChanged);
    schedule();
  }

  function onMutations(records) {
    if (!active) return;
    for (const record of records) {
      if (record.type === 'characterData') {
        if (record.target.nodeType === TEXT_NODE) markDirty(record.target, true);
        continue;
      }
      // Something was inserted right after a text node we track: our wrapper must follow it again.
      const prev = record.previousSibling;
      if (prev && prev.nodeType === TEXT_NODE && wrapperOf.has(prev)) markDirty(prev, false);

      for (const node of record.removedNodes) {
        if (node.nodeType === TEXT_NODE) {
          if (wrapperOf.has(node)) markDirty(node, false);
        } else if (node.localName === TAGS.wrapper) {
          const source = sourceOf.get(node);
          if (source) markDirty(source, false);
        }
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === TEXT_NODE) markDirty(node, false);
        else if (node.nodeType === ELEMENT_NODE && node.localName !== TAGS.wrapper) enqueueScan(node);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Finding text
  // ---------------------------------------------------------------------------------------------

  function shouldSkipElement(el) {
    const tag = el.localName;
    if (SKIP_TAGS.has(tag)) return true;
    if (CODE_TAGS.has(tag) && settings.skipCode && !(isPlainTextDocument && tag === 'pre')) return true;
    const editable = el.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') return true;
    if (el.getAttribute('role') === 'textbox') return true;
    if (el.classList.length > 0) {
      for (const name of EDITOR_CLASSES) if (el.classList.contains(name)) return true;
    }
    return false;
  }

  /** True if `node` or any ancestor (crossing shadow boundaries) is something we must not touch. */
  function isInSkippedSubtree(node) {
    let current = node.nodeType === ELEMENT_NODE ? node : node.parentNode;
    while (current) {
      if (current.nodeType === ELEMENT_NODE) {
        if (shouldSkipElement(current)) return true;
        current = current.parentNode;
      } else if (current.nodeType === FRAGMENT_NODE && current.host) {
        current = current.host;
      } else {
        return false;
      }
    }
    return false;
  }

  function walkFilter(node) {
    if (node.nodeType === TEXT_NODE) {
      return node.data && Bionic.hasWords(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
    return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  }

  function scan(node) {
    if (!node.isConnected) return;
    if (node.nodeType === TEXT_NODE) {
      if (!isInSkippedSubtree(node)) textQueue.push(node);
      return;
    }
    if (node.nodeType === ELEMENT_NODE) {
      if (isInSkippedSubtree(node)) return;
      adoptShadowRoot(node);
    } else if (node.nodeType === FRAGMENT_NODE && node.host && isInSkippedSubtree(node.host)) {
      return;
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkFilter);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.nodeType === TEXT_NODE) textQueue.push(current);
      else adoptShadowRoot(current);
    }
  }

  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    // Closed shadow roots are only reachable through this extension API. They are practically
    // always on custom elements, so we don't pay for the call on every <div>.
    if (el.localName.includes('-') && chrome.dom?.openOrClosedShadowRoot) {
      try {
        return chrome.dom.openOrClosedShadowRoot(el);
      } catch {
        return null;
      }
    }
    return null;
  }

  function adoptShadowRoot(el) {
    const root = shadowRootOf(el);
    if (!root || roots.has(root)) return;
    roots.add(root);
    observer.observe(root, OBSERVE_OPTIONS);
    enqueueScan(root);
  }

  // ---------------------------------------------------------------------------------------------
  // Transforming text
  // ---------------------------------------------------------------------------------------------

  /**
   * Brings one page text node in line with its current state.
   * @param dataChanged the page wrote to node.data since we last looked
   * @param trusted the node came from our tree walk, so its ancestors were already checked
   */
  function syncText(node, dataChanged, trusted) {
    if (node.nodeType !== TEXT_NODE || leftAlone.has(node)) return;
    const parent = node.parentNode;
    const wrapper = wrapperOf.get(node);

    if (wrapper) {
      if (!parent) {
        // The page removed its text node: the text is gone, so is our copy.
        wrapper.remove();
        forget(node, wrapper);
      } else if (!wrapper.parentNode) {
        // The page removed our wrapper (e.g. a framework dropping unknown children). Give the text
        // back and stop touching this node so we don't fight over it.
        if (!dataChanged && node.data === '') node.data = wrapper.textContent;
        forget(node, wrapper);
        leftAlone.add(node);
      } else if (dataChanged || node.data !== '') {
        // The page wrote new text into its node.
        if (!Bionic.hasWords(node.data)) {
          wrapper.remove();
          forget(node, wrapper);
        } else if (renderedTooOften(node)) {
          wrapper.remove();
          forget(node, wrapper);
          leftAlone.add(node);
        } else {
          render(node, wrapper, parent);
        }
      } else if (node.nextSibling !== wrapper) {
        // The page moved its text node or inserted something right after it.
        parent.insertBefore(wrapper, node.nextSibling);
      }
      return;
    }

    if (!parent || !node.data || !Bionic.hasWords(node.data)) return;
    if (parent.nodeType === ELEMENT_NODE && SKIP_TAGS.has(parent.localName)) return;
    if (!trusted && (!node.isConnected || isInSkippedSubtree(node))) return;
    if (renderedTooOften(node)) {
      leftAlone.add(node);
      return;
    }
    render(node, templates.wrapper.cloneNode(false), parent);
  }

  function render(node, wrapper, parent) {
    const fragment = Bionic.buildFragment(document, node.data, settings, templates);
    if (!fragment) return;
    wrapper.replaceChildren(fragment);
    if (node.nextSibling !== wrapper) parent.insertBefore(wrapper, node.nextSibling);
    wrapperOf.set(node, wrapper);
    sourceOf.set(wrapper, node);
    node.data = '';
  }

  function forget(node, wrapper) {
    wrapperOf.delete(node);
    sourceOf.delete(wrapper);
  }

  // Protects against pages that rewrite the same text node continuously (or "repair" our change).
  function renderedTooOften(node) {
    const now = performance.now();
    const log = renderLog.get(node);
    if (!log || now - log.since > RENDER_WINDOW_MS) {
      renderLog.set(node, { since: now, count: 1 });
      return false;
    }
    log.count += 1;
    return log.count > MAX_RENDERS;
  }

  function rerenderAll() {
    templates = Bionic.createTemplates(document, settings);
    mutateQuietly(() => {
      for (const root of roots) {
        for (const wrapper of root.querySelectorAll(TAGS.wrapper)) {
          const fragment = Bionic.buildFragment(document, wrapper.textContent, settings, templates);
          if (fragment) wrapper.replaceChildren(fragment);
        }
      }
    });
  }

  function restoreAll() {
    for (const root of roots) {
      for (const wrapper of root.querySelectorAll(TAGS.wrapper)) restoreWrapper(wrapper);
    }
  }

  function restoreWrapper(wrapper) {
    const source = sourceOf.get(wrapper);
    if (!source) {
      // A copy of our wrapper made by the page (cloneNode): turn it back into plain text.
      wrapper.replaceWith(document.createTextNode(wrapper.textContent));
      return;
    }
    if (source.parentNode && source.data === '') source.data = wrapper.textContent;
    wrapper.remove();
    forget(source, wrapper);
  }

  // ---------------------------------------------------------------------------------------------
  // Clean copy: don't leak half-bold words into documents the user pastes into
  // ---------------------------------------------------------------------------------------------

  function onCopy(event) {
    if (roots.size === 0 || !event.clipboardData) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const box = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) box.appendChild(selection.getRangeAt(i).cloneContents());
    const ours = box.querySelectorAll(OUR_SELECTOR);
    if (ours.length === 0) return;

    for (const el of ours) el.replaceWith(...el.childNodes);
    for (const el of box.querySelectorAll('[href]')) if (typeof el.href === 'string') el.setAttribute('href', el.href);
    for (const el of box.querySelectorAll('[src]')) if (typeof el.src === 'string') el.setAttribute('src', el.src);
    box.normalize();

    event.clipboardData.setData('text/html', box.innerHTML);
    event.clipboardData.setData('text/plain', selection.toString());
    event.preventDefault();
  }
})();
