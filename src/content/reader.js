/*
 * Reader view: extracts the main text of the page with Mozilla Readability and shows it in a calm,
 * distraction-free overlay (the shared reading view: bionic emphasis, the user's font and spacing,
 * a theme, a progress bar and the time left). Injected on demand by the background worker, together
 * with src/vendor/Readability.js, src/shared/sanitize.js and src/shared/reading-view.js.
 *
 * On Google Docs, whose editor draws text on a <canvas>, the document is fetched through Docs'
 * own export (with the user's session, same origin) instead; Google Slides likewise as plain text.
 */
(() => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  if (ADHDR.reader) {
    ADHDR.reader.toggle();
    return;
  }

  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const MIN_ARTICLE_CHARS = 140; // same threshold as Readability's isProbablyReaderable

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
      article = (await extractFromCanvasApp()) || extract();
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

  /**
   * Google Docs and Slides draw their text on a canvas, which nothing can read or restyle. Their
   * export endpoints return the same document as HTML / text for the signed-in user.
   */
  async function extractFromCanvasApp() {
    const match = location.hostname === 'docs.google.com' && location.pathname.match(/^(\/(?:u\/\d+\/)?(document|presentation)\/d\/[\w-]+)/);
    if (!match) return null;
    const [, base, kind] = match;
    const title = document.title.replace(/\s+[-–—]\s+Google (Docs|Документы|Slides|Презентации)$/i, '').trim();
    const exportUrl = kind === 'document' ? `${base}/export?format=html` : `${base}/export/txt`;
    const response = await fetch(exportUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`export failed: ${response.status}`);
    const text = await response.text();

    const doc = document.implementation.createHTMLDocument(title);
    const content = doc.createElement('div');
    if (kind === 'document') {
      const exported = new DOMParser().parseFromString(text, 'text/html');
      content.append(...exported.body.childNodes);
    } else {
      for (const block of text.split(/\n\s*\n/)) {
        if (!block.trim()) continue;
        const p = doc.createElement('p');
        p.textContent = block.trim();
        content.append(p);
      }
    }
    return { title, content, textContent: content.textContent, siteName: kind === 'document' ? 'Google Docs' : 'Google Slides', lang: document.documentElement.lang };
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
    ADHDR.sanitizeContent(article.content, { baseUrl: document.baseURI });
    const content = document.importNode(article.content, true);
    const words = ADHDR.countWords(article.textContent);
    const minutes = Math.max(1, Math.round(words / 200));
    const site = article.siteName || location.hostname.replace(/^www\./, '');

    const host = document.createElement('div');
    host.setAttribute(ADHDR.UI_ATTRIBUTE, 'reader');
    for (const [name, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', display: 'block', 'z-index': '2147483646' })) {
      host.style.setProperty(name, value, 'important');
    }
    const shadow = host.attachShadow({ mode: 'open' });

    const html = document.documentElement;
    const previousOverflow = [html.style.getPropertyValue('overflow'), html.style.getPropertyPriority('overflow')];
    html.style.setProperty('overflow', 'hidden', 'important');
    html.append(host);

    const view = ADHDR.createReadingView({
      doc: document,
      container: shadow,
      styleTarget: shadow,
      settings,
      site,
      lang: article.lang || document.documentElement.lang,
      dir: article.dir,
      onClose: close,
    });
    view.setTitle(title);
    view.setMeta([article.byline, site, t('readerMinutes', [String(minutes)])].filter(Boolean).join(' · '));
    view.content.append(content);
    view.setWords(words);

    const previousFocus = document.activeElement;
    view.focus();
    state = { host, view, previousOverflow, previousFocus };
  }

  function close() {
    if (!state || state.opening) return;
    const { host, view, previousOverflow, previousFocus } = state;
    state = null;
    view.destroy();
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
