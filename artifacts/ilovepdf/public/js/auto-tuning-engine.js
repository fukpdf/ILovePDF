// Phase G — Advanced Auto-Tuning Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
// Extends Phase 31 AutoTuner without replacing it.
//
// § G1  HardwareBenchmark   — GPU, CPU, WASM, memory benchmarks
// § G2  DeviceFingerprint   — capability scoring (local-only, no external transmission)
// § G3  AdaptiveController  — live tuning of workers, scale, chunk, concurrency
// § G4  OptimizationMemory  — rolling history of best params per device tier
// § G5  PerformanceTelemetry— per-tool timing, page/s, MB/s metrics (local only)
//
// Exposes: window.AutoTuningEngine

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[ATE]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  var _IDB_NAME  = 'p37-autotune-v1';
  var _IDB_STORE = 'profiles';
  var _db        = null;

  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(_IDB_NAME, 1);
      req.onupgradeneeded = function (e) { e.target.result.createObjectStore(_IDB_STORE, { keyPath: 'k' }); };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror   = function () { rej(req.error); };
    });
  }

  function _idbPut(rec) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).put(rec);
        tx.oncomplete = function () { res(true); };
        tx.onerror    = function () { res(false); };
      });
    }).catch(function () { return false; });
  }

  function _idbGet(key) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        var req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(key);
        req.onsuccess = function () { res(req.result || null); };
        req.onerror   = function () { res(null); };
      });
    }).catch(function () { return null; });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § G1  HARDWARE BENCHMARK
  // Runs micro-benchmarks on first load to score the device.
  // ═══════════════════════════════════════════════════════════════════════════
  var HardwareBenchmark = (function () {
    var _results = null;
    var _running = false;

    // CPU: integer ops/ms
    function _cpuScore() {
      var start = performance.now();
      var x = 0;
      for (var i = 0; i < 2000000; i++) { x = (x + i * 3) ^ (i >> 2); }
      return Math.round(2000000 / (performance.now() - start));
    }

    // WASM: f32 multiply loop
    async function _wasmScore() {
      if (typeof WebAssembly === 'undefined') return 0;
      try {
        // Minimal WASM: f32 multiply loop (hand-crafted WAT binary)
        var wat = '(module (func $bench (result i32) (local $i i32) (local $x f32) (local.set $x (f32.const 1.1)) (block $break (loop $loop (local.set $i (i32.add (local.get $i) (i32.const 1))) (local.set $x (f32.mul (local.get $x) (f32.const 1.000001))) (br_if $break (i32.ge_u (local.get $i) (i32.const 500000))) (br $loop))) (i32.const 1)) (export "bench" (func $bench)))';
        var mod  = await WebAssembly.compile(new TextEncoder().encode(wat)).catch(function () { return null; });
        if (!mod) return 500;
        var inst = await WebAssembly.instantiate(mod, {});
        var start = performance.now();
        for (var i = 0; i < 10; i++) inst.exports.bench();
        var ms = performance.now() - start;
        return Math.round(5000000 / ms);
      } catch (_) { return 500; }
    }

    // Memory bandwidth: large ArrayBuffer copy
    function _memScore() {
      try {
        var N   = 8 * MB;
        var src = new Float32Array(N / 4);
        var dst = new Float32Array(N / 4);
        for (var i = 0; i < src.length; i++) src[i] = i * 0.001;
        var start = performance.now();
        dst.set(src);
        var ms    = performance.now() - start;
        return Math.round((N / MB) / (ms / 1000));  // MB/s
      } catch (_) { return 100; }
    }

    // GPU: simple pipeline test
    async function _gpuScore() {
      if (typeof navigator === 'undefined' || !navigator.gpu) return 0;
      try {
        var adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return 0;
        var device  = await adapter.requestDevice();
        if (!device) return 0;
        // Score by limits
        var score = 50;
        var limits = device.limits;
        if (limits.maxComputeWorkgroupSizeX >= 256) score += 25;
        if (limits.maxStorageBufferBindingSize >= 256 * MB) score += 25;
        device.destroy();
        return score;
      } catch (_) { return 0; }
    }

    async function run() {
      if (_results) return _results;
      if (_running) return null;
      _running = true;
      try {
        var cpu  = _cpuScore();
        var mem  = _memScore();
        var wasm = await _wasmScore();
        var gpu  = await _gpuScore();
        var cores = navigator.hardwareConcurrency || 2;
        var ram   = 0;
        if (navigator.deviceMemory) ram = navigator.deviceMemory;

        _results = { cpu: cpu, mem: mem, wasm: wasm, gpu: gpu, cores: cores, ramGB: ram, ts: Date.now() };
        _log('benchmark', _results);
        return _results;
      } catch (ex) {
        _err('benchmark', ex);
        return { cpu: 500, mem: 100, wasm: 500, gpu: 0, cores: 2, ramGB: 2, ts: Date.now() };
      } finally {
        _running = false;
      }
    }

    function getResults() { return _results; }
    return { run: run, getResults: getResults };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G2  DEVICE FINGERPRINT
  // Scores the device into a tier (0–4) using benchmark results + navigator API.
  // ALL DATA IS LOCAL ONLY — nothing is transmitted externally.
  // ═══════════════════════════════════════════════════════════════════════════
  var DeviceFingerprint = (function () {
    var _score = null;

    function compute(benchResults) {
      if (!benchResults) benchResults = { cpu: 500, mem: 100, wasm: 500, gpu: 0, cores: 2, ramGB: 2 };
      var score = 0;
      // CPU
      if (benchResults.cpu > 3000000) score += 2;
      else if (benchResults.cpu > 1000000) score += 1;
      // Memory bandwidth
      if (benchResults.mem > 5000) score += 2;
      else if (benchResults.mem > 2000) score += 1;
      // WASM
      if (benchResults.wasm > 2000000) score += 2;
      else if (benchResults.wasm > 500000) score += 1;
      // GPU
      if (benchResults.gpu >= 75) score += 3;
      else if (benchResults.gpu >= 50) score += 2;
      else if (benchResults.gpu > 0) score += 1;
      // Cores
      if (benchResults.cores >= 8) score += 2;
      else if (benchResults.cores >= 4) score += 1;
      // RAM
      if (benchResults.ramGB >= 8) score += 2;
      else if (benchResults.ramGB >= 4) score += 1;

      // Tier 0 = very low-end, 4 = high-end workstation
      var tier = score >= 12 ? 4 : score >= 9 ? 3 : score >= 6 ? 2 : score >= 3 ? 1 : 0;
      _score   = { score: score, tier: tier, maxScore: 14, benchResults: benchResults };
      _log('fingerprint', _score);
      return _score;
    }

    function getTier() { return _score ? _score.tier : 2; }
    function getScore() { return _score; }
    return { compute: compute, getTier: getTier, getScore: getScore };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G3  ADAPTIVE CONTROLLER
  // Derives optimal processing parameters from device tier + memory pressure.
  // ═══════════════════════════════════════════════════════════════════════════
  var AdaptiveController = (function () {
    var _overrides = {};

    function _tier() {
      var mp   = window.MemPressure;
      var pt   = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      var dt   = DeviceFingerprint.getTier();
      // Reduce device tier under memory pressure
      if (pt === 'critical') return Math.max(0, dt - 2);
      if (pt === 'danger')   return Math.max(0, dt - 2);
      if (pt === 'high')     return Math.max(0, dt - 1);
      return dt;
    }

    function workerCount() {
      if (_overrides.workerCount !== undefined) return _overrides.workerCount;
      var t   = _tier();
      var map = [1, 2, 2, 4, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)];
      return map[t] || 2;
    }

    function renderScale() {
      if (_overrides.renderScale !== undefined) return _overrides.renderScale;
      var t   = _tier();
      var map = [0.75, 1.0, 1.2, 1.5, 2.0];
      return map[t] || 1.0;
    }

    function chunkSizeMB() {
      if (_overrides.chunkSizeMB !== undefined) return _overrides.chunkSizeMB;
      var t   = _tier();
      var map = [1, 2, 4, 8, 16];
      return map[t] || 4;
    }

    function concurrency() {
      if (_overrides.concurrency !== undefined) return _overrides.concurrency;
      var t   = _tier();
      var map = [1, 1, 2, 3, 4];
      return map[t] || 2;
    }

    function ocrMode() {
      if (_overrides.ocrMode !== undefined) return _overrides.ocrMode;
      var t = _tier();
      return t >= 3 ? 'dense-text' : t >= 2 ? 'normal' : 'fast';
    }

    function batchSize() {
      if (_overrides.batchSize !== undefined) return _overrides.batchSize;
      var t   = _tier();
      var map = [1, 2, 4, 8, 16];
      return map[t] || 4;
    }

    function setOverride(key, value) { _overrides[key] = value; }
    function clearOverrides() { _overrides = {}; }

    function getAll() {
      return {
        workerCount:  workerCount(),
        renderScale:  renderScale(),
        chunkSizeMB:  chunkSizeMB(),
        concurrency:  concurrency(),
        ocrMode:      ocrMode(),
        batchSize:    batchSize(),
        deviceTier:   _tier(),
      };
    }

    // Push params to existing Phase31 AutoTuner if present
    function sync() {
      var p31at = window.Phase31 && window.Phase31.AutoTuner;
      if (!p31at || typeof p31at.override !== 'function') return;
      var params = getAll();
      try { p31at.override(params); } catch (_) {}
    }

    // Sync every 30s
    setInterval(sync, 30000);

    return { workerCount: workerCount, renderScale: renderScale, chunkSizeMB: chunkSizeMB, concurrency: concurrency, ocrMode: ocrMode, batchSize: batchSize, setOverride: setOverride, clearOverrides: clearOverrides, getAll: getAll, sync: sync };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G4  OPTIMIZATION MEMORY
  // Stores best-performing params per device tier in IDB for future sessions.
  // ═══════════════════════════════════════════════════════════════════════════
  var OptimizationMemory = (function () {
    var _cache = {};

    function save(tier, toolId, params, perfMetrics) {
      var k   = 'tier' + tier + ':' + toolId;
      var rec = { k: k, tier: tier, toolId: toolId, params: params, perf: perfMetrics, ts: Date.now() };
      _cache[k] = rec;
      return _idbPut(rec);
    }

    function load(tier, toolId) {
      var k = 'tier' + tier + ':' + toolId;
      if (_cache[k]) return Promise.resolve(_cache[k]);
      return _idbGet(k).then(function (r) {
        if (r) _cache[k] = r;
        return r;
      });
    }

    // Find the best params for current device tier
    async function getBestParams(toolId) {
      var tier   = DeviceFingerprint.getTier();
      var stored = await load(tier, toolId);
      if (stored && stored.params) return stored.params;
      return AdaptiveController.getAll();
    }

    return { save: save, load: load, getBestParams: getBestParams };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § G5  PERFORMANCE TELEMETRY (local only)
  // Records per-tool timing, page/s, MB/s. No external transmission.
  // ═══════════════════════════════════════════════════════════════════════════
  var PerformanceTelemetry = (function () {
    var _sessions = {};   // toolId → { startMs, pages, bytes, checkpoints }
    var _history  = [];   // last 50 completed sessions
    var MAX_HIST  = 50;

    function startSession(toolId, totalPages, totalBytes) {
      var id = toolId + '_' + Date.now();
      _sessions[id] = {
        id: id, toolId: toolId,
        startMs: performance.now(),
        totalPages: totalPages || 0,
        totalBytes: totalBytes || 0,
        completedPages: 0,
        checkpoints: [],
      };
      return id;
    }

    function checkpoint(sessionId, pagesCompleted, note) {
      var s = _sessions[sessionId];
      if (!s) return;
      s.completedPages = pagesCompleted;
      s.checkpoints.push({ ms: performance.now() - s.startMs, pages: pagesCompleted, note: note || '' });
    }

    function endSession(sessionId) {
      var s = _sessions[sessionId];
      if (!s) return null;
      var elapsed = performance.now() - s.startMs;
      var report  = {
        toolId:     s.toolId,
        elapsedMs:  Math.round(elapsed),
        pagesPerSec: s.totalPages > 0 ? (s.totalPages / (elapsed / 1000)).toFixed(2) : 0,
        mbPerSec:    s.totalBytes > 0 ? (s.totalBytes / MB / (elapsed / 1000)).toFixed(2) : 0,
        totalPages:  s.totalPages,
        checkpoints: s.checkpoints,
        deviceTier:  DeviceFingerprint.getTier(),
        ts:          Date.now(),
      };
      _history.unshift(report);
      if (_history.length > MAX_HIST) _history.pop();
      delete _sessions[sessionId];

      // Save best params if this session was fast
      if (report.pagesPerSec > 0) {
        OptimizationMemory.save(report.deviceTier, report.toolId, AdaptiveController.getAll(), {
          pagesPerSec: report.pagesPerSec, mbPerSec: report.mbPerSec,
        }).catch(function () {});
      }

      _log('session-end', report);
      return report;
    }

    function getHistory(toolId) {
      if (!toolId) return _history.slice();
      return _history.filter(function (r) { return r.toolId === toolId; });
    }

    function getStats() {
      return {
        activeSessions: Object.keys(_sessions).length,
        historyCount:   _history.length,
        recentTools:    _history.slice(0, 5).map(function (r) { return r.toolId; }),
      };
    }

    return { startSession: startSession, checkpoint: checkpoint, endSession: endSession, getHistory: getHistory, getStats: getStats };
  }());


  // ── Bootstrap: run benchmark + fingerprint asynchronously ─────────────────
  setTimeout(async function () {
    try {
      var bench = await HardwareBenchmark.run();
      DeviceFingerprint.compute(bench);
      AdaptiveController.sync();
      _log('bootstrap-complete', { tier: DeviceFingerprint.getTier() });
    } catch (ex) {
      _err('bootstrap', ex);
      DeviceFingerprint.compute(null);
    }
  }, 3000);


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.AutoTuningEngine = {
    version:              VERSION,
    HardwareBenchmark:    HardwareBenchmark,
    DeviceFingerprint:    DeviceFingerprint,
    AdaptiveController:   AdaptiveController,
    OptimizationMemory:   OptimizationMemory,
    PerformanceTelemetry: PerformanceTelemetry,

    // Convenience: get tuned params for current device + memory state
    getParams: function () { return AdaptiveController.getAll(); },

    // Convenience: get best known params for a tool
    getBestParams: function (toolId) { return OptimizationMemory.getBestParams(toolId); },

    // Convenience: start a perf session
    startSession: function (toolId, pages, bytes) { return PerformanceTelemetry.startSession(toolId, pages, bytes); },
    endSession:   function (id) { return PerformanceTelemetry.endSession(id); },

    audit: function () {
      return {
        version:      VERSION,
        deviceTier:   DeviceFingerprint.getTier(),
        deviceScore:  DeviceFingerprint.getScore(),
        benchmark:    HardwareBenchmark.getResults(),
        currentParams: AdaptiveController.getAll(),
        telemetry:    PerformanceTelemetry.getStats(),
      };
    },
  };

  _log('loaded', {});
}());
