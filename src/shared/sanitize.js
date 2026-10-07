/*
 * Cleans HTML from untrusted sources (a web page's article, an EPUB chapter, a Google Docs export)
 * down to reading content: known tags, harmless attributes, safe URLs. Classic script: used by the
 * reader view (content script) and the document viewer (extension page).
 */
(function (root) {
  'use strict';

  const ns = root.ADHDR || (root.ADHDR = {});

  // What may stay. Anything else is unwrapped (kept as its text) or, for active/embedded content,
  // dropped together with what's inside.
  const KEEP = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre',
    'code', 'kbd', 'samp', 'var', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub',
    'sup', 'abbr', 'cite', 'q', 'time', 'br', 'hr', 'img', 'picture', 'source', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'div', 'span', 'section', 'article',
    'details', 'summary', 'aside', 'header', 'footer',
  ]);
  const DROP = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form',
    'input', 'button', 'select', 'textarea', 'svg', 'math', 'canvas', 'video', 'audio', 'link', 'meta',
    'head', 'title', 'base',
  ]);
  const ATTRIBUTES = {
    '*': ['lang', 'dir', 'title'],
    a: ['href'],
    img: ['src', 'srcset', 'alt', 'width', 'height'],
    source: ['srcset', 'type', 'media'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed', 'type'],
    time: ['datetime'],
    blockquote: ['cite'],
    q: ['cite'],
    details: ['open'],
  };
  const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'cite']);
  const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'blob:'];

  function defaultResolve(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl);
      if (SAFE_PROTOCOLS.includes(url.protocol)) return url.href;
      return url.href.startsWith('data:image/') ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Cleans `container` in place.
   * Options:
   *   baseUrl  — for resolving relative links (default: the current document's base URL)
   *   resolve(value, attribute, element) — maps a URL attribute to a safe URL or null; defaults to
   *            resolving against baseUrl and allowing http(s)/mailto/blob and data:image only
   *   idPrefix — keep element ids, prefixed (for in-book links); without it ids are removed
   *   newTab   — open links in a new tab (default true)
   */
  function sanitizeContent(container, options = {}) {
    const baseUrl = options.baseUrl || container.ownerDocument.baseURI;
    const resolve = options.resolve || ((value) => defaultResolve(value, baseUrl));
    const newTab = options.newTab !== false;

    for (const el of [...container.querySelectorAll('*')]) {
      if (!container.contains(el)) continue; // inside something already dropped
      const tag = el.localName;
      if (DROP.has(tag)) {
        el.remove();
        continue;
      }
      if (!KEEP.has(tag)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      const allowed = [...ATTRIBUTES['*'], ...(ATTRIBUTES[tag] || [])];
      for (const { name, value } of [...el.attributes]) {
        if (name === 'id' && options.idPrefix) {
          el.setAttribute('id', options.idPrefix + value);
        } else if (!allowed.includes(name)) {
          el.removeAttribute(name);
        } else if (name === 'srcset') {
          const safe = value.split(',').every((part) => resolve(part.trim().split(/\s+/)[0], name, el));
          if (!safe) el.removeAttribute(name);
        } else if (URL_ATTRIBUTES.has(name)) {
          const url = resolve(value, name, el);
          if (url) el.setAttribute(name, url);
          else el.removeAttribute(name);
        }
      }
      if (tag === 'a' && el.hasAttribute('href') && newTab && !el.getAttribute('href').startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return container;
  }

  ns.sanitizeContent = sanitizeContent;
})(globalThis);
