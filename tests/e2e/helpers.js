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

/**
 * A React 18 app rendered on the server (streaming, with a <Suspense> boundary) and hydrated in the
 * browser after `?hydrateAfter=` ms; the boundary's lazy part arrives `?lazyAfter=` ms after that.
 * Hydration errors are collected in window.__recoverable.
 */
function renderSsrPage(req, res) {
  const React = require('react');
  const { renderToPipeableStream } = require('react-dom/server');
  const makeSsrApp = require('../fixtures/ssr-app.js');
  const params = new URL(req.url, 'http://x').searchParams;
  const hydrateAfter = Number(params.get('hydrateAfter') || 0);
  const lazyAfter = Number(params.get('lazyAfter') || 0);
  const App = makeSsrApp(React, 0);
  const stream = renderToPipeableStream(React.createElement(App), {
    onAllReady() {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSR</title></head><body><div id="root">');
      stream.pipe(res);
    },
  });
  const tail = `</div>
    <script src="/node_modules/react/umd/react.production.min.js"></script>
    <script src="/node_modules/react-dom/umd/react-dom.production.min.js"></script>
    <script src="/tests/fixtures/ssr-app.js"></script>
    <script>
      window.__recoverable = [];
      setTimeout(() => {
        ReactDOM.hydrateRoot(document.getElementById('root'), React.createElement(makeSsrApp(React, ${lazyAfter})), {
          onRecoverableError: (error) => window.__recoverable.push(String(error && error.message || error)),
        });
      }, ${hydrateAfter});
    </script></body></html>`;
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (chunk) res.write(chunk);
    return end(tail, ...rest);
  };
}

/** Registers before/after hooks and returns an object filled in once the browser is up. */
function setupExtension() {
  const env = {};
  const routes = new Map(); // pathname → { body, headers }, added by tests with env.serve()
  let server;

  test.before(async () => {
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, pathname);
      if (pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (pathname === '/ssr-react') {
        renderSsrPage(req, res);
        return;
      }
      if (routes.has(pathname)) {
        const { body, headers } = routes.get(pathname);
        res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)), ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
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
    // Pages left open by a failed test keep connections alive, which would keep the process running.
    server?.closeAllConnections();
    server?.close();
  });

  test.beforeEach(async () => {
    await env.worker.evaluate(() => chrome.storage.sync.clear());
  });

  /** Serves `body` at `pathname` (for generated documents); returns its full URL. */
  env.serve = (pathname, body, headers = {}) => {
    routes.set(pathname, { body, headers });
    return `${env.baseUrl}${pathname}`;
  };

  env.viewerUrl = (file) => `chrome-extension://${env.extensionId}/src/viewer/viewer.html${file ? `?file=${encodeURIComponent(file)}` : ''}`;

  env.setSettings = (patch) => env.worker.evaluate((p) => chrome.storage.sync.set(p), patch);

  /** Opens a fixture (or any server path starting with "/"); `beforeLoad(page)` runs before navigation. */
  env.openPage = async (name, beforeLoad) => {
    const page = await env.context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    await beforeLoad?.(page);
    await page.goto(name.startsWith('/') ? `${env.baseUrl}${name}` : `${env.baseUrl}/tests/fixtures/${name}`);
    return { page, errors };
  };

  // (Match patterns never include the #fragment.)
  env.tabIdOf = (page) => env.worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, page.url().split('#')[0]);

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

/**
 * Whether the page has an element matching `selector`. Returns a plain boolean: asserting on an
 * ElementHandle makes a failing assertion try to print the whole Playwright object graph.
 */
function exists(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel) !== null, selector);
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

module.exports = { setupExtension, textOf, boldParts, waitForBold, exists };
