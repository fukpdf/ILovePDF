// RuntimePredictiveLoader v1.0 — Arc 7 / Phase B
// =====================================================================
// Processor-level predictive loading. Distinct from RuntimePrefetch
// (which prefetches assets/routes) — this specifically predicts which
// TOOL PROCESSOR will be needed next and activates it proactively.
//
// Prediction signals:
//   - Hover (300ms dwell on a tool card → activate its processor)
//   - Navigation (popstate/pushState → detect incoming tool)
//   - Recent tool history (last 5 tools stored in sessionStorage)
//   - Usage pattern learning (frequency map in sessionStorage)
//   - Adjacency model (tools used together more likely to be used again)
//
// Actions taken on prediction:
//   - RuntimeProcessorLoader.activate(family)
//   - WorkerPool.prewarm(workerUrl)
//   - RuntimeStreamingHydration.schedule(P1 modules)
//
// Cancellation: memory pressure > 80% → suspend all preloads.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimePredictiveLoader) return;

  var LOG     = '[PredictLoader]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var HOVER_DWELL_MS    = 300;   // hover dwell before preload
  var HISTORY_KEY       = 'ilpdf_tool_history';
  var FREQ_KEY          = 'ilpdf_tool_freq';
  var MAX_HISTORY       = 10;
  var MEM_CANCEL_PCT    = 0.80;  // suspend preloads above 80% heap
  var PRELOAD_COOLDOWN  = 60 * 1000; // don't re-preload same family within 1 min

  // ── Tool → processor family map ──────────────────────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'split','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'merge-pdf':'organize','split-pdf':'split','rotate-pdf':'organize',
    'compress':'compress','compress-pdf':'compress',
    'pdf-to-word':'convert','pdf-to-excel':'convert','pdf-to-powerpoint':'convert',
    'word-to-pdf':'convert','excel-to-pdf':'convert','powerpoint-to-pdf':'convert',
    'jpg-to-pdf':'organize','pdf-to-jpg':'organize','html-to-pdf':'organize',
    'watermark':'edit','sign':'edit','protect':'edit','unlock':'edit','edit':'edit',
    'repair':'repair','compare':'edit',
    'ocr':'ocr','ocr-pdf':'ocr',
    'ai-summarize':'ai-nlp','ai-summarizer':'ai-nlp','translate':'ai-nlp',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Adjacency model (co-use probabilities) ────────────────────────
  // family A used → often followed by family B
  var ADJACENCY = {
    'organize': ['compress', 'convert'],
    'convert':  ['edit', 'ocr'],
    'compress': ['organize', 'convert'],
    'ocr':      ['convert', 'ai-nlp'],
    'ai-nlp':   ['convert', 'edit'],
    'edit':     ['compress', 'organize'],
    'image':    ['compress', 'organize'],
    'repair':   ['ocr', 'convert'],
    'split':    ['compress', 'convert'],
  };

  // ── Worker URLs per family ────────────────────────────────────────
  var FAMILY_WORKER = {
    'organize':  '/workers/pdf-lib-worker.js',
    'split':     '/workers/pdf-lib-worker.js',
    'compress':  '/workers/compress-worker.js',
    'convert':   '/workers/pdf-word-docx-worker.js',
    'edit':      '/workers/pdf-lib-worker.js',
    'repair':    '/workers/repair-worker.js',
    'ocr':       '/workers/advanced-worker.js',
    'ai-nlp':    '/workers/summary-worker.js',
    'image':     '/workers/image-tools-worker.js',
  };

  // ── State ─────────────────────────────────────────────────────────
  var _lastPreloadAt  = {};  // family → timestamp
  var _hoverTimers    = {};  // toolId → timer
  var _history        = [];
  var _freq           = {};
  var _telemetry      = [];
  var _metrics        = { predictions: 0, preloads: 0, cancelled: 0, hits: 0 };
  var _suspended      = false;

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── Load history + freq from sessionStorage ───────────────────────
  function _loadSession() {
    try {
      var h = sessionStorage.getItem(HISTORY_KEY);
      if (h) _history = JSON.parse(h).slice(-MAX_HISTORY);
      var f = sessionStorage.getItem(FREQ_KEY);
      if (f) _freq = JSON.parse(f);
    } catch (_) {}
  }

  function _saveSession() {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(_history.slice(-MAX_HISTORY)));
      sessionStorage.setItem(FREQ_KEY, JSON.stringify(_freq));
    } catch (_) {}
  }

  // ── Record a tool use ─────────────────────────────────────────────
  function recordUse(toolId) {
    if (!toolId) return;
    _history.push(toolId);
    if (_history.length > MAX_HISTORY) _history.shift();
    _freq[toolId] = (_freq[toolId] || 0) + 1;
    _metrics.hits++;
    _saveSession();

    // Proactively preload adjacent families
    var family = TOOL_FAMILY[toolId];
    if (family && ADJACENCY[family]) {
      ADJACENCY[family].forEach(function (adj) {
        setTimeout(function () { _preload(adj, 'adjacency'); }, 500);
      });
    }
  }

  // ── Memory pressure check ─────────────────────────────────────────
  function _memOk() {
    try {
      var pm = performance.memory;
      if (!pm) return true;
      return (pm.usedJSHeapSize / pm.jsHeapSizeLimit) < MEM_CANCEL_PCT;
    } catch (_) { return true; }
  }

  // ── Preload a family's processor ──────────────────────────────────
  function _preload(family, signal) {
    if (_suspended) { _metrics.cancelled++; return; }
    if (!_memOk())  { _suspended = true; _metrics.cancelled++; _tel('suspended', {}); return; }
    var now  = Date.now();
    var last = _lastPreloadAt[family] || 0;
    if (now - last < PRELOAD_COOLDOWN) return; // cooled down
    _lastPreloadAt[family] = now;
    _metrics.preloads++;

    // 1. Activate processor
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr && ldr.activate) ldr.activate(family);
    } catch (_) {}

    // 2. Prewarm worker
    var workerUrl = FAMILY_WORKER[family];
    if (workerUrl) {
      try {
        var wp = G.WorkerPool;
        if (wp && wp.prewarm) wp.prewarm(workerUrl);
      } catch (_) {}
    }

    _tel('preload', { family: family, signal: signal });
    console.debug(LOG, 'preloaded:', family, '(' + signal + ')');

    try {
      G.dispatchEvent(new CustomEvent('predictive-loader:preload', {
        detail: { family: family, signal: signal },
      }));
    } catch (_) {}
  }

  // ── Hover prediction ─────────────────────────────────────────────
  function _installHover() {
    document.addEventListener('mouseover', function (e) {
      var el = e.target && e.target.closest && e.target.closest('[data-tool]');
      if (!el) return;
      var toolId = el.getAttribute('data-tool');
      if (!toolId || _hoverTimers[toolId]) return;
      _hoverTimers[toolId] = setTimeout(function () {
        delete _hoverTimers[toolId];
        var family = TOOL_FAMILY[toolId];
        if (family) { _metrics.predictions++; _preload(family, 'hover'); }
      }, HOVER_DWELL_MS);
    }, { passive: true });

    document.addEventListener('mouseout', function (e) {
      var el = e.target && e.target.closest && e.target.closest('[data-tool]');
      if (!el) return;
      var toolId = el.getAttribute('data-tool');
      if (toolId && _hoverTimers[toolId]) {
        clearTimeout(_hoverTimers[toolId]);
        delete _hoverTimers[toolId];
      }
    }, { passive: true });
  }

  // ── Navigation prediction ─────────────────────────────────────────
  function _installNavPrediction() {
    // Intercept pushState / popstate to predict destination tool
    var origPush = history.pushState;
    try {
      history.pushState = function (state, title, url) {
        var r = origPush.apply(this, arguments);
        _predictFromUrl(url || '');
        return r;
      };
    } catch (_) {}
    G.addEventListener('popstate', function () { _predictFromUrl(location.pathname); });
  }

  function _predictFromUrl(url) {
    var match = String(url).match(/\/tool\/([^/?#]+)/);
    var toolId = match && match[1];
    if (!toolId) return;
    var family = TOOL_FAMILY[toolId];
    if (family) { _metrics.predictions++; _preload(family, 'navigation'); }
  }

  // ── Recent-tool prediction on page load ───────────────────────────
  function _predictFromHistory() {
    if (!_history.length) return;
    var recent = _history[_history.length - 1];
    var family = TOOL_FAMILY[recent];
    if (family) { _metrics.predictions++; _preload(family, 'recent-history'); }

    // Also predict top-2 by frequency
    var sorted = Object.keys(_freq).sort(function (a, b) { return _freq[b] - _freq[a]; });
    sorted.slice(0, 2).forEach(function (toolId) {
      var fam = TOOL_FAMILY[toolId];
      if (fam && fam !== family) {
        setTimeout(function () { _preload(fam, 'frequency'); }, 1000);
      }
    });
  }

  // ── Release suspension on memory improvement ──────────────────────
  setInterval(function () {
    if (_suspended && _memOk()) {
      _suspended = false;
      _tel('resumed', {});
    }
  }, 30000);

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    _loadSession();
    _installHover();
    _installNavPrediction();
    setTimeout(_predictFromHistory, 2000); // after page settle

    // Record current page tool
    try {
      var body = document.body;
      if (body) {
        var toolId = body.getAttribute('data-tool') || (location.pathname.match(/\/tool\/([^/?#]+)/) || [])[1];
        if (toolId) recordUse(toolId);
      }
    } catch (_) {}

    console.debug(LOG, 'v' + VERSION + ' ready | history:', _history.length, 'tools | freq:', Object.keys(_freq).length);
  }

  // Intercept tool:runtime-ready to record uses + drive adjacency
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (id) recordUse(id);
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimePredictiveLoader = Object.freeze({
    VERSION:      VERSION,
    recordUse:    recordUse,
    preload:      function (family) { _preload(family, 'manual'); },
    isSuspended:  function () { return _suspended; },
    getMetrics:   function () { return Object.assign({}, _metrics); },
    getHistory:   function () { return _history.slice(); },
    getFrequency: function () { return Object.assign({}, _freq); },
    getTelemetry: function () { return _telemetry.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — hover/nav/history/frequency prediction active');

}(window));
