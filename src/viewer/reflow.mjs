/*
 * Turns the positioned text runs of PDF pages (pdf.js getTextContent items) into flowing text:
 * lines → paragraphs and headings, without running headers/footers and page numbers, with words
 * split by end-of-line hyphens joined again. Pure functions, no DOM.
 *
 * PDF coordinates: y grows upwards, so the next line down has a smaller y.
 */

const SENTENCE_END = /[.!?…:;"»”’)\]]$/u;
const BULLET = /^(?:[•●▪◦‣∙·–—-]\s|\(?\d{1,3}[.)]\s|[a-zа-яё][.)]\s)/iu;
const SPLIT_WORD = /\p{L}[-­]$/u;
const COMPOUND = /\p{L}+(?:-\p{L}+)+/gu;
const LAST_PART = /\p{L}+-$/u;
const FIRST_PART = /^\p{L}+/u;
const LOWER_START = /^\p{Ll}/u;
const PAGE_NUMBER = /^(?:[-–—]\s*)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\s*[-–—])?$|^(?:page|p\.|стр\.?|страница)\s*\d+(?:\s*(?:of|из|\/)\s*\d+)?$/iu;
const MARGIN = 0.08; // top and bottom share of the page where running headers/footers live

function clean(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/g, '').replace(/\s+/g, ' ');
}

/** Groups a page's text runs into lines: { text, x0, x1, y, size }. */
export function pageLines(items) {
  const lines = [];
  let line = null;
  for (const item of items) {
    const [a, b, c, d, x, y] = item.transform;
    // Rotated runs are watermarks and margin notes, not part of the text flow.
    if (Math.abs(b) > Math.abs(a) * 0.2 || Math.abs(c) > Math.abs(d) * 0.2) continue;
    const size = Math.abs(d) || item.height || 1;
    const str = clean(item.str || '');
    if (str.trim()) {
      const tolerance = Math.max(line?.size || 0, size) * 0.45;
      const sameLine = line && !line.ended && Math.abs(y - line.y) <= tolerance && x >= line.x1 - Math.max(line.size, size) * 1.5;
      if (sameLine) {
        const gap = x - line.x1;
        if (gap > size * 0.12 && !line.text.endsWith(' ') && !str.startsWith(' ')) line.text += ' ';
        line.text += str;
        line.x1 = Math.max(line.x1, x + (item.width || 0));
        if (str.trim().length > line.mainLength) {
          line.size = size; // the line's size is that of its longest run (not of a footnote mark)
          line.mainLength = str.trim().length;
        }
      } else {
        line = { text: str, x0: x, x1: x + (item.width || 0), y, size, mainLength: str.trim().length, ended: false };
        lines.push(line);
      }
    }
    if (item.hasEOL && line) line.ended = true;
  }
  return lines
    .map(({ text, x0, x1, y, size }) => ({ text: text.trim(), x0, x1, y, size }))
    .filter((l) => l.text);
}

