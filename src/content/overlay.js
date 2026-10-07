/*
 * Full-viewport overlay drawn above the page (top frame only): colour tint, overall dimming and the
 * focus spotlight that keeps one line or one paragraph bright and dims the rest.
 *
 * Everything lives in one fixed, click-through host with `mix-blend-mode: multiply`: a light colour
 * multiplied over the page tints it like coloured paper, and black multiplied darkens it, so tint,
 * dimming and the spotlight's shadow combine in a single layer.
 */
(function (root) {
  'use strict';

  const ns = root.ADHDR || (root.ADHDR = {});

  // Elements that usually wrap one paragraph-sized piece of text.
  const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'table-cell', 'table-caption', 'flow-root', 'flex', 'grid']);
  const MAX_BLOCK_SHARE = 0.75; // larger "paragraphs" (whole articles, layout boxes) fall back to a line
  const SPOT_PADDING = 8;

  function px(value) {
    return `${Math.round(value)}px`;
  }

  function setStyles(el, styles) {
    for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, 'important');
  }

  function createOverlay(doc) {
    const win = doc.defaultView;
    let host = null;
    let tint = null;
    let dim = null;
    let spot = null;
    let settings = null;
    let tracking = false;
    let pointer = null;
    let frame = 0;
    let lastBlock = null;
    let lastBand = null;

    function ensureHost() {
      if (host) {
        if (!host.isConnected) doc.documentElement.append(host);
        return;
      }
      host = doc.createElement('div');
      host.setAttribute(ns.UI_ATTRIBUTE, 'overlay');
      setStyles(host, {
        all: 'initial',
        position: 'fixed',
        inset: '0',
        display: 'block',
        'pointer-events': 'none',
        'z-index': '2147483647',
        'mix-blend-mode': 'multiply',
      });
      const shadow = host.attachShadow({ mode: 'open' });
      const layer = () => {
        const el = doc.createElement('div');
        setStyles(el, { position: 'absolute', inset: '0', display: 'none' });
        shadow.append(el);
        return el;
      };
      tint = layer();
      dim = layer();
      spot = layer();
      spot.className = 'spot';
      setStyles(spot, { inset: 'auto', transition: 'top 90ms ease-out, height 90ms ease-out, left 90ms ease-out, width 90ms ease-out' });
      if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) setStyles(spot, { transition: 'none' });
      doc.documentElement.append(host);
    }

    /** Applies settings (or removes everything when `next` is null). */
    function update(next) {
      settings = next;
      const wantTint = next && next.tint !== 'none';
      const wantDim = next && next.dim > 0;
      const wantFocus = next && next.focus !== 'off';
      if (!wantTint && !wantDim && !wantFocus) {
        destroy();
        return;
      }
      ensureHost();
      setStyles(tint, wantTint ? { display: 'block', background: ns.TINT_COLORS[next.tint], opacity: String(next.tintStrength / 100) } : { display: 'none' });
      setStyles(dim, wantDim ? { display: 'block', background: '#000', opacity: String(next.dim / 100) } : { display: 'none' });
      setTracking(wantFocus);
      if (wantFocus) {
        setStyles(spot, { 'box-shadow': `0 0 0 200vmax rgba(0, 0, 0, ${next.focusDim / 100})` });
        lastBlock = null;
        lastBand = null;
        requestUpdate();
      } else {
        setStyles(spot, { display: 'none' });
      }
    }

    function destroy() {
      setTracking(false);
      host?.remove();
      host = null;
    }

    function setTracking(on) {
      if (on === tracking) return;
      tracking = on;
      const method = on ? 'addEventListener' : 'removeEventListener';
      win[method]('mousemove', onPointer, { capture: true, passive: true });
      win[method]('scroll', requestUpdate, { capture: true, passive: true });
      win[method]('resize', requestUpdate, { passive: true });
      if (!on && frame) {
        win.cancelAnimationFrame(frame);
        frame = 0;
      }
    }

    function onPointer(event) {
      pointer = { x: event.clientX, y: event.clientY };
      requestUpdate();
    }

    function requestUpdate() {
      if (!frame && tracking) frame = win.requestAnimationFrame(positionSpot);
    }

    function positionSpot() {
      frame = 0;
      if (!settings || settings.focus === 'off') return;
      // Before the first mouse move, start near the top third of the screen.
      const { x, y } = pointer || { x: win.innerWidth / 2, y: win.innerHeight / 3 };
      if (settings.focus === 'paragraph') {
        const block = blockAt(x, y) || (lastBlock?.isConnected ? lastBlock : null);
        if (block) {
          lastBlock = block;
          const r = contentRect(block);
          showSpot(r.left - SPOT_PADDING, r.top - SPOT_PADDING / 2, r.width + SPOT_PADDING * 2, r.height + SPOT_PADDING, 10);
          return;
        }
      }
      showBand(y, lineAt(x, y));
    }

    /** Full-width band around the text line at `y` (or around the pointer when not over text). */
    function showBand(y, line) {
      const height = line ? line.height : lastBand?.height || 28;
      const center = line ? line.top + line.height / 2 : y;
      lastBand = { height };
      const pad = Math.max(4, height * 0.3);
      showSpot(0, center - height / 2 - pad, win.innerWidth, height + pad * 2, 0);
    }

    function showSpot(left, top, width, height, radius) {
      setStyles(spot, { display: 'block', left: px(left), top: px(top), width: px(width), height: px(height), 'border-radius': px(radius) });
    }

    /** Element under the point, descending into open and closed shadow roots; plus those roots. */
    function deepHit(x, y) {
      let el = doc.elementFromPoint(x, y);
      const shadowRoots = [];
      while (el) {
        const shadow = el.shadowRoot || root.chrome?.dom?.openOrClosedShadowRoot?.(el);
        if (!shadow) break;
        const inner = shadow.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        shadowRoots.push(shadow);
        el = inner;
      }
      return { el, shadowRoots };
    }

    /** Rectangle of the text line under the point, or null when the point isn't over text. */
    function lineAt(x, y) {
      let rect = null;
      if (typeof doc.caretPositionFromPoint === 'function') {
        const { shadowRoots } = deepHit(x, y);
        const pos = doc.caretPositionFromPoint(x, y, shadowRoots.length ? { shadowRoots } : undefined);
        if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) rect = pos.getClientRect();
      } else if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(x, y);
        if (range?.startContainer.nodeType === Node.TEXT_NODE) rect = range.getBoundingClientRect();
      }
      if (!rect || rect.height === 0) return null;
      // caret APIs snap to the nearest text even far away; only accept a line the pointer is on.
      if (y < rect.top - rect.height * 0.5 || y > rect.bottom + rect.height * 0.5) return null;
      return rect;
    }

    /**
     * Box around the block's text rather than the element: a paragraph's own box also runs under
     * floated neighbours (infoboxes, images), which shouldn't be highlighted.
     */
    function contentRect(block) {
      const range = doc.createRange();
      range.selectNodeContents(block);
      const r = range.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : block.getBoundingClientRect();
    }

    /** The paragraph-like block under the point, or null. */
    function blockAt(x, y) {
      let el = deepHit(x, y).el;
      while (el && el !== doc.body && el !== doc.documentElement) {
        if (el.hasAttribute?.(ns.UI_ATTRIBUTE) && el.getAttribute(ns.UI_ATTRIBUTE) === 'overlay') return null;
        if (el.nodeType === Node.ELEMENT_NODE && BLOCK_DISPLAYS.has(win.getComputedStyle(el).display) && el.textContent.trim()) break;
        el = el.parentNode?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? el.parentNode.host : el.parentNode;
      }
      if (!el || el === doc.body || el === doc.documentElement || el.nodeType !== Node.ELEMENT_NODE) return null;
      if (el.getAttribute(ns.UI_ATTRIBUTE) === 'reader') return null;
      const r = el.getBoundingClientRect();
      if (r.height > win.innerHeight * MAX_BLOCK_SHARE || r.width < 20) return null;
      return el;
    }

    return { update, refresh: requestUpdate, destroy };
  }

  ns.createOverlay = createOverlay;
})(globalThis);
