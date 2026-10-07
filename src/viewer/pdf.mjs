/*
 * PDF support for the document viewer (pdf.js). Two ways to show a PDF:
 *   text  — the text extracted and reflowed into paragraphs (reflow.mjs), so bionic emphasis,
 *           fonts, spacing, themes and focus all work, like on any web page;
 *   pages — the original pages drawn on canvases (figures, tables, layout), with a selectable
 *           text layer, rendered lazily as they scroll into view.
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { pageLines, documentStats, createReflower } from './reflow.mjs';

const ADHDR = globalThis.ADHDR;
const asset = (path) => new URL(`../vendor/pdfjs/${path}`, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

const SAMPLE_PAGES = 24; // pages measured up front for body size, line spacing and running headers
const SCANNED_CHARS_PER_PAGE = 30; // less text than this per page: probably a scan without a text layer
const MAX_PAGE_WIDTH = 1100;

/** Opens PDF bytes. `askPassword(wrong)` resolves to a password, or null to give up. */
export async function loadPdf(bytes, askPassword) {
  const task = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    isEvalSupported: false,
    enableXfa: false,
  });
  task.onPassword = async (update, reason) => {
    const password = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (password === null) task.destroy();
    else update(password);
  };
  return task.promise;
}

const PLACEHOLDER_TITLE = /^(untitled\b.*|microsoft (word|powerpoint) - .*|.+\.(docx?|pptx?|xlsx?|odt|pdf|tex|dvi)|about:blank|(https?|file):.*)$/i;

/** Title (the placeholders PDF makers write instead of one are skipped), author and language. */
export async function pdfInfo(pdf) {
  let info = {};
  try {
    info = (await pdf.getMetadata()).info || {};
  } catch {
    // no metadata
  }
  const title = String(info.Title || '').trim();
  return {
    title: title && !PLACEHOLDER_TITLE.test(title) ? title : '',
    author: String(info.Author || '').trim(),
    lang: String(info.Language || '').trim(),
  };
}

/** The PDF's bookmarks as [{ label, page, level }]. */
export async function pdfOutline(pdf) {
  const result = [];
  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    return result;
  }
  const walk = async (items, level) => {
    for (const item of items || []) {
      let page = null;
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
      } catch {
        // broken destination: keep the entry without a target
      }
      if (item.title?.trim()) result.push({ label: item.title.trim(), page, level });
      if (level < 3) await walk(item.items, level + 1);
    }
  };
  await walk(outline, 1);
  return result;
}

const words = (text) => text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase(); // (\W only knows Latin)
const sameText = (a, b) => words(a) !== '' && words(a) === words(b);

/** For PDFs without a title in their metadata: the first-page heading in the largest type. */
function guessTitle(blocks) {
  const headings = blocks.filter((block) => block.type !== 'p' && words(block.text).length >= 3 && block.text.length <= 200);
  return headings.find((block) => block.type === 'h2') || headings[0] || null;
}

/**
 * Shows `pdf` inside the reading view. `ui` provides: progress(page, total), done() and title(text)
 * (called when the title had to be guessed from the first page). `title` is the document's title,
 * shown above the text, so the first-page heading repeating it is left out.
 * Returns a controller: { mode, setMode(mode), currentPage(), goToPage(n), goToBookmark(label, page),
 * pageCount, destroy() }.
 */
