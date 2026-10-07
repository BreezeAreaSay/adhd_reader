/*
 * Bionic-style text transform: finds words and decides how much of each word to emphasise.
 * Pure logic shared by the content script, the popup/options preview and the unit tests.
 */
(function (root) {
  'use strict';

  // Our elements use unknown, hyphen-free tag names on purpose: site CSS never targets them
  // (unlike <b>/<span>), and they are not "undefined custom elements", so page rules such as
  // `:not(:defined) { visibility: hidden }` can't hide them.
  const TAGS = Object.freeze({ wrapper: 'adhdrw', bold: 'adhdrb', rest: 'adhdrr' });

  // Only scripts whose words are separated by spaces and whose letters don't join. Splitting a word
  // into a bold head and a regular tail breaks shaping in cursive (Arabic…) and abugida
  // (Devanagari…) scripts and makes no sense in spaceless ones (CJK, Thai…), so those are left alone.
  const LETTER = '\\p{sc=Latin}\\p{sc=Cyrillic}\\p{sc=Greek}\\p{sc=Armenian}\\p{sc=Georgian}\\p{sc=Hebrew}';
  const WORD_CHAR = `${LETTER}\\p{M}\\p{N}\\u00AD\\u200C\\u200D`;
  // A word: optional leading digits ("2nd"), a letter, then letters/marks/digits, optionally joined
  // by apostrophes ("don't", "l'homme").
  const WORD_RE = new RegExp(`\\p{N}*[${LETTER}][${WORD_CHAR}]*(?:['\\u2019][${LETTER}][${WORD_CHAR}]*)*`, 'gu');
  const HAS_LETTER_RE = new RegExp(`[${LETTER}]`, 'u');
  // Code points that belong to the preceding character (accents, soft hyphen, joiners).
  const ATTACHED_RE = /[\p{M}\u00AD\u200C\u200D]/u;
  // How much of its colour the rest of a word keeps in already-bold text.
  const HEAVY_FADE = 70;

  function hasWords(text) {
    return HAS_LETTER_RE.test(text);
  }

  /** Code-unit offsets at which each user-perceived character of `word` ends. */
  function characterEnds(word) {
    const ends = [];
    let offset = 0;
    for (const ch of word) {
      offset += ch.length;
      if (ends.length > 0 && ATTACHED_RE.test(ch)) ends[ends.length - 1] = offset;
      else ends.push(offset);
    }
    return ends;
  }

  /**
   * Number of UTF-16 code units at the start of `word` to emphasise.
   * `fixation` is the share of the word's characters (in %) to make bold. One-letter words are bold
   * entirely; longer words always keep at least one regular character.
   */
  function emphasisLength(word, fixation, ends = characterEnds(word)) {
    const count = ends.length;
    if (count <= 1) return word.length;
    const bold = Math.min(count - 1, Math.max(1, Math.ceil((count * fixation) / 100)));
    return ends[bold - 1];
  }

  /**
   * Returns `{ start, mid, end }` for every word to emphasise: [start, mid) is bold, [mid, end) not.
   * Options: `fixation` (%), `saccade` (emphasise every N-th word), `minWordLength` (in characters).
   */
  function findWords(text, { fixation = 50, saccade = 1, minWordLength = 1 } = {}) {
    const words = [];
    let index = 0;
    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(text)) !== null) {
      const word = match[0];
      const ends = characterEnds(word);
      if (ends.length < minWordLength) continue;
      if (index++ % saccade !== 0) continue;
      const start = match.index;
      words.push({ start, mid: start + emphasisLength(word, fixation, ends), end: start + word.length });
    }
    return words;
  }

  /**
   * Element templates for the given settings; cloning them is faster than building styles per word.
   * `normal` is for regular text. `heavy` is for text that is already bold (headings, <strong>): a
   * bold start would be invisible there, so the start gets the heaviest weight and the rest of the
   * word is faded a little.
   */
  function createTemplates(doc, { weight, fade }) {
    const wrapper = doc.createElement(TAGS.wrapper);
    // Neutralise any site rule that could reach the wrapper (e.g. `.flex > * { display: block }`).
    wrapper.style.setProperty('all', 'unset', 'important');

    const make = (tag, props) => {
      const el = doc.createElement(tag);
      for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value, 'important');
      return el;
    };
    // In the `color` property currentColor is the inherited colour, so this fades the tail relative
    // to whatever colour the text has. Cheaper than `opacity` (no stacking contexts).
    const faded = (percent) => ({ color: `color-mix(in srgb, currentColor ${percent}%, transparent)` });

    return {
      wrapper,
      normal: {
        bold: make(TAGS.bold, { 'font-weight': String(weight) }),
        rest: fade < 100 ? make(TAGS.rest, faded(fade)) : null,
      },
      heavy: {
        bold: make(TAGS.bold, { 'font-weight': '900' }),
        rest: make(TAGS.rest, faded(Math.min(fade, HEAVY_FADE))),
      },
    };
  }

  /**
   * Builds the emphasised version of `text` as a DocumentFragment (text nodes + bold/rest elements),
   * or returns null when the text contains no words to emphasise.
   */
  function buildFragment(doc, text, settings, templates, heavy = false) {
    const words = findWords(text, settings);
    if (words.length === 0) return null;
    const { bold: boldTemplate, rest: restTemplate } = heavy ? templates.heavy : templates.normal;

    const fragment = doc.createDocumentFragment();
    let plain = '';
    let pos = 0;
    const flush = () => {
      if (plain) fragment.appendChild(doc.createTextNode(plain));
      plain = '';
    };

    for (const { start, mid, end } of words) {
      plain += text.slice(pos, start);
      flush();
      const bold = boldTemplate.cloneNode(false);
      bold.textContent = text.slice(start, mid);
      fragment.appendChild(bold);
      if (end > mid) {
        if (restTemplate) {
          const rest = restTemplate.cloneNode(false);
          rest.textContent = text.slice(mid, end);
          fragment.appendChild(rest);
        } else {
          plain = text.slice(mid, end);
        }
      }
      pos = end;
    }
    plain += text.slice(pos);
    flush();
    return fragment;
  }

  const Bionic = Object.freeze({ TAGS, hasWords, emphasisLength, findWords, createTemplates, buildFragment });

  const ns = root.ADHDR || (root.ADHDR = {});
  ns.Bionic = Bionic;
  if (typeof module === 'object' && module.exports) module.exports = Bionic;
})(globalThis);
