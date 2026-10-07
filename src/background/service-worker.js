/*
 * Background service worker: shortcuts, context menu, toolbar badge, reader view, open tabs, and
 * PDF links opened in the document viewer.
 */
// In Firefox this runs as an event page, with settings.js loaded before it by the manifest.
if (typeof importScripts === 'function') importScripts('../shared/settings.js');

const ADHDR = self.ADHDR;
const t = (key) => chrome.i18n.getMessage(key) || key;

const PAGE_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];
const FOCUS_MODES = ['off', 'line', 'paragraph'];
// Dependencies of the reader view; normally already present as the regular content scripts.
const READER_DEPENDENCIES = ['src/shared/settings.js', 'src/content/bionic.js', 'src/content/engine.js', 'src/content/font-faces.js', 'src/content/typography.js'];
const READER_FILES = ['src/vendor/Readability.js', 'src/shared/sanitize.js', 'src/shared/reading-view.js', 'src/content/reader.js'];

const VIEWER_PAGE = 'src/viewer/viewer.html';
// Google Docs/Slides export addresses the reader view may ask us to fetch (and nothing else).
const GOOGLE_EXPORT = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?(?:document|presentation)\/d\/[\w-]+\/export(?:\?format=html|\/txt)$/;
// Links the context menu offers to open in the viewer.
const DOCUMENT_LINKS = ['pdf', 'PDF', 'epub', 'EPUB', 'fb2', 'FB2', 'fb2.zip'].flatMap((ext) => [`*://*/*.${ext}`, `*://*/*.${ext}?*`, `*://*/*.${ext}#*`, `file:///*.${ext}`]);

// Not every Chromium-based or WebExtensions browser has every API (no context menus or keyboard
// shortcuts on iPhone/iPad, for example): features whose API is missing are simply skipped.
const hasMenus = Boolean(chrome.contextMenus);

chrome.runtime.onInstalled.addListener(async () => {
  if (hasMenus) createMenus();
  await injectIntoOpenTabs();
});

// Content scripts declared in the manifest only reach pages loaded after install. Inject them into
// tabs that are already open so the extension works without reloading every tab.
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: PAGE_PATTERNS });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files })
        .catch(() => {}), // discarded tabs, the Web Store, file:// without access…
    ),
  );
}

/** Opens or closes the reader view in a tab. Resolves to false when the page can't be scripted. */
async function toggleReader(tabId) {
  const target = { tabId, frameIds: [0] };
  try {
    const [{ result: loaded } = {}] = await chrome.scripting.executeScript({
      target,
      func: () => ({ reader: Boolean(globalThis.ADHDR?.reader), base: Boolean(globalThis.ADHDR?.createBionicEngine && globalThis.ADHDR?.createTypography) }),
    });
    if (loaded?.reader) {
      await chrome.scripting.executeScript({ target, func: () => globalThis.ADHDR.reader.toggle() });
    } else {
      await chrome.scripting.executeScript({ target, files: [...(loaded?.base ? [] : READER_DEPENDENCIES), ...READER_FILES] });
    }
    return true;
  } catch {
    return false;
  }
}

async function toggleSite(tab) {
  const siteKey = ADHDR.siteKeyFromUrl(tab?.url);
  if (!siteKey) return;
  const settings = await ADHDR.loadSettings();
  if (!settings.enabled) {
    // The user asked to toggle this site while everything is off: they want it on here.
    await ADHDR.saveSettings({ enabled: true, ...ADHDR.sitePatch(settings, siteKey, true) });
    return;
  }
  await ADHDR.saveSettings(ADHDR.sitePatch(settings, siteKey, !ADHDR.isSiteActive(settings, siteKey)));
}

async function activeTab() {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

chrome.commands?.onCommand.addListener(async (command, tab) => {
  tab = tab ?? (await activeTab());
  const settings = await ADHDR.loadSettings();
  if (command === 'toggle-global') {
    await ADHDR.saveSettings({ enabled: !settings.enabled });
  } else if (command === 'toggle-site') {
    await toggleSite(tab);
  } else if (command === 'toggle-reader') {
    if (tab) await toggleReader(tab.id);
  } else if (command === 'cycle-focus') {
    const next = FOCUS_MODES[(FOCUS_MODES.indexOf(settings.focus) + 1) % FOCUS_MODES.length];
    await ADHDR.saveSettings({ focus: next });
  }
});

// --- Context menu ---------------------------------------------------------------------------------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const base = { contexts: ['page', 'selection', 'link', 'image'], documentUrlPatterns: PAGE_PATTERNS };
    chrome.contextMenus.create({ ...base, id: 'reader', title: t('menuReader') });
    chrome.contextMenus.create({ ...base, id: 'focus', title: t('menuFocus') });
    for (const mode of FOCUS_MODES) {
      chrome.contextMenus.create({ ...base, id: `focus-${mode}`, parentId: 'focus', type: 'radio', title: t(`focus_${mode}`) });
    }
    chrome.contextMenus.create({ ...base, id: 'toggle-site', title: t('menuToggleSite') });
    chrome.contextMenus.create({ id: 'open-document', contexts: ['link'], targetUrlPatterns: DOCUMENT_LINKS, title: t('menuOpenInViewer') });
    ADHDR.loadSettings().then(syncMenus);
  });
}

