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
  const ATTACHED_RE = /[\p{M}­‌‍]/u;

  function hasWords(text) {
    return HAS_LETTER_RE.test(text);
  }

  /**
   * Number of UTF-16 code units at the start of `word` to emphasise.
   * `fixation` is the share of the word's characters (in %) to make bold. One-letter words are bold
   * entirely; longer words always keep at least one regular character.
   */
  function emphasisLength(word, fixation) {
    const ends = []; // code-unit offset at which each user-perceived character ends
    let offset = 0;
    for (const ch of word) {
      offset += ch.length;
      if (ends.length > 0 && ATTACHED_RE.test(ch)) ends[ends.length - 1] = offset;
      else ends.push(offset);
    }
    const count = ends.length;
    if (count <= 1) return word.length;
    const bold = Math.min(count - 1, Math.max(1, Math.ceil((count * fixation) / 100)));
    return ends[bold - 1];
  }

  /** Returns `{ start, mid, end }` for every word: [start, mid) is emphasised, [mid, end) is not. */
  function findWords(text, fixation) {
    const words = [];
    WORD_RE.lastIndex = 0;
    let match;
    while ((match = WORD_RE.exec(text)) !== null) {
      const start = match.index;
      const word = match[0];
      words.push({ start, mid: start + emphasisLength(word, fixation), end: start + word.length });
    }
    return words;
  }

  /** Element templates for the given settings; cloning them is faster than building styles per word. */
  function createTemplates(doc, { weight, fade }) {
    const wrapper = doc.createElement(TAGS.wrapper);
    // Neutralise any site rule that could reach the wrapper (e.g. `.flex > * { display: block }`).
    wrapper.style.setProperty('all', 'unset', 'important');

    const bold = doc.createElement(TAGS.bold);
    bold.style.setProperty('font-weight', String(weight), 'important');

    let rest = null;
    if (fade < 100) {
      rest = doc.createElement(TAGS.rest);
      // In the `color` property currentColor is the inherited colour, so this fades the tail
      // relative to whatever colour the text has. Cheaper than `opacity` (no stacking contexts).
      rest.style.setProperty('color', `color-mix(in srgb, currentColor ${fade}%, transparent)`, 'important');
    }
    return { wrapper, bold, rest };
  }

  /**
   * Builds the emphasised version of `text` as a DocumentFragment (text nodes + bold/rest elements),
   * or returns null when the text contains no words to emphasise.
   */
  function buildFragment(doc, text, settings, templates) {
    const words = findWords(text, settings.fixation);
    if (words.length === 0) return null;

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
      const bold = templates.bold.cloneNode(false);
      bold.textContent = text.slice(start, mid);
      fragment.appendChild(bold);
      if (end > mid) {
        if (templates.rest) {
          const rest = templates.rest.cloneNode(false);
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
