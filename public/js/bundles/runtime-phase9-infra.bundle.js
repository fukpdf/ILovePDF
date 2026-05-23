// ── Phase 9 Infrastructure Layer — Phase 9 build bundle ──────────────────────────
// Generated: 2026-05-23T14:47:13.311Z  BUILD_ID: mpigppq5
// Files: 6

// ── SOURCE: public/js/runtime-network-state.js ──
// runtime-network-state.js — Phase 9 network quality monitoring
// Monitors connection type, effective bandwidth, RTT, and online/offline
// transitions. Other modules read window.RuntimeNetworkState.getState()
// to adapt concurrency and chunk sizes dynamically.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeNetworkState) return;

  var _state = {
    online:        navigator.onLine !== false,
    type:          'unknown',
    effectiveType: '4g',
    downlinkMbps:  10,
    rttMs:         50,
    saveData:      false,
    degraded:      false,
    since:         Date.now(),
  };

  var _listeners = [];
  var _history   = []; // last 20 state changes

  function _snapshot() {
    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        _state.type          = conn.type          || 'unknown';
        _state.effectiveType = conn.effectiveType  || '4g';
        _state.downlinkMbps  = conn.downlink       || 10;
        _state.rttMs         = conn.rtt            || 50;
        _state.saveData      = !!conn.saveData;
      }
    } catch (_) {}
    _state.degraded = (_state.effectiveType === 'slow-2g' ||
                       _state.effectiveType === '2g'      ||
                       _state.rttMs > 800                 ||
                       _state.downlinkMbps < 0.5);
  }

  function _fire(event) {
    _history.push({ event: event, state: Object.assign({}, _state), ts: Date.now() });
    if (_history.length > 20) _history.shift();
    _listeners.forEach(function (fn) {
      try { fn(event, Object.assign({}, _state)); } catch (_) {}
    });
    if (_state.degraded) {
      try {
        var ss = G.RuntimeSecurityStream;
        if (ss && typeof ss.push === 'function') {
          ss.push('network-degraded', 'network-state', 'INFO',
            'Network quality degraded: ' + _state.effectiveType,
            { rtt: _state.rttMs, downlink: _state.downlinkMbps });
        }
      } catch (_) {}
    }
  }

  function _onOnline()  { _state.online = true;  _state.since = Date.now(); _snapshot(); _fire('online');  }
  function _onOffline() { _state.online = false; _state.since = Date.now(); _fire('offline'); }

  try { window.addEventListener('online',  _onOnline);  } catch (_) {}
  try { window.addEventListener('offline', _onOffline); } catch (_) {}

  try {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', function () { _snapshot(); _fire('connection-change'); });
    }
  } catch (_) {}

  _snapshot();

  // ── Adaptive chunk size helper ────────────────────────────────────────────
  // Returns recommended upload/download chunk size in bytes based on network.
  function recommendedChunkBytes() {
    if (!_state.online) return 512 * 1024;
    var mbps = _state.downlinkMbps || 10;
    if (mbps < 0.5) return  256 * 1024;   // 256 KB — slow-2g
    if (mbps < 2)   return  512 * 1024;   // 512 KB — 2g
    if (mbps < 10)  return 2048 * 1024;   //   2 MB — 3g/4g moderate
    return               8192 * 1024;     //   8 MB — fast connection
  }

  G.RuntimeNetworkState = Object.freeze({
    getState:               function () { return Object.assign({}, _state); },
    isDegraded:             function () { return _state.degraded; },
    isOnline:               function () { return _state.online; },
    recommendedChunkBytes:  recommendedChunkBytes,
    onStateChange:          function (fn) { if (typeof fn === 'function') _listeners.push(fn); },
    getHistory:             function () { return _history.slice(); },
  });
}());

