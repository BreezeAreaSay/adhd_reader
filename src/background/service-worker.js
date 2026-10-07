/* Background service worker: keyboard shortcuts, toolbar badge, activation in already-open tabs. */
importScripts('../shared/settings.js');

const ADHDR = self.ADHDR;

// Content scripts declared in the manifest only reach pages loaded after install. Inject them into
// tabs that are already open so the extension works without reloading every tab.
chrome.runtime.onInstalled.addListener(async () => {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files })
        .catch(() => {}), // discarded tabs, the Web Store, file:// without access…
    ),
  );
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const settings = await ADHDR.loadSettings();
  if (command === 'toggle-global') {
    await ADHDR.saveSettings({ enabled: !settings.enabled });
  } else if (command === 'toggle-site') {
    const activeTab = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const siteKey = ADHDR.siteKeyFromUrl(activeTab?.url);
    if (!siteKey) return;
    if (!settings.enabled) {
      // The user pressed "toggle on this site" while everything is off: they want it on here.
      await ADHDR.saveSettings({
        enabled: true,
        disabledSites: ADHDR.setSiteDisabled(settings.disabledSites, siteKey, false),
      });
      return;
    }
    const disabled = ADHDR.isSiteDisabled(settings, siteKey);
    await ADHDR.saveSettings({
      disabledSites: ADHDR.setSiteDisabled(settings.disabledSites, siteKey, !disabled),
    });
  }
});

// The top frame of each tab reports whether it is active; show "off" on the icon when it isn't.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'status' || !sender.tab || sender.frameId !== 0) return;
  const tabId = sender.tab.id;
  chrome.action.setBadgeText({ tabId, text: message.active ? '' : chrome.i18n.getMessage('badgeOff') });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6b7280' });
});
