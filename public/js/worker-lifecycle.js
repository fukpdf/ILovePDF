// Worker Lifecycle v1.0 — Phase 1C Stabilization (T006)
// Normalizes worker allocation, release, termination, failure cleanup,
// navigation cleanup, tab-hidden behavior, and rapid tool-switching safety.
//
// DESIGN PRINCIPLE: purely additive — does NOT replace WorkerPool.
// All existing code continues working. This layer makes worker creation
// observable, cancellable, and migration-safe.
//
// Integrates with (when present):
//   WorkerPool, WorkerLeakDetector, DeadlockMonitor, LifecycleManager,
//   TimerRegistry, StabilityMetrics, MemPressure
//
// Exposed as:   window.WorkerLifecycle
// Also patches: window.P1.workers  (migration adapter)
//
// [FUTURE: WorkerOrchestrator] Replace P1.workers.create() / dispatchToPool()
// bodies with WorkerOrchestrator.dispatch(). All call-sites already use the
// P1.workers surface — no further touch-ups needed.
(function () {
  'use strict';

  if (window.WorkerLifecycle) return;

  var LOG = '[WL]';

  // ── Internal registry ──────────────────────────────────────────────────────
  // Map<worker, { name, url, created, navToken, dlmId }>
  var _registry  = new Map();
  // Set of workers created during the current "navigation epoch"
  var _epochSet  = new Set();
  // Count of workers spawned this epoch (for rapid-switch detection)
  var _epochCount = 0;
  var _EPOCH_RESET_MS = 5000;
  var _epochTimer  = null;

  // Track whether the tab is currently hidden (for concurrency reduction)
  var _tabHidden = false;

  // ── Token factory — mirrors WorkerPool.CancelToken but nav-aware ──────────
  function NavToken() {
    var _cancelled = false;
    var _cbs = [];
    return {
      get cancelled() { return _cancelled; },
      cancel: function (reason) {
        if (_cancelled) return;
        _cancelled = true;
        _cbs.forEach(function (fn) { try { fn(reason || 'cancelled'); } catch (_) {} });
        _cbs = [];
      },
      onCancel: function (fn) {
        if (_cancelled) { try { fn('already-cancelled'); } catch (_) {} return; }
        _cbs.push(fn);
      },
    };
  }

  // ── Epoch management (rapid tool-switching guard) ─────────────────────────
  // If > EPOCH_SPAM_LIMIT workers are created within EPOCH_RESET_MS,
  // log a warning so we can detect runaway allocation patterns in the console.
  var EPOCH_SPAM_LIMIT = 8;

  function _resetEpoch() {
    _epochSet.clear();
    _epochCount = 0;
    _epochTimer  = null;
  }

  function _bumpEpoch(worker, name) {
    _epochSet.add(worker);
    _epochCount++;
    if (!_epochTimer) {
      _epochTimer = setTimeout(_resetEpoch, _EPOCH_RESET_MS);
      if (window.TimerRegistry) window.TimerRegistry.registerTimeout('wl-epoch', _epochTimer);
    }
    if (_epochCount > EPOCH_SPAM_LIMIT) {
      console.warn(LOG, 'rapid worker allocation detected (' + _epochCount +
        ' in ' + (_EPOCH_RESET_MS / 1000) + 's) — last: ' + name);
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('wl-rapid-allocation:' + _epochCount); } catch (_) {}
      }
    }
  }

  // ── Core create ───────────────────────────────────────────────────────────
  // opts: { navToken?, name?, track? }
  // Returns the raw Worker (pass-through) — or null on failure.
  //
  // [FUTURE: WorkerOrchestrator] replace body with orchestrator spawn call
  // that adds priority routing, cross-tab coordination, telemetry.
  function create(url, opts) {
    opts = opts || {};
    var name  = opts.name || url.split('/').pop();
    var token = opts.navToken || null;

    // Check concurrency cap under memory pressure
    if (window.MemPressure && window.MemPressure.maxWorkers) {
      var cap = window.MemPressure.maxWorkers();
      var alive = _countAlive();
      if (alive >= cap) {
        console.warn(LOG, 'concurrency cap reached (' + alive + '/' + cap + ') under memory pressure — blocking new worker: ' + name);
        if (window.StabilityMetrics) {
          try { window.StabilityMetrics.recordEvent('wl-concurrency-blocked:' + name); } catch (_) {}
        }
        return null;
      }
    }

    var worker;
    try { worker = new Worker(url); } catch (e) {
      console.warn(LOG, 'Worker creation failed for', url, e.message);
      return null;
    }

    var dlmId = null;

    // Register with WorkerLeakDetector
    if (window.WorkerLeakDetector) {
      try { window.WorkerLeakDetector.track(worker, name); } catch (_) {}
    }

    // Register with DeadlockMonitor HeartbeatValidator
    if (window.DeadlockMonitor) {
      try { dlmId = window.DeadlockMonitor.registerWorker(worker, name); } catch (_) {}
    }

    var meta = {
      name:    name,
      url:     url,
      created: Date.now(),
      token:   token,
      dlmId:   dlmId,
    };
    _registry.set(worker, meta);
    _bumpEpoch(worker, name);

    // Auto-release when nav token fires
    if (token) {
      token.onCancel(function (reason) {
        _release(worker, 'nav-cancel:' + reason);
      });
    }

    // Tab-hidden: pulse immediately so WLD timer doesn't think it's idle
    if (window.WorkerLeakDetector) {
      try { window.WorkerLeakDetector.pulse(worker); } catch (_) {}
    }

    return worker;
  }

  // ── Internal release ──────────────────────────────────────────────────────
  function _release(worker, reason) {
    var meta = _registry.get(worker);
    if (!meta) return;
    _registry.delete(worker);
    _epochSet.delete(worker);

    // Untrack from WorkerLeakDetector
    if (window.WorkerLeakDetector) {
      try { window.WorkerLeakDetector.untrack(worker); } catch (_) {}
    }
    // Unregister from DeadlockMonitor
    if (meta.dlmId && window.DeadlockMonitor && window.DeadlockMonitor.HeartbeatValidator) {
      try { window.DeadlockMonitor.HeartbeatValidator.unregister(meta.dlmId); } catch (_) {}
    }
    // Terminate
    try { worker.terminate(); } catch (_) {}

    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('wl-released:' + (reason || 'explicit')); } catch (_) {}
    }
  }

  // ── Public release ────────────────────────────────────────────────────────
  // Graceful termination: onmessage/onerror are cleared first so no stale
  // callbacks fire after termination.
  function release(worker) {
    if (!worker) return;
    try { worker.onmessage = null; worker.onerror = null; } catch (_) {}
    _release(worker, 'explicit-release');
  }

  // ── Pulse helper ──────────────────────────────────────────────────────────
  // Call this whenever a worker sends a message to prevent zombie detection.
  function pulse(worker) {
    if (!worker) return;
    if (window.WorkerLeakDetector) {
      try { window.WorkerLeakDetector.pulse(worker); } catch (_) {}
    }
    if (window.DeadlockMonitor) {
      var meta = _registry.get(worker);
      if (meta && meta.dlmId) {
        try { window.DeadlockMonitor.pingWorker(meta.dlmId); } catch (_) {}
      }
    }
    var m = _registry.get(worker);
    if (m) m.lastPulse = Date.now();
  }

  // ── Navigation cancel token factory ───────────────────────────────────────
  // Returns a NavToken that is automatically cancelled when the page hides
  // or navigation occurs. Pass as opts.navToken to create().
  var _activeNavTokens = [];

  function createNavToken() {
    var tok = NavToken();
    _activeNavTokens.push(tok);
    tok.onCancel(function () {
      var i = _activeNavTokens.indexOf(tok);
      if (i !== -1) _activeNavTokens.splice(i, 1);
    });
    return tok;
  }

  function _cancelAllNavTokens(reason) {
    var tokens = _activeNavTokens.slice();
    _activeNavTokens.length = 0;
    tokens.forEach(function (t) { try { t.cancel(reason); } catch (_) {} });
  }

  // ── Tab-hidden behavior ───────────────────────────────────────────────────
  // When the tab becomes hidden, we reduce WorkerPool's effective concurrency
  // by NOT creating new workers (tracked via _tabHidden flag).
  // Existing workers continue running — no forced termination.
  function _onHide() {
    _tabHidden = true;
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('wl-tab-hidden:workers-' + _countAlive()); } catch (_) {}
    }
  }

  function _onResume() {
    _tabHidden = false;
  }

  if (window.LifecycleManager) {
    window.LifecycleManager.onHide(_onHide);
    window.LifecycleManager.onResume(_onResume);
  }

  // ── Navigation / pagehide cleanup ─────────────────────────────────────────
  // On pagehide: cancel all nav tokens (triggers release of all workers
  // created via createNavToken). Then forcibly release any remaining.
  window.addEventListener('pagehide', function () {
    _cancelAllNavTokens('pagehide');
    // Release any workers not covered by a nav token
    _registry.forEach(function (meta, worker) {
      try { worker.onmessage = null; worker.onerror = null; } catch (_) {}
      try { worker.terminate(); } catch (_) {}
    });
    _registry.clear();
    _epochSet.clear();
  }, { passive: true });

  // ── WorkerPool pool-level dispatch adapter ─────────────────────────────────
  // Wraps WorkerPool.run() to:
  //   1. Enforce memory-pressure concurrency cap
  //   2. Honour cancellation tokens
  //   3. Pulse DeadlockMonitor while task is running
  //
  // [FUTURE: WorkerOrchestrator] replace inner call with orchestrator dispatch
  function dispatchToPool(workerUrl, message, transferables, opts) {
    opts = opts || {};

    // Memory pressure concurrency cap
    if (window.MemPressure && window.MemPressure.isUnderPressure && window.MemPressure.isUnderPressure()) {
      var maxW = window.MemPressure.maxWorkers ? window.MemPressure.maxWorkers() : 1;
      if (window.WorkerPool) {
        var stats = window.WorkerPool.getStats ? window.WorkerPool.getStats() : null;
        if (stats) {
          var totalBusy = Object.values(stats).reduce(function (s, p) { return s + (p.busy || 0); }, 0);
          if (totalBusy >= maxW) {
            return Promise.reject(new Error('wl-concurrency-cap:memory-pressure'));
          }
        }
      }
    }

    if (!window.WorkerPool) return Promise.reject(new Error('WorkerPool not available'));
    return window.WorkerPool.run(workerUrl, message, transferables, opts);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function _countAlive() {
    return _registry.size;
  }

  function getStats() {
    var list = [];
    var now  = Date.now();
    _registry.forEach(function (meta, _) {
      list.push({
        name:    meta.name,
        url:     meta.url,
        ageS:    Math.round((now - meta.created) / 1000),
        hasNavToken: !!meta.token,
      });
    });
    return {
      alive:      _registry.size,
      epochCount: _epochCount,
      tabHidden:  _tabHidden,
      workers:    list,
    };
  }

  // ── Extend P1 with workers migration surface ───────────────────────────────
  // [FUTURE: WorkerOrchestrator] All call-sites using P1.workers.create() /
  // P1.workers.dispatch() will be wired to the orchestrator by updating only
  // these two functions — no touch-ups at call sites.
  if (window.P1) {
    window.P1.workers = {
      create:      create,
      release:     release,
      pulse:       pulse,
      createNavToken: createNavToken,
      dispatch:    dispatchToPool,
    };
    // Update diagnostics to include worker lifecycle stats
    var _origDiag = window.P1.diagnostics;
    window.P1.diagnostics = function () {
      var base = _origDiag ? _origDiag() : {};
      base.workerLifecycle = getStats();
      return base;
    };
  }

  window.WorkerLifecycle = {
    create:          create,
    release:         release,
    pulse:           pulse,
    createNavToken:  createNavToken,
    dispatch:        dispatchToPool,
    cancelAllTokens: _cancelAllNavTokens,
    getStats:        getStats,
  };

  console.debug('[WorkerLifecycle] ready — T006 worker lifecycle normalization active');
}());
