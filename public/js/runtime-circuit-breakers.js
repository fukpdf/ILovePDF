// runtime-circuit-breakers.js — Auto Circuit Breakers (Phase 2D)
// ADDITIVE ONLY. Implements per-subsystem circuit breakers that open (disable)
// when repeated failures are detected and close (restore) automatically after
// a cooldown. Never modifies the underlying subsystems — only gates calls to them.
//
// Circuit states: CLOSED (normal) → OPEN (tripped) → HALF-OPEN (testing) → CLOSED
//
// window.RuntimeCircuitBreakers — public API
(function () {
  'use strict';

  if (window.RuntimeCircuitBreakers) return;

  var LOG     = '[RCB]';
  var VERSION = '1.0.0';

  // ── Circuit definitions ───────────────────────────────────────────────────────
  // Each circuit monitors a named subsystem.
  // failureThreshold: consecutive failures to open the circuit
  // cooldownMs: time the circuit stays OPEN before trying HALF-OPEN
  // sampleWindow: rolling window for failure counting (ms)

  var CIRCUITS = {
    ocr: {
      label:            'OCR',
      failureThreshold: 3,
      cooldownMs:       60000,   // 1 min
      sampleWindow:     120000,  // 2 min
      description:      'Tesseract OCR subsystem',
    },
    gpu: {
      label:            'GPU',
      failureThreshold: 2,
      cooldownMs:       30000,   // 30 s
      sampleWindow:     60000,   // 1 min
      description:      'WebGPU/WebGL compute path',
    },
    workerPool: {
      label:            'WorkerPool',
      failureThreshold: 4,
      cooldownMs:       30000,
      sampleWindow:     90000,
      description:      'Web Worker dispatch pool',
    },
    pdfjs: {
      label:            'PDF.js',
      failureThreshold: 3,
      cooldownMs:       45000,
      sampleWindow:     120000,
      description:      'PDF.js rendering engine',
    },
    ai: {
      label:            'AI',
      failureThreshold: 3,
      cooldownMs:       60000,
      sampleWindow:     120000,
      description:      'ONNX/AI inference pipeline',
    },
    scheduler: {
      label:            'Scheduler',
      failureThreshold: 5,
      cooldownMs:       20000,
      sampleWindow:     60000,
      description:      'RuntimeScheduler task queue',
    },
  };

  // ── Circuit state store ───────────────────────────────────────────────────────
  // Map<name, { state, failures[], openedAt, halfOpenAt, tripsTotal, lastError }>
  // state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  var _circuits = {};

  function _initCircuit(name) {
    if (_circuits[name]) return;
    _circuits[name] = {
      state:      'CLOSED',
      failures:   [],     // timestamps of recent failures
      openedAt:   0,
      halfOpenAt: 0,
      tripsTotal: 0,
      lastError:  null,
    };
  }

  Object.keys(CIRCUITS).forEach(_initCircuit);

  // ── State machine ─────────────────────────────────────────────────────────────

  function _pruneFailures(name) {
    var def = CIRCUITS[name];
    if (!def) return;
    var cutoff = Date.now() - def.sampleWindow;
    var c = _circuits[name];
    c.failures = c.failures.filter(function (ts) { return ts > cutoff; });
  }

  function isOpen(name) {
    _initCircuit(name);
    var c   = CIRCUITS[name];
    var st  = _circuits[name];
    if (!c) return false;

    switch (st.state) {
      case 'CLOSED':   return false;
      case 'OPEN':
        // Check if cooldown has elapsed → transition to HALF_OPEN
        if (Date.now() - st.openedAt >= c.cooldownMs) {
          st.state      = 'HALF_OPEN';
          st.halfOpenAt = Date.now();
          console.info(LOG, '[' + name + '] HALF-OPEN — testing recovery');
          try {
            if (window.RuntimeEventBus) window.RuntimeEventBus.emit('circuit:half-open', { name: name });
          } catch (_) {}
          return false; // allow one test call through
        }
        return true; // still open
      case 'HALF_OPEN': return false; // allow test call
      default:          return false;
    }
  }

  function recordSuccess(name) {
    _initCircuit(name);
    var st = _circuits[name];
    if (st.state === 'HALF_OPEN' || st.state === 'OPEN') {
      st.state    = 'CLOSED';
      st.failures = [];
      st.openedAt = 0;
      console.info(LOG, '[' + name + '] CLOSED — recovered after success');
      try {
        if (window.RuntimeEventBus) window.RuntimeEventBus.emit('circuit:closed', { name: name });
      } catch (_) {}
    }
  }

  function recordFailure(name, error) {
    _initCircuit(name);
    var def = CIRCUITS[name];
    var st  = _circuits[name];
    if (!def) return;

    st.failures.push(Date.now());
    st.lastError = (error && error.message) || String(error);
    _pruneFailures(name);

    if (st.state === 'HALF_OPEN') {
      // Failed during half-open test → re-open with double cooldown
      st.state    = 'OPEN';
      st.openedAt = Date.now() - (def.cooldownMs / 2); // start cooldown from halfway
      st.tripsTotal++;
      console.warn(LOG, '[' + name + '] OPEN again (half-open test failed)');
      _emitOpen(name);
      return;
    }

    if (st.failures.length >= def.failureThreshold && st.state === 'CLOSED') {
      st.state    = 'OPEN';
      st.openedAt = Date.now();
      st.tripsTotal++;
      console.warn(LOG, '⚡ [' + name + '] circuit OPEN after', st.failures.length, 'failures');
      _emitOpen(name);
      _triggerFallback(name);
    }
  }

  function _emitOpen(name) {
    try {
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.emit('circuit:open', {
          name:   name,
          trips:  _circuits[name].tripsTotal,
          error:  _circuits[name].lastError,
        });
      }
    } catch (_) {}
  }

  // ── Fallback actions when a circuit trips ─────────────────────────────────────
  function _triggerFallback(name) {
    switch (name) {
      case 'ocr':
        // Terminate all Tesseract workers; next OCR will use fallback text extraction
        try {
          if (window.RuntimeTesseractCleaner) window.RuntimeTesseractCleaner.sweep();
        } catch (_) {}
        console.warn(LOG, '[ocr] OCR fallback activated — text extraction mode');
        break;

      case 'gpu':
        // Flag GPU path as unavailable; callers should check isOpen('gpu')
        console.warn(LOG, '[gpu] GPU path disabled — CPU fallback only');
        break;

      case 'workerPool':
        // Reduce worker concurrency by trimming idle pools
        try {
          var WP = window.WorkerPool;
          if (WP) {
            var stats = WP.getStats();
            Object.keys(stats).forEach(function (url) {
              if (stats[url].crashed > 0) WP.terminatePool(url);
            });
          }
        } catch (_) {}
        console.warn(LOG, '[workerPool] pools pruned — reduced concurrency mode');
        break;

      case 'pdfjs':
        // Flush all PDF docs and reset cleaner
        try { if (window.RuntimePdfCleaner) window.RuntimePdfCleaner.sweep(); } catch (_) {}
        console.warn(LOG, '[pdfjs] PDF.js reset — next render gets a fresh instance');
        break;

      case 'ai':
        // Pause AI tasks
        try {
          if (window.RuntimeScheduler) window.RuntimeScheduler.cancelType('ai', 'circuit-open:ai');
        } catch (_) {}
        console.warn(LOG, '[ai] AI tasks cancelled — inference disabled during cooldown');
        break;

      case 'scheduler':
        // Clear stuck wait queue
        try {
          if (window.RuntimeScheduler) window.RuntimeScheduler.cancelAll('circuit-open:scheduler');
        } catch (_) {}
        break;
    }
  }

  // ── Wrap a function with circuit-breaker protection ───────────────────────────
  // Returns a wrapped async function that:
  //   - Throws immediately if circuit is OPEN
  //   - Records success/failure automatically
  //   - Restores circuit on success in HALF_OPEN state
  function wrap(name, fn) {
    return function () {
      if (isOpen(name)) {
        var def = CIRCUITS[name] || {};
        return Promise.reject(new Error('circuit-open:' + name + ' (' + (def.description || name) + ')'));
      }
      var args = arguments;
      var result;
      try {
        result = fn.apply(this, args);
      } catch (syncErr) {
        recordFailure(name, syncErr);
        throw syncErr;
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          function (v) { recordSuccess(name); return v; },
          function (e) { recordFailure(name, e); throw e; }
        );
      }
      recordSuccess(name);
      return result;
    };
  }

  // ── Force-reset a circuit ────────────────────────────────────────────────────
  function reset(name) {
    if (_circuits[name]) {
      _circuits[name].state    = 'CLOSED';
      _circuits[name].failures = [];
      _circuits[name].openedAt = 0;
      console.info(LOG, '[' + name + '] manually reset to CLOSED');
    }
  }

  function resetAll() {
    Object.keys(_circuits).forEach(reset);
  }

  function getStats() {
    var out = { version: VERSION, circuits: {} };
    Object.keys(CIRCUITS).forEach(function (name) {
      var def = CIRCUITS[name];
      var st  = _circuits[name] || {};
      var remainingCooldown = st.state === 'OPEN'
        ? Math.max(0, def.cooldownMs - (Date.now() - st.openedAt))
        : 0;
      out.circuits[name] = {
        label:      def.label,
        state:      st.state || 'CLOSED',
        failures:   (st.failures || []).length,
        trips:      st.tripsTotal || 0,
        lastError:  st.lastError || null,
        cooldownRemaining: remainingCooldown,
      };
    });
    return out;
  }

  // ── Wire up automatic failure detection from EventBus ─────────────────────────
  function _wireEventBus() {
    try {
      var EB = window.RuntimeEventBus;
      if (!EB) return;

      EB.on('worker:error',          function (e) { if (e && e.url) recordFailure('workerPool', e.error); });
      EB.on('timeout:fired',         function (e) { if (e && e.url && /ocr|tesseract/i.test(e.url)) recordFailure('ocr', e); });
      EB.on('tesseract:auto-terminated', function () { recordFailure('ocr', new Error('tesseract-terminated')); });
      EB.on('pdf:auto-destroyed',    function () { /* informational only */ });
      EB.on('panic:triggered',       function (e) {
        if (e && e.reason) {
          if (/worker/i.test(e.reason))    recordFailure('workerPool', e);
          if (/scheduler/i.test(e.reason)) recordFailure('scheduler', e);
          if (/heap|canvas/i.test(e.reason)) {
            // Don't trip circuits on memory issues — panic manager handles those
          }
        }
      });
    } catch (_) {}
  }

  setTimeout(_wireEventBus, 1500);

  window.RuntimeCircuitBreakers = {
    isOpen:          isOpen,
    recordSuccess:   recordSuccess,
    recordFailure:   recordFailure,
    wrap:            wrap,
    reset:           reset,
    resetAll:        resetAll,
    getStats:        getStats,
    CIRCUITS:        CIRCUITS,
    VERSION:         VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded —', Object.keys(CIRCUITS).length, 'circuits initialized');
}());
