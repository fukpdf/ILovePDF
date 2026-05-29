// ── Arc 7 Ultra Performance + Streaming Runtime — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-29T10:30:45.737Z  BUILD_ID: mpqs70k8
// Files: 8

// ── SOURCE: public/js/runtime-streaming-hydration.js ──
// RuntimeStreamingHydration v1.0 — Arc 7 / Phase A
// =====================================================================
// Streaming tool hydration: viewport-aware + interaction-driven +
// predictive + chunk-scheduled. Distinct from RuntimeHydrationScheduler
// (which manages P0/P1/P2 tier ordering globally) — this file manages
// WHEN hydration begins based on what the user is looking at and doing.
//
// Techniques:
//   - IntersectionObserver: hydrate tool sections as they scroll into view
//   - Interaction-driven: first pointer/touch triggers high-priority flush
//   - Chunk scheduler: splits heavy hydration into idle micro-batches
//     (requestIdleCallback with deadline.timeRemaining budget)
//   - Ultra-low-end fallback: single module per animation frame on <2 cores
//   - First-interaction latency tracker: measures hydration-to-ready gap
//
// Works alongside RuntimeHydrationDomains (Arc 3) and
// RuntimeProcessorHydration (Arc 6) — does NOT replace them.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamingHydration) return;

  var LOG     = '[StreamHydration]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  var _cores  = (navigator.hardwareConcurrency || 2);
  var _isLow  = _cores <= 2;
  var _isMid  = _cores <= 4 && !_isLow;

  // ── Config ────────────────────────────────────────────────────────
  var CHUNK_BUDGET_MS  = _isLow ? 5 : _isMid ? 10 : 16;  // idle time per chunk
  var CHUNK_INTERVAL   = _isLow ? 200 : _isMid ? 100 : 50;
  var INTERACT_FLUSH   = true;   // flush pending on first interaction

  // ── State ─────────────────────────────────────────────────────────
  var _queue         = [];      // { fn, name, priority, ts }
  var _running       = false;
  var _firstInteract = false;
  var _interactAt    = null;
  var _hydrationMap  = {};      // selector → { hydrated, ts, modules[] }
  var _telemetry     = [];
  var _metrics       = { chunksRun: 0, modulesHydrated: 0, avgChunkMs: 0, p99Ms: 0,
                         firstInteractMs: null, viewportMs: null };
  var _chunkTimes    = [];

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── Queue a hydration module ──────────────────────────────────────
  function schedule(name, fn, priority) {
    if (typeof fn !== 'function') return;
    _queue.push({ fn: fn, name: name || 'anon',
                  priority: priority || 0, ts: Date.now() });
    _queue.sort(function (a, b) { return b.priority - a.priority; });
    if (!_running) _scheduleChunk();
  }

  // ── Chunk runner via requestIdleCallback / setTimeout fallback ────
  function _scheduleChunk() {
    if (_running || !_queue.length) return;
    _running = true;
    var run = typeof G.requestIdleCallback === 'function'
      ? function () { G.requestIdleCallback(_runChunk, { timeout: 500 }); }
      : function () { setTimeout(_runChunkSimple, CHUNK_INTERVAL); };
    run();
  }

  function _runChunk(deadline) {
    _running = false;
    var t0 = Date.now();
    var ran = 0;
    while (_queue.length && deadline.timeRemaining() > CHUNK_BUDGET_MS) {
      var item = _queue.shift();
      _runModule(item);
      ran++;
    }
    _recordChunk(Date.now() - t0, ran);
    if (_queue.length) _scheduleChunk();
  }

  function _runChunkSimple() {
    _running = false;
    var t0 = Date.now();
    if (_isLow) {
      // Ultra-low: one module per frame only
      if (_queue.length) _runModule(_queue.shift());
    } else {
      var budget = CHUNK_BUDGET_MS;
      var ran = 0;
      while (_queue.length && (Date.now() - t0) < budget) {
        _runModule(_queue.shift());
        ran++;
      }
    }
    _recordChunk(Date.now() - t0, 1);
    if (_queue.length) _scheduleChunk();
  }

  function _runModule(item) {
    try {
      var t = Date.now();
      item.fn();
      _metrics.modulesHydrated++;
      _tel('module', { name: item.name, ms: Date.now() - t });
    } catch (e) {
      _tel('module-err', { name: item.name, err: e && e.message });
    }
  }

  function _recordChunk(ms, count) {
    _metrics.chunksRun++;
    _chunkTimes.push(ms);
    if (_chunkTimes.length > 50) _chunkTimes.shift();
    var sorted = _chunkTimes.slice().sort(function (a, b) { return a - b; });
    _metrics.avgChunkMs = Math.round(sorted.reduce(function (a, b) { return a + b; }, 0) / sorted.length);
    _metrics.p99Ms      = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1] || 0;
    _tel('chunk', { ms: ms, count: count, queue: _queue.length });
  }

  // ── Interaction flush ─────────────────────────────────────────────
  function _onFirstInteraction() {
    if (_firstInteract) return;
    _firstInteract  = true;
    _interactAt     = Date.now();
    _metrics.firstInteractMs = _interactAt;
    _tel('first-interact', { queue: _queue.length });

    if (INTERACT_FLUSH && _queue.length) {
      // Promote all queued items to priority 10 and drain immediately
      _queue.forEach(function (item) { item.priority = Math.max(item.priority, 10); });
      setTimeout(function () {
        while (_queue.length) _runModule(_queue.shift());
        _tel('flush-complete', {});
      }, 0);
    }

    // Activate P1 + P2 on RuntimeHydrationScheduler
    try {
      var hs = G.RuntimeHydrationScheduler;
      if (hs && hs.activate) { hs.activate('P1'); hs.activate('P2'); }
    } catch (_) {}

    // Drive RuntimeProcessorHydration to force-activate on current tool
    try {
      var ph = G.RuntimeProcessorHydration;
      var toolId = document.body && document.body.getAttribute('data-tool');
      if (ph && ph.forceActivate && toolId) ph.forceActivate(toolId);
    } catch (_) {}
  }

  // ── Viewport-aware hydration via IntersectionObserver ─────────────
  var _observer = null;
  function _installViewportObserver() {
    if (!G.IntersectionObserver) return;
    _observer = new G.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el     = entry.target;
        var toolId = el.getAttribute('data-tool') || el.getAttribute('data-section');
        if (!toolId || (_hydrationMap[toolId] && _hydrationMap[toolId].hydrated)) return;
        _hydrationMap[toolId] = { hydrated: true, ts: Date.now(), modules: [] };
        _metrics.viewportMs   = Date.now();
        _tel('viewport', { toolId: toolId });
        _observer && _observer.unobserve(el);

        // Drive processor hydration for in-view tool
        try {
          var ldr = G.RuntimeProcessorLoader;
          if (ldr && ldr.activateForTool) ldr.activateForTool(toolId);
        } catch (_) {}

        try {
          G.dispatchEvent(new CustomEvent('streaming-hydration:viewport', {
            detail: { toolId: toolId },
          }));
        } catch (_) {}
      });
    }, { rootMargin: '100px', threshold: 0.1 });

    // Observe all tool sections/cards on the page
    try {
      document.querySelectorAll('[data-tool], [data-section]').forEach(function (el) {
        _observer && _observer.observe(el);
      });
    } catch (_) {}
  }

  // ── Predictive: activate P1 when tool section is 200px away ──────
  function _installScrollPredict() {
    if (_isLow) return; // skip on very weak devices
    try {
      var pred = new G.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var toolId = entry.target.getAttribute('data-tool');
          if (!toolId) return;
          try {
            var hd = G.RuntimeHydrationDomains;
            if (hd && hd.activate) hd.activate(toolId, 'P1');
          } catch (_) {}
        });
      }, { rootMargin: '200px', threshold: 0 });
      document.querySelectorAll('[data-tool]').forEach(function (el) { pred.observe(el); });
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    // Interaction listeners
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, _onFirstInteraction, { once: true, passive: true });
    });

    _installViewportObserver();
    _installScrollPredict();

    _tel('boot', { cores: _cores, isLow: _isLow, chunkBudgetMs: CHUNK_BUDGET_MS });
    console.debug(LOG, 'v' + VERSION + ' ready — cores:', _cores, '| chunk budget:', CHUNK_BUDGET_MS + 'ms');

    try {
      G.dispatchEvent(new CustomEvent('arc7:streaming-hydration-ready', {
        detail: { version: VERSION, isLow: _isLow },
      }));
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeStreamingHydration = Object.freeze({
    VERSION:    VERSION,
    schedule:   schedule,
    getMetrics: function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _telemetry.slice(); },
    getQueueLength: function () { return _queue.length; },
    isLowEnd:   function () { return _isLow; },
    flush:      _onFirstInteraction,
  });

}(window));

