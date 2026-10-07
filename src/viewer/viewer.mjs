/*
 * Document viewer: opens PDF, EPUB, FB2 and TXT files (from a link: ?file=<url>, or from the
 * computer: file picker / drag and drop) in the reading view, where bionic emphasis, fonts,
 * spacing, themes, tint and focus all work. Remembers where you stopped reading.
 */
import { loadPdf, pdfInfo, pdfOutline, createPdfPresenter } from './pdf.mjs';
import { detectKind, parseBook } from './books.mjs';

const ADHDR = globalThis.ADHDR;
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

const POSITIONS_KEY = 'positions';
const MAX_POSITIONS = 60;
const SCANNED_CHARS_PER_PAGE = 30;
const KIND_LABELS = { pdf: 'PDF', epub: 'EPUB', fb2: 'FB2', txt: 'TXT' };

// Extra styles for the reading view (added to its stylesheet, so the theme variables apply).
const VIEWER_CSS = `
  .article.pages-mode { max-width: none; padding: 20px 12px 40vh; }
  .pages-mode > .title, .pages-mode > .meta { max-width: 900px; margin-left: auto; margin-right: auto; }
  .pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .pdf-page { position: relative; flex: none; background: #fff; box-shadow: 0 1px 6px rgb(0 0 0 / 0.18); }
  .pdf-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .reader[data-theme="dark"] .pdf-page { background: #111; }
  .reader[data-theme="dark"] .pdf-page canvas { filter: invert(0.9) hue-rotate(180deg); }
  .reader[data-theme="sepia"] .pdf-page canvas { filter: sepia(0.3) brightness(0.97); }
  .textLayer {
    position: absolute; inset: 0; overflow: clip; opacity: 1; line-height: 1; text-align: initial;
    letter-spacing: normal; word-spacing: normal; -webkit-text-size-adjust: none; text-size-adjust: none;
    forced-color-adjust: none; transform-origin: 0 0; caret-color: CanvasText; z-index: 0;
    --min-font-size: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }
  .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
  .textLayer > :not(.markedContent), .textLayer .markedContent span:not(.markedContent) {
    z-index: 1; --font-height: 0; font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1; --rotate: 0deg; transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .textLayer .markedContent { display: contents; }
  .textLayer ::selection { background: rgb(0 90 255 / 0.25); }
  .textLayer br::selection { background: transparent; }
  .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
  .page-break { margin: 1.8em 0 1.2em; color: var(--muted); font: 12px/1 system-ui, sans-serif; letter-spacing: 0.2em; text-align: center; }
  .page-break::before { content: "— "; }
  .page-break::after { content: " —"; }
  .viewer-notice, .viewer-error {
    margin: 0 0 1.5em; padding: 12px 16px; border-radius: 10px; font: 14px/1.5 system-ui, sans-serif;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .viewer-error { background: color-mix(in srgb, #d04040 14%, transparent); }
  .viewer-notice button, .viewer-error button {
    margin: 8px 8px 0 0; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--text); font: inherit; cursor: pointer;
  }
  .book-section + .book-section { margin-top: 3em; padding-top: 2em; border-top: 1px solid var(--line); }
  .book-section > h1:first-child, .book-section > h2:first-child { margin-top: 0; }
  .poem p { margin: 0 0 0.2em; } .poem { margin: 1em 0 1em 1.5em; font-style: italic; }
  .epigraph { margin: 1em 0 1.5em 30%; font-style: italic; color: var(--muted); }
  .notes { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--line); font-size: 0.85em; }
  .toc {
    position: fixed; top: 0; bottom: 0; left: 0; z-index: 4; width: min(360px, 86vw); box-sizing: border-box;
    overflow-y: auto; padding: 18px 14px; background: var(--bg); color: var(--text); border-right: 1px solid var(--line);
    box-shadow: 4px 0 28px rgb(0 0 0 / 0.14); font: 14px/1.4 system-ui, sans-serif; letter-spacing: normal; word-spacing: normal;
  }
  .toc h2 { margin: 2px 8px 12px; color: var(--muted); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
  .toc button { display: block; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .toc button:hover, .toc button:focus-visible { background: var(--line); outline: none; }
  .toc button[data-level="2"] { padding-left: 22px; }
  .toc button[data-level="3"] { padding-left: 36px; font-size: 13px; }
  .resume {
    position: fixed; left: 50%; bottom: 24px; z-index: 4; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; border-radius: 12px; background: var(--text); color: var(--bg); box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
    font: 14px/1.4 system-ui, sans-serif;
  }
  .resume button { padding: 4px 10px; border: 1px solid currentColor; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
`;

