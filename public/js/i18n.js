/* RuntimeI18n — Phase 21 Complete: Global Multilingual Translation Engine
   Supports 20 languages, RTL auto-detection, lazy locale loading,
   DOM translation via data-i18n attributes, localStorage persistence,
   MutationObserver auto-translation, and dynamic content patching.

   API:
     RuntimeI18n.setLanguage(lang)       async — switch active language
     RuntimeI18n.getLanguage()                  — current language code
     RuntimeI18n.translate(key, vars)           — resolve a translation key
     RuntimeI18n.t(key, vars)                   — alias for translate
     RuntimeI18n.extend(lang, flatKeys)         — merge extra translation keys
     RuntimeI18n.patch(node)                    — translate a DOM subtree
     RuntimeI18n.rerender()                     — re-apply all [data-i18n] in DOM
     RuntimeI18n.observe()                      — start MutationObserver
     RuntimeI18n.refreshDynamic()               — rerender + trigger bridge
     RuntimeI18n.translateNode(node)            — alias for patch
     RuntimeI18n.loadLocale(lang)        async  — pre-load a locale pack
     RuntimeI18n.availableLanguages()           — array of {code,name,nativeName,flag,rtl?}
     RuntimeI18n.detectBrowserLanguage()        — auto-detect from navigator.languages
     RuntimeI18n.isRTL(lang?)                   — true if RTL language
     RuntimeI18n.init()                  async  — bootstrap (called automatically)

   Global shorthand: window.t(key, vars)
*/
(function () {
  'use strict';

  var LOCALES_BASE  = '/locales/';
  var STORAGE_KEY   = 'ilovepdf_lang';
  var DEFAULT_LANG  = 'en';
  var RTL_LANGS     = new Set(['ar', 'ur', 'fa', 'he', 'yi', 'dv', 'ps', 'sd']);

  var AVAILABLE = [
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

  var _currentLang = DEFAULT_LANG;
  var _cache       = {};   // lang → flat key→value map
  var _loading     = {};   // lang → Promise (deduplicates concurrent fetches)
  var _fetched     = {};   // lang → true when fully fetched from JSON file
  var _fallback    = {};   // English flat map (always loaded as fallback)
  var _observer    = null; // MutationObserver instance
  var _obsTimer    = null; // debounce timer for observer

  function flatten(obj, prefix) {
    var result = {};
    prefix = prefix || '';
    Object.keys(obj).forEach(function (k) {
      var fullKey = prefix ? (prefix + '.' + k) : k;
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
      .then(function (data) {
        _cache[lang] = Object.assign(_cache[lang] || {}, flatten(data));
        _fetched[lang] = true;
        return _cache[lang];
      })
      .catch(function (err) {
        console.warn('[RuntimeI18n] Failed to load locale "' + lang + '":', err);
        if (!_cache[lang]) _cache[lang] = {};
        _fetched[lang] = true;
        return _cache[lang];
      });
    return _loading[lang];
  }

  var RuntimeI18n = {

    loadLocale: function (lang) {
      if (_fetched[lang]) return Promise.resolve(_cache[lang]);
      return fetchLocale(lang);
    },

    /* Merge additional flat translation keys into a locale cache.
       Useful for runtime extensions without modifying locale JSON files. */
    extend: function (lang, keys) {
      if (!lang || typeof keys !== 'object') return;
      if (!_cache[lang]) _cache[lang] = {};
      Object.assign(_cache[lang], keys);
      if (lang === DEFAULT_LANG) _fallback = _cache[DEFAULT_LANG];
      if (lang === _currentLang || lang === DEFAULT_LANG) {
        this._applyToDOM();
      }
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
      /* RTL-specific body class for targeted CSS overrides */
      document.body && document.body.classList.toggle('rtl', rtl);
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

      document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
        var text = resolve(el.getAttribute('data-i18n-aria-label'));
        if (text !== null) el.setAttribute('aria-label', text);
      });
    },

    /* Translate a specific DOM node and all its [data-i18n] descendants. */
    patch: function (node) {
      if (!node || node.nodeType !== 1) return;
      var self     = this;
      var locale   = _cache[_currentLang] || {};
      var fallback = _fallback;

      function resolve(key) {
        var v = locale[key];
        if (v !== undefined) return v;
        v = fallback[key];
        return v !== undefined ? v : null;
      }

      function applyNode(el) {
        if (el.hasAttribute('data-i18n')) {
          var text = resolve(el.getAttribute('data-i18n'));
          if (text !== null) {
            var tag = el.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
              if (el.hasAttribute('placeholder')) el.placeholder = text;
              else el.value = text;
            } else { el.textContent = text; }
          }
        }
        if (el.hasAttribute('data-i18n-placeholder')) {
          var t2 = resolve(el.getAttribute('data-i18n-placeholder'));
          if (t2 !== null) el.placeholder = t2;
        }
        if (el.hasAttribute('data-i18n-html')) {
          var t3 = resolve(el.getAttribute('data-i18n-html'));
          if (t3 !== null) el.innerHTML = t3;
        }
        if (el.hasAttribute('data-i18n-title')) {
          var t4 = resolve(el.getAttribute('data-i18n-title'));
          if (t4 !== null) el.title = t4;
        }
        if (el.hasAttribute('data-i18n-aria-label')) {
          var t5 = resolve(el.getAttribute('data-i18n-aria-label'));
          if (t5 !== null) el.setAttribute('aria-label', t5);
        }
      }

      applyNode(node);
      node.querySelectorAll(
        '[data-i18n],[data-i18n-placeholder],[data-i18n-html],[data-i18n-title],[data-i18n-aria-label]'
      ).forEach(applyNode);
    },

    /* Alias for patch() — named for discoverability. */
    translateNode: function (node) { return this.patch(node); },

    /* Re-apply all translations to the current DOM. */
    rerender: function () { this._applyToDOM(); },

    /* Full refresh: rerender DOM + trigger tool card bridge. */
    refreshDynamic: function () {
      this._applyToDOM();
      if (window.ToolI18nBridge && typeof window.ToolI18nBridge.patch === 'function') {
        window.ToolI18nBridge.patch();
      }
    },

    /* Start MutationObserver — auto-translates newly injected [data-i18n] nodes.
       Called once inside init(). Safe to call multiple times (no-op after first). */
    observe: function () {
      if (_observer || typeof MutationObserver === 'undefined') return;
      var self = this;
      _observer = new MutationObserver(function (mutations) {
        var needsTranslate = false;
        var ATTRS = ['data-i18n','data-i18n-placeholder','data-i18n-html','data-i18n-title','data-i18n-aria-label'];
        var SELECTOR = ATTRS.map(function(a){ return '[' + a + ']'; }).join(',');

        for (var i = 0; i < mutations.length && !needsTranslate; i++) {
          var m = mutations[i];
          for (var j = 0; j < m.addedNodes.length && !needsTranslate; j++) {
            var node = m.addedNodes[j];
            if (node.nodeType !== 1) continue;
            var hasAttr = ATTRS.some(function(a){ return node.hasAttribute(a); });
            if (hasAttr || node.querySelector(SELECTOR)) {
              needsTranslate = true;
            }
          }
        }

        if (needsTranslate) {
          clearTimeout(_obsTimer);
          _obsTimer = setTimeout(function () {
            self._applyToDOM();
          }, 20);
        }
      });

      if (document.body) {
        _observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', function () {
          _observer.observe(document.body, { childList: true, subtree: true });
        });
      }
    },

    init: function () {
      var self = this;
      return self.loadLocale(DEFAULT_LANG).then(function () {
        _fallback = _cache[DEFAULT_LANG] || {};
        /* 1. Saved preference always wins. */
        var stored = null;
        try { stored = localStorage.getItem(STORAGE_KEY); } catch (_) {}
        if (stored) {
          return self.setLanguage(stored).then(function(lang) {
            self.observe();
            return lang;
          });
        }
        /* 2. Browser language detection. */
        var browserLang = self.detectBrowserLanguage();
        /* 3. Geo lookup for English browsers. */
        if (browserLang === DEFAULT_LANG) {
          return self._detectGeoLanguage().then(function (geoLang) {
            return self.setLanguage(geoLang || DEFAULT_LANG);
          }).then(function(lang) {
            self.observe();
            return lang;
          });
        }
        return self.setLanguage(browserLang).then(function(lang) {
          self.observe();
          return lang;
        });
      });
    },

    _detectGeoLanguage: function () {
      var GEO_MAP = {
        SA:'ar',AE:'ar',KW:'ar',QA:'ar',BH:'ar',OM:'ar',JO:'ar',
        IQ:'ar',EG:'ar',LY:'ar',TN:'ar',MA:'ar',DZ:'ar',SD:'ar',
        YE:'ar',SY:'ar',LB:'ar',PS:'ar',
        PK:'ur', IR:'fa', BD:'bn',
        IN:'hi', NP:'hi',
        CN:'zh', TW:'zh', HK:'zh', MO:'zh',
        JP:'ja', KR:'ko', TR:'tr', ID:'id',
        RU:'ru', KZ:'ru', BY:'ru',
        FR:'fr', MC:'fr', LU:'fr',
        DE:'de', AT:'de',
        ES:'es', MX:'es', AR:'es', CL:'es', CO:'es', PE:'es', VE:'es',
        BR:'pt', PT:'pt',
        IT:'it', SM:'it',
        NL:'nl', BE:'nl',
        PL:'pl',
      };
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve(null); }
        }, 1500);
        fetch('/api/geo', { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : {}; })
          .then(function (d) {
            clearTimeout(timer);
            if (!done) {
              done = true;
              var lang = d && d.country ? GEO_MAP[String(d.country).toUpperCase()] : null;
              resolve(lang || null);
            }
          })
          .catch(function () {
            clearTimeout(timer);
            if (!done) { done = true; resolve(null); }
          });
      });
    },
  };

  RuntimeI18n.audit = function () {
    var lang = RuntimeI18n.getLanguage ? RuntimeI18n.getLanguage() : 'en';
    var cache = RuntimeI18n._cache || {};
    var keys = cache[lang] ? Object.keys(cache[lang]) : [];
    console.group('[i18n audit] lang=' + lang + '  keys=' + keys.length);
    console.log('Cached languages:', Object.keys(cache));
    console.log('Sample keys:', keys.slice(0, 20));
    console.groupEnd();
    return { lang: lang, keyCount: keys.length, languages: Object.keys(cache) };
  };

  window.RuntimeI18n = RuntimeI18n;
  window.t = function (key, vars) { return RuntimeI18n.translate(key, vars); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { RuntimeI18n.init(); });
  } else {
    RuntimeI18n.init();
  }
})();
