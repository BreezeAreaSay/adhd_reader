/* Options page: every setting, the list of sites where the extension is off, shortcuts. */
(async () => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  const { t, localize, bindSettings, renderPreview } = ADHDR.ui;

  localize();

  const preview = document.getElementById('preview');
  const sites = document.getElementById('sites');
  const sitesStatus = document.getElementById('sites-status');

  bindSettings(document.body, (settings, { draft }) => {
    renderPreview(preview, t('previewTextLong'), settings);
    if (!draft && document.activeElement !== sites) sites.value = settings.disabledSites.join('\n');
  });

  document.getElementById('save-sites').addEventListener('click', async () => {
    const saved = await ADHDR.saveSettings({ disabledSites: sites.value.split(/[\s,]+/) });
    sites.value = saved.disabledSites.join('\n');
    sitesStatus.textContent = t('saved');
    setTimeout(() => (sitesStatus.textContent = ''), 2000);
  });

  document.getElementById('reset').addEventListener('click', async () => {
    if (confirm(t('resetConfirm'))) await ADHDR.resetSettings();
  });

  document.getElementById('open-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  const list = document.getElementById('shortcuts');
  for (const command of await chrome.commands.getAll()) {
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
