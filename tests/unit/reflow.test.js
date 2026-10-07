const test = require('node:test');
const assert = require('node:assert/strict');

let R;
test.before(async () => {
  R = await import('../../src/viewer/reflow.mjs');
});

/** A text run at (x, y) in a size-`size` font; width approximated from the text length. */
function run(str, x, y, size = 10, extra = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size, hasEOL: false, ...extra };
}

/** A page of body lines (left edge 50, 14pt apart from y=720, below the top margin) with optional extra runs. */
function page(lines, { height = 800, header, footer } = {}) {
  const items = [];
  if (header) items.push(run(header, 50, 780, 8));
  lines.forEach((line, i) => {
    const [text, x = 50] = Array.isArray(line) ? line : [line];
    items.push(run(text, x, 720 - i * 14));
  });
  if (footer) items.push(run(footer, 290, 20, 8));
  return { items, height };
}

function reflow(pages) {
  const prepared = pages.map((p) => ({ lines: R.pageLines(p.items), height: p.height }));
  const stats = R.documentStats(prepared);
  const reflower = R.createReflower(stats);
  const blocks = [];
  prepared.forEach((p, i) => blocks.push(...reflower.addPage(p.lines, i + 1, p.height)));
  blocks.push(...reflower.finish());
  return blocks;
}

test('runs on the same baseline form one line, with spaces where there are gaps', () => {
  const lines = R.pageLines([run('Hello', 50, 700), run('world', 82, 700), run('again', 50, 686)]);
  assert.deepEqual(lines.map((l) => l.text), ['Hello world', 'again']);
});

test('joins wrapped lines into paragraphs and splits at blank space and short last lines', () => {
  const blocks = reflow([
    page([
      'Attention is a skill that can be trained with patience and',
      'regular practice over many weeks.',
      ['A new paragraph starts here with an indent and goes on', 70],
      'to the next line of the same paragraph.',
    ]),
  ]);
  assert.deepEqual(blocks.map((b) => [b.type, b.text]), [
    ['p', 'Attention is a skill that can be trained with patience and regular practice over many weeks.'],
    ['p', 'A new paragraph starts here with an indent and goes on to the next line of the same paragraph.'],
  ]);
});

test('rejoins words split by an end-of-line hyphen, also in Cyrillic', () => {
  const blocks = reflow([page(['Внимание помогает удер-', 'живать нить текста при чтении длинных стра-', 'ниц и глав книги.'])]);
  assert.equal(blocks[0].text, 'Внимание помогает удерживать нить текста при чтении длинных страниц и глав книги.');
});

test('keeps the hyphen of a compound word the document also writes whole', () => {
  const blocks = reflow([
    page([
      'Children with attention-deficit disorder read more easily when the',
      'text is calm. A child with attention-',
      'deficit traits benefits from short para-',
      'graphs and clear headings in a book.',
    ]),
  ]);
  assert.match(blocks[0].text, /with attention-deficit traits benefits from short paragraphs and/);
});

test('larger text becomes headings', () => {
  const items = [run('Chapter One', 50, 735, 20), ...page(['Body text of the chapter goes here and continues.']).items];
  const blocks = reflow([{ items, height: 800 }]);
  assert.deepEqual(blocks.map((b) => b.type), ['h2', 'p']);
  assert.equal(blocks[0].text, 'Chapter One');
});

test('drops running headers, footers and page numbers repeated across pages', () => {
  const pages = [1, 2, 3, 4].map((n) =>
    page([`Body sentence number ${n} of the document text that`, 'continues on the next line of body text.'], { header: 'My Book Title', footer: String(n) }),
  );
  const blocks = reflow(pages);
  assert.ok(!blocks.some((b) => /My Book Title/.test(b.text)), 'running header removed');
  assert.ok(!blocks.some((b) => /^\d+$/.test(b.text) || / \d$/.test(b.text)), 'page numbers removed');
  assert.equal(blocks.length, 4);
  assert.match(blocks[0].text, /^Body sentence number 1 .* body text\.$/);
});

test('a paragraph running over a page break continues, with an anchor where the page starts', () => {
  const blocks = reflow([
    page(['The sentence begins on the first page and', 'keeps going across the page']),
    page(['break without stopping at all.', ['Then another paragraph begins on page two.', 70]]),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'The sentence begins on the first page and keeps going across the page break without stopping at all.');
  assert.deepEqual(blocks[0].anchors, [{ offset: 0, page: 1 }, { offset: blocks[0].text.indexOf('break'), page: 2 }]);
});

test('list items start new blocks and rotated watermark text is ignored', () => {
  const items = [
    ...page(['Shopping list for the week:', '• apples and pears', '• bread', '1) milk']).items,
    { str: 'DRAFT', transform: [0, 40, -40, 0, 300, 400], width: 100, height: 40, hasEOL: false },
  ];
  const blocks = reflow([{ items, height: 800 }]);
  assert.deepEqual(blocks.map((b) => b.text), ['Shopping list for the week:', '• apples and pears', '• bread', '1) milk']);
});
