/*
 * The reading view shared by the reader overlay on web pages and the document viewer (PDF, EPUB,
 * FB2, TXT): a scrolling column with a progress bar, a toolbar, the article, bionic emphasis and the
 * user's font, spacing, theme and text size — all following the stored settings live.
 * Classic script; needs settings.js, bionic.js, engine.js, font-faces.js and typography.js.
 */
(function (root) {
  'use strict';

  const ns = root.ADHDR || (root.ADHDR = {});
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

  const THEMES = Object.freeze({
    light: { bg: '#fbfaf7', text: '#1d2125', muted: '#646b73', link: '#0b6b5d', line: '#e4e1d9', accent: '#0f7a69', code: '#f0eee8' },
    sepia: { bg: '#f4ecd8', text: '#3b2f1e', muted: '#7b6a50', link: '#8a4b0f', line: '#e0d3b6', accent: '#a5672b', code: '#ebe0c6' },
    dark: { bg: '#16181c', text: '#e2e4e8', muted: '#9aa1ab', link: '#5fd3bd', line: '#2c3037', accent: '#3cc4aa', code: '#22262c' },
  });
  const THEME_ORDER = ['light', 'sepia', 'dark'];
  const WORDS_PER_MINUTE = 200;
  const UI_FONT = '14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function resolveTheme(theme) {
    if (theme !== 'auto') return theme;
    return root.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** CSS custom properties of the reading theme, e.g. for pages around the view. */
  function themeVars(settings) {
    const theme = THEMES[resolveTheme(settings.readerTheme)];
    return `--bg: ${theme.bg}; --text: ${theme.text}; --muted: ${theme.muted}; --link: ${theme.link}; --line: ${theme.line}; --accent: ${theme.accent}; --code: ${theme.code};`;
  }

  function readingCss(settings) {
    const font = ns.fontStack(settings.font) || ns.FONT_STACKS.system;
    const lineHeight = settings.lineHeight > 100 ? settings.lineHeight / 100 : 1.7;
    const width = `calc(${settings.readerWidth}ch + 48px)`;
    return `
      :host { all: initial; }
      .reader {
        ${themeVars(settings)}
        position: fixed; inset: 0; overflow-y: auto; overscroll-behavior: contain;
        background: var(--bg); color: var(--text); color-scheme: ${resolveTheme(settings.readerTheme) === 'dark' ? 'dark' : 'light'};
        font-family: ${font}; font-size: ${settings.readerFontSize}px; line-height: ${lineHeight};
        letter-spacing: ${settings.letterSpacing / 100}em; word-spacing: ${settings.wordSpacing / 100}em;
        -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      }
      .reader:focus { outline: none; }
      .progress { position: sticky; top: 0; z-index: 3; height: 3px; }
      .progress-bar { height: 100%; width: 0; background: var(--accent); }
      .toolbar {
        position: sticky; top: 3px; z-index: 2; border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(8px);
        font: ${UI_FONT}; letter-spacing: normal; word-spacing: normal;
      }
      /* Same font and size as the article, so its ch-based width lines up with the text column. */
      .toolbar-inner { display: flex; align-items: center; gap: 12px; max-width: ${width}; margin: 0 auto; padding: 8px 24px; box-sizing: border-box; font-family: ${font}; font-size: ${settings.readerFontSize}px; }
      .toolbar-inner > * { font: ${UI_FONT}; }
      .site { flex: 1; min-width: 0; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
      .left { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .tools { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
      .tool {
        min-width: 34px; height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px;
        background: transparent; color: var(--text); font: inherit; cursor: pointer; white-space: nowrap;
      }
      .tool:hover { background: var(--line); }
      .tool[aria-pressed="true"] { background: var(--line); border-color: var(--accent); }
      .tool svg { display: block; width: 16px; height: 16px; margin: 0 auto; }
      .tool:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .article { max-width: ${width}; margin: 0 auto; padding: 40px 24px 40vh; box-sizing: border-box; }
      .title { margin: 0 0 0.4em; font-size: 1.7em; line-height: 1.25; font-weight: 700; }
      .meta { margin: 0 0 2em; color: var(--muted); font-size: 0.8em; }
      .meta:empty { display: none; }
      .content :is(h1, h2, h3, h4, h5, h6) { margin: 1.6em 0 0.6em; line-height: 1.3; }
      .content h1, .content h2 { font-size: 1.35em; }
      .content h3 { font-size: 1.15em; }
      .content :is(h4, h5, h6) { font-size: 1em; }
      .content :is(p, ul, ol, dl, blockquote, figure, pre, table) { margin: 0 0 1em; }
      .content li + li { margin-top: 0.3em; }
      .content a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
      .content img { display: block; max-width: 100%; height: auto; margin: 1em auto; border-radius: 4px; }
      .content figure { margin: 1.5em 0; }
      .content figcaption { color: var(--muted); font-size: 0.85em; text-align: center; }
      .content blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--line); }
      .content pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: var(--code); font-size: 0.85em; line-height: 1.5; white-space: pre-wrap; }
      .content :is(code, kbd, samp, pre) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: normal; word-spacing: normal; }
      .content :not(pre) > code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--code); font-size: 0.9em; }
      .content table { display: block; overflow-x: auto; border-collapse: collapse; }
      .content :is(td, th) { padding: 6px 10px; border: 1px solid var(--line); }
      .content hr { margin: 2em 0; border: 0; border-top: 1px solid var(--line); }
    `;
  }

  function themeIcon(doc) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const ring = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [name, value] of Object.entries({ cx: '8', cy: '8', r: '6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' })) ring.setAttribute(name, value);
    const half = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    half.setAttribute('d', 'M8 2a6 6 0 0 1 0 12z');
    half.setAttribute('fill', 'currentColor');
    svg.append(ring, half);
    return svg;
  }

  function countWords(text) {
    return (String(text).match(/\S+/g) || []).length;
  }

  /**
   * Builds a reading view inside `container` (a shadow root or document.body).
   * Options: doc, container, styleTarget (shadow root or document that receives the stylesheet),
   * settings, site, lang, dir, extraCss, tools ([{ action, label, title }] shown before the
   * standard ones), onAction(action, button), onClose (shows a close button and handles Esc),
   * onScroll(progress), onSettings(settings).
   */
  function createReadingView(options) {
    const { doc, container, styleTarget } = options;
    let settings = options.settings;
    let words = 0;
    let statusFormatter = null;

    const h = (tag, attributes = {}, ...children) => {
      const el = doc.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null) el.setAttribute(name, value);
      el.append(...children);
      return el;
    };
    const tool = ({ action, label, title }) => h('button', { class: 'tool', type: 'button', 'data-action': action, title, 'aria-label': title }, label);

    const sheet = new doc.defaultView.CSSStyleSheet();
    const applyCss = () => sheet.replaceSync(readingCss(settings) + (options.extraCss || ''));
    applyCss();
    styleTarget.adoptedStyleSheets = [...styleTarget.adoptedStyleSheets, sheet];

    const bar = h('div', { class: 'progress-bar' });
    const left = h('span', { class: 'left' });
    const site = h('span', { class: 'site' }, options.site || '');
    const tools = h(
      'div',
      { class: 'tools' },
      ...(options.tools || []).map(tool),
      tool({ action: 'smaller', label: 'A−', title: t('readerSmaller') }),
      tool({ action: 'larger', label: 'A+', title: t('readerLarger') }),
      tool({ action: 'theme', label: themeIcon(doc), title: t('readerTheme') }),
      ...(options.onClose ? [tool({ action: 'close', label: '✕', title: t('readerClose') })] : []),
    );
    const titleEl = h('h1', { class: 'title' });
    const metaEl = h('p', { class: 'meta' });
    const content = h('div', { class: 'content' });
    const article = h('article', { class: 'article' }, titleEl, metaEl, content);
    const toolbar = h('div', { class: 'toolbar', [ns.UI_ATTRIBUTE]: 'toolbar' }, h('div', { class: 'toolbar-inner' }, site, left, tools));
    const scroller = h(
      'div',
      { class: 'reader', tabindex: '-1', role: 'document', lang: options.lang || undefined, dir: options.dir || 'auto' },
      h('div', { class: 'progress', 'aria-hidden': 'true' }, bar),
      toolbar,
      article,
    );
    container.append(scroller);

    const engine = ns.createBionicEngine();
    const applySettings = (next) => {
      settings = next;
      applyCss();
      scroller.dataset.theme = resolveTheme(next.readerTheme);
      if (ns.fontStack(next.font) && !['system', 'serif'].includes(next.font)) ns.ensureFontFaces(doc);
      engine.update(next.enabled && next.bionic ? next : null, scroller);
      options.onSettings?.(next);
      updateProgress();
    };

    function progress() {
      const max = scroller.scrollHeight - scroller.clientHeight;
      return max > 0 ? Math.min(1, scroller.scrollTop / max) : 1;
    }

    function updateProgress() {
      const p = progress();
      bar.style.width = `${(p * 100).toFixed(1)}%`;
      const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
      const remaining = Math.max(1, Math.ceil(minutes * (1 - p)));
      const time = p >= 0.99 ? t('readerDone') : t('readerMinutesLeft', [String(remaining)]);
      left.textContent = statusFormatter ? statusFormatter(p, time) : time;
      return p;
    }

    const onScroll = () => {
      const p = updateProgress();
      options.onScroll?.(p);
      ns.refreshOverlay?.();
    };
    const onClick = async (event) => {
      const button = event.target.closest?.('[data-action]');
      const action = button?.dataset.action;
      if (!action) return;
      const current = await ns.loadSettings();
      if (action === 'close') options.onClose?.();
      else if (action === 'smaller') ns.saveSettings({ readerFontSize: current.readerFontSize - 2 });
      else if (action === 'larger') ns.saveSettings({ readerFontSize: current.readerFontSize + 2 });
      else if (action === 'theme') {
        const now = resolveTheme(current.readerTheme);
        ns.saveSettings({ readerTheme: THEME_ORDER[(THEME_ORDER.indexOf(now) + 1) % THEME_ORDER.length] });
      } else options.onAction?.(action, button);
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && options.onClose) {
        event.stopPropagation();
        event.preventDefault();
        options.onClose();
      }
    };
    const onCopy = (event) => {
      const selection = container.getSelection ? container.getSelection() : doc.getSelection();
      ns.cleanCopy(event, selection, doc);
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    toolbar.addEventListener('click', onClick);
    doc.defaultView.addEventListener('keydown', onKey, true);
    container.addEventListener('copy', onCopy);
    const unsubscribe = ns.onSettingsChanged(applySettings);
    applySettings(settings);

    return {
      scroller,
      article,
      content,
      toolbar,
      engine,
      get settings() {
        return settings;
      },
      setSite(text) {
        site.textContent = text || '';
      },
      setTitle(text) {
        titleEl.textContent = text || '';
      },
      setMeta(text) {
        metaEl.textContent = text || '';
      },
      setWords(count) {
        words = count;
        updateProgress();
      },
      addWords(text) {
        words += countWords(text);
        updateProgress();
      },
      setStatusFormatter(formatter) {
        statusFormatter = formatter;
        updateProgress();
      },
      setLang(lang) {
        if (lang) scroller.setAttribute('lang', lang);
      },
      progress,
      refresh: updateProgress,
      scrollToProgress(p) {
        scroller.scrollTop = p * (scroller.scrollHeight - scroller.clientHeight);
        updateProgress();
      },
      focus() {
        scroller.focus({ preventScroll: true });
      },
      button(action) {
        return tools.querySelector(`[data-action="${action}"]`);
      },
      destroy() {
        engine.update(null);
        unsubscribe();
        doc.defaultView.removeEventListener('keydown', onKey, true);
        container.removeEventListener('copy', onCopy);
        styleTarget.adoptedStyleSheets = styleTarget.adoptedStyleSheets.filter((s) => s !== sheet);
        scroller.remove();
      },
    };
  }

  ns.READING_THEMES = THEMES;
  ns.resolveTheme = resolveTheme;
  ns.themeVars = themeVars;
  ns.countWords = countWords;
  ns.createReadingView = createReadingView;
})(globalThis);