export function createPdfPresenter(pdf, view, ui, { title = '' } = {}) {
  const doc = view.content.ownerDocument;
  const pageCount = pdf.numPages;
  let mode = null;
  let generation = 0; // bumps on every mode switch so stale async work stops
  let anchors = []; // text mode: page anchors in document order
  let pageBoxes = []; // pages mode: one box per page
  let observer = null;
  let textDone = null; // resolves with { chars } once the whole text has been laid out

  const el = (tag, attributes = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  };

  async function extractPage(number) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const [x0, y0, x1, y1] = page.view;
    const lines = pageLines(content.items).map((line) => ({ ...line, y: line.y - y0, x0: line.x0 - x0, x1: line.x1 - x0 }));
    page.cleanup();
    return { lines, height: y1 - y0, width: x1 - x0 };
  }

  /** A block's text with an anchor <span> wherever a page begins inside it. */
  function blockElement(block) {
    const node = el(block.type);
    let pos = 0;
    for (const anchor of block.anchors) {
      if (anchor.offset > pos) node.append(block.text.slice(pos, anchor.offset));
      const mark = el('span', { class: 'page-anchor', 'data-page': String(anchor.page) });
      node.append(mark);
      anchors.push(mark);
      pos = anchor.offset;
    }
    node.append(block.text.slice(pos));
    return node;
  }

  let titleDropped = false;
  let pageAt = 1; // text mode: the page the next block starts on

  function appendBlocks(container, blocks) {
    const fragment = doc.createDocumentFragment();
    for (const block of blocks) {
      if (block.anchors[0]?.offset === 0) pageAt = block.anchors[0].page;
      const startPage = pageAt;
      if (block.anchors.length) pageAt = block.anchors[block.anchors.length - 1].page;
      if (!titleDropped && startPage === 1 && block.type !== 'p' && sameText(block.text, title)) {
        // The title is already shown above the text. Keep the block's page anchors.
        titleDropped = true;
        for (const anchor of block.anchors) fragment.append(blockElement({ type: 'span', text: '', anchors: [{ ...anchor, offset: 0 }] }));
        continue;
      }
      if (block.anchors[0]?.offset === 0 && block.anchors[0].page > 1) {
        fragment.append(el('div', { class: 'page-break', [ADHDR.UI_ATTRIBUTE]: 'page-break', 'aria-hidden': 'true' }, String(block.anchors[0].page)));
      }
      const node = blockElement(block);
      node.dataset.page = String(startPage);
      fragment.append(node);
      view.addWords(block.text);
    }
    container.append(fragment);
  }

  async function renderText(run) {
    const container = el('div', { class: 'pdf-text' });
    view.article.classList.remove('pages-mode');
    view.content.replaceChildren(container);
    anchors = [];
    titleDropped = false;
    pageAt = 1;
    view.setWords(0);

    const sample = [];
    const sampleSize = Math.min(pageCount, SAMPLE_PAGES);
    for (let n = 1; n <= sampleSize; n++) {
      sample.push(await extractPage(n));
      if (run !== generation) return null;
      ui.progress(n, pageCount);
    }
    const reflower = createReflower(documentStats(sample));
    let chars = 0;
    for (let n = 1; n <= pageCount; n++) {
      const page = n <= sampleSize ? sample[n - 1] : await extractPage(n);
      if (run !== generation) return null;
      for (const line of page.lines) chars += line.text.length;
      const blocks = reflower.addPage(page.lines, n, page.height);
      if (n === 1 && !title) {
        title = guessTitle(blocks)?.text || '';
        if (title) ui.title?.(title);
      }
      appendBlocks(container, blocks);
      if (n > sampleSize) ui.progress(n, pageCount);
      if (n % 8 === 0) await new Promise((resolve) => setTimeout(resolve)); // let the page breathe
    }
    appendBlocks(container, reflower.finish());
    ui.done();
    return { chars };
  }

  async function renderPages(run) {
    const container = el('div', { class: 'pdf-pages', [ADHDR.UI_ATTRIBUTE]: 'pages' });
    view.article.classList.add('pages-mode');
    view.content.replaceChildren(container);
    pageBoxes = [];
    const available = Math.min(MAX_PAGE_WIDTH, Math.max(320, view.article.clientWidth - 24));
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      if (run !== generation) return;
      const base = page.getViewport({ scale: 1 });
      const scale = available / base.width;
      const box = el('div', { class: 'pdf-page', 'data-page': String(n) });
      box.style.width = `${Math.floor(base.width * scale)}px`;
      box.style.height = `${Math.floor(base.height * scale)}px`;
      box.pdfScale = scale;
      pageBoxes.push(box);
      container.append(box);
      ui.progress(n, pageCount);
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) drawPage(entry.target, run);
      },
      { root: view.scroller, rootMargin: '1200px 0px' },
    );
    for (const box of pageBoxes) observer.observe(box);
    ui.done();
  }

  async function drawPage(box, run) {
    if (box.drawn) return;
    box.drawn = true;
    observer?.unobserve(box);
    const page = await pdf.getPage(Number(box.dataset.page));
    if (run !== generation) return;
    const viewport = page.getViewport({ scale: box.pdfScale });
    const ratio = doc.defaultView.devicePixelRatio || 1;
    const canvas = el('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const layer = el('div', { class: 'textLayer' });
    layer.style.setProperty('--total-scale-factor', String(box.pdfScale));
    box.append(canvas, layer);
    try {
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      await new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') console.warn('ADHD Reader: page render failed', error);
    }
  }

  function currentPage() {
    const top = view.scroller.getBoundingClientRect().top + view.scroller.clientHeight * 0.3;
    const list = mode === 'pages' ? pageBoxes : anchors;
    let lo = 0;
    let hi = list.length - 1;
    let found = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].getBoundingClientRect().top <= top) {
        found = Number(list[mid].dataset.page);
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  function scrollToNode(node) {
    const offset = node.getBoundingClientRect().top - view.scroller.getBoundingClientRect().top;
    view.scroller.scrollTop += offset - 70;
  }

  function goToPage(number) {
    const list = mode === 'pages' ? pageBoxes : anchors;
    const target = list.find((node) => Number(node.dataset.page) >= number) || list[list.length - 1];
    if (target) scrollToNode(target);
  }

  /** A bookmark: in the text, the heading with its title (bookmarks rarely point at the line), else its page. */
  function goToBookmark(label, page) {
    if (mode === 'text') {
      const headings = [...view.content.querySelectorAll('h2, h3')].filter((h) => sameText(h.textContent, label));
      const heading = headings.find((h) => !page || Number(h.dataset.page) >= page - 1) || headings[0];
      if (heading) {
        scrollToNode(heading);
        return;
      }
    }
    if (page) goToPage(page);
  }

  async function setMode(next) {
    if (next === mode) return textDone;
    const page = mode ? currentPage() : null;
    mode = next;
    const run = ++generation;
    observer?.disconnect();
    observer = null;
    if (next === 'text') {
      textDone = renderText(run);
      const result = await textDone;
      if (page > 1 && run === generation) goToPage(page);
      return result;
    }
    await renderPages(run);
    if (page > 1 && run === generation) goToPage(page);
    return null;
  }

  return {
    get mode() {
      return mode;
    },
    setMode,
    currentPage,
    goToPage,
    goToBookmark,
    pageCount,
    destroy() {
      generation++;
      observer?.disconnect();
      pdf.destroy();
    },
  };
}