// ── SOURCE: public/js/runtime-memory-recovery.js ──
// runtime-memory-recovery.js — Phase 9 memory pressure recovery
// Responds to memory pressure events (device memory, heap thresholds) by
// evicting IDB/OPFS caches, dropping blob URLs, and signalling the advanced
// engine to reduce concurrency. Registers on window.RuntimeMemoryRecovery.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeMemoryRecovery) return;

  var _recoveries = 0;
  var _lastRecovery = 0;
  var _COOLDOWN_MS = 15000; // minimum 15 s between recovery runs

  // ── Tracked blob URLs ─────────────────────────────────────────────────────
  var _blobs = new Set();
  function trackBlob(url) { _blobs.add(url); }
  function releaseBlobs() {
    var released = 0;
    _blobs.forEach(function (url) {
      try { URL.revokeObjectURL(url); released++; } catch (_) {}
    });
    _blobs.clear();
    return released;
  }

  // ── IDB cache eviction ────────────────────────────────────────────────────
  function evictIdbCache() {
    try {
      if (G.IDBCache && typeof G.IDBCache.clear === 'function') {
        G.IDBCache.clear().catch(function () {});
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── OPFS cleanup ──────────────────────────────────────────────────────────
  function evictOpfsStaging() {
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        navigator.storage.getDirectory().then(function (root) {
          var iter = root.values ? root.values() : null;
          if (!iter) return;
          (function next() {
            iter.next().then(function (r) {
              if (r.done) return;
              var h = r.value;
              if (h && /^ae_stage_/.test(h.name)) root.removeEntry(h.name).catch(function () {});
              next();
            }).catch(function () {});
          }());
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // ── Reduce advanced-engine concurrency ───────────────────────────────────
  function throttleEngines() {
    try {
      if (G.WorkerPool && typeof G.WorkerPool.setMaxPerUrl === 'function') {
        G.WorkerPool.setMaxPerUrl(1);
      }
    } catch (_) {}
  }

  // ── Emit telemetry ────────────────────────────────────────────────────────
  function _emit(level, detail) {
    try {
      var st = G.SecurityTelemetry;
      if (st && typeof st.record === 'function') {
        st.record('memory-recovery', { level: level, detail: detail, recoveries: _recoveries });
      }
    } catch (_) {}
  }

  // ── Core recovery routine ─────────────────────────────────────────────────
  function recover(reason) {
    var now = Date.now();
    if (now - _lastRecovery < _COOLDOWN_MS) return false;
    _lastRecovery = now;
    _recoveries++;

    var released = releaseBlobs();
    var evictedIdb = evictIdbCache();
    evictOpfsStaging();
    throttleEngines();

    _emit('warn', { reason: reason, blobsReleased: released, idbEvicted: evictedIdb });
    console.info('[RuntimeMemoryRecovery] recovery #' + _recoveries +
      ' reason=' + reason + ' blobs=' + released + ' idb=' + evictedIdb);
    return true;
  }

  // ── Device memory pressure listener (Chrome 75+) ─────────────────────────
  function _startPressureObserver() {
    try {
      if (G.MemoryMeasurement || !('requestStorageAccess' in document)) return;
      if (typeof G.performance !== 'undefined' && G.performance.memory) {
        setInterval(function () {
          var m = G.performance.memory;
          if (!m) return;
          var ratio = m.usedJSHeapSize / (m.jsHeapSizeLimit || 1);
          if (ratio > 0.80) recover('heap-pressure-' + Math.round(ratio * 100) + 'pct');
        }, 10000);
      }
    } catch (_) {}
  }

  // ── Memory pressure event (iOS Safari 15+ / Chrome) ──────────────────────
  if (typeof window.addEventListener === 'function') {
    try {
      window.addEventListener('memorypressure', function (e) {
        var level = (e && e.level) || 'critical';
        recover('os-' + level);
      });
    } catch (_) {}
  }

  _startPressureObserver();

  G.RuntimeMemoryRecovery = Object.freeze({
    recover:     recover,
    trackBlob:   trackBlob,
    releaseBlobs:releaseBlobs,
    getStats: function () {
      return { recoveries: _recoveries, trackedBlobs: _blobs.size, lastRecovery: _lastRecovery };
    },
  });
}());

// ── SOURCE: public/js/runtime-lazy-engine-loader.js ──
// runtime-lazy-engine-loader.js — Phase 9 lazy engine loading coordinator
// Coordinates deferred loading of heavy engines (pdf-lib, pdfjs, tesseract,
// xlsx, mammoth) based on idle time, tool activation, and network state.
// Prevents redundant loads by acting as a singleton registry with promise
// deduplication. Exposes window.RuntimeLazyEngineLoader.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeLazyEngineLoader) return;

  // ── Engine registry ───────────────────────────────────────────────────────
  var _engines = {};  // name → { promise: Promise|null, loaded: bool, ms: number|null }
  var _queue   = [];  // scheduled prewarm { name, priority, fn }
  var _idle    = false;

  function _getOrCreate(name) {
    if (!_engines[name]) _engines[name] = { promise: null, loaded: false, ms: null };
    return _engines[name];
  }

  // ── Register + load an engine ─────────────────────────────────────────────
  // loaderFn must return a Promise that resolves when the engine is ready.
  function register(name, loaderFn) {
    var e = _getOrCreate(name);
    if (e.loaded) return Promise.resolve(true);
    if (e.promise) return e.promise;
    var t0 = Date.now();
    e.promise = Promise.resolve().then(loaderFn).then(function () {
      e.loaded = true;
      e.ms     = Date.now() - t0;
      e.promise = null;
      console.debug('[LazyEngineLoader] loaded:', name, 'in', e.ms, 'ms');
      _drainQueue();
      return true;
    }).catch(function (err) {
      e.promise = null;
      console.warn('[LazyEngineLoader] failed to load engine:', name, err && err.message);
      throw err;
    });
    return e.promise;
  }

  // ── Prewarm scheduling (runs during idle) ─────────────────────────────────
  function schedulePrewarm(name, priority, loaderFn) {
    _queue.push({ name: name, priority: priority || 5, fn: loaderFn });
    _queue.sort(function (a, b) { return a.priority - b.priority; });
    _maybeDrainOnIdle();
  }

  function _drainQueue() {
    var item = _queue.shift();
    if (!item) return;
    var e = _getOrCreate(item.name);
    if (e.loaded || e.promise) { _drainQueue(); return; }
    register(item.name, item.fn).then(_drainQueue).catch(_drainQueue);
  }

  function _maybeDrainOnIdle() {
    if (_idle) { _drainQueue(); return; }
    try {
      if (G.requestIdleCallback) {
        G.requestIdleCallback(function (deadline) {
          _idle = true;
          if (deadline.timeRemaining() > 20) _drainQueue();
        }, { timeout: 5000 });
      } else {
        setTimeout(function () { _idle = true; _drainQueue(); }, 3000);
      }
    } catch (_) {}
  }

  // ── BrowserTools bridge ───────────────────────────────────────────────────
  // Hook into BrowserTools loads if available so we track what's already loaded.
  function _markLoaded(name) {
    var e = _getOrCreate(name);
    if (!e.loaded) { e.loaded = true; e.ms = 0; }
  }

  // Try to detect already-loaded engines on next tick (after BrowserTools init)
  setTimeout(function () {
    try {
      if (G.PDFLib)     _markLoaded('pdf-lib');
      if (G.pdfjsLib)   _markLoaded('pdfjs');
      if (G.JSZip)      _markLoaded('jszip');
      if (G.mammoth)    _markLoaded('mammoth');
      if (G.XLSX)       _markLoaded('xlsx');
      if (G.Tesseract)  _markLoaded('tesseract');
      if (G.PptxGenJS)  _markLoaded('pptxgenjs');
    } catch (_) {}
  }, 500);

  G.RuntimeLazyEngineLoader = Object.freeze({
    register:         register,
    schedulePrewarm:  schedulePrewarm,
    isLoaded: function (name) {
      var e = _engines[name]; return !!(e && e.loaded);
    },
    getStats: function () {
      var out = {};
      Object.keys(_engines).forEach(function (k) {
        var e = _engines[k];
        out[k] = { loaded: e.loaded, ms: e.ms, pending: !!e.promise };
      });
      return out;
    },
  });
}());

// ── SOURCE: public/js/runtime-performance-monitor.js ──
// runtime-performance-monitor.js — Phase 9 client-side performance metrics
// Collects LCP, FID, CLS, tool processing times, memory samples, and
// long-task counts. Exposes window.RuntimePerformanceMonitor with a
// getReport() method for the admin dashboard and telemetry pipeline.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimePerformanceMonitor) return;

  var _metrics = {
    lcp:        null,   // Largest Contentful Paint (ms)
    fid:        null,   // First Input Delay (ms)
    cls:        0,      // Cumulative Layout Shift score
    ttfb:       null,   // Time to First Byte (ms)
    fcp:        null,   // First Contentful Paint (ms)
    longTasks:  0,      // count of tasks > 50 ms
    longTaskMs: 0,      // total ms blocked in long tasks
    toolRuns:   [],     // ring buffer: last 30 tool timings { tool, ms, ok }
  };

  var _MAX_TOOL_RUNS = 30;

  // ── Web Vitals via PerformanceObserver ────────────────────────────────────
  function _observe(type, callback) {
    try {
      if (!G.PerformanceObserver) return;
      var po = new G.PerformanceObserver(function (list) {
        list.getEntries().forEach(callback);
      });
      po.observe({ type: type, buffered: true });
    } catch (_) {}
  }

  _observe('largest-contentful-paint', function (e) {
    _metrics.lcp = Math.round(e.startTime);
  });

  _observe('first-input', function (e) {
    _metrics.fid = Math.round(e.processingStart - e.startTime);
  });

  _observe('layout-shift', function (e) {
    if (!e.hadRecentInput) _metrics.cls = +(_metrics.cls + (e.value || 0)).toFixed(4);
  });

  _observe('longtask', function (e) {
    _metrics.longTasks++;
    _metrics.longTaskMs += Math.round(e.duration || 0);
  });

  // TTFB + FCP from navigation / paint entries
  try {
    var nav = G.performance && G.performance.getEntriesByType &&
              G.performance.getEntriesByType('navigation')[0];
    if (nav) _metrics.ttfb = Math.round(nav.responseStart - nav.requestStart);

    var paints = G.performance && G.performance.getEntriesByName &&
                 G.performance.getEntriesByName('first-contentful-paint');
    if (paints && paints[0]) _metrics.fcp = Math.round(paints[0].startTime);
  } catch (_) {}

  // ── Startup duration tracking ────────────────────────────────────────────
  // Captures navigation→DOMContentLoaded and navigation→load durations.
  // Uses PerformanceNavigationTiming when available, falls back to Date.now().
  var _startupMs = null;   // DOMContentLoaded duration from nav start
  var _loadMs    = null;   // window load event duration from nav start

  (function () {
    try {
      var nav = G.performance && G.performance.getEntriesByType &&
                G.performance.getEntriesByType('navigation')[0];
      if (nav) {
        _startupMs = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
        _loadMs    = Math.round(nav.loadEventEnd - nav.startTime);
      }
    } catch (_) {}

    // Fallback: hook events if nav timing not yet populated
    if (!_startupMs) {
      var _navStart = (G.performance && G.performance.timing &&
                       G.performance.timing.navigationStart) || Date.now();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          _startupMs = Date.now() - _navStart;
        }, { once: true });
      } else {
        _startupMs = Date.now() - _navStart;
      }
    }
    if (!_loadMs) {
      var _navStart2 = (G.performance && G.performance.timing &&
                        G.performance.timing.navigationStart) || Date.now();
      G.addEventListener('load', function () {
        _loadMs = Date.now() - _navStart2;
      }, { once: true });
    }
  }());

  // ── Memory sampler ────────────────────────────────────────────────────────
  var _memorySamples = [];
  var _MAX_MEM_SAMPLES = 20;
  function _sampleMemory() {
    try {
      var m = G.performance && G.performance.memory;
      if (!m) return;
      _memorySamples.push({
        ts:        Date.now(),
        usedMb:    +(m.usedJSHeapSize  / 1048576).toFixed(1),
        totalMb:   +(m.totalJSHeapSize / 1048576).toFixed(1),
        limitMb:   +(m.jsHeapSizeLimit / 1048576).toFixed(1),
      });
      if (_memorySamples.length > _MAX_MEM_SAMPLES) _memorySamples.shift();
    } catch (_) {}
  }
  setInterval(_sampleMemory, 15000);
  _sampleMemory();

  // ── Tool timing API ───────────────────────────────────────────────────────
  function recordToolRun(toolId, durationMs, succeeded) {
    _metrics.toolRuns.push({ tool: toolId, ms: durationMs, ok: !!succeeded, ts: Date.now() });
    if (_metrics.toolRuns.length > _MAX_TOOL_RUNS) _metrics.toolRuns.shift();
    try {
      var st = G.SecurityTelemetry;
      if (st && typeof st.record === 'function') {
        st.record('tool-perf', { tool: toolId, ms: durationMs, ok: !!succeeded });
      }
    } catch (_) {}
  }

  function getReport() {
    var mem = _memorySamples.length ? _memorySamples[_memorySamples.length - 1] : null;
    return {
      vitals: {
        lcp:   _metrics.lcp,
        fid:   _metrics.fid,
        cls:   _metrics.cls,
        fcp:   _metrics.fcp,
        ttfb:  _metrics.ttfb,
      },
      startup:      { domContentLoadedMs: _startupMs, loadMs: _loadMs },
      longTasks:    { count: _metrics.longTasks, totalMs: _metrics.longTaskMs },
      memory:       mem,
      memorySamples:_memorySamples.slice(),
      toolRuns:     _metrics.toolRuns.slice(),
      ts:           Date.now(),
    };
  }

  G.RuntimePerformanceMonitor = Object.freeze({
    recordToolRun:    recordToolRun,
    getReport:        getReport,
    getStartupMs:     function () { return { domContentLoadedMs: _startupMs, loadMs: _loadMs }; },
    getVitals: function () { return Object.assign({}, _metrics.lcp !== null ? {
      lcp: _metrics.lcp, fid: _metrics.fid, cls: _metrics.cls,
      fcp: _metrics.fcp, ttfb: _metrics.ttfb,
    } : {}); },
  });
}());

