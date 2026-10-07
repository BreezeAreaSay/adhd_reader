/*
 * Settings model shared by the content script, background worker, popup and options page.
 * Loaded as a classic script everywhere (content scripts can't be ES modules), so it attaches to
 * the global `ADHDR` namespace; it also exports for Node so the unit tests can use it.
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    fixation: 50, // % of each word's letters to make bold
    weight: 700, // font-weight of the emphasised part
    fade: 100, // opacity (%) of the rest of the word; 100 = not faded
    skipCode: true, // leave <code>, <pre>, <kbd>… untouched
    disabledSites: Object.freeze([]), // site keys (see siteKeyFromUrl) where the extension is off
  });

  const LIMITS = Object.freeze({
    fixation: [10, 90],
    weight: [400, 900],
    fade: [20, 100],
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

  function isSiteDisabled(settings, siteKey) {
    return Boolean(siteKey) && settings.disabledSites.some((entry) => siteMatches(siteKey, entry));
  }

  /** Returns a new disabled-sites list with `siteKey` switched off (disabled=true) or back on. */
  function setSiteDisabled(list, siteKey, disabled) {
    if (!siteKey) return list.slice();
    if (!disabled) return list.filter((entry) => !siteMatches(siteKey, entry));
    return list.some((entry) => siteMatches(siteKey, entry)) ? list.slice() : [...list, siteKey];
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
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
      fixation: clampInt(src.fixation, LIMITS.fixation, DEFAULTS.fixation),
      weight: Math.round(clampInt(src.weight, LIMITS.weight, DEFAULTS.weight) / 100) * 100,
      fade: clampInt(src.fade, LIMITS.fade, DEFAULTS.fade),
      skipCode: typeof src.skipCode === 'boolean' ? src.skipCode : DEFAULTS.skipCode,
      disabledSites: normalizeSiteList(src.disabledSites),
    };
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

  /** Calls `callback(settings)` with the full, normalised settings whenever they change. */
  function onSettingsChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') loadSettings().then(callback);
    });
  }

  const api = {
    DEFAULTS,
    LIMITS,
    normalizeSettings,
    normalizeSite,
    siteKeyFromUrl,
    isSiteDisabled,
    setSiteDisabled,
    loadSettings,
    saveSettings,
    resetSettings,
    onSettingsChanged,
  };

  const ns = root.ADHDR || (root.ADHDR = {});
  Object.assign(ns, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