const state = {
  settings: await ADHDR.loadSettings(),
  view: null,
  presenter: null,
  cleanup: null,
  toc: null,
  key: null,
  source: null, // { url, name, kind }
};

const overlay = ADHDR.createOverlay(document);
ADHDR.refreshOverlay = () => overlay.refresh();

localizeStatic();
applyPageTheme();
overlay.update(state.settings.enabled ? state.settings : null);
ADHDR.onSettingsChanged((next) => {
  state.settings = next;
  applyPageTheme();
  overlay.update(next.enabled ? next : null);
});
setupFilePicking();
window.addEventListener('pagehide', () => state.view && rememberPosition(state.view));

const fileUrl = new URLSearchParams(location.search).get('file');
if (fileUrl) openUrl(fileUrl);
else showWelcome();

// --- page chrome ----------------------------------------------------------------------------------

function localizeStatic() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function applyPageTheme() {
  document.body.setAttribute('style', ADHDR.themeVars(state.settings));
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function setupFilePicking() {
  const input = document.getElementById('file-input');
  document.getElementById('choose').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) openFile(input.files[0]);
    input.value = '';
  });
  let depth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    depth++;
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('is-dragging');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    depth = 0;
    document.body.classList.remove('is-dragging');
    if (!file) return;
    event.preventDefault();
    openFile(file);
  });
}

// --- welcome screen -------------------------------------------------------------------------------

async function showWelcome(note) {
  closeDocument();
  document.title = 'ADHD Reader';
  const welcome = document.getElementById('welcome');
  welcome.hidden = false;
  const noteEl = document.getElementById('welcome-note');
  noteEl.hidden = !note;
  noteEl.textContent = note || '';

  const positions = Object.entries(await readPositions()).sort((a, b) => b[1].at - a[1].at);
  const list = document.getElementById('recent-list');
  list.replaceChildren();
  for (const [, entry] of positions.slice(0, 12)) {
    const meta = [KIND_LABELS[entry.kind], `${Math.round((entry.progress || 0) * 100)}%`, new Date(entry.at).toLocaleDateString()].filter(Boolean).join(' · ');
    const button = el('button', { type: 'button' }, el('span', { class: 'recent-title' }, entry.title || entry.name || '—'), el('span', { class: 'recent-meta' }, meta));
    button.addEventListener('click', () => {
      if (entry.url) location.href = `${location.pathname}?file=${encodeURIComponent(entry.url)}`;
      else {
        showWelcome(t('viewerPickAgain', [entry.name || entry.title]));
        document.getElementById('file-input').click();
      }
    });
    list.append(el('li', {}, button));
  }
  document.getElementById('recent').hidden = positions.length === 0;
}

// --- opening documents ----------------------------------------------------------------------------

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname);
    return last || url;
  } catch {
    return url;
  }
}

function withoutExtension(name) {
  return name.replace(/\.(pdf|epub|fb2(\.zip)?|zip|txt)$/i, '');
}

async function openUrl(url) {
  const name = fileNameFromUrl(url);
  let site = '';
  try {
    site = url.startsWith('file:') ? t('localFiles') : new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep empty
  }
  const view = startView({ site, url });
  view.setTitle(withoutExtension(name));
  setLoading(view, t('viewerDownloading'));
  try {
    const bytes = await fetchBytes(url, (loaded, total) => {
      if (total) setLoading(view, t('viewerDownloadingPercent', [String(Math.round((loaded / total) * 100))]));
    });
    await openBytes(view, bytes, { name, url });
  } catch (error) {
    await showError(view, error, url);
  }
}

async function openFile(file) {
  history.replaceState(null, '', location.pathname);
  const view = startView({ site: t('localFiles') });
  view.setTitle(withoutExtension(file.name));
  setLoading(view, t('viewerOpening'));
  try {
    await openBytes(view, new Uint8Array(await file.arrayBuffer()), { name: file.name });
  } catch (error) {
    await showError(view, error, null);
  }
}

