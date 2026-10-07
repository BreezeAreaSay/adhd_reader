const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/shared/settings.js');

test('normalizeSettings fills defaults and clamps values', () => {
  assert.deepEqual(S.normalizeSettings(undefined), { ...S.DEFAULTS, disabledSites: [] });
  const s = S.normalizeSettings({ fixation: 500, weight: 650, fade: 'x', enabled: 'yes', disabledSites: ['WWW.Example.com', 'example.com', '???'] });
  assert.equal(s.fixation, 90);
  assert.equal(s.weight, 700);
  assert.equal(s.fade, 100);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.disabledSites, ['example.com']);
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

test('a disabled domain covers its subdomains', () => {
  const settings = S.normalizeSettings({ disabledSites: ['example.com'] });
  assert.equal(S.isSiteDisabled(settings, 'example.com'), true);
  assert.equal(S.isSiteDisabled(settings, 'news.example.com'), true);
  assert.equal(S.isSiteDisabled(settings, 'notexample.com'), false);
  assert.equal(S.isSiteDisabled(settings, null), false);
});

test('setSiteDisabled adds and removes sites without duplicates', () => {
  assert.deepEqual(S.setSiteDisabled([], 'a.com', true), ['a.com']);
  assert.deepEqual(S.setSiteDisabled(['a.com'], 'a.com', true), ['a.com']);
  assert.deepEqual(S.setSiteDisabled(['a.com'], 'x.a.com', true), ['a.com']);
  assert.deepEqual(S.setSiteDisabled(['a.com', 'b.com'], 'x.a.com', false), ['b.com']);
});
