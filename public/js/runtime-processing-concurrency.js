// RuntimeProcessingConcurrency v1.0 — Performance Layer
// =====================================================================
// Browser-side processing semaphore.
//
// Problem: Multiple tools can be triggered simultaneously (multi-tab
// drag-and-drop, rapid user retries) overwhelming the WorkerPool and
// causing memory spikes.  The existing RuntimeQueue wraps server-side
// QueueClient calls; this module limits *browser-side* processing jobs.
//
// Design:
//   • Slot count adapts to RuntimeAdaptivePipeline device tier
//     (low: 1, mid: 2, high: 3)
//   • acquire(opts?) → Promise<release_fn>   — blocks until a slot is free
//   • tryAcquire()   → release_fn | null     — non-blocking attempt
//   • Each acquire has an optional timeout; exceeded → rejects with 'timeout'
//   • Priority queue: 'high' > 'normal' > 'low'
//   • Integrates with RuntimeTelemetry + RuntimeEventBus
//
// Exposed as: window.RuntimeProcessingConcurrency
//   .acquire(opts?)  → Promise<Function>   opts: { priority, timeoutMs, label }
//   .tryAcquire()    → Function | null
//   .getStats()      → { slots, active, queued, totalAcquired, totalReleased }
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessingConcurrency) return;

  var LOG = '[RPC]';

  var PRIORITY_WEIGHT = { high: 3, normal: 2, low: 1 };
  var DEFAULT_TIMEOUT = 30000; // 30 s
  var RECHECK_INTERVAL = 80;   // ms between queue drain checks

  // ── Slot configuration ────────────────────────────────────────────────────
  function _maxSlots() {
    try {
      if (G.RuntimeAdaptivePipeline) {
        var prof = G.RuntimeAdaptivePipeline.getProfile();
        switch (prof.deviceTier) {
          case 'low':  return 1;
          case 'high': return 3;
          default:     return 2;
        }
      }
      // Heuristic fallback
      var mem   = navigator.deviceMemory  || 4;
      var cores = navigator.hardwareConcurrency || 4;
      if (mem <= 2 || cores <= 2) return 1;
      if (mem >= 8 && cores >= 8) return 3;
      return 2;
    } catch (_) { return 2; }
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var _active  = 0;     // currently running
  var _waiting = [];    // [{resolve, reject, priority, label, ts, timeoutId}]
  var _stats   = { totalAcquired: 0, totalReleased: 0, totalTimeout: 0 };
  var _drainingId = null;

  // ── Release function factory ──────────────────────────────────────────────
  function _makeRelease(label) {
    var released = false;
    return function release() {
      if (released) return;
      released = true;
      _active = Math.max(0, _active - 1);
      _stats.totalReleased++;

      if (G.RuntimeTelemetry) {
        try { G.RuntimeTelemetry.record('concurrency:released', { label: label, active: _active }); } catch (_) {}
      }
      _drain();
    };
  }

  // ── Drain waiting queue ───────────────────────────────────────────────────
  function _drain() {
    if (_drainingId) return;
    _drainingId = setTimeout(function () {
      _drainingId = null;
      var slots = _maxSlots();

      // Sort waiting by priority (highest first), then by arrival time
      _waiting.sort(function (a, b) {
        var pd = (PRIORITY_WEIGHT[b.priority] || 2) - (PRIORITY_WEIGHT[a.priority] || 2);
        return pd !== 0 ? pd : (a.ts - b.ts);
      });

      while (_active < slots && _waiting.length > 0) {
        var next = _waiting.shift();
        if (next.timeoutId) { clearTimeout(next.timeoutId); next.timeoutId = null; }
        _active++;
        _stats.totalAcquired++;

        if (G.RuntimeTelemetry) {
          try { G.RuntimeTelemetry.record('concurrency:acquired', { label: next.label, active: _active, queued: _waiting.length }); } catch (_) {}
        }
        if (G.RuntimeEventBus) {
          try { G.RuntimeEventBus.emit('concurrency:acquired', { label: next.label, active: _active }); } catch (_) {}
        }

        next.resolve(_makeRelease(next.label));
      }
    }, 0);
  }

  // ── acquire(opts?) → Promise<release_fn> ─────────────────────────────────
  function acquire(opts) {
    opts = opts || {};
    var priority  = opts.priority  || 'normal';
    var timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : DEFAULT_TIMEOUT;
    var label     = opts.label     || 'task';
    var slots     = _maxSlots();

    // Fast path: slot available right now
    if (_active < slots) {
      _active++;
      _stats.totalAcquired++;
      if (G.RuntimeTelemetry) {
        try { G.RuntimeTelemetry.record('concurrency:acquired', { label: label, active: _active, queued: 0 }); } catch (_) {}
      }
      return Promise.resolve(_makeRelease(label));
    }

    // Queue it
    return new Promise(function (resolve, reject) {
      var entry = { resolve: resolve, reject: reject, priority: priority, label: label, ts: Date.now(), timeoutId: null };

      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(function () {
          var idx = _waiting.indexOf(entry);
          if (idx !== -1) _waiting.splice(idx, 1);
          _stats.totalTimeout++;
          if (G.RuntimeTelemetry) {
            try { G.RuntimeTelemetry.record('concurrency:timeout', { label: label }); } catch (_) {}
          }
          reject(new Error('concurrency:timeout:' + label));
        }, timeoutMs);
      }

      _waiting.push(entry);

      if (G.RuntimeTelemetry) {
        try { G.RuntimeTelemetry.record('concurrency:queued', { label: label, queued: _waiting.length }); } catch (_) {}
      }

      // Re-try drain (slot may have freed between check and push)
      _drain();
    });
  }

  // ── tryAcquire() → release_fn | null ─────────────────────────────────────
  function tryAcquire(label) {
    var slots = _maxSlots();
    if (_active < slots) {
      _active++;
      _stats.totalAcquired++;
      return _makeRelease(label || 'try');
    }
    return null;
  }

  // ── getStats() ────────────────────────────────────────────────────────────
  function getStats() {
    return {
      slots:         _maxSlots(),
      active:        _active,
      queued:        _waiting.length,
      totalAcquired: _stats.totalAcquired,
      totalReleased: _stats.totalReleased,
      totalTimeout:  _stats.totalTimeout,
    };
  }

  // ── Cancel all queued on pagehide ─────────────────────────────────────────
  G.addEventListener('pagehide', function () {
    _waiting.forEach(function (e) {
      if (e.timeoutId) clearTimeout(e.timeoutId);
      e.reject(new Error('concurrency:pagehide'));
    });
    _waiting.length = 0;
  }, { passive: true });

  // ── React to adaptive pipeline profile changes ────────────────────────────
  if (G.RuntimeAdaptivePipeline && G.RuntimeAdaptivePipeline.onProfileChange) {
    G.RuntimeAdaptivePipeline.onProfileChange(function () {
      // Drain may free up or reduce slots
      _drain();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeProcessingConcurrency = {
    acquire:    acquire,
    tryAcquire: tryAcquire,
    getStats:   getStats,
  };

  console.debug(LOG, 'RuntimeProcessingConcurrency v1.0 ready — slots:', _maxSlots());

}(window));
