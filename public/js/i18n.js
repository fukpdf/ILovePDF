/* RuntimeI18n — Phase 10B-H: Global Multilingual Translation Engine
   Supports 20 languages, RTL auto-detection, lazy locale loading,
   DOM translation via data-i18n attributes, and localStorage persistence.

   API:
     RuntimeI18n.setLanguage(lang)       async — switch active language
     RuntimeI18n.getLanguage()                  — current language code
     RuntimeI18n.translate(key, vars)           — resolve a translation key
     RuntimeI18n.t(key, vars)                   — alias for translate
     RuntimeI18n.loadLocale(lang)        async  — pre-load a locale pack
     RuntimeI18n.availableLanguages()           — array of {code, name, nativeName, flag, rtl?}
     RuntimeI18n.detectBrowserLanguage()        — auto-detect from navigator.languages
     RuntimeI18n.isRTL(lang?)                   — true if RTL language
     RuntimeI18n.init()                  async  — bootstrap (called automatically)

   Global shorthand: window.t(key, vars)
*/
(function () {
  'use strict';

  const LOCALES_BASE  = '/locales/';
  const STORAGE_KEY   = 'ilovepdf_lang';
  const DEFAULT_LANG  = 'en';
  const RTL_LANGS     = new Set(['ar', 'ur', 'fa', 'he', 'yi', 'dv', 'ps', 'sd']);

  const AVAILABLE = [
    { code:'en', name:'English',    nativeName:'English',    flag:'🇬🇧' },
    { code:'ar', name:'Arabic',     nativeName:'العربية',    flag:'🇸🇦', rtl:true },
    { code:'ur', name:'Urdu',       nativeName:'اردو',       flag:'🇵🇰', rtl:true },
    { code:'fa', name:'Persian',    nativeName:'فارسی',      flag:'🇮🇷', rtl:true },
    { code:'hi', name:'Hindi',      nativeName:'हिन्दी',     flag:'🇮🇳' },
    { code:'bn', name:'Bengali',    nativeName:'বাংলা',      flag:'🇧🇩' },
    { code:'zh', name:'Chinese',    nativeName:'中文',        flag:'🇨🇳' },
    { code:'ja', name:'Japanese',   nativeName:'日本語',      flag:'🇯🇵' },
    { code:'ko', name:'Korean',     nativeName:'한국어',      flag:'🇰🇷' },
    { code:'tr', name:'Turkish',    nativeName:'Türkçe',     flag:'🇹🇷' },
    { code:'id', name:'Indonesian', nativeName:'Indonesia',  flag:'🇮🇩' },
    { code:'ru', name:'Russian',    nativeName:'Русский',    flag:'🇷🇺' },
    { code:'fr', name:'French',     nativeName:'Français',   flag:'🇫🇷' },
    { code:'de', name:'German',     nativeName:'Deutsch',    flag:'🇩🇪' },
    { code:'es', name:'Spanish',    nativeName:'Español',    flag:'🇪🇸' },
    { code:'pt', name:'Portuguese', nativeName:'Português',  flag:'🇧🇷' },
    { code:'it', name:'Italian',    nativeName:'Italiano',   flag:'🇮🇹' },
    { code:'nl', name:'Dutch',      nativeName:'Nederlands', flag:'🇳🇱' },
    { code:'pl', name:'Polish',     nativeName:'Polski',     flag:'🇵🇱' },
  ];

  let _currentLang = DEFAULT_LANG;
  let _cache       = {};   // lang → flat key→value map
  let _loading     = {};   // lang → Promise (deduplicates concurrent fetches)
  let _fallback    = {};   // English flat map (always loaded as fallback)

  function flatten(obj, prefix) {
    const result = {};
    prefix = prefix || '';
    Object.keys(obj).forEach(function (k) {
      const fullKey = prefix ? (prefix + '.' + k) : k;
      if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
        Object.assign(result, flatten(obj[k], fullKey));
      } else {
        result[fullKey] = String(obj[k]);
      }
    });
    return result;
  }

  function fetchLocale(lang) {
    if (_loading[lang]) return _loading[lang];
    _loading[lang] = fetch(LOCALES_BASE + lang + '.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) { _cache[lang] = flatten(data); return _cache[lang]; })
      .catch(function (err) {
        console.warn('[RuntimeI18n] Failed to load locale "' + lang + '":', err);
        _cache[lang] = {};
        return {};
      });
    return _loading[lang];
  }

  var RuntimeI18n = {

    loadLocale: function (lang) {
      if (_cache[lang]) return Promise.resolve(_cache[lang]);
      return fetchLocale(lang);
    },

    setLanguage: function (lang) {
      var self = this;
      var code = ((lang || DEFAULT_LANG) + '').toLowerCase().split('-')[0];
      var supported = AVAILABLE.filter(function (l) { return l.code === code; })[0];
      var target = supported ? code : DEFAULT_LANG;

      var loads = [self.loadLocale(target)];
      if (target !== DEFAULT_LANG) loads.push(self.loadLocale(DEFAULT_LANG));

      return Promise.all(loads).then(function () {
        _currentLang = target;
        _fallback    = _cache[DEFAULT_LANG] || {};
        try { localStorage.setItem(STORAGE_KEY, target); } catch (_) {}
        self._applyRTL(target);
        self._applyToDOM();
        try {
          window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: target } }));
        } catch (_) {}
        return target;
      });
    },

    getLanguage: function () { return _currentLang; },

    translate: function (key, vars) {
      var locale = _cache[_currentLang] || {};
      var text   = locale[key] !== undefined ? locale[key]
                 : _fallback[key] !== undefined ? _fallback[key]
                 : key;
      if (vars && typeof vars === 'object') {
        text = text.replace(/\{\{(\w+)\}\}/g, function (_, k) {
          return vars[k] != null ? vars[k] : '{{' + k + '}}';
        });
      }
      return text;
    },

    t: function (key, vars) { return this.translate(key, vars); },

    availableLanguages: function () { return AVAILABLE.slice(); },

    detectBrowserLanguage: function () {
      var langs = navigator.languages || [navigator.language || DEFAULT_LANG];
      for (var i = 0; i < langs.length; i++) {
        var code = langs[i].toLowerCase().split('-')[0];
        var found = AVAILABLE.filter(function (l) { return l.code === code; })[0];
        if (found) return code;
      }
      return DEFAULT_LANG;
    },

    isRTL: function (lang) { return RTL_LANGS.has(lang || _currentLang); },

    _applyRTL: function (lang) {
      var rtl = RTL_LANGS.has(lang);
      document.documentElement.setAttribute('dir',  rtl ? 'rtl' : 'ltr');
      document.documentElement.setAttribute('lang', lang);
    },

    _applyToDOM: function () {
      var locale   = _cache[_currentLang] || {};
      var fallback = _fallback;

      function resolve(key) {
        if (locale[key]   !== undefined) return locale[key];
        if (fallback[key] !== undefined) return fallback[key];
        return null;
      }

      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        var text = resolve(el.getAttribute('data-i18n'));
        if (text === null) return;
        var tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.hasAttribute('placeholder')) el.placeholder = text;
          else el.value = text;
        } else {
          el.textContent = text;
        }
      });

      document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
        var text = resolve(el.getAttribute('data-i18n-placeholder'));
        if (text !== null) el.placeholder = text;
      });

      document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
        var text = resolve(el.getAttribute('data-i18n-html'));
        if (text !== null) el.innerHTML = text;
      });

      document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        var text = resolve(el.getAttribute('data-i18n-title'));
        if (text !== null) el.title = text;
      });
    },

    init: function () {
      var self = this;
      return self.loadLocale(DEFAULT_LANG).then(function () {
        _fallback = _cache[DEFAULT_LANG] || {};
        var stored = DEFAULT_LANG;
        try { stored = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG; } catch (_) {}
        var lang = (stored !== DEFAULT_LANG) ? stored : self.detectBrowserLanguage();
        return self.setLanguage(lang);
      });
    },
  };

  window.RuntimeI18n = RuntimeI18n;
  window.t = function (key, vars) { return RuntimeI18n.translate(key, vars); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { RuntimeI18n.init(); });
  } else {
    RuntimeI18n.init();
  }
})();