function syncMenus(settings) {
  chrome.contextMenus.update(`focus-${settings.focus}`, { checked: true }, () => void chrome.runtime.lastError);
}

if (hasMenus) ADHDR.onSettingsChanged(syncMenus);

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'reader') {
    if (tab) await toggleReader(tab.id);
  } else if (info.menuItemId === 'open-document' && info.linkUrl) {
    await chrome.tabs.create({ url: viewerUrl(info.linkUrl), ...(tab ? { index: tab.index + 1, openerTabId: tab.id } : {}) });
  } else if (info.menuItemId === 'toggle-site') {
    await toggleSite(tab);
  } else if (String(info.menuItemId).startsWith('focus-')) {
    await ADHDR.saveSettings({ focus: String(info.menuItemId).slice('focus-'.length) });
  }
});

// --- Messages -------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'status' && sender.tab && sender.frameId === 0) {
    // The top frame of each tab reports whether it is active; show "off" on the icon when it isn't.
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: message.active ? '' : t('badgeOff') });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#6b7280' });
  } else if (message?.type === 'toggleReader' && Number.isInteger(message.tabId)) {
    toggleReader(message.tabId).then(sendResponse);
    return true; // async response
  } else if (message?.type === 'fetchExport' && sender.tab && GOOGLE_EXPORT.test(message.url)) {
    // The reader view on Google Docs/Slides, when the export redirects off docs.google.com.
    fetch(message.url, { credentials: 'include' })
      .then(async (response) => sendResponse(response.ok ? { text: await response.text() } : { status: response.status }))
      .catch(() => sendResponse({ status: 'network' }));
    return true; // async response
  } else if (message?.type === 'openOriginal' && sender.tab && isDocumentUrl(message.url)) {
    // The viewer's "open the original" button: show the browser's own viewer this time.
    allowOriginal(sender.tab.id, message.url).then(() => chrome.tabs.update(sender.tab.id, { url: message.url }));
  }
});

// --- Documents ------------------------------------------------------------------------------------
// Chrome shows PDFs in its own viewer, which extensions can't reach. When a tab is about to show a
// PDF, it is sent to the extension's viewer instead, which downloads the same file and shows it with
// all the reading modes. The viewer's ↗ button goes back to the original.

function viewerUrl(file) {
  return chrome.runtime.getURL(VIEWER_PAGE) + (file ? `?file=${encodeURIComponent(file)}` : '');
}

function isDocumentUrl(url) {
  return typeof url === 'string' && /^(https?|file):/i.test(url);
}

function header(details, name) {
  return details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value || '';
}

/** A tab navigating to a PDF that the browser would display (not download). */
function isPdfNavigation(details) {
  if (details.tabId < 0 || details.method !== 'GET' || details.statusCode !== 200) return false;
  if (details.documentLifecycle === 'prerender') return false;
  if (/^\s*attachment/i.test(header(details, 'content-disposition'))) return false;
  return /^\s*application\/(x-)?pdf\b/i.test(header(details, 'content-type'));
}

// Tabs where the user asked for the original: [{ tab, url, at }], kept for the browser session.
// Matched by URL, or by tab for a short while (the original may redirect to another address).
const ORIGINALS_KEY = 'originals';
const ORIGINAL_GRACE_MS = 30000;
const sessionStore = chrome.storage.session;

async function originals() {
  try {
    return (await sessionStore?.get(ORIGINALS_KEY))?.[ORIGINALS_KEY] || [];
  } catch {
    return [];
  }
}

async function saveOriginals(list) {
  try {
    await sessionStore?.set({ [ORIGINALS_KEY]: list.slice(-50) });
  } catch {
    // no session storage: the next PDF in this tab opens in the viewer again
  }
}

async function allowOriginal(tabId, url) {
  await saveOriginals([...(await originals()).filter((entry) => entry.tab !== tabId), { tab: tabId, url, at: Date.now() }]);
}

async function wantsOriginal(tabId, url) {
  const entry = (await originals()).find((item) => item.tab === tabId);
  return Boolean(entry) && (entry.url === url || Date.now() - entry.at < ORIGINAL_GRACE_MS);
}

async function openInViewer(tabId, url) {
  const settings = await ADHDR.loadSettings();
  if (!settings.enabled || !settings.openDocuments || !ADHDR.isSiteActive(settings, ADHDR.siteKeyFromUrl(url))) return;
  if (await wantsOriginal(tabId, url)) return;
  await chrome.tabs.update(tabId, { url: viewerUrl(url) }).catch(() => {});
}

chrome.webRequest?.onHeadersReceived.addListener(
  (details) => {
    if (isPdfNavigation(details)) openInViewer(details.tabId, details.url);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders'],
);

// Local PDFs (file://) have no response headers: go by the file name.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const url = changeInfo.url;
  if (!url || !/^file:\/\/[^?#]*\.pdf$/i.test(url)) return;
  if (await chrome.extension?.isAllowedFileSchemeAccess?.()) openInViewer(tabId, url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const list = await originals();
  if (list.some((entry) => entry.tab === tabId)) await saveOriginals(list.filter((entry) => entry.tab !== tabId));
});
