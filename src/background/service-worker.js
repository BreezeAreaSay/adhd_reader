/* Background service worker: shortcuts, context menu, toolbar badge, reader view, open tabs. */
importScripts('../shared/settings.js');

const ADHDR = self.ADHDR;
const t = (key) => chrome.i18n.getMessage(key) || key;

const PAGE_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];
const FOCUS_MODES = ['off', 'line', 'paragraph'];
// Dependencies of the reader view; normally already present as the regular content scripts.
const READER_DEPENDENCIES = ['src/shared/settings.js', 'src/content/bionic.js', 'src/content/engine.js', 'src/content/font-faces.js', 'src/content/typography.js'];
const READER_FILES = ['src/vendor/Readability.js', 'src/content/reader.js'];

chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
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

chrome.commands.onCommand.addListener(async (command, tab) => {
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
    ADHDR.loadSettings().then(syncMenus);
  });
}

function syncMenus(settings) {
  chrome.contextMenus.update(`focus-${settings.focus}`, { checked: true }, () => void chrome.runtime.lastError);
}

ADHDR.onSettingsChanged(syncMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'reader') {
    if (tab) await toggleReader(tab.id);
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
  }
});
