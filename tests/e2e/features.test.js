/*
 * End-to-end tests for the features beyond plain bionic emphasis: word selection options, site
 * modes, page typography, tint/dim/focus overlay and the reader view.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupExtension, boldParts, waitForBold, exists } = require('./helpers');

const env = setupExtension();

const OVERLAY = '[data-adhdr-ui="overlay"]';
const READER = '[data-adhdr-ui="reader"]';

/** Resolves once the page's content script has loaded its settings; returns its status. */
async function settledStatus(page) {
  const tabId = await env.tabIdOf(page);
  for (let i = 0; i < 100; i++) {
    const status = await env.worker
      .evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getStatus' }, { frameId: 0 }), tabId)
      .catch(() => null);
    if (status?.ready) return status;
    await page.waitForTimeout(100);
  }
  throw new Error('content script never became ready');
}

function toggleReader(page) {
  return env.tabIdOf(page).then((tabId) => env.worker.evaluate((id) => toggleReader(id), tabId));
}

test('saccade, minimum word length and stronger emphasis in already-bold text', async () => {
  await env.setSettings({ saccade: 2, minWordLength: 3 });
  const { page } = await env.openPage('basic.html');
  await waitForBold(page, '#plain');
  assert.deepEqual((await boldParts(page, '#plain')).slice(0, 4), ['Bio', 'hel', 'ey', 'thro']);

  const heading = await page.$eval('h1', (h1) => ({
    head: getComputedStyle(h1.querySelector('adhdrb')).fontWeight,
    tail: getComputedStyle(h1.querySelector('adhdrr')).color,
    text: h1.innerText,
  }));
  assert.equal(heading.text, 'Reading test page');
  assert.equal(heading.head, '900');
  assert.match(heading.tail, /0\.7\)$/, `faded tail colour, got ${heading.tail}`);
  await page.close();
});

test('"only on these sites" mode', async () => {
  await env.setSettings({ siteMode: 'only', enabledSites: ['example.com'] });
  const { page } = await env.openPage('basic.html');
  assert.equal((await settledStatus(page)).active, false);
  assert.equal(await exists(page, 'adhdrw'), false);

  await env.setSettings({ enabledSites: ['example.com', '127.0.0.1'] });
  await waitForBold(page, '#plain');
  await page.close();
});

test('page font and spacing apply to the page and its shadow DOM, even under a strict CSP', async () => {
  await env.setSettings({ font: 'atkinson', lineHeight: 180, letterSpacing: 5 });
  for (const [name, selector] of [['basic.html', '#plain'], ['csp.html', '#csp-text']]) {
    const { page, errors } = await env.openPage(name);
    await page.waitForFunction((s) => getComputedStyle(document.querySelector(s)).fontFamily.includes('ADHDR Atkinson'), selector);
    const metrics = await page.$eval(selector, (p) => {
      const cs = getComputedStyle(p);
      return { lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), letterSpacing: parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize) };
    });
    assert.ok(Math.abs(metrics.lineHeight - 1.8) < 0.02, `line height ${metrics.lineHeight}`);
    assert.ok(Math.abs(metrics.letterSpacing - 0.05) < 0.005, `letter spacing ${metrics.letterSpacing}`);
    // The bundled font files really load (Latin from Atkinson, Cyrillic from PT Sans).
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'ADHDR Atkinson' && f.status === 'loaded'));
    assert.deepEqual(errors, [], name);

    if (name === 'basic.html') {
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#open-box').shadowRoot.querySelector('p')).fontFamily.includes('ADHDR Atkinson'));
      // Code keeps its monospace font.
      assert.doesNotMatch(await page.$eval('#pre', (pre) => getComputedStyle(pre).fontFamily), /ADHDR/);
    }

    await env.setSettings({ font: 'site', lineHeight: 100, letterSpacing: 0 });
    await page.waitForFunction((s) => !getComputedStyle(document.querySelector(s)).fontFamily.includes('ADHDR'), selector);
    await env.setSettings({ font: 'atkinson', lineHeight: 180, letterSpacing: 5 });
    await page.close();
  }
});