// ── SOURCE: public/js/runtime-predictive-loader.js ──
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

// ── SOURCE: public/js/runtime-stream-workers.js ──
// RuntimeStreamWorkers v1.0 — Arc 7 / Phase C
// =====================================================================
// Chunked processing coordinator. Sits ABOVE RuntimeStreamBridge
// (which handles the byte transport) and RuntimeStreamPipeline
// (which handles backpressure) — this manages EXECUTION SCHEDULING:
//
//   - Micro-batch scheduling: breaks long CPU tasks into yielding chunks
//     using requestIdleCallback + deadline.timeRemaining()
//   - Partial completion checkpoints: saves progress to IDB so a
//     tab-reload or crash can resume from the last checkpoint
//   - Tab suspension detection: pauses on visibilitychange, resumes
//     when the tab becomes visible again
//   - Progressive progress events: streams 0–100% progress so the UI
//     can show live updates without waiting for completion
//   - Continuation tokens: callers get a token to query or cancel
//
// Does NOT replace WorkerPool or StreamBridge — extends them.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamWorkers) return;

  var LOG     = '[StreamWorkers]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var _cores        = navigator.hardwareConcurrency || 2;
  var MICRO_MS      = _cores <= 2 ? 8 : _cores <= 4 ? 12 : 16;
  var YIELD_FREQ    = 5;   // yield every N chunks regardless
  var SUSPEND_PAUSE = true;
  var IDB_TTL_MS    = 4 * 60 * 60 * 1000; // 4 hr checkpoint TTL

  // ── Execution state ───────────────────────────────────────────────
  var _tokens   = {};   // token → { state, onProgress, onComplete, onError, chunks[] }
  var _paused   = false;
  var _metrics  = { tasks: 0, completed: 0, suspended: 0, resumed: 0, checkpoints: 0, errors: 0 };
  var _telemetry = [];

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  function _genToken() {
    return 'swt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ── Checkpoint: save progress to IDB ──────────────────────────────
  var _idbName = 'ilpdf-stream-workers';
  var _idbVer  = 1;
  var _idb     = null;

  function _openIdb() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(_idbName, _idbVer);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore('checkpoints', { keyPath: 'token' });
      };
      req.onsuccess = function () { _idb = req.result; res(_idb); };
      req.onerror   = function () { rej(req.error); };
    });
  }

  function _saveCheckpoint(token, data) {
    _metrics.checkpoints++;
    _openIdb().then(function (db) {
      var tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put({ token: token, ts: Date.now(), data: data });
    }).catch(function () {});
  }

  function _loadCheckpoint(token) {
    return _openIdb().then(function (db) {
      return new Promise(function (res) {
        var tx  = db.transaction('checkpoints', 'readonly');
        var req = tx.objectStore('checkpoints').get(token);
        req.onsuccess = function () {
          var rec = req.result;
          if (!rec || (Date.now() - rec.ts) > IDB_TTL_MS) { res(null); return; }
          res(rec.data);
        };
        req.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }

  function _clearCheckpoint(token) {
    _openIdb().then(function (db) {
      var tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').delete(token);
    }).catch(function () {});
  }

  // ── Micro-batch runner ────────────────────────────────────────────
  function _runBatch(token) {
    var task = _tokens[token];
    if (!task || task.state === 'done' || task.state === 'error') return;
    if (_paused) { task.state = 'suspended'; return; }
    task.state = 'running';

    var run = function (deadline) {
      if (_paused || !_tokens[token]) return;
      var ran = 0;
      while (task.chunks.length > 0) {
        var ok = deadline ? (deadline.timeRemaining() > MICRO_MS) : true;
        if (!ok && ran > 0) break;
        if (ran >= YIELD_FREQ) break;

        var chunk = task.chunks.shift();
        try {
          var result = chunk.fn(chunk.data);
          ran++;
          task.processedBytes += (chunk.bytes || 0);
          task.processedChunks++;

          var pct = task.totalChunks > 0
            ? Math.round((task.processedChunks / task.totalChunks) * 100)
            : -1;
          try { task.onProgress && task.onProgress(pct, result); } catch (_) {}

          // Checkpoint every 10 chunks
          if (task.processedChunks % 10 === 0) {
            _saveCheckpoint(token, { processedChunks: task.processedChunks, totalChunks: task.totalChunks });
          }

          try {
            G.dispatchEvent(new CustomEvent('stream-workers:progress', {
              detail: { token: token, pct: pct, chunk: task.processedChunks, total: task.totalChunks },
            }));
          } catch (_) {}
        } catch (e) {
          task.state = 'error';
          _metrics.errors++;
          try { task.onError && task.onError(e); } catch (_) {}
          _tel('error', { token: token, err: e && e.message });
          return;
        }
      }

      if (task.chunks.length === 0) {
        // All done
        task.state     = 'done';
        task.doneAt    = Date.now();
        task.durationMs = task.doneAt - task.startedAt;
        _metrics.completed++;
        _clearCheckpoint(token);
        try { task.onComplete && task.onComplete(); } catch (_) {}
        _tel('done', { token: token, ms: task.durationMs, chunks: task.processedChunks });
        console.debug(LOG, 'task done:', token, '—', task.durationMs + 'ms |', task.processedChunks, 'chunks');
      } else {
        // More chunks remaining — yield and re-schedule
        if (typeof G.requestIdleCallback === 'function') {
          G.requestIdleCallback(run, { timeout: 2000 });
        } else {
          setTimeout(function () { run(null); }, 16);
        }
      }
    };

    if (typeof G.requestIdleCallback === 'function') {
      G.requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(function () { run(null); }, 0);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  // Submit a chunked task. Returns a continuation token.
  // chunks: [{ fn: Function, data: any, bytes?: number }]
  function submit(spec) {
    var token = _genToken();
    var chunks = spec.chunks || [];
    _tokens[token] = {
      token:           token,
      state:           'queued',
      chunks:          chunks.slice(),
      totalChunks:     chunks.length,
      processedChunks: 0,
      processedBytes:  0,
      totalBytes:      spec.totalBytes || 0,
      startedAt:       Date.now(),
      doneAt:          null,
      durationMs:      null,
      onProgress:      spec.onProgress  || null,
      onComplete:      spec.onComplete  || null,
      onError:         spec.onError     || null,
    };
    _metrics.tasks++;
    _tel('submit', { token: token, chunks: chunks.length });
    setTimeout(function () { _runBatch(token); }, 0);
    return token;
  }

  function cancel(token) {
    var task = _tokens[token];
    if (task) { task.state = 'cancelled'; task.chunks = []; }
    _clearCheckpoint(token);
    delete _tokens[token];
  }

  function getState(token) {
    var task = _tokens[token];
    if (!task) return null;
    return {
      state: task.state, pct: task.totalChunks > 0
        ? Math.round((task.processedChunks / task.totalChunks) * 100) : -1,
      processedChunks: task.processedChunks, totalChunks: task.totalChunks,
    };
  }

  // ── Tab suspension ────────────────────────────────────────────────
  if (SUSPEND_PAUSE) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        _paused = true;
        _metrics.suspended++;
        _tel('suspended', { active: Object.keys(_tokens).length });
        console.debug(LOG, 'suspended — tab hidden');
      } else {
        _paused = false;
        _metrics.resumed++;
        _tel('resumed', {});
        console.debug(LOG, 'resumed — tab visible');
        // Resume all suspended tasks
        Object.keys(_tokens).forEach(function (token) {
          var task = _tokens[token];
          if (task && task.state === 'suspended' && task.chunks.length > 0) {
            _runBatch(token);
          }
        });
      }
    });
  }

  G.RuntimeStreamWorkers = Object.freeze({
    VERSION:      VERSION,
    submit:       submit,
    cancel:       cancel,
    getState:     getState,
    getMetrics:   function () { return Object.assign({}, _metrics); },
    getTelemetry: function () { return _telemetry.slice(); },
    isPaused:     function () { return _paused; },
    loadCheckpoint: _loadCheckpoint,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — micro-batch chunked execution active | yield:', MICRO_MS + 'ms');

}(window));

// ── SOURCE: public/js/runtime-task-orchestrator.js ──
// RuntimeTaskOrchestrator v1.0 — Arc 7 / Phase D
// =====================================================================
// Enterprise task orchestration. Distinct from RuntimeTaskScheduler
// (Phase 2 priority queue) — this provides the EXECUTION GRAPH layer:
//
//   - Task priority lanes: CRITICAL / HIGH / NORMAL / LOW / BACKGROUND
//   - Cooperative scheduling: yields to UI between task batches
//   - Runtime execution graph: tasks declare dependencies; graph resolves order
//   - Worker affinity: task types routed to preferred worker families
//   - Congestion prediction: queue depth + thermal tier → throttle
//   - Thermal-aware execution: reduce concurrency under heat pressure
//
// AI jobs never block simple tool operations (CRITICAL lane reserved for UI).
// Large OCR/translate jobs auto-throttled to BACKGROUND under pressure.
//
// Integrates with RuntimeProcessorWorkers (Arc 6) for pool coordination.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeTaskOrchestrator) return;

  var LOG     = '[TaskOrchestrator]';
  var VERSION = '1.0';

  // ── Priority lanes ────────────────────────────────────────────────
  var CRITICAL   = 0;  // UI-blocking — run immediately
  var HIGH       = 1;  // Interactive user operation
  var NORMAL     = 2;  // Standard tool processing
  var LOW        = 3;  // Background processing
  var BACKGROUND = 4;  // Deferred / deprioritized

  var LANE_NAMES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'];

  // ── Config ────────────────────────────────────────────────────────
  var _cores        = navigator.hardwareConcurrency || 2;
  var MAX_CONCUR    = { 0: 4, 1: 3, 2: 2, 3: 1, 4: 1 };  // per lane
  var TICK_MS       = 16;   // cooperative scheduling interval
  var THERMAL_CHECK = 30 * 1000;

  // ── Worker affinity per task type ─────────────────────────────────
  var TYPE_AFFINITY = {
    'compress':    'compress',
    'merge':       'organize',
    'split':       'split',
    'ocr':         'ocr',
    'translate':   'ai-nlp',
    'ai-summarize':'ai-nlp',
    'convert':     'convert',
    'watermark':   'edit',
    'repair':      'repair',
    'image':       'image',
  };

  // ── State ─────────────────────────────────────────────────────────
  var _lanes       = [[], [], [], [], []];  // per-priority queue
  var _graph       = {};  // taskId → { deps: [], state, fn, priority, meta }
  var _running     = {};  // taskId → { startedAt, lane }
  var _runningCount = 0;
  var _thermalTier = 'nominal';
  var _ticking     = false;
  var _metrics     = { submitted: 0, completed: 0, dropped: 0, throttled: 0, graphResolved: 0 };
  var _telemetry   = [];
  var _idSeq       = 0;

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  function _genId() { return 'orch_' + (++_idSeq) + '_' + Date.now().toString(36); }

  // ── Thermal tier ──────────────────────────────────────────────────
  function _refreshThermal() {
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) { _thermalTier = pw.getThermalTier() || 'nominal'; return; }
      var ai = G.RuntimeAIScheduler;
      if (ai && ai.getProfile) { _thermalTier = (ai.getProfile().thermal) || 'nominal'; }
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  function _maxConcurrency() {
    // Reduce under thermal pressure
    var base = Math.max(1, _cores - 1);
    if (_thermalTier === 'critical') return 1;
    if (_thermalTier === 'hot')      return Math.min(2, base);
    return base;
  }

  function _laneLimit(lane) {
    var max = MAX_CONCUR[lane] || 1;
    var thermal = _maxConcurrency();
    return lane === CRITICAL ? Math.min(max, thermal + 2) : Math.min(max, thermal);
  }

  // ── Submit a task ─────────────────────────────────────────────────
  // spec: { fn, priority?, type?, deps?, onComplete?, onError?, meta? }
  function submit(spec) {
    if (typeof spec.fn !== 'function') return null;
    var id       = _genId();
    var priority = Math.max(0, Math.min(4, spec.priority || NORMAL));
    var task     = {
      id:         id,
      fn:         spec.fn,
      priority:   priority,
      type:       spec.type    || 'generic',
      deps:       spec.deps    || [],
      onComplete: spec.onComplete || null,
      onError:    spec.onError    || null,
      meta:       spec.meta       || {},
      state:      'queued',
      submittedAt: Date.now(),
    };

    _graph[id] = task;
    _metrics.submitted++;
    _tel('submit', { id: id, lane: LANE_NAMES[priority], type: task.type, deps: task.deps.length });

    // Resolve graph immediately if no deps
    if (task.deps.length === 0) {
      _enqueue(task);
    } else {
      task.state = 'waiting';
    }

    if (!_ticking) _tick();
    return id;
  }

  function _enqueue(task) {
    _lanes[task.priority].push(task);
    task.state = 'ready';
  }

  // ── Check if a task's deps are all done ──────────────────────────
  function _depsResolved(task) {
    return task.deps.every(function (depId) {
      var dep = _graph[depId];
      return dep && dep.state === 'done';
    });
  }

  // ── Tick: cooperative scheduler ───────────────────────────────────
  function _tick() {
    _ticking = true;
    var ran  = 0;

    // Promote waiting tasks whose deps are now resolved
    Object.keys(_graph).forEach(function (id) {
      var task = _graph[id];
      if (task.state === 'waiting' && _depsResolved(task)) {
        _enqueue(task);
        _metrics.graphResolved++;
        _tel('graph-resolved', { id: id });
      }
    });

    // Congestion check
    var maxConc = _maxConcurrency();
    if (_runningCount >= maxConc) {
      _metrics.throttled++;
      setTimeout(_tick, TICK_MS * 4);
      return;
    }

    // Run tasks from highest to lowest priority
    for (var lane = CRITICAL; lane <= BACKGROUND; lane++) {
      var queue   = _lanes[lane];
      var laneMax = _laneLimit(lane);
      var laneRun = 0;

      while (queue.length && _runningCount < maxConc && laneRun < laneMax) {
        var task = queue.shift();
        if (!task || task.state === 'cancelled') continue;

        // Affinity: check if worker pool can accept
        var affFamily = TYPE_AFFINITY[task.type];
        if (affFamily) {
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && !pw.canAccept(affFamily)) {
              // Re-queue at lower priority if pool congested
              if (task.priority < BACKGROUND) {
                task.priority++;
                _lanes[task.priority].push(task);
                _metrics.throttled++;
                _tel('affinity-throttle', { id: task.id, family: affFamily });
              } else {
                _metrics.dropped++;
                task.state = 'dropped';
              }
              continue;
            }
            pw.taskStart && pw.taskStart(affFamily);
          } catch (_) {}
        }

        _runTask(task, affFamily);
        laneRun++;
        ran++;

        // Cooperative: yield to UI after CRITICAL + HIGH
        if (lane >= NORMAL && ran >= 2) break;
      }
    }

    var hasMore = _lanes.some(function (q) { return q.length > 0; });
    var hasWaiting = Object.keys(_graph).some(function (id) { return _graph[id].state === 'waiting'; });
    if (hasMore || hasWaiting || _runningCount > 0) {
      setTimeout(_tick, TICK_MS);
    } else {
      _ticking = false;
    }
  }

  function _runTask(task, affFamily) {
    task.state = 'running';
    _running[task.id] = { startedAt: Date.now(), lane: task.priority };
    _runningCount++;

    setTimeout(function () {
      try {
        task.fn();
        task.state = 'done';
        _metrics.completed++;
        try { task.onComplete && task.onComplete(); } catch (_) {}
        _tel('done', { id: task.id, ms: Date.now() - _running[task.id].startedAt });
      } catch (e) {
        task.state = 'error';
        try { task.onError && task.onError(e); } catch (_) {}
        _tel('error', { id: task.id, err: e && e.message });
      } finally {
        _runningCount = Math.max(0, _runningCount - 1);
        delete _running[task.id];
        if (affFamily) {
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && pw.taskEnd) pw.taskEnd(affFamily);
          } catch (_) {}
        }
        // Cleanup completed tasks
        if (task.state === 'done' || task.state === 'error') {
          setTimeout(function () { delete _graph[task.id]; }, 5000);
        }
      }
    }, 0);
  }

  // ── Cancel a task ─────────────────────────────────────────────────
  function cancel(id) {
    var task = _graph[id];
    if (task) { task.state = 'cancelled'; delete _graph[id]; }
    // Also cancel dependents
    Object.keys(_graph).forEach(function (tid) {
      var t = _graph[tid];
      if (t && t.deps.indexOf(id) !== -1) cancel(tid);
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    return {
      running:      _runningCount,
      queued:       _lanes.reduce(function (s, q) { return s + q.length; }, 0),
      waiting:      Object.keys(_graph).filter(function (id) { return _graph[id].state === 'waiting'; }).length,
      thermalTier:  _thermalTier,
      maxConcurrency: _maxConcurrency(),
      metrics:      Object.assign({}, _metrics),
      laneDepths:   _lanes.map(function (q) { return q.length; }),
    };
  }

  G.RuntimeTaskOrchestrator = Object.freeze({
    VERSION:    VERSION,
    CRITICAL:   CRITICAL,
    HIGH:       HIGH,
    NORMAL:     NORMAL,
    LOW:        LOW,
    BACKGROUND: BACKGROUND,
    submit:     submit,
    cancel:     cancel,
    getStats:   getStats,
    getTelemetry: function () { return _telemetry.slice(); },
    getThermalTier: function () { return _thermalTier; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — 5-lane cooperative orchestrator | maxConc:', _maxConcurrency());

}(window));

// ── SOURCE: public/js/runtime-smart-cache.js ──
// RuntimeSmartCache v1.0 — Arc 7 / Phase E
// =====================================================================
// Adaptive runtime cache orchestration. Distinct from RuntimeResultCache
// (which caches processed file OUTPUTS) — this caches RUNTIME STATE:
// hydration modules, processor init state, worker configs, tool metadata.
//
//   - Adaptive eviction: LRU + frequency scoring (LFU-LRU hybrid)
//   - Hot-runtime preservation: active processor families never evicted
//   - Predictive cache warming: pre-cache likely-next processor configs
//   - Stale-runtime purge: TTL-based eviction for old runtime states
//   - Memory-aware sizing: recalculates max entries based on heap pressure
//   - Tier tracking: warm / hot / cold per cache entry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeSmartCache) return;

  var LOG     = '[SmartCache]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var DEFAULT_MAX   = 200;   // entries
  var DEFAULT_TTL   = 20 * 60 * 1000;  // 20 min stale TTL
  var HOT_TTL       = 60 * 60 * 1000;  // 1 hr for hot entries
  var SWEEP_MS      = 2  * 60 * 1000;  // sweep interval
  var MEM_HIGH_PCT  = 0.75; // shrink cache above 75% heap
  var MEM_CRIT_PCT  = 0.90; // aggressive eviction above 90%

  // ── Cache storage: key → entry ────────────────────────────────────
  // entry: { value, ts, lastHit, hits, tier, ttl, pinned }
  var _cache   = {};
  var _count   = 0;
  var _maxSize = DEFAULT_MAX;
  var _metrics = { sets: 0, gets: 0, hits: 0, misses: 0, evictions: 0, purges: 0, warms: 0 };
  var _tel     = [];

  function _addTel(ev, data) {
    _tel.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_tel.length > 100) _tel.shift();
  }

  // ── Memory pressure ───────────────────────────────────────────────
  function _memPct() {
    try {
      var pm = performance.memory;
      return pm ? pm.usedJSHeapSize / pm.jsHeapSizeLimit : 0;
    } catch (_) { return 0; }
  }

  function _recalcMax() {
    var pct = _memPct();
    if (pct >= MEM_CRIT_PCT) { _maxSize = Math.max(20, Math.floor(DEFAULT_MAX * 0.25)); }
    else if (pct >= MEM_HIGH_PCT) { _maxSize = Math.max(50, Math.floor(DEFAULT_MAX * 0.50)); }
    else { _maxSize = DEFAULT_MAX; }
  }

  // ── Tier logic ────────────────────────────────────────────────────
  function _tier(entry) {
    var age   = Date.now() - entry.ts;
    var hits  = entry.hits || 0;
    if (entry.pinned)        return 'hot';
    if (hits >= 10)          return 'hot';
    if (hits >= 3 && age < HOT_TTL)  return 'warm';
    return 'cold';
  }

  // ── LFU-LRU eviction score: lower = evict first ──────────────────
  function _score(entry) {
    var recency = Date.now() - (entry.lastHit || entry.ts);
    var freq    = entry.hits || 1;
    // cold + old = low score = evict first
    if (entry.pinned) return 1e9;
    return (freq * 1000) - recency;
  }

  // ── set ───────────────────────────────────────────────────────────
  function set(key, value, opts) {
    opts = opts || {};
    _recalcMax();
    var now = Date.now();
    var existing = _cache[key];
    if (!existing) { _count++; }
    _cache[key] = {
      value:   value,
      ts:      now,
      lastHit: now,
      hits:    existing ? (existing.hits + 1) : 0,
      tier:    'cold',
      ttl:     opts.ttl  || DEFAULT_TTL,
      pinned:  opts.pin  || false,
    };
    _cache[key].tier = _tier(_cache[key]);
    _metrics.sets++;

    // Evict if over max
    if (_count > _maxSize) _evict(1);
    return key;
  }

  // ── get ───────────────────────────────────────────────────────────
  function get(key) {
    _metrics.gets++;
    var entry = _cache[key];
    if (!entry) { _metrics.misses++; return undefined; }
    if (_isExpired(entry)) { _drop(key); _metrics.misses++; return undefined; }
    entry.hits++;
    entry.lastHit = Date.now();
    entry.tier = _tier(entry);
    _metrics.hits++;
    return entry.value;
  }

  function has(key) {
    var entry = _cache[key];
    return !!(entry && !_isExpired(entry));
  }

  function del(key) {
    if (_cache[key]) { _drop(key); }
  }

  // ── Pin / unpin (prevent eviction) ───────────────────────────────
  function pin(key)   { if (_cache[key]) { _cache[key].pinned = true;  _cache[key].tier = 'hot'; } }
  function unpin(key) { if (_cache[key]) { _cache[key].pinned = false; _cache[key].tier = _tier(_cache[key]); } }

  // ── Warm: preload a value ─────────────────────────────────────────
  function warm(key, valueFn, opts) {
    if (has(key)) return;
    _metrics.warms++;
    try {
      var val = typeof valueFn === 'function' ? valueFn() : valueFn;
      set(key, val, opts);
    } catch (_) {}
  }

  // ── Internal helpers ──────────────────────────────────────────────
  function _isExpired(entry) {
    return (Date.now() - entry.ts) > (entry.ttl || DEFAULT_TTL);
  }

  function _drop(key) {
    if (_cache[key]) { delete _cache[key]; _count = Math.max(0, _count - 1); }
  }

  // Evict N worst-scored entries
  function _evict(n) {
    var keys = Object.keys(_cache).filter(function (k) { return !_cache[k].pinned; });
    keys.sort(function (a, b) { return _score(_cache[a]) - _score(_cache[b]); });
    var removed = 0;
    for (var i = 0; i < keys.length && removed < n; i++) {
      _drop(keys[i]);
      _metrics.evictions++;
      removed++;
    }
    _addTel('evict', { n: removed });
  }

  // ── Periodic sweep: purge stale + resize ──────────────────────────
  function _sweep() {
    _recalcMax();
    var purged = 0;
    Object.keys(_cache).forEach(function (key) {
      var entry = _cache[key];
      if (!entry.pinned && _isExpired(entry)) { _drop(key); purged++; _metrics.purges++; }
    });

    // Hot-runtime preservation: pin active processor families
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr) {
        var stats = ldr.getStats && ldr.getStats();
        Object.keys(stats || {}).forEach(function (family) {
          if (stats[family].activated) {
            pin('processor:' + family);
          }
        });
      }
    } catch (_) {}

    // Evict if still over limit
    if (_count > _maxSize) _evict(_count - _maxSize);

    if (purged > 0) _addTel('sweep', { purged: purged, remaining: _count, maxSize: _maxSize });
  }
  setInterval(_sweep, SWEEP_MS);

  // ── Predictive warming from PredictiveLoader ──────────────────────
  G.addEventListener('predictive-loader:preload', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (!family) return;
      // Pre-warm common cache entries for this family
      warm('family:config:' + family, function () { return { family: family, warmedAt: Date.now() }; },
           { ttl: HOT_TTL });
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var tiers = { hot: 0, warm: 0, cold: 0 };
    Object.keys(_cache).forEach(function (k) {
      var t = (_cache[k] || {}).tier || 'cold';
      tiers[t] = (tiers[t] || 0) + 1;
    });
    return {
      count: _count, maxSize: _maxSize, memPct: Math.round(_memPct() * 100),
      tiers: tiers, hitRate: _metrics.gets > 0
        ? Math.round((_metrics.hits / _metrics.gets) * 100) : 0,
      metrics: Object.assign({}, _metrics),
    };
  }

  G.RuntimeSmartCache = Object.freeze({
    VERSION:  VERSION,
    set:      set,
    get:      get,
    has:      has,
    del:      del,
    pin:      pin,
    unpin:    unpin,
    warm:     warm,
    getStats: getStats,
    getTelemetry: function () { return _tel.slice(); },
    clear:    function () { _cache = {}; _count = 0; _addTel('clear', {}); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — LFU-LRU hybrid cache | max:', DEFAULT_MAX, 'entries');

}(window));

// ── SOURCE: public/js/runtime-stream-telemetry.js ──
// RuntimeStreamTelemetry v1.0 — Arc 7 / Phase F
// =====================================================================
// Streaming metrics engine. Distinct from RuntimeTelemetry (event-based
// counters) and RuntimeTelemetryEnterprise (security telemetry) — this
// manages TIME-SERIES data with live histograms and ring buffers.
//
//   - Streaming metrics: ring-buffer time series (last N samples)
//   - Live worker throughput: bytes/sec, pages/sec per worker family
//   - Execution FPS: rAF-based render rate monitor
//   - Hydration timing graph: P0/P1/P2 activation latency tracking
//   - Chunk execution analytics: per-chunk timing histograms
//   - Latency histograms: p50/p90/p99 percentile computation
//   - window.getStreamTelemetry() for console/dashboard access
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeStreamTelemetry) return;

  var LOG     = '[StreamTelemetry]';
  var VERSION = '1.0';

  // ── Ring-buffer factory ───────────────────────────────────────────
  function RingBuffer(size) {
    var buf = [];
    return {
      push: function (v) { buf.push(v); if (buf.length > size) buf.shift(); },
      toArray: function () { return buf.slice(); },
      last: function (n) { return buf.slice(-n); },
      length: function () { return buf.length; },
      clear: function () { buf = []; },
    };
  }

  // ── Percentile computation ────────────────────────────────────────
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx    = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
    return sorted[idx];
  }

  function histStats(arr) {
    if (!arr.length) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0, count: 0 };
    var sum = arr.reduce(function (a, b) { return a + b; }, 0);
    return {
      count: arr.length,
      min:   Math.min.apply(null, arr),
      max:   Math.max.apply(null, arr),
      avg:   Math.round(sum / arr.length),
      p50:   percentile(arr, 50),
      p90:   percentile(arr, 90),
      p99:   percentile(arr, 99),
    };
  }

  // ── Metric stores ─────────────────────────────────────────────────
  var RING_SIZE = 120;  // ~2 min of per-second samples
  var _series   = {};   // name → RingBuffer
  var _hist     = {};   // name → RingBuffer (for latency histograms)
  var _counters = {};   // name → number
  var _families = {};   // family → { bytesTotal, pagesTotal, lastSampleAt, throughputBps, throughputPps }

  function _getSeries(name) {
    if (!_series[name]) _series[name] = RingBuffer(RING_SIZE);
    return _series[name];
  }

  function _getHist(name) {
    if (!_hist[name]) _hist[name] = RingBuffer(RING_SIZE);
    return _hist[name];
  }

  // ── Record a measurement ──────────────────────────────────────────
  function record(name, value) {
    _getSeries(name).push({ ts: Date.now(), v: value });
  }

  function increment(name, delta) {
    _counters[name] = (_counters[name] || 0) + (delta || 1);
  }

  function recordLatency(name, ms) {
    _getHist(name).push(ms);
  }

  function recordBytes(family, bytes, pages) {
    if (!_families[family]) _families[family] = { bytesTotal: 0, pagesTotal: 0,
      lastSampleAt: 0, throughputBps: 0, throughputPps: 0, _bytesWindow: RingBuffer(30) };
    var f = _families[family];
    f.bytesTotal += (bytes || 0);
    f.pagesTotal += (pages || 0);
    var now = Date.now();
    var gap = now - (f.lastSampleAt || now);
    if (gap > 0) {
      f.throughputBps = Math.round((bytes || 0) / (gap / 1000));
      f.throughputPps = pages ? Math.round((pages || 0) / (gap / 1000)) : 0;
    }
    f.lastSampleAt = now;
    f._bytesWindow.push({ ts: now, bytes: bytes || 0 });
  }

  // ── Hydration timing graph ────────────────────────────────────────
  var _hydrationGraph = {
    P0: RingBuffer(50), P1: RingBuffer(50), P2: RingBuffer(50),
  };

  function recordHydration(tier, durationMs) {
    var buf = _hydrationGraph[tier];
    if (buf) buf.push({ ts: Date.now(), ms: durationMs });
    recordLatency('hydration:' + tier, durationMs);
  }

  // ── Execution FPS monitor ─────────────────────────────────────────
  var _fps       = 0;
  var _fpsFrames = 0;
  var _fpsSeries = RingBuffer(60);
  var _lastFpsT  = 0;
  var _rafRunning = false;

  function _rafLoop(ts) {
    if (!_rafRunning) return;
    _fpsFrames++;
    if (!_lastFpsT) { _lastFpsT = ts; }
    var elapsed = ts - _lastFpsT;
    if (elapsed >= 1000) {
      _fps = Math.round(_fpsFrames * 1000 / elapsed);
      _fpsSeries.push({ ts: Date.now(), fps: _fps });
      _fpsFrames = 0;
      _lastFpsT  = ts;
    }
    G.requestAnimationFrame(_rafLoop);
  }

  function startFpsMonitor() {
    if (_rafRunning) return;
    _rafRunning = true;
    G.requestAnimationFrame(_rafLoop);
  }

  function stopFpsMonitor() {
    _rafRunning = false;
  }

  // ── Hook into Arc 7 events ────────────────────────────────────────
  G.addEventListener('streaming-hydration:viewport', function (evt) {
    try { increment('hydration:viewport', 1); } catch (_) {}
  });

  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d) recordHydration(d.tier || 'P2', d.durationMs || 0);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d) record('stream-workers:pct', d.pct);
    } catch (_) {}
  });

  G.addEventListener('predictive-loader:preload', function (evt) {
    try { increment('predictive:preloads', 1); } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try { increment('memory:panics', 1); } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try { increment('workers:isolated', 1); } catch (_) {}
  });

  // ── Aggregated telemetry snapshot ─────────────────────────────────
  function getSnapshot() {
    var hydStats = {};
    ['P0', 'P1', 'P2'].forEach(function (tier) {
      hydStats[tier] = histStats(_hydrationGraph[tier].toArray().map(function (e) { return e.ms; }));
    });

    var histSnap = {};
    Object.keys(_hist).forEach(function (name) {
      histSnap[name] = histStats(_hist[name].toArray());
    });

    var familySnap = {};
    Object.keys(_families).forEach(function (f) {
      var fam = _families[f];
      familySnap[f] = {
        bytesTotal:   fam.bytesTotal,
        pagesTotal:   fam.pagesTotal,
        throughputBps: fam.throughputBps,
        throughputPps: fam.throughputPps,
      };
    });

    return {
      ts:          Date.now(),
      fps:         _fps,
      fpsSeries:   _fpsSeries.last(10),
      counters:    Object.assign({}, _counters),
      hydration:   hydStats,
      histograms:  histSnap,
      families:    familySnap,
    };
  }

  // Expose for console/dashboard
  G.getStreamTelemetry = function () { return getSnapshot(); };

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    startFpsMonitor();
    console.debug(LOG, 'v' + VERSION + ' ready — FPS monitor active | window.getStreamTelemetry() available');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeStreamTelemetry = Object.freeze({
    VERSION:         VERSION,
    record:          record,
    increment:       increment,
    recordLatency:   recordLatency,
    recordBytes:     recordBytes,
    recordHydration: recordHydration,
    startFpsMonitor: startFpsMonitor,
    stopFpsMonitor:  stopFpsMonitor,
    getSnapshot:     getSnapshot,
    getFps:          function () { return _fps; },
    getHist:         function (name) { return histStats((_hist[name] || RingBuffer(1)).toArray()); },
    getSeries:       function (name) { return (_series[name] || { toArray: function() { return []; } }).toArray(); },
    getCounters:     function () { return Object.assign({}, _counters); },
  });

}(window));