// ── SOURCE: public/js/runtime-stream-pipeline.js ──
// runtime-stream-pipeline.js — Phase 9 unified stream pipeline
// Provides a composable, backpressure-aware stream pipeline for large file
// processing. Chunks input, passes through transform stages, and outputs via
// ReadableStream or direct callback. Integrates with RuntimeNetworkState for
// adaptive chunk sizing and RuntimeMemoryRecovery for pressure events.
// Exposes window.RuntimeStreamPipeline.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeStreamPipeline) return;

  var _DEFAULT_CHUNK = 2 * 1024 * 1024; // 2 MB default
  var _pipelines = new Map(); // id → { active, stages, bytesSent, bytesTotal }

  // ── Get adaptive chunk size ───────────────────────────────────────────────
  function _chunkSize() {
    try {
      var ns = G.RuntimeNetworkState;
      if (ns && typeof ns.recommendedChunkBytes === 'function') {
        return ns.recommendedChunkBytes();
      }
    } catch (_) {}
    return _DEFAULT_CHUNK;
  }

  // ── Create a pipeline ─────────────────────────────────────────────────────
  // stages: array of async (chunk: Uint8Array) → Uint8Array transform functions
  // opts:  { chunkSize, onProgress, signal }
  // Returns: Promise<Uint8Array> — concatenated output
  async function create(id, input, stages, opts) {
    opts = opts || {};
    if (_pipelines.has(id)) throw new Error('pipeline ' + id + ' already active');

    var bytes = input instanceof Uint8Array ? input :
                input instanceof ArrayBuffer ? new Uint8Array(input) :
                (input && input.buffer instanceof ArrayBuffer) ? new Uint8Array(input.buffer) :
                null;

    if (!bytes) throw new TypeError('RuntimeStreamPipeline: input must be Uint8Array / ArrayBuffer');

    var chunkSz  = opts.chunkSize || _chunkSize();
    var total    = bytes.byteLength;
    var pipeline = { active: true, stages: stages.length, bytesSent: 0, bytesTotal: total };
    _pipelines.set(id, pipeline);

    try {
      var chunks = [];
      var offset = 0;
      while (offset < total) {
        if (opts.signal && opts.signal.aborted) throw new Error('pipeline_aborted');
        var end   = Math.min(offset + chunkSz, total);
        var chunk = bytes.slice(offset, end);
        offset = end;

        // Pass through each stage in sequence
        var transformed = chunk;
        for (var si = 0; si < stages.length; si++) {
          if (!pipeline.active) throw new Error('pipeline_cancelled');
          try {
            transformed = await stages[si](transformed, { id: id, offset: offset, total: total });
          } catch (e) {
            console.warn('[StreamPipeline] stage', si, 'failed:', e && e.message);
            throw e;
          }
        }

        chunks.push(transformed);
        pipeline.bytesSent += end - (offset - (end - offset));

        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(pipeline.bytesSent / total); } catch (_) {}
        }
      }

      // Concatenate all chunks
      var outLen = chunks.reduce(function (s, c) { return s + c.byteLength; }, 0);
      var out    = new Uint8Array(outLen);
      var pos    = 0;
      chunks.forEach(function (c) { out.set(c, pos); pos += c.byteLength; });
      return out;
    } finally {
      pipeline.active = false;
      _pipelines.delete(id);
    }
  }

  // ── Cancel an active pipeline ─────────────────────────────────────────────
  function cancel(id) {
    var p = _pipelines.get(id);
    if (p) { p.active = false; _pipelines.delete(id); }
  }

  // ── Built-in identity stage (passthrough — useful for testing) ────────────
  function identityStage(chunk) { return chunk; }

  G.RuntimeStreamPipeline = Object.freeze({
    create:        create,
    cancel:        cancel,
    identityStage: identityStage,
    getActive: function () {
      var out = [];
      _pipelines.forEach(function (p, id) {
        out.push({ id: id, bytesSent: p.bytesSent, bytesTotal: p.bytesTotal });
      });
      return out;
    },
  });
}());

