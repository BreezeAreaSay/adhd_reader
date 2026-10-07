/* Options page: every setting, the site list for the current site mode, shortcuts. */
(async () => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  const { t, localize, bindSettings, renderPreview, paintSwatches } = ADHDR.ui;

  localize();
  paintSwatches();

  const preview = document.getElementById('preview');
  const sites = document.getElementById('sites');
  const sitesStatus = document.getElementById('sites-status');
  const listKey = (settings) => (settings.siteMode === 'only' ? 'enabledSites' : 'disabledSites');
  let shownList = null;

  bindSettings(document.body, (settings, { draft }) => {
    renderPreview(preview, t('previewTextLong'), settings);
    if (draft) return;
    // Refresh the textarea unless the user is editing it (switching the mode always refreshes it).
    if (document.activeElement !== sites || shownList !== listKey(settings)) {
      sites.value = settings[listKey(settings)].join('\n');
      shownList = listKey(settings);
    }
  });

  document.getElementById('save-sites').addEventListener('click', async () => {
    const key = shownList || listKey(await ADHDR.loadSettings());
    const saved = await ADHDR.saveSettings({ [key]: sites.value.split(/[\s,]+/) });
    sites.value = saved[key].join('\n');
    sitesStatus.textContent = t('saved');
    setTimeout(() => (sitesStatus.textContent = ''), 2000);
  });

  document.getElementById('reset').addEventListener('click', async () => {
    if (confirm(t('resetConfirm'))) await ADHDR.resetSettings();
  });

  document.getElementById('open-viewer').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') });
  });
  document.getElementById('open-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  const list = document.getElementById('shortcuts');
  for (const command of (await chrome.commands?.getAll()) || []) {
    if (command.name === '_execute_action' || !command.description) continue;
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = command.description;
    const keys = document.createElement(command.shortcut ? 'kbd' : 'span');
    keys.textContent = command.shortcut || t('shortcutNotSet');
    if (!command.shortcut) keys.className = 'muted';
    item.append(name, keys);
    list.append(item);
  }
})();