async function fetchBytes(url, onProgress) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    if (url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) throw new Error(t('noticeFileAccess'));
    throw error;
  }
  if (!response.ok) throw new Error(t('viewerHttpError', [String(response.status)]));
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function openBytes(view, bytes, { name, url }) {
  const kind = detectKind(bytes, name);
  if (!kind) throw new Error(t('viewerUnsupported'));
  state.key = url ? url.split('#')[0] : `file:${name}:${bytes.byteLength}`;
  state.source = { url: url || null, name, kind };
  view.button('original').hidden = !url;
  if (kind === 'pdf') await showPdf(view, bytes, name);
  else await showBook(view, kind, bytes, name);
  await restorePosition(view);
  view.scroller.addEventListener('scroll', throttle(() => rememberPosition(view), 1000), { passive: true });
}

function startView({ site, url }) {
  closeDocument();
  document.getElementById('welcome').hidden = true;
  const view = ADHDR.createReadingView({
    doc: document,
    container: document.body,
    styleTarget: document,
    settings: state.settings,
    site,
    extraCss: VIEWER_CSS,
    tools: [
      { action: 'toc', label: '☰', title: t('viewerContents') },
      { action: 'mode', label: t('viewerPagesMode'), title: t('viewerModeHint') },
      { action: 'original', label: '↗', title: t('viewerOriginal') },
      { action: 'open', label: '📂', title: t('viewerOpenFile') },
    ],
    onAction: (action) => onToolbarAction(view, action, url),
  });
  view.button('toc').hidden = true;
  view.button('mode').hidden = true;
  view.button('original').hidden = !url;
  state.view = view;
  view.focus();
  return view;
}

function closeDocument() {
  state.presenter?.destroy();
  state.cleanup?.();
  state.toc?.remove();
  state.view?.destroy();
  document.querySelector('.resume')?.remove();
  Object.assign(state, { view: null, presenter: null, cleanup: null, toc: null, key: null, source: null });
}

function setLoading(view, text) {
  view.setStatusFormatter(() => text);
}

async function showError(view, error, url) {
  console.warn('ADHD Reader viewer:', error);
  const box = el('div', { class: 'viewer-error', role: 'alert' }, el('div', {}, error?.message || String(error)));
  if (url) {
    const original = el('button', { type: 'button' }, t('viewerOriginal'));
    original.addEventListener('click', () => openOriginal(url));
    box.append(original);
  }
  const choose = el('button', { type: 'button' }, t('viewerChoose'));
  choose.addEventListener('click', () => document.getElementById('file-input').click());
  box.append(choose);
  view.content.replaceChildren(box);
  view.setStatusFormatter(() => '');
}

function notice(view, text) {
  view.content.prepend(el('div', { class: 'viewer-notice', [ADHDR.UI_ATTRIBUTE]: 'notice', role: 'status' }, text));
}

function onToolbarAction(view, action, url) {
  if (action === 'open') document.getElementById('file-input').click();
  else if (action === 'original' && url) openOriginal(url);
  else if (action === 'toc') toggleToc();
  else if (action === 'mode' && state.presenter) {
    const next = state.presenter.mode === 'text' ? 'pages' : 'text';
    updateModeButton(view, next);
    state.presenter.setMode(next);
  }
}

function openOriginal(url) {
  chrome.runtime.sendMessage({ type: 'openOriginal', url });
}

function updateModeButton(view, mode) {
  const button = view.button('mode');
  button.textContent = mode === 'text' ? t('viewerPagesMode') : t('viewerTextMode');
  button.setAttribute('aria-pressed', String(mode === 'pages'));
}

// --- PDF -------------------------------------------------------------------------------------------

async function showPdf(view, bytes, name) {
  const pdf = await loadPdf(bytes, async (wrong) => prompt(t(wrong ? 'viewerPasswordWrong' : 'viewerPassword')));
  const { title, author, lang } = await pdfInfo(pdf);
  const showTitle = (text) => {
    view.setTitle(text);
    document.title = `${text} — ADHD Reader`;
  };
  showTitle(title || withoutExtension(name));
  view.setLang(lang);
  view.setMeta([author, t('viewerPdfMeta', [String(pdf.numPages)])].filter(Boolean).join(' · '));

  let loading = t('viewerOpening');
  const presenter = createPdfPresenter(pdf, view, {
    progress: (page, total) => {
      loading = t('viewerPreparing', [String(page), String(total)]);
      view.refresh();
    },
    done: () => {
      loading = null;
      view.refresh();
    },
    title: showTitle,
  }, { title });
  state.presenter = presenter;
  view.setStatusFormatter((p, time) => loading || `${t('viewerPage', [String(presenter.currentPage()), String(presenter.pageCount)])} · ${time}`);

  const modeButton = view.button('mode');
  modeButton.hidden = false;
  updateModeButton(view, 'text');
  const result = await presenter.setMode('text');
  if (result && result.chars / pdf.numPages < SCANNED_CHARS_PER_PAGE) {
    updateModeButton(view, 'pages');
    await presenter.setMode('pages');
    notice(view, t('viewerScanned'));
  }

  const outline = await pdfOutline(pdf);
  if (outline.length) setToc(outline.map((item) => ({ ...item, go: () => presenter.goToBookmark(item.label, item.page) })));
}

