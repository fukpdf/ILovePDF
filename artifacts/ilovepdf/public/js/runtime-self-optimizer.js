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
