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

  const percent = (v) => `${v}%`;
  const FORMATTERS = {
    fixation: percent,
    fade: (v) => (v >= 100 ? t('valueNormal') : `${v}%`),
    saccade: (v) => (v === 1 ? t('saccadeEvery') : t('saccadeNth', [String(v)])),
    minWordLength: (v) => (v === 1 ? t('valueAllWords') : t('minWordLengthValue', [String(v)])),
    lineHeight: (v) => (v <= 100 ? t('valueSite') : (v / 100).toFixed(1)),
    letterSpacing: (v) => (v === 0 ? t('valueNormal') : `+${(v / 100).toFixed(2)} em`),
    wordSpacing: (v) => (v === 0 ? t('valueNormal') : `+${(v / 100).toFixed(2)} em`),
    tintStrength: percent,
    dim: (v) => (v === 0 ? t('valueOff') : `${v}%`),
    focusDim: percent,
    readerFontSize: (v) => `${v} px`,
    readerWidth: (v) => t('readerWidthValue', [String(v)]),
  };

  function isNumeric(value) {
    return value !== '' && !Number.isNaN(Number(value));
  }

  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    return isNumeric(el.value) ? Number(el.value) : el.value;
  }

  function writeInput(el, value) {
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (el.type === 'radio') el.checked = el.value === String(value);
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
      // data-show-if="key=value" / data-hide-if="key=value" toggle dependent controls.
      for (const el of scope.querySelectorAll('[data-show-if], [data-hide-if]')) {
        const [key, value] = (el.dataset.showIf || el.dataset.hideIf).split('=');
        el.hidden = (String(settings[key]) === value) === Boolean(el.dataset.hideIf);
      }
      onUpdate?.(settings, { draft });
    }

    for (const el of inputs) {
      const key = el.dataset.setting;
      el.addEventListener('input', () => {
        if (current && (el.type !== 'radio' || el.checked)) show({ ...current, [key]: readInput(el) }, { draft: true });
      });
      el.addEventListener('change', () => {
        if (el.type !== 'radio' || el.checked) ADHDR.saveSettings({ [key]: readInput(el) });
      });
    }

    ADHDR.loadSettings().then((settings) => show(settings));
    ADHDR.onSettingsChanged((settings) => show(settings));
    return { get: () => current };
  }

  /**
   * Renders `text` (paragraphs separated by blank lines) the way a page would look with `settings`:
   * bionic emphasis, font, spacing and tint.
   */
  function renderPreview(container, text, settings) {
    const templates = ADHDR.Bionic.createTemplates(document, settings);
    container.replaceChildren();
    for (const paragraph of text.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      const fragment = settings.bionic ? ADHDR.Bionic.buildFragment(document, paragraph.trim(), settings, templates) : null;
      p.append(fragment || paragraph.trim());
      container.append(p);
    }
    const stack = ADHDR.fontStack(settings.font);
    if (stack && !['system', 'serif'].includes(settings.font)) ADHDR.ensureFontFaces(document);
    container.style.fontFamily = stack || '';
    container.style.lineHeight = settings.lineHeight > 100 ? String(settings.lineHeight / 100) : '';
    container.style.letterSpacing = settings.letterSpacing ? `${settings.letterSpacing / 100}em` : '';
    container.style.wordSpacing = settings.wordSpacing ? `${settings.wordSpacing / 100}em` : '';
    const tint = ADHDR.TINT_COLORS[settings.tint];
    container.style.backgroundColor = tint ? `color-mix(in srgb, ${tint} ${settings.tintStrength}%, var(--surface))` : '';
    container.classList.toggle('is-off', !settings.enabled);
  }

  /** Paints tint swatches (radio labels with data-tint) in their colours. */
  function paintSwatches(scope = document) {
    for (const swatch of scope.querySelectorAll('[data-tint]')) {
      const color = ADHDR.TINT_COLORS[swatch.dataset.tint];
      if (color) swatch.style.setProperty('--swatch', color);
    }
  }

  root.ADHDR.ui = { t, localize, bindSettings, renderPreview, paintSwatches };
})(globalThis);
