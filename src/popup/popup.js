/* Toolbar popup: global and per-site switches, quick reading settings with a live preview. */
(async () => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  const { t, localize, bindSettings, renderPreview } = ADHDR.ui;

  localize();

  const preview = document.getElementById('preview');
  const siteHost = document.getElementById('site-host');
  const siteToggle = document.getElementById('site-toggle');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const siteKey = ADHDR.siteKeyFromUrl(tab?.url);
  siteHost.textContent = siteKey === 'file://' ? t('localFiles') : siteKey || '—';

  bindSettings(document.body, (settings, { draft }) => {
    renderPreview(preview, t('previewText'), settings);
    if (draft) return;
    siteToggle.disabled = !siteKey || !settings.enabled;
    siteToggle.checked = Boolean(siteKey) && settings.enabled && !ADHDR.isSiteDisabled(settings, siteKey);
  });

  siteToggle.addEventListener('change', async () => {
    const settings = await ADHDR.loadSettings();
    await ADHDR.saveSettings({
      disabledSites: ADHDR.setSiteDisabled(settings.disabledSites, siteKey, !siteToggle.checked),
    });
  });

  document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('reload').addEventListener('click', () => {
    chrome.tabs.reload(tab.id);
    window.close();
  });

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === 'toggle-site')?.shortcut;
  if (shortcut) document.getElementById('shortcut').textContent = t('shortcutHint', [shortcut]);

  showNotice(await diagnose());

  /** Explains why the extension can't work on the current tab, if that's the case. */
  async function diagnose() {
    const url = tab?.url || '';
    if (!siteKey || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)) {
      return { text: t('noticeRestricted') };
    }
    if (siteKey === 'file://' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
      return { text: t('noticeFileAccess') };
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, { frameId: 0 });
      return null;
    } catch {
      if (/\.pdf($|[?#])/i.test(url)) return { text: t('noticePdf') };
      return { text: t('noticeReload'), reload: true };
    }
  }

  function showNotice(notice) {
    if (!notice) return;
    document.getElementById('notice-text').textContent = notice.text;
    document.getElementById('reload').hidden = !notice.reload;
    document.getElementById('notice').hidden = false;
  }
})();
