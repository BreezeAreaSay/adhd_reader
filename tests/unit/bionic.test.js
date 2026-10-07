const test = require('node:test');
const assert = require('node:assert/strict');
const Bionic = require('../../src/content/bionic.js');

/** Marks the emphasised part of each word with **…** for readable assertions. */
function mark(text, options = {}) {
  let out = '';
  let pos = 0;
  for (const { start, mid, end } of Bionic.findWords(text, options)) {
    out += `${text.slice(pos, start)}**${text.slice(start, mid)}**${text.slice(mid, end)}`;
    pos = end;
  }
  return out + text.slice(pos);
}

test('emphasises roughly half of each word by default', () => {
  assert.equal(mark('a to the read words reading'), '**a** **t**o **th**e **re**ad **wor**ds **read**ing');
});

test('works for Cyrillic, Greek and mixed text', () => {
  assert.equal(mark('Привет, мир! Ёжик'), '**При**вет, **ми**р! **Ёж**ик');
  assert.equal(mark('καλημέρα'), '**καλη**μέρα');
  assert.equal(mark('React и Vue'), '**Rea**ct **и** **Vu**e');
});

test('fixation controls the share of bold letters but never bolds a whole multi-letter word', () => {
  assert.equal(mark('reading', { fixation: 10 }), '**r**eading');
  assert.equal(mark('reading', { fixation: 90 }), '**readin**g');
  assert.equal(mark('it', { fixation: 90 }), '**i**t');
});

test('saccade emphasises every N-th word', () => {
  assert.equal(mark('one two three four five', { saccade: 2 }), '**on**e two **thr**ee four **fi**ve');
  assert.equal(mark('one two three four five', { saccade: 3 }), '**on**e two three **fo**ur five');
});

test('minWordLength leaves short words alone and they do not count for saccade', () => {
  assert.equal(mark('a cat in the house', { minWordLength: 3 }), 'a **ca**t in **th**e **hou**se');
  assert.equal(mark('a cat in the house', { minWordLength: 3, saccade: 2 }), 'a **ca**t in the **hou**se');
});

test('keeps accents attached to their letter', () => {
  const decomposed = 'cafés'; // "cafés" written with a combining acute accent
  const [word] = Bionic.findWords(decomposed, { fixation: 70 });
  assert.equal(decomposed.slice(word.start, word.mid), 'café');
});

test('treats apostrophes and leading digits as part of the word', () => {
  assert.equal(mark("don't 2nd"), "**don**'t **2n**d");
});

test('skips numbers, punctuation and scripts where splitting words breaks rendering', () => {
  assert.equal(mark('2024 — 42%'), '2024 — 42%');
  assert.equal(mark('漢字テキスト'), '漢字テキスト');
  assert.equal(mark('مرحبا بالعالم'), 'مرحبا بالعالم');
  assert.equal(mark('नमस्ते दुनिया'), 'नमस्ते दुनिया');
  assert.equal(Bionic.hasWords('  \n 123 '), false);
  assert.equal(Bionic.hasWords('漢字'), false);
  assert.equal(Bionic.hasWords('x'), true);
});

test('keeps soft hyphens inside words', () => {
  assert.equal(mark('сло­во'), '**сло­**во');
});
