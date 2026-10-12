// Navigation Cancel v1.0 — Phase 1C Stabilization (T009)
// Provides AbortController factories that automatically fire on SPA navigation,
// pagehide, popstate, and rapid tool-switching. Stops in-flight queue polling,
// releases workers, and clears pending timers — all on navigation events.
//
// DESIGN PRINCIPLE: additive safety layer. Queue polling in queue-client.js
// and fetch calls in tool-page.js are NOT modified — they continue to work.
// New code uses NavCancel.createController() / NavCancel.registerPolling()
// to gain automatic clean-up without touching existing callsites.
//
// Integrates with: TimerRegistry, LifecycleManager, WorkerLifecycle,
//                  StabilityMetrics, DeadlockMonitor
//
// Exposed as: window.NavCancel
//
// [FUTURE: NavigationOrchestrator] When NavigationOrchestrator is added,
// replace the popstate/pagehide listeners with NavigationOrchestrator hooks.
// NavCancel.cancelAll() becomes the single tear-down point called by the
// orchestrator — no further callsite changes required.
(function () {
  'use strict';

  if (window.NavCancel) return;

  var LOG = '[NC]';

  // ── Registry of active AbortControllers ───────────────────────────────────
  // Map<controller, { label, created }>
  var _controllers = new Map();

  // ── Registry of in-flight polling stop functions ──────────────────────────
  // queue-client.js pollUntilDone runs a while-loop — give callers a way to
  // register a stop function that NavCancel will call on navigation.
  // Map<id, stopFn>
  var _pollingStops = new Map();
  var _pollingIdCounter = 0;

  // ── Registry of workers to terminate on navigation ────────────────────────
  var _navWorkers = new Set();

  // ── Registry of cleanup callbacks ─────────────────────────────────────────
  var _cleanupCbs = new Set();

  // ── Navigation epoch ──────────────────────────────────────────────────────
  // Incremented on every navigation event so stale callbacks can self-detect.
  var _epoch = 0;

  function getEpoch() { return _epoch; }

  // ── AbortController factory ───────────────────────────────────────────────
  // Returns an AbortController whose signal is auto-aborted on navigation.
  // opts:
  //   label?      — human-readable label for debugging (default 'unnamed')
  //   timeoutMs?  — optional per-controller timeout (fires abort automatically)
  //
  // [FUTURE: NavigationOrchestrator] Replace AbortController with orchestrator's
  // CancellableTask handle — all callers already use the signal surface.
  function createController(opts) {
    opts = opts || {};
    var label = opts.label || 'unnamed';

    var ctrl;
    try { ctrl = new AbortController(); } catch (_) {
      // Fallback for very old browsers (should not happen in modern targets)
      ctrl = { signal: { aborted: false }, abort: function () { this.signal.aborted = true; } };
    }

    var meta = { label: label, created: Date.now(), epoch: _epoch };
    _controllers.set(ctrl, meta);

    // Per-controller optional timeout
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      var timerId = setTimeout(function () {
        if (_controllers.has(ctrl)) {
          ctrl.abort();
          _controllers.delete(ctrl);
          console.debug(LOG, 'controller timeout fired for:', label);
        }
      }, opts.timeoutMs);
      if (window.TimerRegistry) {
        window.TimerRegistry.registerTimeout('nc-ctrl-timeout-' + label, timerId);
      }
      meta.timerId = timerId;
    }

    return ctrl;
  }

  // ── Cancel a specific controller ──────────────────────────────────────────
  function cancel(ctrl, reason) {
    if (!ctrl) return;
    var meta = _controllers.get(ctrl);
    if (meta) {
      if (meta.timerId) clearTimeout(meta.timerId);
      _controllers.delete(ctrl);
    }
    try { ctrl.abort(reason || 'cancelled'); } catch (_) {}
  }

  // ── Register a queue polling stop function ────────────────────────────────
  // Returns an id that can be passed to unregisterPolling() when polling ends.
  //
  // Queue-client.js can call:
  //   var pollId = NavCancel.registerPolling(function() { polling = false; });
  //   // ... later when done:
  //   NavCancel.unregisterPolling(pollId);
  function registerPolling(stopFn, label) {
    if (typeof stopFn !== 'function') return -1;
    var id = ++_pollingIdCounter;
    _pollingStops.set(id, { fn: stopFn, label: label || 'poll-' + id });
    return id;
  }

  function unregisterPolling(id) {
    _pollingStops.delete(id);
  }

  // ── Register a Worker to terminate on navigation ───────────────────────────
  function registerWorker(worker) {
    if (worker) _navWorkers.add(worker);
    return function () { _navWorkers.delete(worker); };
  }

  // ── Register an arbitrary cleanup callback ────────────────────────────────
  function registerCleanup(fn, label) {
    if (typeof fn !== 'function') return function () {};
    var entry = { fn: fn, label: label || 'cb' };
    _cleanupCbs.add(entry);
    return function () { _cleanupCbs.delete(entry); };
  }

  // ── Core cancelAll ────────────────────────────────────────────────────────
  // Called by all navigation event handlers. Cancels everything in flight.
  function cancelAll(reason) {
    _epoch++;
    reason = reason || 'navigation';

    var aborted = 0;

    // Abort all AbortControllers
    _controllers.forEach(function (meta, ctrl) {
      if (meta.timerId) clearTimeout(meta.timerId);
      try { ctrl.abort(reason); } catch (_) {}
      aborted++;
    });
    _controllers.clear();

    // Stop all polling loops
    var pollingCount = 0;
    _pollingStops.forEach(function (entry) {
      try { entry.fn(reason); } catch (_) {}
      pollingCount++;
    });
    _pollingStops.clear();

    // Terminate registered nav workers
    var workerCount = 0;
    _navWorkers.forEach(function (w) {
      try { w.onmessage = null; w.onerror = null; } catch (_) {}
      try { w.terminate(); } catch (_) {}
      workerCount++;
    });
    _navWorkers.clear();

    // Run cleanup callbacks
    var cbCount = 0;
    _cleanupCbs.forEach(function (entry) {
      try { entry.fn(reason); } catch (_) {}
      cbCount++;
    });
    _cleanupCbs.clear();

    if (aborted + pollingCount + workerCount + cbCount > 0) {
      console.debug(LOG, 'cancelAll(' + reason + ') —',
        aborted + ' controllers,', pollingCount + ' polls,',
        workerCount + ' workers,', cbCount + ' callbacks');
      if (window.StabilityMetrics) {
        try {
          window.StabilityMetrics.recordEvent('nc-cancel-all:' + reason +
            ':' + (aborted + pollingCount + workerCount));
        } catch (_) {}
      }
    }
  }

  // ── Navigation event listeners ────────────────────────────────────────────

  // pagehide: full cleanup before page leaves bfcache / is unloaded
  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
  }, { passive: true });

  // popstate: SPA back/forward navigation
  window.addEventListener('popstate', function () {
    cancelAll('popstate');
  }, { passive: true });

  // visibilitychange: if the tab is hidden AND the page is navigating away,
  // we want to stop background processing. We do NOT cancel on simple
  // minimize (user may switch back). Cancel only if hidden for > 5 min.
  var _hiddenAt = 0;
  var _hiddenTimer = null;
  var _IS_MOBILE_NC = /Mobile|Tablet|Android|iPhone|iPad/i.test(navigator.userAgent || '');
  var HIDDEN_CANCEL_MS = _IS_MOBILE_NC ? 60 * 1000 : 5 * 60 * 1000; // 60s mobile, 5min desktop

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      _hiddenAt = Date.now();
      _hiddenTimer = setTimeout(function () {
        // If still hidden after 5 min, cancel long-running operations
        if (document.visibilityState === 'hidden') {
          cancelAll('long-hidden');
          if (window.StabilityMetrics) {
            try { window.StabilityMetrics.recordEvent('nc-long-hidden-cancel'); } catch (_) {}
          }
        }
        _hiddenTimer = null;
      }, HIDDEN_CANCEL_MS);
      if (window.TimerRegistry) {
        window.TimerRegistry.registerTimeout('nc-hidden-timeout', _hiddenTimer);
      }
    } else {
      // Tab is visible again — cancel the long-hidden timer
      if (_hiddenTimer) {
        clearTimeout(_hiddenTimer);
        _hiddenTimer = null;
      }
    }
  }, { passive: true });

  // LifecycleManager integration (existing pagehide/resume hooks)
  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(function () {
      // Mark hidden but don't cancel immediately — wait for long-hidden timeout
    });
  }

  // ── loadToolPage hook (SPA navigation in tool-page.js) ───────────────────
  // Monkey-patch loadToolPage so SPA navigations trigger cancelAll().
  // This is the key integration point for rapid tool-switching safety.
  var _origLoadToolPage = null;
  function _hookLoadToolPage() {
    if (typeof window.loadToolPage !== 'function') return;
    if (window.loadToolPage.__nc_hooked) return;
    _origLoadToolPage = window.loadToolPage;
    window.loadToolPage = function (path) {
      cancelAll('spa-nav:' + path);
      return _origLoadToolPage.call(this, path);
    };
    window.loadToolPage.__nc_hooked = true;
    console.debug(LOG, 'loadToolPage hooked for SPA cancellation');
  }

  // Try immediately; if tool-page.js is deferred, retry after DOMContentLoaded
  _hookLoadToolPage();
  document.addEventListener('DOMContentLoaded', _hookLoadToolPage, { once: true });
  // Also retry 500ms after DOMContentLoaded in case deferred scripts run late
  setTimeout(_hookLoadToolPage, 500);

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      epoch:          _epoch,
      activeControllers: _controllers.size,
      activePolling:  _pollingStops.size,
      navWorkers:     _navWorkers.size,
      cleanupCbs:     _cleanupCbs.size,
    };
  }

  window.NavCancel = {
    createController:    createController,
    cancel:              cancel,
    cancelAll:           cancelAll,
    registerPolling:     registerPolling,
    unregisterPolling:   unregisterPolling,
    registerWorker:      registerWorker,
    registerCleanup:     registerCleanup,
    getEpoch:            getEpoch,
    getStats:            getStats,
  };

  console.debug('[NavCancel] ready — T009 navigation cancellation safety active');
}());
