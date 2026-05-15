// RuntimeAdaptivePipeline v1.0 — Phase 7E
// =====================================================================
// Adaptive Pipeline Engine — dynamically tunes batch sizes, chunk sizes,
// worker concurrency, and memory thresholds based on real-time signals:
//
//   • RuntimeMemory tier    (NORMAL / WARNING / CRITICAL / EMERGENCY)
//   • navigator.deviceMemory (device RAM class)
//   • navigator.hardwareConcurrency (CPU core count)
//   • WorkerPool queue depth (back-pressure from worker pool)
//   • RuntimeHealth score   (0-100, degrades limits when unhealthy)
//   • JS heap pressure      (performance.memory when available)
//
// All tuning parameters are updated lazily (max once per _TUNE_INTERVAL_MS)
// and exposed as simple getters so every caller uses consistent values.
//
// Callers that perform their own adaptive logic (LargeFileStreaming, Phase32,
// AdvancedEngine) query this module instead of computing their own heuristics.
//
// API: window.RuntimeAdaptivePipeline
//   .chunkSize()            → number (bytes per OPFS/stream chunk)
//   .batchSize()            → number (pages or items per processing batch)
//   .maxConcurrency()       → number (max simultaneous heavy tasks)
//   .shouldThrottle()       → boolean (true = caller should yield before next op)
//   .throttleYieldMs()      → number (ms to yield when shouldThrottle() is true)
//   .getProfile()           → { tier, chunkSz, batchSz, concurrency, score, ... }
//   .onProfileChange(fn)    → subscribe to profile change events
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeAdaptivePipeline) return;

  var LOG            = '[RAP]';
  var TUNE_INTERVAL  = 5000; // re-evaluate every 5 s
  var MB             = 1024 * 1024;

  // ── Device class detection (run once at init) ──────────────────────────────
  var _deviceMemGB  = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
  var _cpuCores     = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  var _isMobile     = typeof navigator !== 'undefined' && /Mobile|Tablet|Android|iPhone|iPad/i.test(navigator.userAgent || '');

  // ── Device tier: 'low' | 'mid' | 'high' ───────────────────────────────────
  var _deviceTier = (function () {
    if (_deviceMemGB <= 2 || _cpuCores <= 2 || _isMobile) return 'low';
    if (_deviceMemGB >= 8 && _cpuCores >= 8)              return 'high';
    return 'mid';
  }());

  // ── Current profile state ──────────────────────────────────────────────────
  var _profile = {
    tier:        'NORMAL',
    deviceTier:  _deviceTier,
    healthScore: 100,
    chunkSz:     8 * MB,
    batchSz:     10,
    concurrency: 2,
    throttle:    false,
    yieldMs:     0,
    heapPct:     0,
    queueDepth:  0,
    ts:          0,
  };

  var _subscribers = new Set();

  // ── Base tables by device tier ─────────────────────────────────────────────
  var _BASE = {
    low: {
      NORMAL:    { chunk: 2 * MB, batch: 3, conc: 1 },
      WARNING:   { chunk: MB,     batch: 2, conc: 1 },
      CRITICAL:  { chunk: MB,     batch: 1, conc: 1 },
      EMERGENCY: { chunk: MB,     batch: 1, conc: 1 },
    },
    mid: {
      NORMAL:    { chunk: 8 * MB, batch: 10, conc: 2 },
      WARNING:   { chunk: 4 * MB, batch: 5,  conc: 2 },
      CRITICAL:  { chunk: 2 * MB, batch: 2,  conc: 1 },
      EMERGENCY: { chunk: MB,     batch: 1,  conc: 1 },
    },
    high: {
      NORMAL:    { chunk: 16 * MB, batch: 20, conc: 4 },
      WARNING:   { chunk: 8 * MB,  batch: 10, conc: 3 },
      CRITICAL:  { chunk: 4 * MB,  batch: 4,  conc: 2 },
      EMERGENCY: { chunk: 2 * MB,  batch: 2,  conc: 1 },
    },
  };

  // ── Read current memory tier ───────────────────────────────────────────────
  function _memTier() {
    if (global.RuntimeMemory && global.RuntimeMemory.getTier) {
      return global.RuntimeMemory.getTier() || 'NORMAL';
    }
    // Fallback: estimate from heap
    try {
      var m   = performance.memory;
      var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
      if (pct > 0.90) return 'EMERGENCY';
      if (pct > 0.75) return 'CRITICAL';
      if (pct > 0.55) return 'WARNING';
    } catch (_) {}
    return 'NORMAL';
  }

  // ── Read health score ──────────────────────────────────────────────────────
  function _healthScore() {
    if (global.RuntimeHealth && global.RuntimeHealth.getScore) {
      return global.RuntimeHealth.getScore();
    }
    return 100;
  }

  // ── Read JS heap pressure ──────────────────────────────────────────────────
  function _heapPct() {
    try {
      var m = performance.memory;
      return m ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0;
    } catch (_) { return 0; }
  }

  // ── Read WorkerPool queue depth ────────────────────────────────────────────
  function _queueDepth() {
    if (global.WorkerPool && global.WorkerPool.getStats) {
      try {
        var s = global.WorkerPool.getStats();
        return (s.queued || 0) + (s.inflight || 0);
      } catch (_) {}
    }
    if (global.RuntimeWorkers && global.RuntimeWorkers.getStats) {
      try {
        var rs = global.RuntimeWorkers.getStats();
        return rs.inflight || 0;
      } catch (_) {}
    }
    return 0;
  }

  // ── Tune engine ───────────────────────────────────────────────────────────
  function _tune() {
    var now = Date.now();
    if (now - _profile.ts < TUNE_INTERVAL) return; // debounce

    var tier    = _memTier();
    var score   = _healthScore();
    var heap    = _heapPct();
    var qdepth  = _queueDepth();
    var dtier   = _deviceTier;

    var base = _BASE[dtier][tier] || _BASE.mid.NORMAL;

    // Health score deductions: low health → smaller chunks, lower concurrency
    var healthFactor = (score < 50) ? 0.5 : (score < 75) ? 0.75 : 1.0;

    // Heap pressure deductions
    var heapFactor = (heap > 0.80) ? 0.5 : (heap > 0.65) ? 0.75 : 1.0;

    var factor  = Math.min(healthFactor, heapFactor);
    var chunkSz = Math.max(MB, Math.round(base.chunk * factor));
    var batchSz = Math.max(1, Math.round(base.batch * factor));
    var conc    = Math.max(1, Math.round(base.conc * factor));

    // Queue depth throttling: if pool is backed up, reduce concurrency further
    var throttle = (qdepth >= 4) || (tier === 'CRITICAL' || tier === 'EMERGENCY');
    var yieldMs  = throttle ? (tier === 'EMERGENCY' ? 50 : (tier === 'CRITICAL' ? 20 : 10)) : 0;

    var changed = (
      tier    !== _profile.tier    ||
      chunkSz !== _profile.chunkSz ||
      batchSz !== _profile.batchSz ||
      conc    !== _profile.concurrency ||
      throttle !== _profile.throttle
    );

    _profile = {
      tier:        tier,
      deviceTier:  dtier,
      healthScore: score,
      chunkSz:     chunkSz,
      batchSz:     batchSz,
      concurrency: conc,
      throttle:    throttle,
      yieldMs:     yieldMs,
      heapPct:     heap,
      queueDepth:  qdepth,
      ts:          now,
    };

    if (changed) {
      _subscribers.forEach(function (fn) {
        try { fn(Object.assign({}, _profile)); } catch (_) {}
      });
      if (global.RuntimeTelemetry) {
        try {
          global.RuntimeTelemetry.record('adaptive-pipeline:tuned', {
            tier: tier, chunkSz: chunkSz, batchSz: batchSz, conc: conc, score: score,
          });
        } catch (_) {}
      }
    }
  }

  // ── Lazy init: first call primes the profile ───────────────────────────────
  var _initDone = false;
  function _ensureInit() {
    if (!_initDone) {
      _initDone = true;
      _tune();
      // Subscribe to memory events for proactive re-tuning
      if (global.RuntimeEventBus) {
        try {
          global.RuntimeEventBus.on('memory:tier-changed', function () {
            _profile.ts = 0; // force retune
            _tune();
          });
        } catch (_) {}
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function chunkSize() {
    _ensureInit(); _tune();
    return _profile.chunkSz;
  }

  function batchSize() {
    _ensureInit(); _tune();
    return _profile.batchSz;
  }

  function maxConcurrency() {
    _ensureInit(); _tune();
    return _profile.concurrency;
  }

  function shouldThrottle() {
    _ensureInit(); _tune();
    return _profile.throttle;
  }

  function throttleYieldMs() {
    _ensureInit(); _tune();
    return _profile.yieldMs;
  }

  function getProfile() {
    _ensureInit(); _tune();
    return Object.assign({}, _profile);
  }

  function onProfileChange(fn) {
    _ensureInit();
    _subscribers.add(fn);
    return function () { _subscribers.delete(fn); };
  }

  // Yield helper for callers: awaitable pause when throttle is active
  function yieldIfThrottled() {
    _ensureInit();
    if (!_profile.throttle || _profile.yieldMs <= 0) return Promise.resolve();
    return new Promise(function (r) { setTimeout(r, _profile.yieldMs); });
  }

  global.RuntimeAdaptivePipeline = {
    chunkSize:        chunkSize,
    batchSize:        batchSize,
    maxConcurrency:   maxConcurrency,
    shouldThrottle:   shouldThrottle,
    throttleYieldMs:  throttleYieldMs,
    getProfile:       getProfile,
    onProfileChange:  onProfileChange,
    yieldIfThrottled: yieldIfThrottled,
  };

  console.info(LOG, 'RuntimeAdaptivePipeline v1.0 ready — device tier:', _deviceTier, '/ cores:', _cpuCores, '/ RAM:', _deviceMemGB + 'GB');
}(window));
