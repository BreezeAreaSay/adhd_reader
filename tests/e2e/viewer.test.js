/*
 * End-to-end tests for the document viewer: PDF (reflowed text and original pages), EPUB, FB2 and
 * TXT, the reading position, and PDF links opening in the viewer instead of Chrome's own viewer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupExtension, exists } = require('./helpers');
const docs = require('./documents');

const env = setupExtension();
const PDF_HEADERS = { 'content-type': 'application/pdf' };
const BINARY = { 'content-type': 'application/octet-stream' };

let files = null;
// Built in the first test that needs them (the browser is not up yet while other hooks run).
async function documents() {
  files ??= {
    pdf: env.serve('/docs/focus.pdf', await docs.makePdf(env.context), PDF_HEADERS),
    scan: env.serve('/docs/scan.pdf', await docs.makeScannedPdf(env.context), PDF_HEADERS),
    epub: env.serve('/docs/book.epub', docs.makeEpub(), { 'content-type': 'application/epub+zip' }),
    fb2: env.serve('/docs/book.fb2', docs.makeFb2(), BINARY),
    fb2zip: env.serve('/docs/book.fb2.zip', docs.makeFb2({ zipped: true }), { 'content-type': 'application/zip' }),
    txt: env.serve('/docs/book.txt', docs.makeTxt(), { 'content-type': 'text/plain; charset=utf-8' }),
  };
  return files;
}

/** Opens one of the test documents (by its key in documents()) in the viewer, or its start screen. */
async function openViewer(key) {
  const file = key ? (await documents())[key] : null;
  const page = await env.context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  await page.goto(env.viewerUrl(file));
  return { page, errors };
}

/** Text of the content blocks (headings and paragraphs) in reading order. */
function blocks(page) {
  return page.$$eval('.content :is(h1, h2, h3, h4, p)', (nodes) => nodes.map((n) => `${n.localName}: ${n.textContent.replace(/\s+/g, ' ').trim()}`));
}

// A failed test leaves its tab open, and a tab in the background stops drawing PDF pages.
test.afterEach(async () => {
  for (const page of env.context.pages()) if (page.url() !== 'about:blank') await page.close();
});

const status = (page) => page.$eval('.left', (el) => el.textContent);

