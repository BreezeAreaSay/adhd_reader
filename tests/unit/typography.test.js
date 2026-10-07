const test = require('node:test');
const assert = require('node:assert/strict');
require('../../src/content/font-faces.js');
const T = require('../../src/content/typography.js');

const base = { font: 'site', lineHeight: 100, letterSpacing: 0, wordSpacing: 0 };

test('no CSS when nothing is overridden', () => {
  assert.equal(T.buildPageCss(base), '');
});

test('font, line height and spacing rules', () => {
  const css = T.buildPageCss({ font: 'atkinson', lineHeight: 180, letterSpacing: 5, wordSpacing: 10 });
  assert.match(css, /font-family: "ADHDR Atkinson", "ADHDR PT Sans", system-ui, sans-serif !important/);
  assert.match(css, /line-height: 1\.8 !important/);
  assert.match(css, /letter-spacing: 0\.05em !important; word-spacing: 0\.1em !important;/);
  // Icons and code keep their own fonts.
  assert.match(css, /:not\(\[class\*="icon" i\]/);
  assert.match(css, /:is\(pre, code, kbd/);
});

test('every font stack points at bundled faces that exist', () => {
  const families = new Set(globalThis.ADHDR.FONT_FACES.map((f) => f.family));
  for (const stack of Object.values(T.FONT_STACKS)) {
    for (const name of stack.match(/"ADHDR [^"]+"/g) || []) assert.ok(families.has(name.slice(1, -1)), name);
  }
  const css = T.fontFaceCss((file) => `chrome-extension://id/fonts/${file}`);
  assert.match(css, /@font-face \{ font-family: "ADHDR PT Sans"; font-style: normal; font-weight: 400;.*unicode-range: U\+0301,U\+0400-045F/);
});

test('the dyslexia-friendly fonts cover Cyrillic', () => {
  const faces = globalThis.ADHDR.FONT_FACES;
  const andika = faces.filter((f) => f.family === 'ADHDR Andika');
  assert.ok(andika.some((f) => /U\+0400-045F/.test(f.range)), 'Andika has a Cyrillic face');
  // OpenDyslexic ships as one file per weight with Cyrillic inside, so its faces have no unicode-range.
  const openDyslexic = faces.filter((f) => f.family === 'ADHDR OpenDyslexic');
  assert.ok(openDyslexic.length >= 2 && openDyslexic.every((f) => !f.range));
});
