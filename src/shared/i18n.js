/*
 * Texts in the language picked in the settings (Dutch or English), or in the
 * browser's language ("auto", the default).
 *
 * chrome.i18n always follows the browser, so for a picked language the texts
 * come from _locales/<lang>/messages.json. Extension pages and the background
 * read that file themselves; content scripts cannot (the file is not open to
 * web pages) and ask the background for it.
 */
(function (root) {
  'use strict';

  const CMCS = (root.CMCS = root.CMCS || {});
  const LANGUAGES = ['nl', 'en'];
  const SETTINGS_KEY = 'cmcs.settings';
  /** Never wait longer than this for the texts: the browser's language is better than nothing. */
  const LOAD_TIMEOUT_MS = 2000;

  /** Messages of the picked language, or null: chrome.i18n (the browser's language). */
  let table = null;
  let tableLang = null;
  let chosen = 'auto';
  const listeners = new Set();
  const loaded = {};

  /** Fill $1…$9 like chrome.i18n does ($$ is a dollar sign). */
  function fill(message, subs) {
    return message.replace(/\$(\$|[1-9])/g, (_, c) => (c === '$' ? '$' : c <= subs.length ? String(subs[c - 1]) : ''));
  }

  /** Translate `key`; substitutions fill $1, $2, … in messages.json. */
  CMCS.t = function t(key, ...subs) {
    const entry = table && table[key];
    if (entry) return fill(entry.message, subs);
    const text = root.chrome.i18n.getMessage(key, subs.map(String));
    return text || key;
  };

  /**
   * A text that depends on a number: `<key>One` for exactly 1 ("1 artikel"),
   * `<key>` otherwise ("3 artikelen"). chrome.i18n has no plurals of its own.
   */
  CMCS.tn = function tn(key, count, ...subs) {
    return CMCS.t(Number(count) === 1 ? `${key}One` : key, ...subs);
  };

  const browserLanguage = () => (root.chrome.i18n.getUILanguage && root.chrome.i18n.getUILanguage()) || 'en';

  /** The language the texts are in: 'nl' or 'en' (other browser languages get English). */
  CMCS.lang = function lang() {
    if (tableLang) return tableLang;
    return /^nl\b/i.test(browserLanguage()) ? 'nl' : 'en';
  };

  /** Cardmarket is a European site: English with a 24-hour clock and day-month dates. */
  const DEFAULT_VARIANT = { en: 'en-GB', nl: 'nl-NL' };

  /**
   * For dates and numbers: the browser's own variant when it speaks the same
   * language ("en-US", "nl-BE"), else the European one ("en-GB").
   */
  CMCS.locale = function locale() {
    const ui = browserLanguage();
    const lang = CMCS.lang();
    return ui.toLowerCase().split(/[-_]/)[0] === lang ? ui.replace('_', '-') : DEFAULT_VARIANT[lang];
  };

  /** Fill every [data-i18n] / [data-i18n-title] / [data-i18n-label] element under `scope`. */
  CMCS.localize = function localize(scope) {
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = CMCS.t(el.dataset.i18n);
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = CMCS.t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    });
    scope.querySelectorAll('[data-i18n-label]').forEach((el) => {
      el.setAttribute('aria-label', CMCS.t(el.dataset.i18nLabel));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = CMCS.t(el.dataset.i18nPlaceholder);
    });
  };

  const inExtension = () => root.location && root.location.protocol === 'chrome-extension:';

  /** The messages of `lang`, read from the extension's own files. */
  async function readMessages(lang) {
    const res = await fetch(root.chrome.runtime.getURL(`_locales/${lang}/messages.json`));
    if (!res.ok) throw new Error(`messages ${lang}: HTTP ${res.status}`);
    return res.json();
  }

  function loadMessages(lang) {
    if (!loaded[lang]) {
      loaded[lang] = (inExtension()
        ? readMessages(lang)
        : root.chrome.runtime.sendMessage({ type: 'cmcs.messages', lang }).then((reply) => {
            if (!reply || !reply.ok || !reply.messages) throw new Error((reply && reply.error) || 'no messages');
            return reply.messages;
          })
      ).catch((err) => {
        delete loaded[lang];
        throw err;
      });
    }
    return loaded[lang];
  }

  const withTimeout = (promise) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS))]);

  /**
   * Speak `setting` from now on: 'nl', 'en', or 'auto' (the browser's
   * language). Resolves when the texts are there; never rejects (on trouble
   * the browser's language stays).
   */
  async function use(setting) {
    const want = LANGUAGES.includes(setting) ? setting : 'auto';
    chosen = want;
    if (want === 'auto') {
      table = null;
      tableLang = null;
      return;
    }
    try {
      const messages = await withTimeout(loadMessages(want));
      if (chosen !== want) return; // picked something else meanwhile
      table = messages;
      tableLang = want;
    } catch (err) {
      console.warn('[Cart Saver] texts:', err.message || err);
    }
  }

  const settingOf = (settings) => (settings && settings.language) || 'auto';

  /** Start in the language from the settings. Every page waits for this before it shows texts. */
  const ready = (async () => {
    try {
      const stored = await root.chrome.storage.local.get(SETTINGS_KEY);
      await use(settingOf(stored[SETTINGS_KEY]));
    } catch {
      // No storage (or no extension any more): the browser's language.
    }
  })();

  // Picked another language (here, in another window, or in another browser through sync).
  try {
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      const before = settingOf(changes[SETTINGS_KEY].oldValue);
      const after = settingOf(changes[SETTINGS_KEY].newValue);
      if (before === after) return;
      ready.then(() => use(after)).then(() => {
        for (const fn of listeners) {
          try {
            fn(CMCS.lang());
          } catch (err) {
            console.warn('[Cart Saver] language change:', err);
          }
        }
      });
    });
  } catch {
    // Not in an extension context (tests that load this file on its own).
  }

  CMCS.i18n = {
    LANGUAGES,
    ready,
    /** What the settings say: 'auto', 'nl' or 'en'. */
    chosen: () => chosen,
    /** Call `fn` after the language changed and the new texts are in. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** For the background: the messages a content script asks for. */
    messages: (lang) => (LANGUAGES.includes(lang) ? loadMessages(lang) : Promise.reject(new Error(`unknown language ${lang}`))),
  };
})(globalThis);