function normalized(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function inMargin(line, height) {
  return line.y > height * (1 - MARGIN) || line.y < height * MARGIN;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Document-wide measurements from a sample of pages ([{ lines, height }]): the body text size,
 * the usual distance between lines, and the running headers/footers to drop.
 */
export function documentStats(pages) {
  const sizes = [];
  for (const { lines } of pages) {
    for (const line of lines) for (let i = 0; i < Math.min(line.text.length, 200); i += 10) sizes.push(line.size);
  }
  const bodySize = median(sizes) || 10;

  const gaps = [];
  for (const { lines } of pages) {
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const line = lines[i];
      const gap = prev.y - line.y;
      if (gap > 0 && gap < bodySize * 3 && Math.abs(line.size - bodySize) < bodySize * 0.1 && Math.abs(prev.size - bodySize) < bodySize * 0.1) gaps.push(gap);
    }
  }
  const lineGap = median(gaps) || bodySize * 1.25;

  // Text that repeats in the margins of many pages: running titles, "Page # of #", footers.
  const counts = new Map();
  for (const { lines, height } of pages) {
    const seen = new Set();
    for (const line of lines) if (inMargin(line, height)) seen.add(normalized(line.text));
    for (const key of seen) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const boilerplate = new Set();
  if (pages.length >= 3) {
    for (const [key, count] of counts) if (count >= Math.max(3, pages.length * 0.3)) boilerplate.add(key);
  }

  // Words written with a hyphen inside a line ("attention-deficit"): when one of them is split at
  // its hyphen at the end of a line, the hyphen stays.
  const hyphenated = new Set();
  for (const { lines } of pages) {
    for (const line of lines) for (const word of line.text.match(COMPOUND) || []) hyphenated.add(word.toLowerCase());
  }
  return { bodySize, lineGap, boilerplate, hyphenated };
}

function isBoilerplate(line, height, stats) {
  if (!inMargin(line, height)) return false;
  return PAGE_NUMBER.test(line.text) || stats.boilerplate.has(normalized(line.text));
}

/** Right edge of each text column on a page, keyed by the column's left edge. */
function columnEdges(lines, bodySize) {
  const edges = new Map();
  for (const line of lines) {
    const key = Math.round(line.x0 / (bodySize * 4));
    edges.set(key, Math.max(edges.get(key) || 0, line.x1));
  }
  return (line) => edges.get(Math.round(line.x0 / (bodySize * 4))) || line.x1;
}

/**
 * Builds blocks page by page: addPage(lines, pageNumber, pageHeight) returns the blocks completed so
 * far, finish() the rest. A block is { type: 'p' | 'h2' | 'h3', text, anchors: [{ offset, page }] }:
 * anchors mark where in the text each page begins (a paragraph may run over a page break).
 */
export function createReflower(stats) {
  const { bodySize, lineGap } = stats;
  const done = [];
  let paragraph = null; // { block, last, lastPage, lastEdge }
  let heading = null; // { block, last, lastPage }

  const flush = () => {
    if (paragraph) done.push(paragraph.block);
    if (heading) done.push(heading.block);
    paragraph = null;
    heading = null;
  };

  function continues(prev, line, page) {
    if (BULLET.test(line.text)) return false;
    if (Math.abs(line.size - prev.last.size) > bodySize * 0.15) return false;
    const ended = SENTENCE_END.test(prev.last.text);
    const short = prev.last.x1 < prev.lastEdge - bodySize * 2;
    const below = prev.lastPage === page && line.y < prev.last.y;
    if (below) {
      if (prev.last.y - line.y > lineGap * 1.5) return false; // extra space between: a new paragraph
      const indented = line.x0 > prev.last.x0 + bodySize * 0.8 && line.x0 - prev.last.x0 < bodySize * 6;
      return !(ended && (short || indented));
    }
    // A new page or column: carry on unless the previous line clearly closed its paragraph.
    return !(ended && short);
  }

  const keepsHyphen = (before, after) => {
    const compound = `${before.match(LAST_PART)?.[0] || ''}${after.match(FIRST_PART)?.[0] || ''}`;
    return Boolean(stats.hyphenated?.has(compound.toLowerCase()));
  };

  function join(block, text, page, anchorHere) {
    if (block.text.endsWith('-') && LOWER_START.test(text) && keepsHyphen(block.text, text)) {
      if (anchorHere) block.anchors.push({ offset: block.text.length, page });
      block.text += text;
    } else if (SPLIT_WORD.test(block.text) && LOWER_START.test(text)) {
      if (anchorHere) block.anchors.push({ offset: block.text.length - 1, page });
      block.text = block.text.slice(0, -1) + text;
    } else {
      if (anchorHere) block.anchors.push({ offset: block.text.length + 1, page });
      block.text += ` ${text}`;
    }
  }

  function addPage(lines, page, height) {
    const edgeOf = columnEdges(lines, bodySize);
    let first = true;
    for (const line of lines) {
      if (isBoilerplate(line, height, stats)) continue;
      const anchorHere = first;
      first = false;

      if (line.size >= bodySize * 1.2 && line.text.length <= 160) {
        const type = line.size >= bodySize * 1.6 ? 'h2' : 'h3';
        const sameHeading =
          heading && heading.block.type === type && heading.lastPage === page && line.y < heading.last.y && heading.last.y - line.y < line.size * 1.8;
        if (sameHeading) {
          join(heading.block, line.text, page, anchorHere);
          heading.last = line;
          continue;
        }
        flush();
        heading = { block: { type, text: line.text, anchors: anchorHere ? [{ offset: 0, page }] : [] }, last: line, lastPage: page };
        continue;
      }

      const edge = edgeOf(line);
      if (heading || (paragraph && !continues(paragraph, line, page))) flush();
      if (!paragraph) {
        paragraph = { block: { type: 'p', text: line.text, anchors: anchorHere ? [{ offset: 0, page }] : [] }, last: line, lastPage: page, lastEdge: edge };
      } else {
        join(paragraph.block, line.text, page, anchorHere);
        Object.assign(paragraph, { last: line, lastPage: page, lastEdge: edge });
      }
    }
    return done.splice(0);
  }

  function finish() {
    flush();
    return done.splice(0);
  }

  return { addPage, finish };
}