// ── SOURCE: public/js/runtime-self-optimizer.js ──
// RuntimeSelfOptimizer v1.0 — Arc 7 / Phase G
// =====================================================================
// Self-optimizing runtime: observes actual performance, learns device
// capability, and auto-adjusts Arc 6/7 system parameters.
//
// Adjustments made:
//   - Hydration strategy: if P1 consistently slow → defer to idle
//   - Worker counts: if workers crash frequently → reduce maxWorkers
//   - Memory budgets: if panics → lower per-processor budget
//   - Preload strategy: if hover preloads never used → extend cooldown
//   - Thermal policies: if consistently hot → conservative mode
//   - Chunk scheduling: if FPS drops → increase yield frequency
//
// Samples every SAMPLE_MS, adapts every ADAPT_MS (after stable samples).
// Adaptations are persisted to sessionStorage so they survive soft-nav.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeSelfOptimizer) return;

  var LOG     = '[SelfOptimizer]';
  var VERSION = '1.0';

  var SAMPLE_MS      = 30 * 1000;  // sample every 30 s
  var ADAPT_MS       = 5  * 60 * 1000; // adapt every 5 min
  var SAMPLE_HISTORY = 10;         // samples to collect before adapting
  var STORAGE_KEY    = 'ilpdf_optimizer_state';

  // ── Learned state ─────────────────────────────────────────────────
  var _state = {
    // Measurements
    avgP1HydrationMs:  null,
    avgP2HydrationMs:  null,
    workerCrashes:     0,
    memPanics:         0,
    avgFps:            null,
    preloadHitRate:    0,
    thermalEvents:     0,

    // Adaptations applied
    adaptations: [],

    // Flags
    conservativeMode: false,
    workerCapReduced: false,
    memBudgetReduced: false,
    hydrationDeferred: false,
    preloadCooldownMs: 60 * 1000,
    chunkYieldMs: null,
    lastAdaptAt: 0,
  };

  var _samples = {
    fps:      [],
    p1Ms:     [],
    p2Ms:     [],
    crashes:  [],
    panics:   [],
  };

  var _telemetry = [];

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  function _adapt(desc, fn) {
    try {
      fn();
      _state.adaptations.push({ ts: Date.now(), desc: desc });
      if (_state.adaptations.length > 20) _state.adaptations.shift();
      _tel('adapt', { desc: desc });
      console.debug(LOG, 'adaptation:', desc);
      try {
        G.dispatchEvent(new CustomEvent('self-optimizer:adapt', { detail: { desc: desc } }));
      } catch (_) {}
    } catch (_) {}
  }

  // ── Persist / restore ────────────────────────────────────────────
  function _save() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_state)); } catch (_) {}
  }

  function _load() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      // Restore non-measurement fields only (measurements re-observed fresh)
      _state.conservativeMode   = s.conservativeMode   || false;
      _state.workerCapReduced   = s.workerCapReduced   || false;
      _state.memBudgetReduced   = s.memBudgetReduced   || false;
      _state.hydrationDeferred  = s.hydrationDeferred  || false;
      _state.preloadCooldownMs  = s.preloadCooldownMs  || 60000;
      _state.chunkYieldMs       = s.chunkYieldMs       || null;
      _state.adaptations        = s.adaptations        || [];
      _state.lastAdaptAt        = s.lastAdaptAt        || 0;
    } catch (_) {}
  }

  // ── Sample collection ─────────────────────────────────────────────
  function _sample() {
    // FPS from StreamTelemetry
    try {
      var st = G.RuntimeStreamTelemetry;
      if (st) {
        var fps = st.getFps();
        if (fps > 0) _samples.fps.push(fps);
        var h = st.getSnapshot();
        if (h && h.hydration) {
          if (h.hydration.P1 && h.hydration.P1.avg) _samples.p1Ms.push(h.hydration.P1.avg);
          if (h.hydration.P2 && h.hydration.P2.avg) _samples.p2Ms.push(h.hydration.P2.avg);
        }
      }
    } catch (_) {}

    // Worker crashes from ProcessorWorkers
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) {
        var ws = pw.getStats();
        var total = Object.keys(ws).reduce(function (s, f) { return s + (ws[f].crashCount || 0); }, 0);
        _samples.crashes.push(total);
      }
    } catch (_) {}

    // Memory panics from ProcessorMemory
    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm) {
        var ms = pm.getStats();
        var panics = Object.keys(ms).reduce(function (s, f) { return s + (ms[f].panicCount || 0); }, 0);
        _samples.panics.push(panics);
      }
    } catch (_) {}

    // Trim to SAMPLE_HISTORY
    ['fps', 'p1Ms', 'p2Ms', 'crashes', 'panics'].forEach(function (k) {
      if (_samples[k].length > SAMPLE_HISTORY) _samples[k].shift();
    });

    _tel('sample', { fps: _samples.fps.slice(-1)[0], crashes: _samples.crashes.slice(-1)[0] });
  }

  // ── Adaptation engine ─────────────────────────────────────────────
  function _adapt_all() {
    if (_samples.fps.length < 3 && _samples.p1Ms.length < 2) return; // insufficient data
    var now = Date.now();
    if (now - _state.lastAdaptAt < ADAPT_MS) return;
    _state.lastAdaptAt = now;

    var avgFps  = _avg(_samples.fps);
    var avgP1   = _avg(_samples.p1Ms);
    var avgP2   = _avg(_samples.p2Ms);
    var avgCrash = _avg(_samples.crashes);
    var avgPanic = _avg(_samples.panics);

    // 1. Low FPS → increase chunk yield
    if (avgFps > 0 && avgFps < 30 && !_state.chunkYieldMs) {
      _adapt('chunk-yield-increase: fps=' + Math.round(avgFps), function () {
        _state.chunkYieldMs = 20;
        // Signal StreamingHydration to use larger budget
        try {
          var sh = G.RuntimeStreamingHydration;
          if (sh && !_state.conservativeMode) _state.conservativeMode = true;
        } catch (_) {}
      });
    }

    // 2. Slow P1 hydration → defer to idle
    if (avgP1 > 200 && !_state.hydrationDeferred) {
      _adapt('hydration-deferred: avgP1=' + Math.round(avgP1) + 'ms', function () {
        _state.hydrationDeferred = true;
      });
    }

    // 3. Worker crashes → reduce concurrency
    if (avgCrash > 5 && !_state.workerCapReduced) {
      _adapt('worker-cap-reduced: avgCrashes=' + Math.round(avgCrash), function () {
        _state.workerCapReduced = true;
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (pw && pw.setThermalLimit) {
            ['organize','compress','convert','edit','image'].forEach(function (f) {
              pw.setThermalLimit(f, 1);
            });
          }
        } catch (_) {}
      });
    }

    // 4. Memory panics → lower budgets
    if (avgPanic > 2 && !_state.memBudgetReduced) {
      _adapt('mem-budget-reduced: avgPanics=' + Math.round(avgPanic), function () {
        _state.memBudgetReduced = true;
        _state.conservativeMode = true;
      });
    }

    // 5. Recovery: good performance → loosen restrictions
    if (avgFps >= 55 && avgCrash <= 1 && avgPanic <= 0 && _state.conservativeMode) {
      _adapt('conservative-mode-lifted: fps=' + Math.round(avgFps), function () {
        _state.conservativeMode  = false;
        _state.workerCapReduced  = false;
        _state.memBudgetReduced  = false;
        _state.hydrationDeferred = false;
        _state.chunkYieldMs      = null;
      });
    }

    _save();
  }

  function _avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('processor-memory:panic', function () {
    _state.memPanics++;
    _samples.panics.push(_state.memPanics);
    _adapt_all();
  });

  G.addEventListener('processor-workers:isolated', function () {
    _state.workerCrashes++;
    _adapt_all();
  });

  G.addEventListener('mobile:battery-save', function () {
    _adapt('battery-save-mode', function () { _state.conservativeMode = true; });
    _save();
  });

  // ── Periodic timers ───────────────────────────────────────────────
  var _sampleTimer = setInterval(_sample,    SAMPLE_MS);
  var _adaptTimer  = setInterval(_adapt_all, ADAPT_MS);

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    _load();
    if (_state.conservativeMode) {
      console.debug(LOG, 'restored conservative mode from session');
      try {
        G.dispatchEvent(new CustomEvent('self-optimizer:conservative-mode', { detail: { restored: true } }));
      } catch (_) {}
    }
    // First sample after 10s settle
    setTimeout(_sample, 10000);
    console.debug(LOG, 'v' + VERSION + ' ready | sampleHz:', Math.round(60000 / SAMPLE_MS) + '/min | adaptations:', _state.adaptations.length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeSelfOptimizer = Object.freeze({
    VERSION:           VERSION,
    isConservative:    function () { return _state.conservativeMode; },
    getAdaptations:    function () { return _state.adaptations.slice(); },
    getState:          function () { return Object.assign({}, _state); },
    getTelemetry:      function () { return _telemetry.slice(); },
    forceSample:       _sample,
    forceAdapt:        _adapt_all,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — auto-adjusting runtime active');

}(window));

// ── SOURCE: public/js/runtime-mobile-extreme.js ──
// RuntimeMobileExtremeMode v1.0 — Arc 7 / Phase H
// =====================================================================
// Emergency runtime stabilization for very weak devices:
// <2 GB RAM, 2 cores, low battery, or extreme thermal pressure.
//
// Extends RuntimeMobileHardening (Arc 4) with extreme modes that
// kick in when standard hardening is insufficient.
//
// Emergency modes (can stack):
//   ULTRA_LOW_MEMORY  — single worker, 64 MB budgets, no preloading
//   BACKGROUND_EVICT  — evict all dormant processors immediately
//   WORKER_TRIM       — terminate all non-active workers
//   THERMAL_EMERGENCY — force single-core execution, suspend P2 hydration
//   BATTERY_EMERGENCY — suspend preloading, streams, telemetry FPS monitor
//
// Activation: automatic detection OR window.triggerExtremeMode(mode)
// Recovery: auto-exits when conditions improve (checked every CHECK_MS).
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeMobileExtremeMode) return;

  var LOG     = '[ExtremeMode]';
  var VERSION = '1.0';
  var CHECK_MS = 60 * 1000;  // re-check conditions every 60 s

  // ── Mode flags ────────────────────────────────────────────────────
  var _modes = {
    ULTRA_LOW_MEMORY:  false,
    BACKGROUND_EVICT:  false,
    WORKER_TRIM:       false,
    THERMAL_EMERGENCY: false,
    BATTERY_EMERGENCY: false,
  };

  var _metrics   = { activations: 0, deactivations: 0, evictions: 0, trims: 0 };
  var _telemetry = [];
  var _active    = false;  // any mode active

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── Device capability probe ───────────────────────────────────────
  var _cores  = navigator.hardwareConcurrency || 2;
  var _isWeak = _cores <= 2;

  function _heapPct() {
    try {
      var pm = performance.memory;
      return pm ? pm.usedJSHeapSize / pm.jsHeapSizeLimit : 0;
    } catch (_) { return 0; }
  }

  // ── Dispatch a mode activation ────────────────────────────────────
  function _activate(mode, reason) {
    if (_modes[mode]) return;
    _modes[mode] = true;
    _active = true;
    _metrics.activations++;
    _tel('activate:' + mode, { reason: reason });
    console.debug(LOG, 'EXTREME MODE:', mode, '—', reason);

    try {
      G.dispatchEvent(new CustomEvent('extreme-mode:activate', {
        detail: { mode: mode, reason: reason },
      }));
    } catch (_) {}

    _apply(mode);
  }

  function _deactivate(mode) {
    if (!_modes[mode]) return;
    _modes[mode] = false;
    _active = Object.keys(_modes).some(function (m) { return _modes[m]; });
    _metrics.deactivations++;
    _tel('deactivate:' + mode, {});
    console.debug(LOG, 'EXTREME MODE LIFTED:', mode);

    try {
      G.dispatchEvent(new CustomEvent('extreme-mode:deactivate', { detail: { mode: mode } }));
    } catch (_) {}
  }

  // ── Apply mode actions ────────────────────────────────────────────
  function _apply(mode) {
    switch (mode) {

      case 'ULTRA_LOW_MEMORY':
        // Single worker per processor, 64 MB budgets
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (pw) {
            ['organize','split','compress','convert','edit','repair','ocr','ai-nlp','image'].forEach(function (f) {
              pw.setThermalLimit && pw.setThermalLimit(f, 1);
            });
          }
        } catch (_) {}
        // Shrink cache
        try {
          var sc = G.RuntimeSmartCache;
          if (sc) sc.clear();
        } catch (_) {}
        // Stop FPS monitor (rAF overhead)
        try {
          var st = G.RuntimeStreamTelemetry;
          if (st) st.stopFpsMonitor();
        } catch (_) {}
        break;

      case 'BACKGROUND_EVICT':
        // Evict dormant processors from RuntimeProcessorLoader
        _metrics.evictions++;
        try {
          var ldr = G.RuntimeProcessorLoader;
          if (!ldr) break;
          var stats = ldr.getStats && ldr.getStats();
          Object.keys(stats || {}).forEach(function (family) {
            var s = stats[family];
            // Evict if not activated in the last 5 min
            if (!s.activated || (s.lastActiveAt && (Date.now() - s.lastActiveAt) > 5 * 60 * 1000)) {
              try {
                G.dispatchEvent(new CustomEvent('processor-loader:evicted', {
                  detail: { family: family, reason: 'extreme-background-evict', idleMs: Date.now() - s.lastActiveAt },
                }));
              } catch (_) {}
            }
          });
        } catch (_) {}
        break;

      case 'WORKER_TRIM':
        // Terminate non-active workers via WorkerPool
        _metrics.trims++;
        try {
          var wp = G.WorkerPool;
          if (wp && wp.terminateAll) wp.terminateAll();
          else if (wp && wp.trim) wp.trim();
        } catch (_) {}
        break;

      case 'THERMAL_EMERGENCY':
        // Force single-core execution, suspend P2 hydration
        try {
          var hs = G.RuntimeHydrationScheduler;
          if (hs && hs.suspend) hs.suspend('P2');
        } catch (_) {}
        try {
          var pw2 = G.RuntimeProcessorWorkers;
          if (pw2) {
            ['ocr','ai-nlp','convert'].forEach(function (f) {
              pw2.setThermalLimit && pw2.setThermalLimit(f, 1);
            });
          }
        } catch (_) {}
        break;

      case 'BATTERY_EMERGENCY':
        // Suspend preloading
        try {
          // RuntimePredictiveLoader has no explicit suspend — mark via event
          G.dispatchEvent(new CustomEvent('mobile:battery-save', {
            detail: { level: 0, extreme: true },
          }));
        } catch (_) {}
        // Stop telemetry FPS
        try {
          var st2 = G.RuntimeStreamTelemetry;
          if (st2) st2.stopFpsMonitor();
        } catch (_) {}
        break;
    }
  }

  // ── Detection logic ───────────────────────────────────────────────
  function _detect() {
    var heap = _heapPct();

    // Ultra-low memory: heap > 90% on weak device
    if (_isWeak && heap > 0.90) {
      _activate('ULTRA_LOW_MEMORY', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.70 && _modes.ULTRA_LOW_MEMORY) {
      _deactivate('ULTRA_LOW_MEMORY');
    }

    // Background eviction: heap > 80%
    if (heap > 0.80) {
      _activate('BACKGROUND_EVICT', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.65 && _modes.BACKGROUND_EVICT) {
      _deactivate('BACKGROUND_EVICT');
    }

    // Worker trim: heap > 92%
    if (heap > 0.92) {
      _activate('WORKER_TRIM', 'heap=' + Math.round(heap * 100) + '%');
    } else if (heap < 0.75 && _modes.WORKER_TRIM) {
      _deactivate('WORKER_TRIM');
    }

    // Check thermal tier from self-optimizer or worker coordinator
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) {
        var tier = pw.getThermalTier();
        if (tier === 'critical') {
          _activate('THERMAL_EMERGENCY', 'thermal=critical');
        } else if (tier !== 'critical' && tier !== 'hot' && _modes.THERMAL_EMERGENCY) {
          _deactivate('THERMAL_EMERGENCY');
        }
      }
    } catch (_) {}
  }

  // ── Periodic check ────────────────────────────────────────────────
  var _checkTimer = setInterval(_detect, CHECK_MS);

  // ── Hooks: battery / thermal events ──────────────────────────────
  G.addEventListener('mobile:battery-save', function (evt) {
    var d = evt && evt.detail;
    if (d && d.level < 0.10) _activate('BATTERY_EMERGENCY', 'battery=' + Math.round((d.level || 0) * 100) + '%');
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    _activate('ULTRA_LOW_MEMORY', 'memory-panic');
    _activate('BACKGROUND_EVICT', 'memory-panic');
  });

  // ── Public trigger (for testing / manual override) ────────────────
  G.triggerExtremeMode = function (mode, reason) {
    if (_modes.hasOwnProperty(mode)) _activate(mode, reason || 'manual');
  };

  G.liftExtremeMode = function (mode) {
    if (mode) _deactivate(mode);
    else Object.keys(_modes).forEach(_deactivate);
  };

  // ── Boot ──────────────────────────────────────────────────────────
  function _boot() {
    // Immediate check on weak devices
    if (_isWeak) setTimeout(_detect, 2000);
    console.debug(LOG, 'v' + VERSION + ' ready — weak device:', _isWeak, '| window.triggerExtremeMode() available');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeMobileExtremeMode = Object.freeze({
    VERSION:        VERSION,
    isActive:       function () { return _active; },
    getActiveModes: function () {
      return Object.keys(_modes).filter(function (m) { return _modes[m]; });
    },
    activate:       function (mode, reason) { _activate(mode, reason || 'api'); },
    deactivate:     _deactivate,
    detect:         _detect,
    getMetrics:     function () { return Object.assign({}, _metrics); },
    getTelemetry:   function () { return _telemetry.slice(); },
  });

}(window));

