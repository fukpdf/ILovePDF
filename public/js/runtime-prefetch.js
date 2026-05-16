// RuntimePrefetch v1.0 — Phase 28A-D
// Predictive prefetch engine. Intelligently preloads assets, routes,
// locales, and AI pipelines based on user behavior + device capability.
//
// Phase 28A — Predictive prefetch (tool adjacency model + history)
// Phase 28B — Smart chunk federation (idle prefetch, route-aware)
// Phase 28C — SW edge cache heat scoring (communicates with sw.js)
// Phase 28D — Adaptive asset loading (device tier → animation/quality)
//
// Does NOT touch BrowserTools, RuntimeAIScheduler, or any processing path.
// PURELY observational and additive.
//
// Exposed as: window.RuntimePrefetch

(function (G) {
  'use strict';

  if (G.RuntimePrefetch) return;

  var VERSION = '1.0';
  var LOG     = '[RP28]';
  var LS_HIST = 'iplv_pf_history';
  var MAX_HIST = 30;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }
  function _log(m) { console.debug(LOG, m); }

  // ── Tool adjacency model ─────────────────────────────────────────────────
  // Next most likely tools after visiting a tool (Markov-like weights)
  var ADJACENCY = {
    'merge':           ['split', 'compress', 'pdf-to-word', 'add-page-numbers'],
    'split':           ['merge', 'extract-pages', 'compress'],
    'compress':        ['merge', 'split', 'pdf-to-jpg'],
    'rotate':          ['merge', 'compress', 'pdf-to-jpg'],
    'watermark':       ['merge', 'compress', 'sign'],
    'sign':            ['watermark', 'protect', 'merge'],
    'protect':         ['sign', 'unlock', 'merge'],
    'unlock':          ['protect', 'merge', 'compress'],
    'ocr':             ['pdf-to-word', 'ai-summarize', 'compress'],
    'pdf-to-word':     ['pdf-to-excel', 'pdf-to-powerpoint', 'ocr'],
    'pdf-to-excel':    ['pdf-to-word', 'pdf-to-powerpoint', 'ocr'],
    'pdf-to-powerpoint':['pdf-to-word', 'pdf-to-excel', 'compress'],
    'pdf-to-jpg':      ['jpg-to-pdf', 'compress', 'background-remover'],
    'jpg-to-pdf':      ['pdf-to-jpg', 'merge', 'compress'],
    'word-to-pdf':     ['pdf-to-word', 'compress', 'merge'],
    'html-to-pdf':     ['compress', 'merge', 'watermark'],
    'ai-summarize':    ['ocr', 'translate', 'pdf-to-word'],
    'translate':       ['ai-summarize', 'ocr', 'pdf-to-word'],
    'background-remover':['image-filters', 'resize-image', 'crop-image'],
    'image-filters':   ['background-remover', 'resize-image', 'crop-image'],
    'crop-image':      ['resize-image', 'image-filters', 'background-remover'],
    'resize-image':    ['crop-image', 'image-filters', 'jpg-to-pdf'],
    'repair':          ['compress', 'merge', 'ocr'],
    'compare':         ['merge', 'split', 'compress'],
    'redact':          ['protect', 'sign', 'watermark'],
    'numbers-to-words':['currency-converter'],
    'currency-converter':['numbers-to-words'],
  };

  // Routes to prefetch when a tool is predicted
  var TOOL_ROUTE = function (slug) { return '/' + slug; };

  // ── History ────────────────────────────────────────────────────────────────
  function _loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (_) { return []; }
  }

  function _saveHistory(h) {
    try { localStorage.setItem(LS_HIST, JSON.stringify(h.slice(0, MAX_HIST))); } catch (_) {}
  }

  function recordVisit(toolSlug) {
    if (!toolSlug) return;
    var h = _loadHistory();
    h.unshift({ slug: toolSlug, ts: Date.now() });
    _saveHistory(h);
    // Notify SW to track heat
    _trackHeat(TOOL_ROUTE(toolSlug));
    // Kick prefetch after recording
    setTimeout(function () { _doPrefetch(toolSlug); }, 1000);
  }

  // ── Prediction ─────────────────────────────────────────────────────────────
  function predict(currentSlug) {
    var adjacentTools = ADJACENCY[currentSlug] || [];
    // Boost tools seen in recent history
    var h = _loadHistory();
    var recentSet = {};
    h.slice(0, 10).forEach(function (e) { recentSet[e.slug] = (recentSet[e.slug] || 0) + 1; });
    // Score each adjacent tool
    var scored = adjacentTools.map(function (slug) {
      return { slug: slug, score: 10 + (recentSet[slug] || 0) * 5 };
    });
    // Add any high-frequency recent tools not in adjacency
    Object.keys(recentSet).forEach(function (slug) {
      if (adjacentTools.indexOf(slug) === -1 && recentSet[slug] > 1) {
        scored.push({ slug: slug, score: recentSet[slug] * 3 });
      }
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var topTools = scored.slice(0, 5).map(function (e) { return e.slug; });
    return {
      tools:   topTools,
      routes:  topTools.map(TOOL_ROUTE),
      locales: _predictLocales(),
    };
  }

  function _predictLocales() {
    var current = _s(function () { return G.RuntimeI18n && G.RuntimeI18n.getLang && G.RuntimeI18n.getLang(); }, 'en');
    // Related locales by region: if user is on a non-English locale, they
    // might also need the RTL overrides or a neighbour locale
    var related = { en: [], ar: ['ur', 'fa'], ur: ['ar', 'fa'], fa: ['ar', 'ur'], hi: ['ur'], zh: [], fr: ['de', 'es'], de: ['fr'], es: ['pt'], pt: ['es'] };
    return (related[current] || []).slice(0, 2);
  }

  // ── Prefetch execution ─────────────────────────────────────────────────────
  var _prefetched = new Set();

  function prefetchRoute(url) {
    if (_prefetched.has(url)) return;
    _prefetched.add(url);
    try {
      // Method 1: <link rel=prefetch>
      var link = document.createElement('link');
      link.rel  = 'prefetch';
      link.href = url;
      link.as   = 'document';
      document.head.appendChild(link);
      // Method 2: Ask SW to cache it
      _swPrefetch([url]);
    } catch (_) {}
  }

  function prefetchAsset(url) {
    if (_prefetched.has(url)) return;
    _prefetched.add(url);
    try {
      var link = document.createElement('link');
      link.rel  = 'prefetch';
      link.href = url;
      document.head.appendChild(link);
    } catch (_) {}
  }

  function prefetchLocale(lang) {
    if (!lang || lang === 'en') return;
    prefetchAsset('/locales/' + lang + '.json');
  }

  // ── SW communication ────────────────────────────────────────────────────────
  function _swCtrl() {
    return _s(function () { return navigator.serviceWorker && navigator.serviceWorker.controller; });
  }

  function _swPrefetch(urls) {
    var ctrl = _swCtrl();
    if (!ctrl || !urls.length) return;
    try { ctrl.postMessage({ type: 'PREFETCH_URLS', urls: urls }); } catch (_) {}
  }

  function _trackHeat(url) {
    var ctrl = _swCtrl();
    if (!ctrl) return;
    try { ctrl.postMessage({ type: 'TRACK_URL', url: url }); } catch (_) {}
  }

  function getHeatMap() {
    return new Promise(function (resolve) {
      var ctrl = _swCtrl();
      if (!ctrl) { resolve([]); return; }
      try {
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) { resolve(e.data && e.data.hits || []); };
        ctrl.postMessage({ type: 'HEAT_REPORT' }, [ch.port2]);
        setTimeout(function () { resolve([]); }, 2000);
      } catch (_) { resolve([]); }
    });
  }

  // ── Device-adaptive loading ────────────────────────────────────────────────
  var _deviceClass = null;

  function getDeviceClass() {
    if (_deviceClass) return _deviceClass;
    var score = _s(function () { return G.RuntimeAIScheduler && G.RuntimeAIScheduler.getDeviceProfile().score; }, 50);
    _deviceClass = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
    return _deviceClass;
  }

  function applyAdaptiveMode() {
    var cls = getDeviceClass();
    var root = document.documentElement;

    if (cls === 'low') {
      // Reduce animation intensity
      root.setAttribute('data-perf', 'reduced');
      _injectAdaptiveCSS('reduced');
    } else if (cls === 'high') {
      root.setAttribute('data-perf', 'enhanced');
      _injectAdaptiveCSS('enhanced');
    } else {
      root.setAttribute('data-perf', 'standard');
    }

    _log('adaptive mode applied: ' + cls);
    return cls;
  }

  function _injectAdaptiveCSS(mode) {
    if (document.getElementById('iplv-adaptive-' + mode)) return;
    var s = document.createElement('style');
    s.id = 'iplv-adaptive-' + mode;
    if (mode === 'reduced') {
      s.textContent = [
        '[data-perf="reduced"] *{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;}',
        '[data-perf="reduced"] .blur-bg{backdrop-filter:none!important;filter:none!important;}',
        '[data-perf="reduced"] canvas.preview{image-rendering:optimizeSpeed;}',
        '[data-perf="reduced"] .hero-bg,.hero-gradient{background-image:none!important;}',
      ].join('');
    } else if (mode === 'enhanced') {
      s.textContent = [
        '[data-perf="enhanced"] .tool-card{transition:transform 0.2s ease,box-shadow 0.2s ease;}',
        '[data-perf="enhanced"] .tool-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.15);}',
      ].join('');
    }
    document.head.appendChild(s);
  }

  // ── Chunk federation (idle prefetch) ──────────────────────────────────────
  // Uses requestIdleCallback to prefetch predicted tool routes when browser is idle
  function _idlePrefetch(slug) {
    var fn = function () {
      var pred = predict(slug);
      pred.routes.slice(0, 3).forEach(function (url) { prefetchRoute(url); });
      pred.locales.forEach(function (lang) { prefetchLocale(lang); });
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(fn, { timeout: 3000 });
    } else {
      setTimeout(fn, 2000);
    }
  }

  function _doPrefetch(slug) {
    var cls = getDeviceClass();
    if (cls === 'low') return; // don't waste bandwidth on weak devices
    _idlePrefetch(slug);
  }

  // ── Auto-detect current page ───────────────────────────────────────────────
  function _detectCurrentTool() {
    var slug = location.pathname.replace(/^\//, '').split('/')[0];
    if (slug && slug !== '' && slug !== 'admin') {
      recordVisit(slug);
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function _init() {
    applyAdaptiveMode();
    _detectCurrentTool();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimePrefetch = {
    VERSION:          VERSION,
    predict:          predict,
    recordVisit:      recordVisit,
    prefetchRoute:    prefetchRoute,
    prefetchAsset:    prefetchAsset,
    prefetchLocale:   prefetchLocale,
    getHeatMap:       getHeatMap,
    getDeviceClass:   getDeviceClass,
    applyAdaptiveMode:applyAdaptiveMode,

    audit: function () {
      var pred = predict(location.pathname.replace(/^\//, '').split('/')[0]);
      console.group(LOG + ' RuntimePrefetch audit');
      console.log('Device class:', getDeviceClass());
      console.log('Predicted tools:', pred.tools);
      console.log('Predicted routes:', pred.routes);
      console.log('History length:', _loadHistory().length);
      console.log('Prefetched URLs:', _prefetched.size);
      console.groupEnd();
      return { deviceClass: getDeviceClass(), prediction: pred };
    },
  };

  G.RuntimePrefetch = RuntimePrefetch;
  _log('v' + VERSION + ' ready — device class: ' + getDeviceClass());

}(window));
