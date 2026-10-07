/*
 * End-to-end tests: load the unpacked extension into Chromium (Playwright) and check it on
 * fixture pages served over HTTP. Run with `npm run test:e2e`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

let server;
let baseUrl;
let context;
let worker;
let extensionId;

test.before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdr-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // new headless mode, which supports extensions
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.after(async () => {
  await context?.close();
  server?.close();
});

test.beforeEach(async () => {
  await worker.evaluate(() => chrome.storage.sync.clear());
});

function setSettings(patch) {
  return worker.evaluate((p) => chrome.storage.sync.set(p), patch);
}

async function openPage(name) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  await page.goto(`${baseUrl}/tests/fixtures/${name}`);
  return { page, errors };
}

/** Visible text of an element with whitespace collapsed. */
function textOf(page, selector) {
  return page.$eval(selector, (el) => el.innerText.replace(/\s+/g, ' ').trim());
}

/** Bold fragments inside an element (or a shadow root reachable from window[rootVar]). */
function boldParts(page, selector) {
  return page.evaluate((sel) => {
    const scope = sel.startsWith('window.') ? window[sel.slice(7)] : document.querySelector(sel);
    return scope ? [...scope.querySelectorAll('adhdrb')].map((b) => b.textContent) : null;
  }, selector);
}

async function waitForBold(page, selector, timeout = 5000) {
  await page.waitForFunction(
    (sel) => {
      const scope = sel.startsWith('window.') ? window[sel.slice(7)] : document.querySelector(sel);
      return scope && scope.querySelector('adhdrb');
    },
    selector,
    { timeout },
  );
}

test('bolds the start of words on a regular page without changing its text', async () => {
  const { page, errors } = await openPage('basic.html');
  await waitForBold(page, '#plain');

  assert.equal(
    await textOf(page, '#plain'),
    'Bionic reading helps the eyes move through text. Привет, это русский текст для проверки.',
  );
  assert.deepEqual((await boldParts(page, '#plain')).slice(0, 4), ['Bio', 'read', 'hel', 'th']);
  assert.ok((await boldParts(page, '#plain')).includes('При'));
  assert.equal(await textOf(page, '#mixed'), 'Text with a relative link and emphasis inside.');

  const style = await page.$eval('#plain adhdrb', (b) => {
    const cs = getComputedStyle(b);
    return { weight: cs.fontWeight, visibility: cs.visibility };
  });
  assert.deepEqual(style, { weight: '700', visibility: 'visible' });

  // Site rules such as `.stack > * { display: block }` must not reach our wrapper.
  assert.equal(await page.$eval('#stack > adhdrw', (w) => getComputedStyle(w).display), 'inline');
  assert.equal(await textOf(page, '#stack'), 'Direct text in a stack and a span');

  for (const selector of ['#pre', '#code', '#editable', '#cjk']) {
    assert.deepEqual(await boldParts(page, selector), [], `${selector} must stay untouched`);
  }
  assert.equal(await page.$eval('#textarea', (t) => t.value), 'Text area content');
  assert.deepEqual(errors, []);
  await page.close();
});

test('reaches open and closed shadow roots and same-origin iframes', async () => {
  const { page } = await openPage('basic.html');
  await waitForBold(page, '#plain');

  assert.deepEqual(
    await page.evaluate(() => [...document.querySelector('#open-box').shadowRoot.querySelectorAll('adhdrb')].map((b) => b.textContent)),
    ['Op', 'sha', 'wor'],
  );
  await waitForBold(page, 'window.__closedRoot');

  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame.waitForSelector('#inner adhdrb');
  assert.equal(await frame.$eval('#inner', (p) => p.innerText), 'Frame content should be bold too');

  // A shadow root attached after the first pass (component defined later) is picked up too.
  await page.evaluate(() => window.defineLateBox());
  await waitForBold(page, 'window.__lateRoot', 12000);
  await page.close();
});

test('follows framework-style updates of text nodes it has transformed', async () => {
  const { page, errors } = await openPage('basic.html');
  await waitForBold(page, '#dynamic');

  // Update through a retained text node reference.
  await page.evaluate(() => (window.__counterText.nodeValue = 'Count went up to seven'));
  await page.waitForFunction(() => document.querySelector('#counter').innerText === 'Count went up to seven');
  assert.ok((await boldParts(page, '#counter')).includes('sev'));

  // Removing the retained node must work and take the visible text with it.
  await page.evaluate(() => window.__removableText.parentNode.removeChild(window.__removableText));
  await page.waitForFunction(() => document.querySelector('#removable').innerText === '');

  // Inserting before the retained node keeps the visual order.
  await page.evaluate(() => {
    const strong = document.createElement('strong');
    strong.textContent = 'Inserted ';
    window.__targetText.parentNode.insertBefore(strong, window.__targetText);
  });
  await page.waitForFunction(() => document.querySelector('#target').innerText.startsWith('Inserted'));
  assert.equal(await textOf(page, '#target'), 'Inserted Middle text');

  // Content added later is processed as well.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'late';
    p.textContent = 'Late paragraph appears';
    document.body.append(p);
  });
  await waitForBold(page, '#late');
  assert.deepEqual(errors, []);
  await page.close();
});

