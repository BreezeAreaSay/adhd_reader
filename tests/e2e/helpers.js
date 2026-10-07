/*
 * Shared setup for the end-to-end tests: a static file server for the fixtures and a Chromium
 * profile with the unpacked extension loaded (Playwright, new headless mode).
 */
const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
// Served with csp.html to check that the extension copes with a strict Content-Security-Policy.
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'";

/** Registers before/after hooks and returns an object filled in once the browser is up. */
function setupExtension() {
  const env = {};
  let server;

  test.before(async () => {
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, pathname);
      if (pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
      if (pathname.endsWith('/csp.html')) headers['content-security-policy'] = STRICT_CSP;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env.baseUrl = `http://127.0.0.1:${server.address().port}`;

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdr-e2e-'));
    env.context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', // new headless mode, which supports extensions
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    });
    env.worker = env.context.serviceWorkers()[0] || (await env.context.waitForEvent('serviceworker'));
    env.extensionId = new URL(env.worker.url()).host;
  });

  test.after(async () => {
    await env.context?.close();
    server?.close();
  });

  test.beforeEach(async () => {
    await env.worker.evaluate(() => chrome.storage.sync.clear());
  });

  env.setSettings = (patch) => env.worker.evaluate((p) => chrome.storage.sync.set(p), patch);

  env.openPage = async (name) => {
    const page = await env.context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    await page.goto(`${env.baseUrl}/tests/fixtures/${name}`);
    return { page, errors };
  };

  env.tabIdOf = (page) => env.worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, page.url());

  return env;
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

module.exports = { setupExtension, textOf, boldParts, waitForBold };
