/* Toolbar popup: switches, reader view, focus mode and quick reading settings with a live preview. */
(async () => {
  'use strict';

  const ADHDR = globalThis.ADHDR;
  const { t, localize, bindSettings, renderPreview, paintSwatches } = ADHDR.ui;
  const TAB_KEY = 'adhdr-popup-tab';

  localize();
  paintSwatches();
  setupTabs();

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
    siteToggle.checked = Boolean(siteKey) && settings.enabled && ADHDR.isSiteActive(settings, siteKey);
  });

  siteToggle.addEventListener('change', async () => {
    const settings = await ADHDR.loadSettings();
    await ADHDR.saveSettings(ADHDR.sitePatch(settings, siteKey, siteToggle.checked));
  });

  document.getElementById('open-reader').addEventListener('click', async () => {
    const opened = tab && (await chrome.runtime.sendMessage({ type: 'toggleReader', tabId: tab.id }));
    if (opened) window.close();
    else showNotice({ text: t('noticeReaderUnavailable') });
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

  function setupTabs() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const select = (selected) => {
      for (const button of tabs) {
        const on = button === selected;
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
        document.getElementById(button.getAttribute('aria-controls')).hidden = !on;
      }
      try {
        localStorage.setItem(TAB_KEY, selected.id);
      } catch {
        // storage unavailable — the popup just opens on the first tab next time
      }
    };
    for (const button of tabs) {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const next = tabs[(tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        next.focus();
      });
    }
    let saved = null;
    try {
      saved = localStorage.getItem(TAB_KEY);
    } catch {
      // ignore
    }
    select(document.getElementById(saved) || tabs[0]);
  }
})();
