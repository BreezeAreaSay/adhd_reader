/*
 * Reader view: extracts the main text of the page with Mozilla Readability and shows it in a calm,
 * distraction-free overlay with bionic emphasis, the user's font and spacing, a theme, a progress
 * bar and the time left. Injected on demand by the background worker (with src/vendor/Readability.js).
 */
(() => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  if (ADHDR.reader) {
    ADHDR.reader.toggle();
    return;
  }

  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

  const THEMES = {
    light: { bg: '#fbfaf7', text: '#1d2125', muted: '#646b73', link: '#0b6b5d', line: '#e4e1d9', accent: '#0f7a69', code: '#f0eee8' },
    sepia: { bg: '#f4ecd8', text: '#3b2f1e', muted: '#7b6a50', link: '#8a4b0f', line: '#e0d3b6', accent: '#a5672b', code: '#ebe0c6' },
    dark: { bg: '#16181c', text: '#e2e4e8', muted: '#9aa1ab', link: '#5fd3bd', line: '#2c3037', accent: '#3cc4aa', code: '#22262c' },
  };
  const THEME_ORDER = ['light', 'sepia', 'dark'];
  const WORDS_PER_MINUTE = 200;
  const MIN_ARTICLE_CHARS = 140; // same threshold as Readability's isProbablyReaderable

  // What the article may contain after cleaning. Anything else is unwrapped (kept as its text) or,
  // for active/embedded content, dropped.
  const KEEP = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre',
    'code', 'kbd', 'samp', 'var', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub',
    'sup', 'abbr', 'cite', 'q', 'time', 'br', 'hr', 'img', 'picture', 'source', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'div', 'span', 'section', 'article',
    'details', 'summary',
  ]);
  const DROP = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form',
    'input', 'button', 'select', 'textarea', 'svg', 'math', 'canvas', 'video', 'audio', 'link', 'meta',
  ]);
  const ATTRIBUTES = {
    '*': ['lang', 'dir', 'title'],
    a: ['href'],
    img: ['src', 'srcset', 'alt', 'width', 'height'],
    source: ['srcset', 'type', 'media'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed', 'type'],
    time: ['datetime'],
    blockquote: ['cite'],
    q: ['cite'],
    details: ['open'],
  };
  const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'cite']);

  let state = null;

  ADHDR.reader = { toggle, open, close, isOpen: () => state !== null };
  toggle();

  function toggle() {
    if (state) close();
    else open();
  }

  async function open() {
    if (state) return;
    state = { opening: true };
    const settings = await ADHDR.loadSettings();
    let article = null;
    try {
      article = extract();
    } catch (error) {
      console.warn('ADHD Reader: could not extract the article', error);
    }
    // Readability always returns its best guess; too little text means there is no article here.
    if (!article?.content || (article.textContent || '').trim().length < MIN_ARTICLE_CHARS) {
      state = null;
      toast(t('readerNotFound'));
      return;
    }
    build(article, settings);
  }

  /** Runs Readability on a copy of the page (it mutates the document it reads). */
  function extract() {
    const copy = document.cloneNode(true);
    // Undo our own markup in the copy so Readability sees the page's real structure.
    for (const wrapper of copy.querySelectorAll(ADHDR.Bionic.TAGS.wrapper)) {
      wrapper.replaceWith(copy.createTextNode(wrapper.textContent));
    }
    for (const el of copy.querySelectorAll(`[${ADHDR.UI_ATTRIBUTE}]`)) el.remove();
    copy.body?.normalize();
    return new Readability(copy, { charThreshold: 250, serializer: (el) => el }).parse();
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, document.baseURI);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) || url.href.startsWith('data:image/') ? url.href : null;
    } catch {
      return null;
    }
  }

  /** Keeps only reading content: known tags, harmless attributes, safe URLs. */
  function sanitize(container) {
    for (const el of [...container.querySelectorAll('*')]) {
      if (!container.contains(el)) continue; // inside something already dropped
      const tag = el.localName;
      if (DROP.has(tag)) {
        el.remove();
        continue;
      }
      if (!KEEP.has(tag)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      const allowed = [...ATTRIBUTES['*'], ...(ATTRIBUTES[tag] || [])];
      for (const { name, value } of [...el.attributes]) {
        if (!allowed.includes(name)) {
          el.removeAttribute(name);
        } else if (name === 'srcset') {
          const safe = value.split(',').every((part) => safeUrl(part.trim().split(/\s+/)[0]));
          if (!safe) el.removeAttribute(name);
        } else if (URL_ATTRIBUTES.has(name)) {
          const url = safeUrl(value);
          if (url) el.setAttribute(name, url);
          else el.removeAttribute(name);
        }
      }
      if (tag === 'a' && el.hasAttribute('href')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function h(tag, attributes = {}, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    el.append(...children);
    return el;
  }

  function resolveTheme(theme) {
    if (theme !== 'auto') return theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function css(settings) {
    const theme = THEMES[resolveTheme(settings.readerTheme)];
    const font = ADHDR.fontStack(settings.font) || ADHDR.FONT_STACKS.system;
    const lineHeight = settings.lineHeight > 100 ? settings.lineHeight / 100 : 1.7;
    return `
      :host { all: initial; }
      .reader {
        --bg: ${theme.bg}; --text: ${theme.text}; --muted: ${theme.muted}; --link: ${theme.link};
        --line: ${theme.line}; --accent: ${theme.accent}; --code: ${theme.code};
        position: fixed; inset: 0; overflow-y: auto; overscroll-behavior: contain;
        background: var(--bg); color: var(--text); color-scheme: ${resolveTheme(settings.readerTheme) === 'dark' ? 'dark' : 'light'};
        font-family: ${font}; font-size: ${settings.readerFontSize}px; line-height: ${lineHeight};
        letter-spacing: ${settings.letterSpacing / 100}em; word-spacing: ${settings.wordSpacing / 100}em;
        -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
      }
      .reader:focus { outline: none; }
      .progress { position: sticky; top: 0; z-index: 2; height: 3px; }
      .progress-bar { height: 100%; width: 0; background: var(--accent); }
      .toolbar {
        position: sticky; top: 3px; z-index: 1; border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(8px);
        font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: normal; word-spacing: normal;
      }
      /* Same font and size as the article, so its ch-based width lines up with the text column. */
      .toolbar-inner { display: flex; align-items: center; gap: 12px; max-width: calc(${settings.readerWidth}ch + 48px); margin: 0 auto; padding: 8px 24px; box-sizing: border-box; font-family: ${font}; font-size: ${settings.readerFontSize}px; }
      .toolbar-inner > * { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .site { flex: 1; min-width: 0; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
      .left { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .tools { display: flex; gap: 4px; }
      .tool {
        min-width: 34px; height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px;
        background: transparent; color: var(--text); font: inherit; cursor: pointer;
      }
      .tool:hover { background: var(--line); }
      .tool svg { display: block; width: 16px; height: 16px; margin: 0 auto; }
      .tool:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .article { max-width: calc(${settings.readerWidth}ch + 48px); margin: 0 auto; padding: 40px 24px 40vh; box-sizing: border-box; }
      .title { margin: 0 0 0.4em; font-size: 1.7em; line-height: 1.25; font-weight: 700; }
      .meta { margin: 0 0 2em; color: var(--muted); font-size: 0.8em; }
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
      .content pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: var(--code); font-size: 0.85em; line-height: 1.5; }
      .content :is(code, kbd, samp, pre) { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: normal; word-spacing: normal; }
      .content :not(pre) > code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--code); font-size: 0.9em; }
      .content table { display: block; overflow-x: auto; border-collapse: collapse; }
      .content :is(td, th) { padding: 6px 10px; border: 1px solid var(--line); }
      .content hr { margin: 2em 0; border: 0; border-top: 1px solid var(--line); }
    `;
  }

  /**
   * Readability takes the title from <title>, which often ends with the site name after an em dash
   * ("Focus is a skill — Daily Example") while the article repeats a fuller heading. When the
   * article starts with a heading that begins like the title, use that heading and drop it from the
   * body so it isn't shown twice.
   */
  function pickTitle(article) {
    const title = (article.title || document.title || '').trim();
    const heading = article.content.querySelector('h1, h2');
    const headingText = heading?.textContent.replace(/\s+/g, ' ').trim();
    const firstText = [...article.content.querySelectorAll('h1, h2, h3, p, li')].find((el) => el.textContent.trim());
    const titleStart = title.split(/\s[—–|·:-]\s/)[0].trim().toLowerCase();
    if (heading && headingText && firstText === heading && titleStart && headingText.toLowerCase().startsWith(titleStart)) {
      heading.remove();
      return headingText;
    }
    return title;
  }

  function build(article, settings) {
    const title = pickTitle(article);
    sanitize(article.content);
    const content = document.importNode(article.content, true);
    const words = (article.textContent.match(/\S+/g) || []).length;
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    const site = article.siteName || location.hostname.replace(/^www\./, '');

    const host = document.createElement('div');
    host.setAttribute(ADHDR.UI_ATTRIBUTE, 'reader');
    for (const [name, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', display: 'block', 'z-index': '2147483646' })) {
      host.style.setProperty(name, value, 'important');
    }
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css(settings));
    shadow.adoptedStyleSheets = [sheet];

    const bar = h('div', { class: 'progress-bar' });
    const left = h('span', { class: 'left' }, t('readerMinutesLeft', [String(minutes)]));
    const tool = (action, label, title) => h('button', { class: 'tool', type: 'button', 'data-action': action, title, 'aria-label': title }, label);
    const themeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    themeIcon.setAttribute('viewBox', '0 0 16 16');
    themeIcon.setAttribute('aria-hidden', 'true');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [name, value] of Object.entries({ cx: '8', cy: '8', r: '6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' })) ring.setAttribute(name, value);
    const half = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    half.setAttribute('d', 'M8 2a6 6 0 0 1 0 12z');
    half.setAttribute('fill', 'currentColor');
    themeIcon.append(ring, half);
    const meta = [article.byline, site, t('readerMinutes', [String(minutes)])].filter(Boolean).join(' · ');
    const scroller = h(
      'div',
      { class: 'reader', tabindex: '-1', role: 'document', lang: article.lang || document.documentElement.lang || '', dir: article.dir || 'auto' },
      h('div', { class: 'progress', 'aria-hidden': 'true' }, bar),
      h(
        'div',
        // Marked as our UI so the bionic engine leaves the toolbar (and its live time counter) alone.
        { class: 'toolbar', [ADHDR.UI_ATTRIBUTE]: 'toolbar' },
        h(
          'div',
          { class: 'toolbar-inner' },
          h('span', { class: 'site' }, site),
          left,
          h(
            'div',
            { class: 'tools' },
            tool('smaller', 'A−', t('readerSmaller')),
            tool('larger', 'A+', t('readerLarger')),
            tool('theme', themeIcon, t('readerTheme')),
            tool('close', '✕', t('readerClose')),
          ),
        ),
      ),
      h('article', { class: 'article' }, h('h1', { class: 'title' }, title), h('p', { class: 'meta' }, meta), h('div', { class: 'content' }, content)),
    );
    shadow.append(scroller);

    const html = document.documentElement;
    const previousOverflow = [html.style.getPropertyValue('overflow'), html.style.getPropertyPriority('overflow')];
    html.style.setProperty('overflow', 'hidden', 'important');
    html.append(host);

    const engine = ADHDR.createBionicEngine();
    const applySettings = (next) => {
      sheet.replaceSync(css(next));
      if (ADHDR.fontStack(next.font) && !['system', 'serif'].includes(next.font)) ADHDR.ensureFontFaces(document);
      engine.update(next.enabled && next.bionic ? next : null, shadow);
    };
    applySettings(settings);

    const onScroll = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      const progress = max > 0 ? Math.min(1, scroller.scrollTop / max) : 1;
      bar.style.width = `${(progress * 100).toFixed(1)}%`;
      const remaining = Math.ceil(minutes * (1 - progress));
      left.textContent = progress >= 0.99 ? t('readerDone') : t('readerMinutesLeft', [String(Math.max(1, remaining))]);
      ADHDR.refreshOverlay?.();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    };
    const onClick = async (event) => {
      const action = event.target.closest?.('[data-action]')?.dataset.action;
      if (!action) return;
      const current = await ADHDR.loadSettings();
      if (action === 'close') close();
      else if (action === 'smaller') ADHDR.saveSettings({ readerFontSize: current.readerFontSize - 2 });
      else if (action === 'larger') ADHDR.saveSettings({ readerFontSize: current.readerFontSize + 2 });
      else if (action === 'theme') {
        const now = resolveTheme(current.readerTheme);
        ADHDR.saveSettings({ readerTheme: THEME_ORDER[(THEME_ORDER.indexOf(now) + 1) % THEME_ORDER.length] });
      }
    };
    const onCopy = (event) => ADHDR.cleanCopy(event, shadow.getSelection ? shadow.getSelection() : document.getSelection(), document);

    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('click', onClick);
    shadow.addEventListener('copy', onCopy);
    window.addEventListener('keydown', onKey, true);
    const unsubscribe = ADHDR.onSettingsChanged(applySettings);

    const previousFocus = document.activeElement;
    scroller.focus({ preventScroll: true });
    onScroll();

    state = { host, engine, unsubscribe, onKey, previousOverflow, previousFocus };
  }

  function close() {
    if (!state || state.opening) return;
    const { host, engine, unsubscribe, onKey, previousOverflow, previousFocus } = state;
    state = null;
    engine.update(null);
    unsubscribe();
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    const [value, priority] = previousOverflow;
    if (value) document.documentElement.style.setProperty('overflow', value, priority);
    else document.documentElement.style.removeProperty('overflow');
    previousFocus?.focus?.({ preventScroll: true });
  }

  function toast(message) {
    const host = document.createElement('div');
    host.setAttribute(ADHDR.UI_ATTRIBUTE, 'toast');
    const styles = {
      all: 'initial', position: 'fixed', left: '50%', bottom: '32px', transform: 'translateX(-50%)', 'z-index': '2147483646',
      display: 'block', padding: '12px 18px', 'border-radius': '10px', background: '#1f2328', color: '#fff',
      font: '14px/1.4 system-ui, sans-serif', 'box-shadow': '0 6px 24px rgb(0 0 0 / 0.25)', 'max-width': '80vw',
    };
    for (const [name, value] of Object.entries(styles)) host.style.setProperty(name, value, 'important');
    host.textContent = message;
    host.setAttribute('role', 'status');
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 3500);
  }
})();