// --- e-books ---------------------------------------------------------------------------------------

async function showBook(view, kind, bytes, name) {
  const book = await parseBook(kind, bytes, { name, doc: document });
  state.cleanup = book.cleanup;
  view.setTitle(book.title || withoutExtension(name));
  document.title = `${book.title || withoutExtension(name)} — ADHD Reader`;
  view.setMeta([book.author, KIND_LABELS[kind]].filter(Boolean).join(' · '));
  view.setLang(book.lang);
  let words = 0;
  for (const section of book.sections) {
    view.content.append(section);
    words += ADHDR.countWords(section.textContent);
  }
  view.setWords(words);
  view.setStatusFormatter((p, time) => `${Math.round(p * 100)}% · ${time}`);
  if (book.toc.length) {
    setToc(
      book.toc.map((item) => ({
        ...item,
        go: () => {
          const target = document.getElementById(item.id);
          if (target) view.scroller.scrollTop += target.getBoundingClientRect().top - view.scroller.getBoundingClientRect().top - 70;
        },
      })),
    );
  }
}

// --- table of contents -----------------------------------------------------------------------------

function setToc(items) {
  state.view.button('toc').hidden = false;
  const nav = el('nav', { class: 'toc', [ADHDR.UI_ATTRIBUTE]: 'toc', 'aria-label': t('viewerContents') }, el('h2', {}, t('viewerContents')));
  for (const item of items) {
    const button = el('button', { type: 'button', 'data-level': String(Math.min(3, item.level || 1)) }, item.label);
    button.addEventListener('click', () => {
      item.go();
      toggleToc(false);
    });
    nav.append(button);
  }
  nav.hidden = true;
  nav.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleToc(false);
  });
  state.toc = nav;
  // Inside the reading view's scroller so the view's stylesheet (theme colours) applies.
  state.view.scroller.append(nav);
}

function toggleToc(show) {
  if (!state.toc) return;
  const open = show ?? state.toc.hidden;
  state.toc.hidden = !open;
  state.view.button('toc').setAttribute('aria-pressed', String(open));
  if (open) state.toc.querySelector('button')?.focus();
}

// --- reading position ------------------------------------------------------------------------------

async function readPositions() {
  try {
    return (await chrome.storage.local.get(POSITIONS_KEY))[POSITIONS_KEY] || {};
  } catch {
    return {};
  }
}

async function rememberPosition(view) {
  if (!state.key || view !== state.view) return;
  const all = await readPositions();
  all[state.key] = {
    title: view.article.querySelector('.title')?.textContent || state.source?.name,
    name: state.source?.name,
    url: state.source?.url,
    kind: state.source?.kind,
    progress: view.progress(),
    page: state.presenter?.currentPage(),
    at: Date.now(),
  };
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const key of keys.slice(MAX_POSITIONS)) delete all[key];
  await chrome.storage.local.set({ [POSITIONS_KEY]: all });
}

async function restorePosition(view) {
  const saved = (await readPositions())[state.key];
  if (!saved || !(saved.progress > 0.02) || saved.progress > 0.98) return;
  if (saved.page && state.presenter) state.presenter.goToPage(saved.page);
  else view.scrollToProgress(saved.progress);
  const banner = el(
    'div',
    { class: 'resume', role: 'status', [ADHDR.UI_ATTRIBUTE]: 'resume' },
    el('span', {}, saved.page ? t('viewerResumedPage', [String(saved.page)]) : t('viewerResumed')),
  );
  const fromStart = el('button', { type: 'button' }, t('viewerFromStart'));
  fromStart.addEventListener('click', () => {
    view.scroller.scrollTop = 0;
    banner.remove();
  });
  banner.append(fromStart);
  view.scroller.append(banner);
  setTimeout(() => banner.remove(), 8000);
}

function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
