// runtime-soft-reset.js — Emergency Soft Reset (Phase 2D)
// ADDITIVE ONLY. Provides window.RuntimeSoftReset() which recovers the runtime
// WITHOUT a page reload by resetting: WorkerPool, RuntimeWorkers, Scheduler
// counters, PDF refs, OCR refs, timers, canvases.
//
// PRESERVED across reset:
//   - UI state (DOM, modals, input values)
//   - Selected files (FileList references are preserved)
//   - Tool route (window.location unchanged)
//   - User session (cookies, JWT tokens)
//
// window.RuntimeSoftReset — public API
(function () {
  'use strict';

  if (window.RuntimeSoftReset) return;

  var LOG     = '[RSR]';
  var VERSION = '1.0.0';

  var _resetCount  = 0;
  var _lastReset   = 0;
  var _resetHistory = [];
  var MAX_HISTORY  = 10;

  // Minimum time between consecutive soft resets (prevent reset loop)
  var RESET_COOLDOWN_MS = 10000; // 10 s

  // ── Pre-reset snapshot (preserve user state) ──────────────────────────────────
  function _snapshotUiState() {
    var snapshot = {
      scrollY:   window.scrollY,
      tool:      window.location.pathname,
    };
    // Preserve active input values
    try {
      var inputs = document.querySelectorAll('input[type="text"], input[type="number"], textarea');
      snapshot.inputs = Array.from(inputs).map(function (el) {
        return { id: el.id || el.name, value: el.value };
      });
    } catch (_) {}
    return snapshot;
  }

  function _restoreUiState(snapshot) {
    if (!snapshot) return;
    try {
      if (snapshot.inputs) {
        snapshot.inputs.forEach(function (item) {
          if (!item.id) return;
          var el = document.getElementById(item.id) || document.querySelector('[name="' + item.id + '"]');
          if (el && el.value === '') el.value = item.value;
        });
      }
      if (snapshot.scrollY) window.scrollTo(0, snapshot.scrollY);
    } catch (_) {}
  }

  // ── Reset phases ──────────────────────────────────────────────────────────────

  function _resetWorkers() {
    var cleaned = 0;
    try {
      var WP = window.WorkerPool;
      if (WP && WP.getStats) {
        var stats = WP.getStats();
        Object.keys(stats).forEach(function (url) {
          var s = stats[url];
          // Only terminate pools that are in a bad state (crashed or stuck-busy)
          if (s.crashed > 0 || (s.busy === s.total && s.total > 0 && s.queued > 0)) {
            try { WP.terminatePool(url); cleaned++; } catch (_) {}
          }
        });
      }
    } catch (_) {}
    console.debug(LOG, 'workers reset:', cleaned, 'pools terminated');
    return cleaned;
  }

  function _resetSchedulers() {
    var cancelled = 0;
    // Cancel all waiting tasks (not running ones — those complete naturally)
    try {
      if (window.RuntimeScheduler && window.RuntimeScheduler.cancelAll) {
        cancelled += window.RuntimeScheduler.cancelAll('soft-reset');
      }
    } catch (_) {}
    // Cancel TaskScheduler queued waiters (doesn't affect active)
    try {
      if (window.TaskScheduler) {
        ['RENDER', 'AI', 'BACKGROUND'].forEach(function (tier) {
          cancelled += window.TaskScheduler.cancelQueued(tier) || 0;
        });
      }
    } catch (_) {}
    console.debug(LOG, 'schedulers reset:', cancelled, 'queued tasks cancelled');
    return cancelled;
  }

  function _resetPdfRefs() {
    var count = 0;
    try {
      if (window.RuntimePdfCleaner) {
        count = window.RuntimePdfCleaner.sweep() || 0;
      }
    } catch (_) {}
    console.debug(LOG, 'PDF refs reset:', count, 'docs cleaned');
    return count;
  }

  function _resetOcrRefs() {
    var count = 0;
    try {
      if (window.RuntimeTesseractCleaner) {
        count = window.RuntimeTesseractCleaner.sweep() || 0;
      }
    } catch (_) {}
    console.debug(LOG, 'OCR refs reset:', count, 'workers cleaned');
    return count;
  }

  function _resetCanvases() {
    var count = 0;
    try {
      if (window.CanvasPool) { window.CanvasPool.flushPool(); }
    } catch (_) {}
    try {
      if (window.RuntimeCanvasGC) { count = window.RuntimeCanvasGC.sweep() || 0; }
    } catch (_) {}
    console.debug(LOG, 'canvases reset:', count, 'GC\'d');
    return count;
  }

  function _resetTimers(ownerPrefix) {
    // Only clear timers owned by known tool subsystems, not all timers
    // (we don't want to clear the healer's own timers)
    var toolOwners = ['tool', 'pdf', 'ocr', 'merge', 'split', 'compress', 'convert', 'watermark', 'sign'];
    if (window.TimerRegistry) {
      toolOwners.forEach(function (owner) {
        try { window.TimerRegistry.clearOwner(owner); } catch (_) {}
      });
    }
  }

  function _resetZombies() {
    try {
      if (window.RuntimeZombieCleaner) window.RuntimeZombieCleaner.sweep();
    } catch (_) {}
  }

  function _resetCancellationTokens() {
    try {
      // Cancel background-scoped tokens only (not all, which would cancel active ops)
      if (window.RuntimeCancellation && window.RuntimeCancellation.cancelScope) {
        window.RuntimeCancellation.cancelScope('background', 'soft-reset');
      }
    } catch (_) {}
  }

  function _resetCircuitBreakers() {
    // Do NOT force-reset circuit breakers — they should stay open if they tripped
    // for a good reason. The reset is for runtime state, not error history.
    // The circuit will naturally recover via HALF_OPEN after cooldown.
  }

  // ── Main reset entry point ────────────────────────────────────────────────────
  function reset(opts) {
    opts = opts || {};
    var reason = opts.reason || 'manual';

    // Cooldown guard
    if (Date.now() - _lastReset < RESET_COOLDOWN_MS) {
      console.warn(LOG, 'soft-reset throttled — too soon since last reset');
      return { skipped: true, reason: 'cooldown' };
    }

    _resetCount++;
    _lastReset = Date.now();

    console.group(LOG + ' Soft Reset #' + _resetCount + ' — ' + reason);

    // 1. Snapshot UI state
    var snapshot;
    try { snapshot = _snapshotUiState(); } catch (_) {}

    // 2. Notify other systems
    try {
      if (window.RuntimeEventBus) window.RuntimeEventBus.emit('runtime:soft-reset', { count: _resetCount, reason: reason });
    } catch (_) {}

    // 3. Execute reset phases (all safe — each is try/catched)
    var result = {
      count:      _resetCount,
      reason:     reason,
      workers:    0,
      tasks:      0,
      pdf:        0,
      ocr:        0,
      canvases:   0,
    };

    result.workers  = _resetWorkers();
    result.tasks    = _resetSchedulers();
    result.pdf      = _resetPdfRefs();
    result.ocr      = _resetOcrRefs();
    result.canvases = _resetCanvases();

    _resetTimers();
    _resetZombies();
    _resetCancellationTokens();
    _resetCircuitBreakers();

    // 4. Restore UI state
    setTimeout(function () {
      try { _restoreUiState(snapshot); } catch (_) {}
    }, 100);

    // 5. Log result
    console.info(LOG, 'reset complete:', result);
    console.groupEnd();

    _resetHistory.push(Object.assign({}, result, { ts: _lastReset }));
    if (_resetHistory.length > MAX_HISTORY) _resetHistory.shift();

    // 6. Emit completion
    try {
      if (window.RuntimeEventBus) window.RuntimeEventBus.emit('runtime:soft-reset:complete', result);
    } catch (_) {}

    return result;
  }

  function getStats() {
    return {
      resetCount:  _resetCount,
      lastReset:   _lastReset,
      history:     _resetHistory.slice(),
      version:     VERSION,
    };
  }

  // Expose as window.RuntimeSoftReset (callable function + API object)
  var api = {
    reset:    reset,
    getStats: getStats,
    VERSION:  VERSION,
  };

  // Make it callable directly: RuntimeSoftReset() or RuntimeSoftReset.reset()
  var callable = function (opts) { return reset(opts); };
  Object.keys(api).forEach(function (k) { callable[k] = api[k]; });

  window.RuntimeSoftReset = callable;

  console.debug(LOG, 'v' + VERSION + ' loaded — call RuntimeSoftReset() to recover runtime');
}());