test('a PDF opens as flowing text with bionic emphasis, without running headers and page numbers', async () => {
  const { page, errors } = await openViewer('pdf');
  await page.waitForSelector('[data-action="toc"]:not([hidden])', { timeout: 15000 }); // shown last, with the bookmarks
  assert.match(await status(page), /^Page 1 of 5 · ≈ \d+ min left$/);

  assert.equal(await page.$eval('.title', (el) => el.textContent), 'Focus and Reading');
  assert.equal(await page.title(), 'Focus and Reading — ADHD Reader');
  assert.match(await page.$eval('.meta', (el) => el.textContent), /5 pages/);

  const content = await blocks(page);
  // The first heading repeats the title and is left out; the others are headings again.
  assert.deepEqual(content.filter((b) => !b.startsWith('p:')), ['h3: Глава вторая: о чтении', 'h3: Third part']);
  const paragraphs = content.filter((b) => b.startsWith('p:'));
  assert.equal(paragraphs.length, 28, 'one paragraph per paragraph of the original, also across page breaks');
  assert.equal(paragraphs[0], `p: ${docs.EN(1)}`);
  assert.ok(paragraphs.includes(`p: ${docs.RU(4)}`), 'Russian text comes through intact');
  const text = await page.$eval('.content', (el) => el.textContent);
  assert.ok(!text.includes('sample'), 'running header removed');

  // Bionic emphasis works on the text, the page markers are left alone.
  assert.ok((await page.$$eval('.content adhdrb', (b) => b.length)) > 500);
  assert.equal(await page.$$eval('.page-break adhdrb', (b) => b.length), 0);

  // The bookmarks become the table of contents and jump to their page.
  await page.click('[data-action="toc"]');
  assert.deepEqual(await page.$$eval('.toc button', (b) => b.map((x) => `${x.dataset.level} ${x.textContent}`)), ['1 Focus and Reading', '2 Глава вторая: о чтении', '2 Third part']);
  await page.click('.toc button:nth-of-type(3)');
  assert.equal(await page.isVisible('.toc'), false);
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll('.content h3')].find((h) => h.textContent === 'Third part');
    const top = heading.getBoundingClientRect().top;
    return top > 0 && top < 300;
  });
  assert.match(await status(page), /^Page [34] of 5/);

  // The user's look applies here too.
  await env.setSettings({ font: 'opendyslexic', readerTheme: 'dark' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.content')).fontFamily.includes('OpenDyslexic'));
  assert.equal(await page.$eval('.reader', (el) => el.dataset.theme), 'dark');
  await env.setSettings({ bionic: false });
  await page.waitForFunction(() => !document.querySelector('adhdrb'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('a PDF can be shown as its original pages, with selectable text, and back', async () => {
  const { page, errors } = await openViewer('pdf');
  await page.waitForSelector('.content p adhdrb', { timeout: 15000 });
  await page.click('[data-action="mode"]');
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page').length === 5);
  assert.equal(await page.$eval('[data-action="mode"]', (b) => b.textContent), 'Text');
  // Pages are drawn as they come near the screen, with a text layer for selecting and copying.
  await page.waitForSelector('.pdf-page[data-page="1"] canvas');
  await page.waitForFunction(() => document.querySelector('.pdf-page[data-page="1"] .textLayer')?.textContent.includes('paragraph number 1'));
  assert.equal(await page.$$eval('.pdf-page[data-page="5"] canvas', (c) => c.length), 0, 'far pages are not drawn yet');
  assert.equal(await page.$$eval('.textLayer adhdrb', (b) => b.length), 0, 'the text layer must stay aligned with the drawing');
  const drawn = await page.$eval('.pdf-page[data-page="1"] canvas', (canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
    return dark;
  });
  assert.ok(drawn > 1000, 'the page is actually drawn');

  await page.click('[data-action="mode"]');
  await page.waitForSelector('.content p adhdrb');
  assert.equal(await exists(page, '.pdf-page'), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a scanned PDF without text opens as pages and says why', async () => {
  const { page, errors } = await openViewer('scan');
  await page.waitForSelector('.viewer-notice', { timeout: 15000 });
  assert.match(await page.$eval('.viewer-notice', (el) => el.textContent), /scan/);
  assert.equal(await page.$$eval('.pdf-page', (p) => p.length), 3);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an EPUB book: chapters, contents, pictures and links work; its scripts and styles do not', async () => {
  const { page, errors } = await openViewer('epub');
  await page.waitForSelector('.content section adhdrb', { timeout: 15000 });
  assert.equal(await page.$eval('.title', (el) => el.textContent), 'Тестовая книга');
  assert.equal(await page.$eval('.meta', (el) => el.textContent), 'Анна Автор · EPUB');
  assert.equal(await page.$eval('.reader', (el) => el.lang), 'ru');

  const content = await blocks(page);
  assert.equal(content[0], 'h1: Глава первая');
  assert.ok(content.includes(`p: ${docs.RU(18)}`));
  assert.equal(await page.$$eval('.content :is(script, style, link)', (n) => n.length), 0);
  assert.equal(await page.$$eval('.content [onclick]', (n) => n.length), 0);
  assert.equal(await page.evaluate(() => window.__bookScriptRan), undefined);

  // The picture comes from inside the book.
  await page.waitForFunction(() => document.querySelector('.content img')?.naturalWidth > 0);
  assert.match(await page.$eval('.content img', (img) => img.src), /^blob:/);

  // A link to another chapter leads to it.
  const href = await page.$eval('.content a', (a) => a.getAttribute('href'));
  assert.equal(await page.$eval(href, (el) => el.textContent), 'Часть вторая');

  await page.click('[data-action="toc"]');
  assert.deepEqual(await page.$$eval('.toc button', (b) => b.map((x) => `${x.dataset.level} ${x.textContent}`)), ['1 Глава первая', '1 Глава вторая', '2 Часть вторая']);
  await page.click('.toc button:nth-of-type(3)');
  await page.waitForFunction((sel) => {
    const top = document.querySelector(sel).getBoundingClientRect().top;
    return top > 0 && top < 200;
  }, href);
  assert.deepEqual(errors, []);
  await page.close();
});

test('FB2 books in Windows-1251, also zipped, and plain text files', async () => {
  for (const file of ['fb2', 'fb2zip']) {
    const { page, errors } = await openViewer(file);
    await page.waitForSelector('.content section adhdrb', { timeout: 15000 });
    assert.equal(await page.$eval('.title', (el) => el.textContent), 'Книга в кодировке 1251');
    assert.equal(await page.$eval('.meta', (el) => el.textContent), 'Иван Писатель · FB2');
    const content = await blocks(page);
    assert.ok(content.includes('h2: Глава 1 — Начало'));
    assert.ok(content.includes(`p: ${docs.RU(5)}`));
    assert.ok(content.includes('p: Строка стихотворения первая,'));
    assert.deepEqual(await page.$$eval('.epigraph p', (ps) => ps.map((p) => p.textContent)), ['Читать — значит думать чужой головой.', 'Кто-то']);
    // The footnote link points at the note, and notes stay out of the contents.
    const note = await page.$eval('sup a', (a) => a.getAttribute('href'));
    assert.match(await page.$eval(note, (el) => el.textContent), /Текст сноски/);
    assert.deepEqual(await page.$$eval('.toc button', (b) => b.map((x) => x.textContent)), ['Глава 1 — Начало', 'Глава 2']);
    await page.waitForFunction(() => document.querySelector('.content img')?.naturalWidth > 0);
    assert.deepEqual(errors, []);
    await page.close();
  }

  const { page, errors } = await openViewer('txt');
  await page.waitForSelector('.content p adhdrb', { timeout: 15000 });
  assert.deepEqual(await blocks(page), ['h2: ГЛАВА ПЕРВАЯ', `p: ${docs.RU(1)}`, `p: ${docs.RU(2)}`, 'h2: Глава вторая', `p: ${docs.RU(3)}`, `p: ${docs.RU(4)}`]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('files from the computer open from the start screen, which then lists them', async () => {
  const { page, errors } = await openViewer(null);
  await page.waitForSelector('#welcome:not([hidden])');
  assert.equal(await page.$eval('#choose', (b) => b.textContent), 'Choose a file');
  await page.setInputFiles('#file-input', { name: 'Моя книга.epub', mimeType: 'application/epub+zip', buffer: docs.makeEpub() });
  await page.waitForSelector('.content section adhdrb');
  assert.equal(await page.$eval('.site', (el) => el.textContent), 'Local files');
  assert.equal(await page.isVisible('[data-action="original"]'), false);

  await page.$eval('.reader', (el) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  });
  await page.waitForTimeout(1300); // the position is saved once a second while scrolling
  await page.goto(env.viewerUrl(null));
  await page.waitForSelector('#recent:not([hidden])');
  assert.match(await page.$eval('#recent-list', (el) => el.textContent), /Тестовая книга.*EPUB · 5\d%/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the viewer remembers where you stopped reading', async () => {
  const { page } = await openViewer('fb2');
  await page.waitForSelector('.content section adhdrb');
  await page.$eval('.reader', (el) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.6;
  });
  await page.waitForTimeout(1300);
  await page.reload();
  await page.waitForSelector('.resume');
  const progress = await page.$eval('.reader', (el) => el.scrollTop / (el.scrollHeight - el.clientHeight));
  assert.ok(Math.abs(progress - 0.6) < 0.05, `restored to ${progress}`);
  await page.click('.resume button');
  assert.equal(await page.$eval('.reader', (el) => el.scrollTop), 0);
  await page.close();
});

test('PDF links open in the viewer; the original is one click away; downloads and the setting are respected', async () => {
  await documents();
  const page = await env.context.newPage();
  await page.goto(`${env.baseUrl}/tests/fixtures/basic.html`);
  await page.goto(files.pdf).catch(() => {}); // the navigation is replaced, which Playwright reports as aborted
  await page.waitForURL(env.viewerUrl(files.pdf));
  await page.waitForSelector('.content p adhdrb', { timeout: 15000 });

  // ↗ shows the browser's own viewer, and does not bounce back.
  await page.click('[data-action="original"]');
  await page.waitForURL(files.pdf);
  await page.waitForTimeout(800);
  assert.equal(page.url(), files.pdf);
  await page.close();

  // Served as a download: left to the browser.
  const download = env.serve('/docs/download.pdf', fs.readFileSync(path.join(__dirname, '../fixtures/pixel.png')), { ...PDF_HEADERS, 'content-disposition': 'attachment; filename="a.pdf"' });
  const second = await env.context.newPage();
  await second.goto(`${env.baseUrl}/tests/fixtures/basic.html`);
  await second.goto(download).catch(() => {});
  await second.waitForTimeout(800);
  assert.ok(!second.url().startsWith('chrome-extension:'), second.url());
  await second.close();

  // Turned off in the settings.
  await env.setSettings({ openDocuments: false });
  const third = await env.context.newPage();
  await third.goto(files.pdf).catch(() => {});
  await third.waitForTimeout(800);
  assert.equal(third.url(), files.pdf);
  await third.close();
});

test('the popup offers to open files and shows the viewer as its own page', async () => {
  const viewer = await env.context.newPage();
  await viewer.goto(env.viewerUrl(null));
  const popup = await env.context.newPage();
  await popup.goto(`chrome-extension://${env.extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('#preview adhdrb');
  assert.equal(await popup.isVisible('#open-file'), true);
  const opened = env.context.waitForEvent('page');
  await popup.click('#open-file');
  const tab = await opened;
  await tab.waitForLoadState();
  assert.equal(tab.url(), env.viewerUrl(null));
  await tab.close();
  await viewer.close();
});
