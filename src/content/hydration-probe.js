/*
 * Hydration probe. Runs in the page's own JavaScript world (manifest "world": "MAIN"), because only
 * there the framework's state is visible. The content script asks through DOM events whether React
 * or Vue has finished hydrating the server-rendered HTML; this script polls that state and answers
 * with another event. It only reads — it never changes the page — and defines no globals.
 *
 *   content script → document: "adhdr-wait-react" | "adhdr-wait-vue"
 *   probe          → document: "adhdr-hydrated" | "adhdr-hydration-unknown"
 *
 * React can hydrate the page shell first and individual <Suspense> boundaries later (sometimes
 * seconds later). Then the probe first fires "adhdr-pending-boundary" on the <!--$--> comment that
 * opens each boundary still waiting, followed by "adhdr-root-hydrated": everything outside those
 * boundaries may be changed already. "adhdr-hydrated" follows once the boundaries are done too.
 */
(() => {
  'use strict';

  const POLL_MS = 50;
  const GIVE_UP_MS = 8000;
  const ABSENT_AFTER_LOAD_MS = 1500; // no framework root this long after load: not hydrating
  const SUSPENSE_COMPONENT = 13; // React fiber tag (stable since React 16)
  const MAX_FIBERS = 300000;

  let started = false;

  document.addEventListener('adhdr-wait-react', () => start(reactState));
  document.addEventListener('adhdr-wait-vue', () => start(vueState));

  function start(check) {
    if (started) return;
    started = true;
    const startedAt = performance.now();
    let loadedAt = document.readyState === 'complete' ? startedAt : null;
    if (loadedAt === null) window.addEventListener('load', () => (loadedAt = performance.now()), { once: true });

    const tick = () => {
      let state;
      try {
        state = check();
      } catch {
        state = 'unknown';
      }
      const now = performance.now();
      if (state === 'ready') return answer('adhdr-hydrated');
      if (Array.isArray(state)) {
        announcePending(state);
        state = 'hydrating';
      }
      const absentTooLong = state === 'absent' && loadedAt !== null && now - loadedAt > ABSENT_AFTER_LOAD_MS;
      if (state === 'unknown' || absentTooLong || now - startedAt > GIVE_UP_MS) return answer('adhdr-hydration-unknown');
      setTimeout(tick, POLL_MS);
    };
    tick();
  }

  function answer(type) {
    started = false;
    document.dispatchEvent(new CustomEvent(type));
  }

  const announced = new WeakSet();
  let rootAnnounced = false;

  /** Points the content script at boundaries still waiting (the event's target is their <!--$--> comment). */
  function announcePending(comments) {
    for (const comment of comments) {
      if (announced.has(comment) || !comment.isConnected) continue;
      announced.add(comment);
      comment.dispatchEvent(new CustomEvent('adhdr-pending-boundary', { bubbles: true }));
    }
    if (!rootAnnounced) {
      rootAnnounced = true;
      document.dispatchEvent(new CustomEvent('adhdr-root-hydrated'));
    }
  }

  /** Places where frameworks usually mount: the document itself (Next.js app router), <html>, <body> and two levels below it. */
  function containers() {
    const list = [document, document.documentElement, document.body];
    if (document.body) list.push(...document.body.querySelectorAll(':scope > *, :scope > * > *'));
    return list.filter(Boolean);
  }

  /**
   * 'ready' when every React root has fully hydrated; an array of the <!--$--> comments of boundaries
   * still pending once the shells are hydrated; 'hydrating' before that; 'absent' if no root yet.
   */
  function reactState() {
    let found = false;
    const pending = [];
    for (const el of containers()) {
      if (el._reactRootContainer) {
        found = true; // React ≤17: ReactDOM.hydrate() is synchronous, so it's done
        continue;
      }
      for (const key of Object.keys(el)) {
        if (!key.startsWith('__reactContainer$')) continue;
        found = true;
        const current = el[key]?.stateNode?.current;
        if (!current || current.memoizedState?.isDehydrated) return 'hydrating';
        pending.push(...pendingBoundaries(current));
      }
    }
    if (!found) return 'absent';
    if (pending.length === 0) return 'ready';
    return pending.every((comment) => comment?.nodeType === Node.COMMENT_NODE) ? pending : 'hydrating';
  }

  /**
   * Opening comments of the Suspense boundaries still waiting to be hydrated. Walks only `child` and
   * `sibling` links: while React renders in the background, `return` links of the committed tree
   * can point into the work-in-progress tree, where pending boundaries already look hydrated.
   */
  function pendingBoundaries(rootFiber) {
    const found = [];
    const stack = [rootFiber.child];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_FIBERS) {
      for (let node = stack.pop(); node; node = node.sibling) {
        if (++visited > MAX_FIBERS) break;
        if (node.tag === SUSPENSE_COMPONENT && node.memoizedState?.dehydrated) found.push(node.memoizedState.dehydrated);
        if (node.child) stack.push(node.child);
      }
    }
    return found;
  }

  /** Vue hydrates synchronously while mounting and marks the mounted root element. */
  function vueState() {
    for (const el of containers()) {
      if (el !== document && (el.__vue_app__ || el.__vue__)) return 'ready';
    }
    return 'absent';
  }
})();
