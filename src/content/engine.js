/*
 * Bionic engine: applies bionic emphasis to every text node under a root (the page document, or a
 * shadow root of our own such as the reader view) — including text added later and open/closed
 * shadow roots inside it.
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
(function (root) {
  'use strict';

  const ADHDR = root.ADHDR;
  const { Bionic } = ADHDR;
  const { TAGS } = Bionic;

  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const FRAGMENT_NODE = 11;

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
  // Marks our own UI hosts (overlay, reader view); the page engine never descends into them.
  const UI_ATTRIBUTE = 'data-adhdr-ui';

  const RESCAN_DELAYS_MS = [2000, 8000]; // catch shadow roots attached after the first pass
  const MIN_BUDGET_MS = 6;
  const MAX_BUDGET_MS = 30;
  const MAX_RENDERS = 12; // per text node within RENDER_WINDOW_MS; beyond that we leave it alone
  const RENDER_WINDOW_MS = 3000;
  const HEAVY_WEIGHT = 600; // text at least this bold gets the "heavy" emphasis
  const BATCH_SIZE = 64; // text nodes processed between style reads

  const RENDER_KEYS = ['fixation', 'weight', 'fade', 'saccade', 'minWordLength'];

  function createBionicEngine({ onRoot } = {}) {
    let doc = null;
    let baseRoot = null; // document, or the shadow root the engine was started on
    let isPlainTextDocument = false;

    const wrapperOf = new WeakMap(); // page text node -> our wrapper
    const sourceOf = new WeakMap(); // our wrapper -> page text node
    const renderLog = new WeakMap(); // page text node -> { since, count }
    const leftAlone = new WeakSet(); // page text nodes we gave back because the page fought us
    let heavyCache = new Map(); // element -> is its text already bold (valid for one chunk)

    const roots = new Set(); // baseRoot + every shadow root we observe
    const scanQueue = [];
    const scanQueued = new Set();
    const dirtyText = new Map(); // text node -> "its data was changed by the page"
    let textQueue = [];
    let textQueueHead = 0;

    let settings = null;
    let templates = null;
    let active = false;
    let scheduled = false;
    const rescanTimers = [];

    const observer = new MutationObserver(onMutations);

    // -------------------------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------------------------

    /** Starts (settings object), reconfigures, or stops (null) the engine on `startRoot`. */
    function update(next, startRoot = root.document) {
      const prev = settings;
      if (!next) {
        if (active) stop();
        settings = null;
        return;
      }
      settings = next;
      if (!active) start(startRoot);
      else if (prev.skipCode !== next.skipCode) {
        stop();
        start(startRoot);
      } else if (RENDER_KEYS.some((key) => prev[key] !== next[key])) {
        rerenderAll();
      }
    }

    function start(startRoot) {
      active = true;
      baseRoot = startRoot;
      doc = startRoot.nodeType === 9 ? startRoot : startRoot.ownerDocument;
      // Chrome shows .txt files as <body><pre>…</pre></body>; that <pre> is prose, not code.
      isPlainTextDocument = doc.contentType === 'text/plain';
      templates = Bionic.createTemplates(doc, settings);
      addRoot(baseRoot);
      if (baseRoot === doc) {
        for (const delay of RESCAN_DELAYS_MS) rescanTimers.push(setTimeout(rescanAll, delay));
      }
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

    function addRoot(node) {
      if (roots.has(node)) return;
      roots.add(node);
      observer.observe(node, OBSERVE_OPTIONS);
      enqueueScan(node);
      if (node !== doc) onRoot?.(node);
    }

    function rescanAll() {
      if (!active) return;
      for (const r of roots) {
        if (r !== baseRoot && !r.isConnected) roots.delete(r);
      }
      enqueueScan(baseRoot);
    }

    // -------------------------------------------------------------------------------------------
    // Work queue, processed in small idle-time chunks so the page stays responsive
    // -------------------------------------------------------------------------------------------

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
      heavyCache = new Map();

      mutateQuietly(() => {
        while (performance.now() < stopAt) {
          const batch = takeBatch();
          if (batch.length > 0) {
            // Read all computed weights first, then write: a style read right after a DOM write
            // forces a style recalc, so interleaving them would cost one recalc per text node.
            for (const [node] of batch) if (node.parentNode && node.data) isHeavy(node.parentNode);
            for (const [node, dataChanged, trusted] of batch) syncText(node, dataChanged, trusted);
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

    /** Next text nodes to process: page changes first, then nodes found by tree walks. */
    function takeBatch() {
      const batch = [];
      for (const [node, dataChanged] of dirtyText) {
        if (batch.length >= BATCH_SIZE) break;
        dirtyText.delete(node);
        batch.push([node, dataChanged, false]);
      }
      while (batch.length < BATCH_SIZE && textQueueHead < textQueue.length) {
        batch.push([textQueue[textQueueHead++], false, true]);
      }
      return batch;
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

    // -------------------------------------------------------------------------------------------
    // Finding text
    // -------------------------------------------------------------------------------------------

    function shouldSkipElement(el) {
      const tag = el.localName;
      if (SKIP_TAGS.has(tag)) return true;
      if (CODE_TAGS.has(tag) && settings.skipCode && !(isPlainTextDocument && tag === 'pre')) return true;
      const editable = el.getAttribute('contenteditable');
      if (editable !== null && editable !== 'false') return true;
      if (el.getAttribute('role') === 'textbox' || el.hasAttribute(UI_ATTRIBUTE)) return true;
      if (el.classList.length > 0) {
        for (const name of EDITOR_CLASSES) if (el.classList.contains(name)) return true;
      }
      return false;
    }

    /** True if `node` or an ancestor up to our root (crossing shadow boundaries) must not be touched. */
    function isInSkippedSubtree(node) {
      let current = node.nodeType === ELEMENT_NODE ? node : node.parentNode;
      while (current && current !== baseRoot) {
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
      } else if (node !== baseRoot && node.nodeType === FRAGMENT_NODE && node.host && isInSkippedSubtree(node.host)) {
        return;
      }
      const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, walkFilter);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current.nodeType === TEXT_NODE) textQueue.push(current);
        else adoptShadowRoot(current);
      }
    }

    function adoptShadowRoot(el) {
      const shadow = shadowRootOf(el);
      if (shadow) addRoot(shadow);
    }

    // -------------------------------------------------------------------------------------------
    // Transforming text
    // -------------------------------------------------------------------------------------------

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
      const fragment = Bionic.buildFragment(doc, node.data, settings, templates, isHeavy(parent));
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

    /** Whether text directly inside `parent` is already bold (headings, <strong>, CSS-bold…). */
    function isHeavy(parent) {
      const el = parent.nodeType === ELEMENT_NODE ? parent : parent.host;
      if (!el) return false;
      let heavy = heavyCache.get(el);
      if (heavy === undefined) {
        heavy = parseFloat(getComputedStyle(el).fontWeight) >= HEAVY_WEIGHT;
        heavyCache.set(el, heavy);
      }
      return heavy;
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

    function allWrappers() {
      const list = [];
      for (const r of roots) list.push(...r.querySelectorAll(TAGS.wrapper));
      return list;
    }

    function rerenderAll() {
      templates = Bionic.createTemplates(doc, settings);
      heavyCache = new Map();
      // Read every computed weight first, then write: interleaving would force a style recalc per node.
      const jobs = allWrappers().map((wrapper) => [wrapper, wrapper.parentNode && isHeavy(wrapper.parentNode)]);
      mutateQuietly(() => {
        for (const [wrapper, heavy] of jobs) {
          const fragment = Bionic.buildFragment(doc, wrapper.textContent, settings, templates, heavy);
          if (fragment) wrapper.replaceChildren(fragment);
        }
      });
    }

    function restoreAll() {
      for (const wrapper of allWrappers()) restoreWrapper(wrapper);
    }

    function restoreWrapper(wrapper) {
      const source = sourceOf.get(wrapper);
      if (!source) {
        // A copy of our wrapper made by the page (cloneNode): turn it back into plain text.
        wrapper.replaceWith(doc.createTextNode(wrapper.textContent));
        return;
      }
      if (source.parentNode && source.data === '') source.data = wrapper.textContent;
      wrapper.remove();
      forget(source, wrapper);
    }

    return {
      update,
      isActive: () => active,
      roots: () => [...roots],
    };
  }

  /** Open or closed shadow root of `el` (closed ones only for custom elements and our own hosts). */
  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    // Closed shadow roots are only reachable through this extension API. They are practically
    // always on custom elements, so we don't pay for the call on every <div>.
    if (el.localName.includes('-') && root.chrome?.dom?.openOrClosedShadowRoot) {
      try {
        return chrome.dom.openOrClosedShadowRoot(el);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Copy handler: don't leak half-bold words into documents the user pastes into. `selection` is the
   * document's selection, or a shadow root's (Chrome's ShadowRoot#getSelection) for our reader view.
   */
  function cleanCopy(event, selection, doc) {
    if (!event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const box = doc.createElement('div');
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

  ADHDR.createBionicEngine = createBionicEngine;
  ADHDR.shadowRootOf = shadowRootOf;
  ADHDR.cleanCopy = cleanCopy;
  ADHDR.UI_ATTRIBUTE = UI_ATTRIBUTE;
})(globalThis);
