/*
 * The Firefox build (dist/firefox) in a real Firefox, driven by Selenium + geckodriver.
 *
 * Needs Firefox 140+ and geckodriver; point at them with FIREFOX_BIN and GECKODRIVER, e.g.
 *   FIREFOX_BIN=~/firefox/firefox GECKODRIVER=~/bin/geckodriver npm run test:firefox
 * Without them the tests are skipped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('../server');
const docs = require('../e2e/documents');

const { FIREFOX_BIN, GECKODRIVER } = process.env;
const skip = !FIREFOX_BIN || !GECKODRIVER ? 'set FIREFOX_BIN and GECKODRIVER to run the Firefox tests' : false;

const ADDON_ID = 'adhd-reader@breezeareasay.github.io';
const UUID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'; // fixed moz-extension:// host for the tests
const EXT = `moz-extension://${UUID}`;

let driver = null;
let server = null;
let control = null; // a tab with an extension page, for calls into the extension APIs
let tab = null; // the tab the tests browse in
const files = {};

test.before(async () => {
  if (skip) return;
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.js')], { stdio: 'ignore' });
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

  server = await startServer();
  // Test documents (the PDFs are printed by Chromium, which the other tests use anyway).
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext();
  files.pdf = server.serve('/docs/focus.pdf', await docs.makePdf(context), { 'content-type': 'application/pdf' });
  await browser.close();
  files.epub = server.serve('/docs/book.epub', docs.makeEpub(), { 'content-type': 'application/epub+zip' });

  driver = await startFirefox(path.join(ROOT, `dist/adhd-reader-firefox-${version}.zip`));
  control = await driver.getWindowHandle();
  await driver.get(`${EXT}/src/options/options.html`);
  await driver.switchTo().newWindow('tab');
  tab = await driver.getWindowHandle();
});

/** A headless Firefox with the add-on at `addon` (a zip) installed temporarily. */
async function startFirefox(addon) {
  const { Builder } = require('selenium-webdriver');
  const firefox = require('selenium-webdriver/firefox');
  const options = new firefox.Options()
    .setBinary(FIREFOX_BIN)
    .addArguments('-headless')
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  const browser = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(GECKODRIVER))
    .build();
  await browser.installAddon(addon, true);
  return browser;
}

test.after(async () => {
  await driver?.quit();
  server?.close();
});

test.beforeEach(async () => {
  if (!skip) await inExtension(() => chrome.storage.sync.clear());
});

/** Runs `fn` in the extension's options page (with access to the extension APIs). */
async function inExtension(fn, ...args) {
  await driver.switchTo().window(control);
  try {
    return await driver.executeScript(fn, ...args);
  } finally {
    await driver.switchTo().window(tab);
  }
}

const setSettings = (patch) => inExtension((p) => chrome.storage.sync.set(p), patch);
const run = (fn, ...args) => driver.executeScript(fn, ...args);

/** Waits until `fn` (run in the page) returns something truthy, and returns that. */
async function until(fn, ...args) {
  let last = null;
  const result = await driver
    .wait(async () => {
      last = await run(fn, ...args).catch((error) => error);
      return last instanceof Error ? false : last;
    }, 10000)
    .catch(() => {
      throw new Error(`timed out waiting for ${fn.toString().slice(0, 160)} (last: ${last})`);
    });
  return result;
}

const open = (pathname) => driver.get(`${server.baseUrl}${pathname}`);

test('bionic emphasis on a page and in its open and closed shadow roots', { skip }, async () => {
  await open('/tests/fixtures/basic.html');
  await until(() => document.querySelector('#plain adhdrb'));
  assert.equal(await run(() => document.querySelector('#plain').innerText), 'Bionic reading helps the eyes move through text. Привет, это русский текст для проверки.');
  assert.deepEqual(await run(() => [...document.querySelector('#open-box').shadowRoot.querySelectorAll('adhdrb')].map((b) => b.textContent)), ['Op', 'sha', 'wor']);
  await until(() => window.__closedRoot.querySelector('adhdrb'));
  await run(() => window.defineLateBox());
  await until(() => window.__lateRoot.querySelector('adhdrb'));
  // Untouched: code, form fields, editable text.
  assert.equal(await run(() => document.querySelector('#editable adhdrb')), null);

  await setSettings({ enabled: false });
  await until(() => !document.querySelector('adhdrb'));
});

