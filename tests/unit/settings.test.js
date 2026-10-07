const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/settings.js');

test('normalizeSettings fills defaults and clamps values', () => {
  assert.deepEqual(S.normalizeSettings(undefined), { ...S.DEFAULTS, disabledSites: [], enabledSites: [] });
  const s = S.normalizeSettings({
    fixation: 500, weight: 650, fade: 'x', enabled: 'yes', saccade: 0, lineHeight: 999,
    disabledSites: ['WWW.Example.com', 'example.com', '???'],
  });
  assert.equal(s.fixation, 90);
  assert.equal(s.weight, 700);
  assert.equal(s.fade, 100);
  assert.equal(s.enabled, true);
  assert.equal(s.saccade, 1);
  assert.equal(s.lineHeight, 240);
  assert.deepEqual(s.disabledSites, ['example.com']);
});

test('normalizeSettings only accepts known choices', () => {
  const s = S.normalizeSettings({ font: 'comic-sans', tint: 'blue', focus: 'paragraph', siteMode: 'nowhere', readerTheme: 'sepia' });
  assert.equal(s.font, 'site');
  assert.equal(s.tint, 'blue');
  assert.equal(s.focus, 'paragraph');
  assert.equal(s.siteMode, 'all');
  assert.equal(s.readerTheme, 'sepia');
});

test('normalizeSite accepts URLs, wildcards, ports and IDN', () => {
  assert.equal(S.normalizeSite('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(S.normalizeSite('*.example.com'), 'example.com');
  assert.equal(S.normalizeSite('localhost:3000'), 'localhost');
  assert.equal(S.normalizeSite('пример.рф'), 'xn--e1afmkfd.xn--p1ai');
  assert.equal(S.normalizeSite('file:///home/me/a.html'), 'file://');
  assert.equal(S.normalizeSite('   '), '');
  assert.equal(S.normalizeSite('http://'), '');
});

test('siteKeyFromUrl only accepts web pages and local files', () => {
  assert.equal(S.siteKeyFromUrl('https://www.habr.com/ru/articles/1/'), 'habr.com');
  assert.equal(S.siteKeyFromUrl('http://127.0.0.1:8080/'), '127.0.0.1');
  assert.equal(S.siteKeyFromUrl('file:///tmp/x.txt'), 'file://');
  assert.equal(S.siteKeyFromUrl('chrome://extensions'), null);
  assert.equal(S.siteKeyFromUrl('about:blank'), null);
  assert.equal(S.siteKeyFromUrl(undefined), null);
});

test('"everywhere except" mode: a listed domain covers its subdomains', () => {
  const settings = S.normalizeSettings({ disabledSites: ['example.com'] });
  assert.equal(S.isSiteActive(settings, 'example.com'), false);
  assert.equal(S.isSiteActive(settings, 'news.example.com'), false);
  assert.equal(S.isSiteActive(settings, 'notexample.com'), true);
  assert.equal(S.isSiteActive(settings, null), true);
});

test('"only on" mode: active only on listed sites', () => {
  const settings = S.normalizeSettings({ siteMode: 'only', enabledSites: ['wikipedia.org'], disabledSites: ['ru.wikipedia.org'] });
  assert.equal(S.isSiteActive(settings, 'ru.wikipedia.org'), true);
  assert.equal(S.isSiteActive(settings, 'example.com'), false);
  assert.equal(S.isSiteActive(settings, null), false);
});

test('sitePatch edits the list of the current mode', () => {
  const all = S.normalizeSettings({ disabledSites: ['a.com', 'b.com'] });
  assert.deepEqual(S.sitePatch(all, 'x.a.com', true), { disabledSites: ['b.com'] });
  assert.deepEqual(S.sitePatch(all, 'c.com', false), { disabledSites: ['a.com', 'b.com', 'c.com'] });
  assert.deepEqual(S.sitePatch(all, 'x.a.com', false), { disabledSites: ['a.com', 'b.com'] });

  const only = S.normalizeSettings({ siteMode: 'only', enabledSites: ['a.com'] });
  assert.deepEqual(S.sitePatch(only, 'c.com', true), { enabledSites: ['a.com', 'c.com'] });
  assert.deepEqual(S.sitePatch(only, 'a.com', false), { enabledSites: [] });
});