test('tint and dim overlay, focus on the line or paragraph under the mouse', async () => {
  const { page, errors } = await env.openPage('basic.html');
  await waitForBold(page, '#plain');

  await env.setSettings({ tint: 'blue', tintStrength: 40, dim: 20 });
  await page.waitForSelector(OVERLAY, { state: 'attached' });
  const overlay = await page.$eval(OVERLAY, (host) => {
    const cs = getComputedStyle(host);
    const [tint, dim] = host.shadowRoot.children;
    return {
      host: [cs.position, cs.pointerEvents, cs.mixBlendMode, cs.zIndex],
      tint: [tint.style.display, tint.style.opacity],
      dim: [dim.style.display, dim.style.opacity],
    };
  });
  assert.deepEqual(overlay, { host: ['fixed', 'none', 'multiply', '2147483647'], tint: ['block', '0.4'], dim: ['block', '0.2'] });

  // The spotlight frames the paragraph's text, not its element box.
  const box = await page.$eval('#plain', (p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const r = range.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const spot = () => page.$eval(OVERLAY, (host) => {
    const s = host.shadowRoot.querySelector('.spot');
    return { display: s.style.display, top: parseFloat(s.style.top), left: parseFloat(s.style.left), width: parseFloat(s.style.width), height: parseFloat(s.style.height) };
  });

  await env.setSettings({ tint: 'none', dim: 0, focus: 'line' });
  await page.mouse.move(box.left + 30, box.top + 8);
  await page.waitForFunction(() => document.querySelector('[data-adhdr-ui="overlay"]')?.shadowRoot.querySelector('.spot').style.display === 'block');
  await page.waitForTimeout(100);
  let rect = await spot();
  assert.equal(rect.left, 0);
  assert.ok(rect.top <= box.top + 2 && rect.top >= box.top - 25, `band top ${rect.top} vs line top ${box.top}`);
  assert.ok(rect.height > 15 && rect.height < 60, `band height ${rect.height}`);

  await env.setSettings({ focus: 'paragraph' });
  await page.mouse.move(box.left + 40, box.top + 10);
  await page.waitForFunction(
    (b) => {
      const s = document.querySelector('[data-adhdr-ui="overlay"]')?.shadowRoot.querySelector('.spot');
      return s && Math.abs(parseFloat(s.style.top) - (b.top - 4)) < 2 && Math.abs(parseFloat(s.style.height) - (b.height + 8)) < 2;
    },
    box,
  );
  rect = await spot();
  assert.ok(Math.abs(rect.left - (box.left - 8)) < 2 && Math.abs(rect.width - (box.width + 16)) < 2, JSON.stringify({ rect, box }));

  await env.setSettings({ focus: 'off' });
  await page.waitForSelector(OVERLAY, { state: 'detached' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('reader view shows only the article, cleaned up, with bionic emphasis', async () => {
  const { page, errors } = await env.openPage('news.html');
  await waitForBold(page, '#first');
  assert.equal(await toggleReader(page), true);
  await page.waitForFunction((sel) => document.querySelector(sel)?.shadowRoot?.querySelector('.content adhdrb'), READER);

  const info = await page.$eval(READER, (host) => {
    const root = host.shadowRoot;
    const content = root.querySelector('.content');
    return {
      title: root.querySelector('.title').textContent,
      text: content.textContent.replace(/\s+/g, ' '),
      active: content.querySelector('script, iframe, button, form'),
      handlers: [...content.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => a.name.startsWith('on'))),
      links: [...content.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('target')]),
      image: content.querySelector('img')?.getAttribute('src'),
      overflow: document.documentElement.style.overflow,
      focused: root.activeElement?.className,
      left: root.querySelector('.left').textContent,
      toolbarBionic: Boolean(root.querySelector('.toolbar adhdrb')),
    };
  });
  // The <title> ends with the site name; the article's own, fuller heading is used instead, once.
  assert.equal(info.title, 'Focus is a skill you can practise');
  assert.ok(!info.text.includes('Focus is a skill you can practise'), 'heading is not repeated in the body');
  assert.match(info.text, /Attention is not a fixed amount/);
  assert.match(info.text, /be kind to yourself/);
  for (const clutter of ['headphones', 'First! Great article', 'Ten tips', 'All rights reserved', 'Sign in']) {
    assert.ok(!info.text.includes(clutter), `"${clutter}" should not be in the reader view`);
  }
  assert.equal(info.active, null);
  assert.equal(info.handlers, false);
  // The javascript: link is reduced to its text; the real one opens in a new tab.
  assert.deepEqual(info.links, [[`${env.baseUrl}/guide`, '_blank']]);
  assert.match(info.text, /like to click here or follow/);
  assert.equal(info.image, `${env.baseUrl}/tests/fixtures/pixel.png`);
  assert.equal(info.overflow, 'hidden');
  assert.equal(info.focused, 'reader');
  assert.match(info.left, /min/);
  assert.equal(info.toolbarBionic, false);

  // Toolbar buttons change the stored settings, which restyle the view.
  await page.$eval(READER, (host) => host.shadowRoot.querySelector('[data-action="larger"]').click());
  await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel).shadowRoot.querySelector('.reader')).fontSize === '22px', READER);

  await page.keyboard.press('Escape');
  await page.waitForSelector(READER, { state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
  assert.equal(await page.evaluate(() => window.__clicked), undefined);
  assert.deepEqual(errors, []);
  await page.close();
});

test('reader view works where the extension is off and under a strict CSP; says so when there is no article', async () => {
  await env.setSettings({ disabledSites: ['127.0.0.1'] });
  const { page, errors } = await env.openPage('csp.html');
  assert.equal((await settledStatus(page)).active, false);
  assert.equal(await toggleReader(page), true);
  await page.waitForFunction((sel) => document.querySelector(sel)?.shadowRoot?.querySelector('.content adhdrb'), READER);
  const background = await page.$eval(READER, (host) => getComputedStyle(host.shadowRoot.querySelector('.reader')).backgroundColor);
  assert.notEqual(background, 'rgba(0, 0, 0, 0)', 'reader styles must apply despite the CSP');
  assert.equal(await toggleReader(page), true); // toggles it closed again
  await page.waitForSelector(READER, { state: 'detached' });
  assert.equal(await exists(page, 'adhdrw'), false, 'the page itself stays untouched');
  assert.deepEqual(errors, []);
  await page.close();

  const empty = await env.openPage('empty.html');
  await settledStatus(empty.page);
  assert.equal(await toggleReader(empty.page), true);
  const toast = await empty.page.waitForSelector('[data-adhdr-ui="toast"]');
  assert.match(await toast.textContent(), /main text/);
  assert.equal(await exists(empty.page, READER), false);
  await empty.page.close();
});

test('every suggested keyboard shortcut is actually assigned by Chrome', async () => {
  // Chrome silently drops suggested keys that clash with its own (Alt+Shift+B focuses the bookmarks bar).
  const manifest = require('../../manifest.json');
  const assigned = Object.fromEntries(await env.worker.evaluate(async () => (await chrome.commands.getAll()).map((c) => [c.name, c.shortcut])));
  for (const [name, command] of Object.entries(manifest.commands)) {
    if (!command.suggested_key) continue;
    assert.equal(assigned[name], command.suggested_key.default, `${name} shortcut`);
  }
});

test('Cyrillic is drawn by OpenDyslexic and Andika themselves, and by PT Sans for Latin-only fonts', async () => {
  const page = await env.context.newPage();
  await page.goto(`chrome-extension://${env.extensionId}/src/options/options.html`);
  const widths = await page.evaluate(async () => {
    ADHDR.ensureFontFaces(document);
    const text = 'Съешь же ещё этих мягких французских булок, да выпей чаю';
    const families = ['ADHDR OpenDyslexic', 'ADHDR Andika', 'ADHDR PT Sans'];
    await Promise.all(families.map((family) => document.fonts.load(`20px "${family}"`, text)));
    const context = document.createElement('canvas').getContext('2d');
    const width = (font) => {
      context.font = `20px ${font}`;
      return Math.round(context.measureText(text).width);
    };
    return {
      fallback: width('monospace'),
      openDyslexic: width('"ADHDR OpenDyslexic", monospace'),
      andika: width('"ADHDR Andika", monospace'),
      ptSans: width('"ADHDR PT Sans", monospace'),
      atkinsonStack: width(ADHDR.fontStack('atkinson')),
    };
  });
  assert.notEqual(widths.openDyslexic, widths.fallback, 'OpenDyslexic draws Cyrillic itself');
  assert.notEqual(widths.andika, widths.fallback, 'Andika draws Cyrillic itself');
  assert.equal(widths.atkinsonStack, widths.ptSans, 'Atkinson falls back to PT Sans for Cyrillic');
  await page.close();
});
