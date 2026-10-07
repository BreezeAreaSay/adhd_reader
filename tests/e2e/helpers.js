/*
 * Shared setup for the end-to-end tests: the test server (../server.js) and a Chromium
 * profile with the unpacked extension loaded (Playwright, new headless mode).
 */
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer, ROOT } = require('../server');

/** Registers before/after hooks and returns an object filled in once the browser is up. */
function setupExtension() {
  const env = {};
  let server;

  test.before(async () => {
    server = await startServer();
    env.baseUrl = server.baseUrl;

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

  /** Serves `body` at `pathname` (for generated documents); returns its full URL. */
  env.serve = (pathname, body, headers) => server.serve(pathname, body, headers);

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
