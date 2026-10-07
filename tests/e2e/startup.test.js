/*
 * End-to-end tests for when the extension starts changing a page: right away on plain pages, only
 * after hydration on server-rendered React/Vue apps (changing their DOM earlier breaks them).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupExtension, exists } = require('./helpers');

const env = setupExtension();

/** Records DOMContentLoaded and the moment our first wrapper appears, in page time. */
function recordTimes(page) {
  return page.addInitScript(() => {
    window.__times = {};
    document.addEventListener('DOMContentLoaded', () => (window.__times.dcl = performance.now()));
    new MutationObserver((records, observer) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeName === 'ADHDRW') {
            window.__times.firstBold = performance.now();
            observer.disconnect();
            return;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test('starts right after the HTML is parsed on plain pages', async () => {
  const { page, errors } = await env.openPage('article.html', recordTimes);
  await page.waitForFunction(() => window.__times.firstBold);
  const { dcl, firstBold } = await page.evaluate(() => window.__times);
  console.log(`  first emphasis ${Math.round(firstBold - dcl)} ms after DOMContentLoaded`);
  assert.ok(firstBold - dcl < 1000, `took ${firstBold - dcl} ms`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('waits for React hydration, then leaves only still-pending <Suspense> boundaries for later', async () => {
  const { page, errors } = await env.openPage('/ssr-react?hydrateAfter=500&lazyAfter=2500', recordTimes);

  // The shell gets emphasis once React has hydrated it; the lazy boundary is still dehydrated then.
  await page.waitForSelector('#shell adhdrb', { timeout: 10000 });
  assert.equal(await exists(page, '#lazy adhdrb'), false, 'the pending boundary must not be touched yet');

  // Once the lazy part has loaded and hydrated, it gets emphasis too.
  await page.waitForSelector('#lazy adhdrb', { timeout: 10000 });
  assert.equal(await page.$eval('#lazy', (p) => p.innerText), 'Lazy section hydrated later on purpose');

  // React still works, and it never saw a hydration mismatch.
  await page.click('#more');
  await page.waitForFunction(() => document.querySelector('#more').innerText === 'Clicked 1 times');
  assert.deepEqual(await page.evaluate(() => window.__recoverable), []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('recognises pages that a framework will hydrate', async () => {
  const page = await env.context.newPage();
  await page.goto(`${env.baseUrl}/tests/fixtures/empty.html`);
  await page.addScriptTag({ path: path.resolve(__dirname, '../../src/content/page-kind.js') });
  const kinds = await page.evaluate(() => {
    const cases = {
      plain: '<main><p>Hello</p><!-- a normal comment --></main>',
      nextData: '<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script>',
      nextAppRouter: '<p>x</p><script>self.__next_f.push([1,""])</script>',
      reactStreaming: '<div id="root"><!--$--><p>x</p><!--/$--></div>',
      remix: '<script>window.__remixContext = {};</script>',
      nuxt: '<div id="__nuxt"><p>x</p></div>',
      vue3: '<div id="app"><!--[--><p>x</p><!--]--></div>',
      svelte5: '<div><!--[!--><p>x</p><!--]--></div>',
      sveltekit: '<body data-sveltekit-preload-data="hover"><p>x</p></body>',
      angular: '<app-root ng-version="17.0.0"><p>x</p></app-root>',
      astro: '<astro-island uid="1"><p>x</p></astro-island>',
    };
    return Object.fromEntries(
      Object.entries(cases).map(([name, html]) => [name, ADHDR.hydrationKind(new DOMParser().parseFromString(html, 'text/html'))]),
    );
  });
  assert.deepEqual(kinds, {
    plain: null,
    nextData: 'react',
    nextAppRouter: 'react',
    reactStreaming: 'react',
    remix: 'react',
    nuxt: 'vue',
    vue3: 'vue',
    svelte5: 'other',
    sveltekit: 'other',
    angular: 'other',
    astro: 'other',
  });
  await page.close();
});
