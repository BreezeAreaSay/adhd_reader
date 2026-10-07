/*
 * Settings model shared by the content scripts, background worker, popup and options page.
 * Loaded as a classic script everywhere (content scripts can't be ES modules), so it attaches to
 * the global `ADHDR` namespace; it also exports for Node so the unit tests can use it.
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    siteMode: 'all', // 'all': everywhere except disabledSites; 'only': only on enabledSites
    disabledSites: Object.freeze([]),
    enabledSites: Object.freeze([]),

    // Bionic emphasis
    bionic: true,
    fixation: 50, // % of each word's letters to make bold
    weight: 700, // font-weight of the emphasised part
    fade: 100, // opacity (%) of the rest of the word; 100 = not faded
    saccade: 1, // emphasise every N-th word
    minWordLength: 1, // leave shorter words alone
    skipCode: true, // leave <code>, <pre>, <kbd>… untouched

    // Page look
    font: 'site',
    lineHeight: 100, // % of the font size; 100 = keep the site's
    letterSpacing: 0, // hundredths of an em
    wordSpacing: 0, // hundredths of an em
    tint: 'none',
    tintStrength: 35, // %
    dim: 0, // % darkening of the whole page

    // Focus
    focus: 'off', // 'off' | 'line' | 'paragraph'
    focusDim: 55, // % darkening outside the focused line/paragraph

    // Reader mode
    readerTheme: 'auto',
    readerFontSize: 20, // px
    readerWidth: 68, // characters per line
  });

  const LIMITS = Object.freeze({
    fixation: [10, 90],
    weight: [400, 900],
    fade: [20, 100],
    saccade: [1, 4],
    minWordLength: [1, 5],
    lineHeight: [100, 240],
    letterSpacing: [0, 20],
    wordSpacing: [0, 50],
    tintStrength: [10, 80],
    dim: [0, 70],
    focusDim: [20, 85],
    readerFontSize: [14, 34],
    readerWidth: [45, 100],
  });

  const CHOICES = Object.freeze({
    siteMode: ['all', 'only'],
    font: ['site', 'opendyslexic', 'andika', 'ptsans', 'atkinson', 'lexend', 'system', 'serif'],
    tint: ['none', 'cream', 'peach', 'yellow', 'green', 'blue', 'rose', 'gray'],
    focus: ['off', 'line', 'paragraph'],
    readerTheme: ['auto', 'light', 'sepia', 'dark'],
  });

  const BOOLEANS = ['enabled', 'bionic', 'skipCode'];

  // Light colours multiplied over the page, like coloured paper.
  const TINT_COLORS = Object.freeze({
    cream: '#fff1cf',
    peach: '#ffd9c2',
    yellow: '#fff59a',
    green: '#d5f2cc',
    blue: '#cfe4ff',
    rose: '#ffd3df',
    gray: '#dcdcdc',
  });

  function clampInt(value, [min, max], fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  /**
   * Normalises a user-entered site ("https://www.Example.com/path", "*.example.com", "пример.рф")
   * to the key we store and match against: a lowercase hostname without "www.", or "file://" for
   * local files. Returns '' for anything unusable.
   */
  function normalizeSite(input) {
    let s = String(input ?? '').trim().toLowerCase();
    if (!s) return '';
    if (s.startsWith('file:')) return 'file://';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
    let host;
    try {
      host = new URL(`http://${s}`).hostname; // also converts IDN to punycode, drops port/path
    } catch {
      return '';
    }
    host = host.replace(/^www\./, '').replace(/\.$/, '');
    return host && !host.startsWith('.') ? host : '';
  }

  /** Site key of a page URL, or null for pages the extension can't (or shouldn't) run on. */
  function siteKeyFromUrl(url) {
    if (!url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:') return 'file://';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normalizeSite(parsed.hostname) || null;
  }

  /** True when `entry` covers `siteKey` — the same host or one of its parent domains. */
  function siteMatches(siteKey, entry) {
    return siteKey === entry || siteKey.endsWith(`.${entry}`);
  }

  function listCovers(list, siteKey) {
    return Boolean(siteKey) && list.some((entry) => siteMatches(siteKey, entry));
  }

  /** Whether the per-site rules allow the extension on `siteKey` (ignores the global switch). */
  function isSiteActive(settings, siteKey) {
    if (settings.siteMode === 'only') return listCovers(settings.enabledSites, siteKey);
    return !listCovers(settings.disabledSites, siteKey);
  }

  /** Returns a new site list with `siteKey` added (include=true) or removed with its parent domains. */
  function updateSiteList(list, siteKey, include) {
    if (!siteKey) return list.slice();
    if (!include) return list.filter((entry) => !siteMatches(siteKey, entry));
    return listCovers(list, siteKey) ? list.slice() : [...list, siteKey];
  }

  /** Settings patch that turns the extension on or off for `siteKey` in the current site mode. */
  function sitePatch(settings, siteKey, on) {
    if (settings.siteMode === 'only') return { enabledSites: updateSiteList(settings.enabledSites, siteKey, on) };
    return { disabledSites: updateSiteList(settings.disabledSites, siteKey, !on) };
  }

  function normalizeSiteList(list) {
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const site = normalizeSite(item);
      if (site) seen.add(site);
    }
    return [...seen];
  }

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const key of BOOLEANS) out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULTS[key];
    for (const [key, range] of Object.entries(LIMITS)) out[key] = clampInt(src[key], range, DEFAULTS[key]);
    out.weight = Math.round(out.weight / 100) * 100;
    for (const [key, options] of Object.entries(CHOICES)) out[key] = options.includes(src[key]) ? src[key] : DEFAULTS[key];
    out.disabledSites = normalizeSiteList(src.disabledSites);
    out.enabledSites = normalizeSiteList(src.enabledSites);
    return out;
  }

  // --- chrome.storage wrappers (sync storage, so settings follow the user's Chrome profile) ---

  async function loadSettings() {
    return normalizeSettings(await chrome.storage.sync.get(null));
  }

  async function saveSettings(patch) {
    const merged = normalizeSettings({ ...(await loadSettings()), ...patch });
    const changed = {};
    for (const key of Object.keys(patch)) if (key in merged) changed[key] = merged[key];
    await chrome.storage.sync.set(changed);
    return merged;
  }

  async function resetSettings() {
    await chrome.storage.sync.clear();
    return normalizeSettings({});
  }

  /**
   * Calls `callback(settings)` with the full, normalised settings whenever they change.
   * Returns a function that stops listening.
   */
  function onSettingsChanged(callback) {
    const listener = (changes, area) => {
      if (area === 'sync') loadSettings().then(callback);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  const api = {
    DEFAULTS,
    LIMITS,
    CHOICES,
    TINT_COLORS,
    normalizeSettings,
    normalizeSite,
    siteKeyFromUrl,
    isSiteActive,
    updateSiteList,
    sitePatch,
    loadSettings,
    saveSettings,
    resetSettings,
    onSettingsChanged,
  };

  const ns = root.ADHDR || (root.ADHDR = {});
  Object.assign(ns, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