// ── SOURCE: public/js/runtime-worker-prewarm.js ──
// runtime-worker-prewarm.js — Phase 9 worker pool prewarming
// Proactively warms WorkerPool slots for the top tools (pdf-lib, pdf-worker,
// compress) after the first file drop or during idle time, so the first
// real dispatch hits a warm slot instead of paying worker boot latency.
// Exposes window.RuntimeWorkerPrewarm.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeWorkerPrewarm) return;

  var _warmed   = new Set();
  var _started  = false;
  var _DROP_TRIGGERED = false;

  // Workers to prewarm in priority order (highest → lowest)
  var PREWARM_TARGETS = [
    { url: '/workers/pdf-lib-worker.js',  priority: 1 },
    { url: '/workers/pdf-worker.js',      priority: 2 },
    { url: '/workers/compress-worker.js', priority: 3 },
    { url: '/workers/advanced-worker.js', priority: 4 },
  ];

  // ── Single-slot prewarm via WorkerPool ────────────────────────────────────
  function _warmOne(target) {
    if (_warmed.has(target.url)) return;
    _warmed.add(target.url);
    try {
      var WP = G.WorkerPool;
      if (WP && typeof WP.prewarm === 'function') {
        WP.prewarm(target.url, 1).catch(function () {});
      } else if (WP && typeof WP.run === 'function') {
        // Fallback: send a no-op ping so the slot boots
        WP.run(target.url, { __ping: true }, 'background').catch(function () {});
      }
    } catch (_) {}
  }

  // ── Idle-time prewarm ─────────────────────────────────────────────────────
  function _idlePrewarm() {
    if (_started) return;
    _started = true;
    var idx = 0;
    function _next(deadline) {
      while (idx < PREWARM_TARGETS.length &&
             (!deadline || deadline.timeRemaining() > 10)) {
        _warmOne(PREWARM_TARGETS[idx++]);
      }
      if (idx < PREWARM_TARGETS.length) {
        if (G.requestIdleCallback) {
          G.requestIdleCallback(_next, { timeout: 8000 });
        } else {
          setTimeout(function () { _next(null); }, 1500);
        }
      }
    }
    if (G.requestIdleCallback) {
      G.requestIdleCallback(_next, { timeout: 5000 });
    } else {
      setTimeout(function () { _next(null); }, 4000);
    }
  }

  // ── File-drop triggered prewarm (warm top 2 immediately) ─────────────────
  function onFileDrop() {
    if (_DROP_TRIGGERED) return;
    _DROP_TRIGGERED = true;
    _warmOne(PREWARM_TARGETS[0]);
    _warmOne(PREWARM_TARGETS[1]);
    // Warm remaining on next idle
    _idlePrewarm();
  }

  // ── Tool-hint prewarm (warm the specific worker for a tool) ──────────────
  var _TOOL_WORKER = {
    'merge':         '/workers/pdf-lib-worker.js',
    'split':         '/workers/pdf-lib-worker.js',
    'rotate':        '/workers/pdf-lib-worker.js',
    'crop':          '/workers/pdf-lib-worker.js',
    'protect':       '/workers/pdf-lib-worker.js',
    'unlock':        '/workers/pdf-lib-worker.js',
    'watermark':     '/workers/pdf-lib-worker.js',
    'page-numbers':  '/workers/pdf-lib-worker.js',
    'compress':      '/workers/compress-worker.js',
    'ocr':           '/workers/pdf-worker.js',
    'pdf-to-word':   '/workers/pdf-worker.js',
    'ai-summarize':  '/workers/advanced-worker.js',
  };

  function prewarmForTool(toolId) {
    var url = _TOOL_WORKER[toolId];
    if (url) _warmOne({ url: url });
  }

  // ── Auto-attach to file drop zones on DOMContentLoaded ───────────────────
  function _attachDropListeners() {
    try {
      var zones = document.querySelectorAll('[data-drop-zone],[id="drop-zone"],[class*="upload"]');
      if (!zones.length) zones = [document];
      zones.forEach(function (el) {
        el.addEventListener('dragover', function () { onFileDrop(); }, { once: true, passive: true });
        el.addEventListener('drop',     function () { onFileDrop(); }, { once: true, passive: true });
      });
      var inputs = document.querySelectorAll('input[type="file"]');
      inputs.forEach(function (el) {
        el.addEventListener('change', function () { onFileDrop(); }, { once: true, passive: true });
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _attachDropListeners);
  } else {
    setTimeout(_attachDropListeners, 0);
  }

  // Start idle prewarm 6 s after page load (generous delay to avoid
  // contending with the main-thread during initial render).
  setTimeout(_idlePrewarm, 6000);

  G.RuntimeWorkerPrewarm = Object.freeze({
    onFileDrop:     onFileDrop,
    prewarmForTool: prewarmForTool,
    isWarmed: function (url) { return _warmed.has(url); },
    getStats: function () {
      return { warmed: Array.from(_warmed), dropTriggered: _DROP_TRIGGERED, started: _started };
    },
  });
}());

