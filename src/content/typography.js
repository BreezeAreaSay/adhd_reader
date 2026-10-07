/*
 * Page typography: reading-friendly fonts and extra line/letter/word spacing.
 *
 * Styles go into constructable stylesheets (document.adoptedStyleSheets and the adoptedStyleSheets
 * of every shadow root the bionic engine finds). Unlike <style> elements these are not blocked by a
 * page's Content-Security-Policy. Fonts are bundled with the extension (see /fonts).
 */
(function (root) {
  'use strict';

  const ns = root.ADHDR || (root.ADHDR = {});

  // OpenDyslexic, Andika and PT Sans cover Cyrillic. Atkinson and Lexend are Latin-only: PT Sans fills
  // in for Cyrillic letters there.
  const FONT_STACKS = Object.freeze({
    opendyslexic: '"ADHDR OpenDyslexic", "ADHDR PT Sans", system-ui, sans-serif',
    andika: '"ADHDR Andika", "ADHDR PT Sans", system-ui, sans-serif',
    atkinson: '"ADHDR Atkinson", "ADHDR PT Sans", system-ui, sans-serif',
    lexend: '"ADHDR Lexend", "ADHDR PT Sans", system-ui, sans-serif',
    ptsans: '"ADHDR PT Sans", system-ui, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "PT Serif", Cambria, "Times New Roman", serif',
  });

  // Elements whose font we set. Their descendants inherit it unless the site styles them explicitly,
  // which keeps icon fonts (<i class="fa">, Material Icons on <span>) and <code> intact.
  const FONT_TARGETS = 'html, body, div, p, li, dd, dt, blockquote, figcaption, caption, td, th, h1, h2, h3, h4, h5, h6, article, section, main, aside, header, footer, nav, a, label, summary, em, strong, b, small, cite, q, button';
  const NOT_FONT = ':not([class*="icon" i], [class*="fa-"], .fa, .material-icons, [class*="material-symbols"], [class*="glyph" i], :is(pre, code, kbd, samp, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, .xterm) *)';
  // Line height only for running text: overriding it on buttons and menus breaks layouts.
  const PROSE_TARGETS = 'p, li, dd, dt, blockquote, figcaption, td, th, article, main, section';
  const SPACING_TARGETS = `${FONT_TARGETS}, span`;
  const NOT_CODE = ':not(:is(pre, code, kbd, samp, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, .xterm), :is(pre, code, kbd, samp, .monaco-editor, .CodeMirror, .cm-editor, .ace_editor, .xterm) *)';

  function fontStack(font) {
    return FONT_STACKS[font] || null;
  }

  /** CSS for the page (no @font-face), or '' when nothing is overridden. Pure — used in tests. */
  function buildPageCss({ font, lineHeight, letterSpacing, wordSpacing }) {
    const rules = [];
    const stack = fontStack(font);
    if (stack) rules.push(`:is(${FONT_TARGETS})${NOT_FONT} { font-family: ${stack} !important; }`);
    if (lineHeight > 100) rules.push(`:is(${PROSE_TARGETS})${NOT_CODE} { line-height: ${lineHeight / 100} !important; }`);
    const spacing = [];
    if (letterSpacing > 0) spacing.push(`letter-spacing: ${letterSpacing / 100}em !important;`);
    if (wordSpacing > 0) spacing.push(`word-spacing: ${wordSpacing / 100}em !important;`);
    if (spacing.length) rules.push(`:is(${SPACING_TARGETS})${NOT_CODE} { ${spacing.join(' ')} }`);
    return rules.join('\n');
  }

  /** @font-face rules for every bundled font; `urlOf(file)` turns a file name into a URL. */
  function fontFaceCss(urlOf) {
    return (ns.FONT_FACES || [])
      .map(
        (f) =>
          `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; ` +
          `font-display: swap; src: url("${urlOf(f.file)}") format("woff2");` +
          `${f.range ? ` unicode-range: ${f.range};` : ''} }`,
      )
      .join('\n');
  }

  function adopt(target, sheet) {
    if (!target.adoptedStyleSheets.includes(sheet)) target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
  }

  function unadopt(target, sheet) {
    if (target.adoptedStyleSheets.includes(sheet)) {
      target.adoptedStyleSheets = target.adoptedStyleSheets.filter((s) => s !== sheet);
    }
  }

  // One @font-face sheet per document, shared by the page typography and the reader view.
  // Font faces only work at document level, not inside shadow roots.
  const faceSheets = new WeakMap();
  function ensureFontFaces(doc) {
    if (!faceSheets.has(doc)) {
      const sheet = new doc.defaultView.CSSStyleSheet();
      sheet.replaceSync(fontFaceCss((file) => chrome.runtime.getURL(`fonts/${file}`)));
      faceSheets.set(doc, sheet);
    }
    adopt(doc, faceSheets.get(doc));
  }

  function createTypography(doc) {
    const sheet = new doc.defaultView.CSSStyleSheet();
    const shadowRoots = new Set();
    let attached = false;

    function update(settings) {
      const css = settings ? buildPageCss(settings) : '';
      if (!css) {
        if (attached) {
          unadopt(doc, sheet);
          for (const r of shadowRoots) unadopt(r, sheet);
          attached = false;
        }
        return;
      }
      sheet.replaceSync(css);
      if (fontStack(settings.font) && settings.font !== 'system' && settings.font !== 'serif') ensureFontFaces(doc);
      if (!attached) {
        adopt(doc, sheet);
        for (const r of shadowRoots) if (r.isConnected) adopt(r, sheet);
        attached = true;
      }
    }

    function addRoot(shadowRoot) {
      if (shadowRoots.has(shadowRoot)) return;
      shadowRoots.add(shadowRoot);
      if (attached) adopt(shadowRoot, sheet);
    }

    return { update, addRoot };
  }

  ns.FONT_STACKS = FONT_STACKS;
  ns.fontStack = fontStack;
  ns.buildPageCss = buildPageCss;
  ns.ensureFontFaces = ensureFontFaces;
  ns.createTypography = createTypography;
  if (typeof module === 'object' && module.exports) module.exports = { FONT_STACKS, fontStack, buildPageCss, fontFaceCss };
})(globalThis);