test('page font and spacing, also in shadow roots without bionic and under a strict CSP', { skip }, async () => {
  await setSettings({ bionic: false, font: 'atkinson', lineHeight: 180 });
  await open('/tests/fixtures/basic.html');
  await until(() => getComputedStyle(document.querySelector('#plain')).fontFamily.includes('ADHDR Atkinson'));
  await until(() => getComputedStyle(window.__closedRoot.querySelector('p')).fontFamily.includes('ADHDR Atkinson'));
  await until(() => getComputedStyle(document.querySelector('#open-box').shadowRoot.querySelector('p')).fontFamily.includes('ADHDR Atkinson'));
  // The font files load from the extension.
  await until(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'ADHDR Atkinson' && f.status === 'loaded'));
  const lineHeight = await run(() => {
    const cs = getComputedStyle(document.querySelector('#plain'));
    return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  });
  assert.ok(Math.abs(lineHeight - 1.8) < 0.02, `line height ${lineHeight}`);

  await open('/tests/fixtures/csp.html');
  await until(() => getComputedStyle(document.querySelector('#csp-text')).fontFamily.includes('ADHDR Atkinson'));

  await setSettings({ font: 'site', lineHeight: 100 });
  await until(() => !getComputedStyle(document.querySelector('#csp-text')).fontFamily.includes('ADHDR'));
});

test('React: a client app keeps working, a server-rendered one hydrates without errors', { skip }, async () => {
  await open('/tests/fixtures/react.html');
  await until(() => document.querySelector('#list adhdrb'));
  await run(() => document.querySelector('#inc').click());
  await until(() => document.querySelector('#status').innerText === 'Odd number of clicks');
  await run(() => document.querySelector('#add').click());
  await until(() => document.querySelectorAll('#list li').length === 3);
  await run(() => document.querySelector('#toggle').click());
  await until(() => document.querySelector('#label').innerText === 'Label: hidden state');
  assert.equal(await run(() => document.querySelector('#cond').innerText.replace(/\s+/g, ' ').trim()), 'Before after');

  // The hydration probe runs in the page's world: emphasis waits until React has hydrated.
  await open('/ssr-react?hydrateAfter=500&lazyAfter=1500');
  await until(() => document.querySelector('#shell adhdrb'));
  assert.equal(await run(() => document.querySelector('#lazy adhdrb')), null, 'the pending boundary must not be touched yet');
  await until(() => document.querySelector('#lazy adhdrb'));
  await run(() => document.querySelector('#more').click());
  await until(() => document.querySelector('#more').innerText === 'Clicked 1 times');
  assert.deepEqual(await run(() => window.__recoverable), []);
});

test('tint and focus overlay', { skip }, async () => {
  await setSettings({ tint: 'blue', focus: 'line' });
  await open('/tests/fixtures/article.html');
  await until(() => {
    const host = document.querySelector('[data-adhdr-ui="overlay"]');
    return host && getComputedStyle(host.shadowRoot.children[0]).display === 'block';
  });
});

test('reader view on an article', { skip }, async () => {
  await open('/tests/fixtures/article.html');
  await until(() => document.querySelector('adhdrb'));
  const pageUrl = await driver.getCurrentUrl();
  const opened = await inExtension(async (url) => {
    const target = (await chrome.tabs.query({})).find((t) => t.url === url); // (Firefox patterns have no ports)
    return chrome.runtime.sendMessage({ type: 'toggleReader', tabId: target.id });
  }, pageUrl);
  assert.equal(opened, true);
  await until(() => document.querySelector('[data-adhdr-ui="reader"]')?.shadowRoot?.querySelector('.content adhdrb'));
  const reader = await run(() => {
    const root = document.querySelector('[data-adhdr-ui="reader"]').shadowRoot;
    return { title: root.querySelector('.title').textContent, background: getComputedStyle(root.querySelector('.reader')).backgroundColor };
  });
  assert.ok(reader.title.length > 0);
  assert.notEqual(reader.background, 'rgba(0, 0, 0, 0)', 'the reader view is styled');
});