test('keeps a React app working through updates, insertions and removals', async () => {
  const { page, errors } = await openPage('react.html');
  await waitForBold(page, '#list');
  await waitForBold(page, '#cond');

  await page.click('#inc');
  await page.waitForFunction(() => document.querySelector('#status').innerText === 'Odd number of clicks');
  assert.equal(await textOf(page, '#count'), 'Clicked 1 times so far');

  await page.click('#add');
  await page.click('#add');
  await page.waitForFunction(() => document.querySelectorAll('#list li').length === 4);
  await page.click('#remove');
  await page.waitForFunction(() => document.querySelectorAll('#list li').length === 3);
  assert.equal(await textOf(page, '#list'), 'New entry number 2 First item text Second item text');

  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('#label').innerText === 'Label: hidden state');
  assert.equal(await textOf(page, '#cond'), 'Before after');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('#label').innerText === 'Label: shown state');
  assert.equal(await textOf(page, '#cond'), 'Before conditional words after');

  await page.click('#inc');
  await page.waitForFunction(() => document.querySelector('#status').innerText === 'Even number of clicks');
  await waitForBold(page, '#status');
  await waitForBold(page, '#label');
  assert.deepEqual(errors, []);
  await page.close();
});

test('settings apply live and turning it off restores the original DOM', async () => {
  const { page } = await openPage('basic.html');
  await waitForBold(page, '#plain');

  await setSettings({ fixation: 90, fade: 50 });
  await page.waitForFunction(() => document.querySelector('#plain adhdrb').textContent === 'Bioni');
  const restColor = await page.$eval('#plain adhdrr', (r) => getComputedStyle(r).color);
  assert.match(restColor, /0\.5\)$|\/ 0\.5\)$/, `faded colour, got ${restColor}`);

  await setSettings({ disabledSites: ['127.0.0.1'] });
  await page.waitForFunction(() => !document.querySelector('adhdrw'));
  assert.equal(await page.evaluate(() => document.getElementById('static').innerHTML === window.__originalHTML), true);

  await setSettings({ disabledSites: [] });
  await waitForBold(page, '#plain');
  await setSettings({ enabled: false });
  await page.waitForFunction(() => !document.querySelector('adhdrw'));
  await page.close();
});

test('copying gives clean HTML without our elements', async () => {
  const { page } = await openPage('basic.html');
  await waitForBold(page, '#mixed');
  const copied = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('mixed'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { html: data.getData('text/html'), text: data.getData('text/plain') };
  });
  assert.equal(copied.text, 'Text with a relative link and emphasis inside.');
  assert.doesNotMatch(copied.html, /adhdr/);
  assert.match(copied.html, /href="http:\/\/127\.0\.0\.1:\d+\/relative\/link"/);
  assert.match(copied.html, /<em>emphasis<\/em>/);
  await page.close();
});

test('processes a large page quickly', async () => {
  const { page } = await openPage('large.html');
  const started = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('adhdrw').length === 2000, null, { timeout: 15000 });
  const elapsed = Date.now() - started;
  console.log(`  2000 paragraphs / 50 000 words processed in ${elapsed} ms (after page load)`);
  assert.ok(elapsed < 10000);
  await page.close();
});

test('popup and options pages render without errors', async () => {
  for (const pagePath of ['src/popup/popup.html', 'src/options/options.html']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
    await page.waitForSelector('#preview adhdrb');
    assert.equal(await page.$eval('[data-setting="fixation"]', (i) => i.value), '50');
    assert.deepEqual(errors, [], pagePath);
    await page.close();
  }
});

test('re-injecting the content script hands over cleanly (extension update in open tabs)', async () => {
  const { page, errors } = await openPage('basic.html');
  await waitForBold(page, '#plain');
  const before = await page.$eval('#plain', (p) => p.innerHTML);

  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, page.url());
  await worker.evaluate(
    (id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: chrome.runtime.getManifest().content_scripts[0].js }),
    tabId,
  );
  // The old copy restored the page synchronously; the new one is still waiting for the page to settle.
  assert.equal(await page.$eval('#plain', (p) => p.querySelector('adhdrw') === null && p.textContent.startsWith('Bionic')), true);

  await page.waitForFunction((html) => document.querySelector('#plain adhdrb') && document.querySelector('#plain').innerHTML === html, before, { timeout: 8000 });
  assert.equal(await page.$$eval('#plain adhdrw', (w) => w.length), 1);
  assert.equal(await textOf(page, '#plain'), 'Bionic reading helps the eyes move through text. Привет, это русский текст для проверки.');
  assert.deepEqual(errors, []);
  await page.close();
});
