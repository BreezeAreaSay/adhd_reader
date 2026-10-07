/*
 * Finds the page's shadow roots — open ones, and closed ones on custom elements — including those
 * attached later. Used for the page font and spacing when bionic emphasis is off: the bionic engine
 * finds shadow roots during its own walk over the text, but without it nothing would look inside
 * web components. Only elements are visited, never text, so this stays cheap.
 */
(function (root) {
  'use strict';

  const ADHDR = root.ADHDR;
  const ELEMENT_NODE = 1;
  // Custom elements defined (and so given their shadow roots) after they were added to the page
  // cause no DOM mutation: look again a few times while the page settles.
  const RESCAN_DELAYS_MS = [1000, 3000, 8000];

  function createShadowRootWatcher(doc, onRoot) {
    const roots = new Set();
    const timers = [];
    let observer = null;

    function check(el) {
      if (el.hasAttribute(ADHDR.UI_ATTRIBUTE)) return; // our own UI
      const shadow = ADHDR.shadowRootOf(el);
      if (!shadow || roots.has(shadow)) return;
      roots.add(shadow);
      observer.observe(shadow, { childList: true, subtree: true });
      onRoot(shadow);
      scan(shadow);
    }

    function scan(node) {
      if (node.nodeType === ELEMENT_NODE) check(node);
      for (const el of node.querySelectorAll('*')) check(el);
    }

    function rescan() {
      for (const r of roots) if (!r.isConnected) roots.delete(r);
      if (doc.documentElement) scan(doc.documentElement);
    }

    function start() {
      if (observer) return;
      observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node.nodeType === ELEMENT_NODE && node.isConnected) scan(node);
        }
      });
      observer.observe(doc, { childList: true, subtree: true });
      rescan();
      for (const delay of RESCAN_DELAYS_MS) timers.push(setTimeout(rescan, delay));
    }

    function stop() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      for (const timer of timers.splice(0)) clearTimeout(timer);
      roots.clear();
    }

    return { start, stop, roots: () => [...roots] };
  }

  ADHDR.createShadowRootWatcher = createShadowRootWatcher;
})(globalThis);
