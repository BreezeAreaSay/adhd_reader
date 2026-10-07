/* Helpers shared by the popup and the options page: i18n, settings form binding, live preview. */
(function (root) {
  'use strict';

  const ADHDR = root.ADHDR;

  function t(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
  }

  /** Fills elements marked with data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label. */
  function localize(scope = document) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const dataKey = `i18n${attr.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
      for (const el of scope.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[dataKey]));
    }
  }

  const FORMATTERS = {
    fixation: (v) => `${v}%`,
    fade: (v) => (v >= 100 ? t('fadeOff') : `${v}%`),
  };

  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'radio' || el.type === 'range' || el.type === 'number') return Number(el.value);
    return el.value;
  }

  function writeInput(el, value) {
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (el.type === 'radio') el.checked = Number(el.value) === value;
    else el.value = value;
  }

  /**
   * Two-way binds every [data-setting] input inside `scope` to the stored settings. `onUpdate` is
   * called with the settings to display — on load, on storage changes and while a slider is dragged
   * (draft values, not saved until the slider is released).
   */
  function bindSettings(scope, onUpdate) {
    let current = null;
    const inputs = [...scope.querySelectorAll('[data-setting]')];

    function show(settings, { draft = false } = {}) {
      if (!draft) {
        current = settings;
        for (const el of inputs) writeInput(el, settings[el.dataset.setting]);
      }
      for (const out of scope.querySelectorAll('[data-output]')) {
        const key = out.dataset.output;
        out.textContent = (FORMATTERS[key] || String)(settings[key]);
      }
      onUpdate?.(settings, { draft });
    }

    for (const el of inputs) {
      const key = el.dataset.setting;
      el.addEventListener('input', () => {
        if (current) show({ ...current, [key]: readInput(el) }, { draft: true });
      });
      el.addEventListener('change', () => {
        ADHDR.saveSettings({ [key]: readInput(el) });
      });
    }

    ADHDR.loadSettings().then((settings) => show(settings));
    ADHDR.onSettingsChanged((settings) => show(settings));
    return { get: () => current };
  }

  /** Renders `text` (paragraphs separated by blank lines) with the emphasis the page would get. */
  function renderPreview(container, text, settings) {
    const templates = ADHDR.Bionic.createTemplates(document, settings);
    container.replaceChildren();
    for (const paragraph of text.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      const fragment = ADHDR.Bionic.buildFragment(document, paragraph.trim(), settings, templates);
      p.append(fragment || paragraph.trim());
      container.append(p);
    }
    container.classList.toggle('is-off', !settings.enabled);
  }

  root.ADHDR.ui = { t, localize, bindSettings, renderPreview };
})(globalThis);
