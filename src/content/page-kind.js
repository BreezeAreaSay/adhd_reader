/*
 * Recognises server-rendered pages that a JavaScript framework will "hydrate" (take over) after
 * loading. Changing such a page's DOM before hydration ends makes the framework report a mismatch
 * and re-render, so the content script waits for those pages and starts right away on all others.
 */
(function (root) {
  'use strict';

  const ns = root.ADHDR || (root.ADHDR = {});

  // Markers in the HTML that each framework's server renderer leaves behind.
  const REACT_SELECTOR = [
    'script#__NEXT_DATA__', // Next.js pages router
    'script[src*="/_next/"]', // Next.js (both routers)
    '#___gatsby',
    '[data-reactroot]', // React ≤ 17 renderToString
  ].join(', ');
  const REACT_INLINE = ['self.__next_f', '__remixContext', '__reactRouterContext', '$RC('];
  const VUE_SELECTOR = '#__nuxt, [data-server-rendered], script#__NUXT_DATA__';
  const VUE_INLINE = ['window.__NUXT__'];
  const OTHER_SELECTOR = [
    '[ng-version]', '[ngh]', 'script#ng-state', // Angular
    'astro-island', // Astro islands
    '[data-sveltekit-hydrate]', 'script[data-sveltekit-fetched]', '[data-sveltekit-preload-data]', // SvelteKit
    '[data-hk]', // SolidStart
  ].join(', ');

  /** 'react' | 'vue' | 'other' for pages that will be hydrated, null for plain pages. */
  function hydrationKind(doc) {
    if (doc.querySelector(REACT_SELECTOR)) return 'react';
    if (doc.querySelector(VUE_SELECTOR)) return 'vue';
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const code = script.textContent;
      if (REACT_INLINE.some((marker) => code.includes(marker))) return 'react';
      if (VUE_INLINE.some((marker) => code.includes(marker))) return 'vue';
    }
    if (doc.querySelector(OTHER_SELECTOR)) return 'other';
    return commentMarkers(doc);
  }

  // React streaming SSR wraps Suspense boundaries in <!--$-->…<!--/$-->. Vue 3 marks fragments with
  // <!--[-->…<!--]-->, and so does Svelte 5, which also leaves <!--[!--> (SvelteKit pages were
  // already recognised by their data-sveltekit attributes). Lit SSR and Fresh (Preact) leave their
  // own comments. If a page tagged 'vue' turns out not to be Vue, the probe reports "unknown" and
  // the content script falls back to waiting for a quiet main thread.
  function commentMarkers(doc) {
    if (!doc.body) return null;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
    let fragments = false;
    let other = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const data = node.data;
      if (data === '$' || data === '$?' || data === '$!') return 'react';
      if (data === '[!' || data.startsWith('lit-part') || data.startsWith('frsh-')) other = true;
      else if (data === '[' || data === ']') fragments = true;
    }
    if (other) return 'other';
    return fragments ? 'vue' : null;
  }

  ns.hydrationKind = hydrationKind;
})(globalThis);