test('document viewer: PDF as text and as pages, EPUB', { skip }, async () => {
  await driver.get(`${EXT}/src/viewer/viewer.html?file=${encodeURIComponent(files.pdf)}`);
  await until(() => document.querySelector('[data-action="toc"]') && !document.querySelector('[data-action="toc"]').hidden);
  assert.equal(await run(() => document.querySelector('.title').textContent), 'Focus and Reading');
  assert.ok(await run(() => document.querySelectorAll('.content p adhdrb').length > 300));
  assert.ok(await run(() => [...document.querySelectorAll('.content p')].some((p) => p.textContent.startsWith('Это абзац номер 4.'))));

  await run(() => document.querySelector('[data-action="mode"]').click());
  await until(() => document.querySelector('.pdf-page[data-page="1"] .textLayer')?.textContent.includes('paragraph number 1'));
  await until(() => document.querySelector('.pdf-page[data-page="1"] canvas'));

  await driver.get(`${EXT}/src/viewer/viewer.html?file=${encodeURIComponent(files.epub)}`);
  await until(() => document.querySelector('.content section adhdrb'));
  assert.equal(await run(() => document.querySelector('.title').textContent), 'Тестовая книга');
  await until(() => document.querySelector('.content img')?.naturalWidth > 0);
});

test('a PDF link opens in the viewer instead of the built-in one', { skip }, async () => {
  await open('/tests/fixtures/basic.html');
  await driver.get(files.pdf);
  await driver.wait(async () => (await driver.getCurrentUrl()).startsWith(`${EXT}/src/viewer/viewer.html`), 10000);
  assert.equal(await driver.getCurrentUrl(), `${EXT}/src/viewer/viewer.html?file=${encodeURIComponent(files.pdf)}`);
  await until(() => document.querySelector('.content p adhdrb'));
});

test('popup and options pages work', { skip }, async () => {
  await driver.get(`${EXT}/src/popup/popup.html`);
  await until(() => document.querySelector('#preview adhdrb'));
  await driver.get(`${EXT}/src/options/options.html`);
  await until(() => document.querySelector('#preview adhdrb'));
  await run(() => {
    const select = document.querySelector('select[data-setting="font"]');
    select.value = 'andika';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => getComputedStyle(document.getElementById('preview')).fontFamily.includes('ADHDR Andika'));
  assert.equal(await inExtension(async () => (await chrome.storage.sync.get('font')).font), 'andika');
});

test('the repository folder itself also loads in Firefox, without a build', { skip }, async () => {
  // What someone gets from "Download ZIP" on GitHub: the cross-browser manifest as it is.
  const { zipSync } = require('fflate');
  const entries = {};
  const add = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.posix.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) add(rel);
      else entries[rel] = fs.readFileSync(path.join(ROOT, rel));
    }
  };
  for (const dir of ['_locales', 'icons', 'fonts', 'src']) add(dir);
  entries['manifest.json'] = fs.readFileSync(path.join(ROOT, 'manifest.json'));
  const zip = path.join(ROOT, 'dist', 'repository-as-is.zip');
  fs.writeFileSync(zip, zipSync(entries));
  // A browser of its own: replacing a temporary add-on in place upsets Firefox.
  await driver.quit();
  driver = await startFirefox(zip);
  await open('/tests/fixtures/basic.html');
  await until(() => document.querySelector('#plain adhdrb') && window.__closedRoot.querySelector('adhdrb'));
  // The background runs too: a PDF link goes to the viewer.
  await driver.get(files.pdf);
  await driver.wait(async () => (await driver.getCurrentUrl()).startsWith(`${EXT}/src/viewer/viewer.html`), 10000);
  await until(() => document.querySelector('.content p adhdrb'));
});
