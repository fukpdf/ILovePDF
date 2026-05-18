// runtime-zombie-cleaner.js — Zombie Task Cleaner (Phase 2D)
// ADDITIVE ONLY. Detects and destroys orphaned promises, abandoned OCR jobs,
// dangling abort controllers, stale event listeners, and lingering worker refs.
//
// window.RuntimeZombieCleaner — public API
(function () {
  'use strict';

  if (window.RuntimeZombieCleaner) return;

  var LOG     = '[RZC]';
  var VERSION = '1.0.0';

  // ── Orphan registry ─────────────────────────────────────────────────────────
  // External code registers cleanup handles here; cleaner sweeps them on schedule.
  // Handle: { id, label, ts, cleanup: fn, isAlive?: fn → bool }
  var _registry = new Map();
  var _nextId   = 1;
  var _stats    = { registered: 0, cleaned: 0, errors: 0 };

  // Max age before a registered handle is force-cleaned (default 10 min)
  var MAX_AGE_MS = 10 * 60 * 1000;

  function register(opts) {
    opts = opts || {};
    var id    = _nextId++;
    var entry = {
      id:      id,
      label:   opts.label   || 'orphan-' + id,
      ts:      Date.now(),
      cleanup: opts.cleanup  || null,
      isAlive: opts.isAlive  || null,
      maxAge:  opts.maxAge   || MAX_AGE_MS,
    };
    _registry.set(id, entry);
    _stats.registered++;
    return {
      id:    id,
      done: function () { _registry.delete(id); },
    };
  }

  // ── AbortController pool ─────────────────────────────────────────────────────
  // Tools can register AbortControllers; cleaner aborts and purges stale ones.
  var _controllers = new Map(); // id → { controller, ts, label }
  var _ctrlNextId  = 1;

  function trackAbortController(controller, label) {
    var id = _ctrlNextId++;
    _controllers.set(id, { controller: controller, ts: Date.now(), label: label || 'ctrl-' + id });
    return {
      id:   id,
      done: function () { _controllers.delete(id); },
    };
  }

  // ── Event listener purge ─────────────────────────────────────────────────────
  // Track add/remove pairs so cleaner can sweep unmatched listeners.
  var _listeners = []; // { target, type, fn, ts, label }

  function trackListener(target, type, fn, label) {
    _listeners.push({ target: target, type: type, fn: fn, ts: Date.now(), label: label || type });
    return function remove() {
      var idx = _listeners.findIndex(function (e) { return e.fn === fn; });
      if (idx !== -1) _listeners.splice(idx, 1);
      try { target.removeEventListener(type, fn); } catch (_) {}
    };
  }

  // ── Worker ref tracker ───────────────────────────────────────────────────────
  var _workerRefs = new Map(); // id → { worker, ts, label, terminated }
  var _wRefNextId = 1;

  function trackWorker(worker, label) {
    var id = _wRefNextId++;
    _workerRefs.set(id, { worker: worker, ts: Date.now(), label: label || 'worker-' + id, terminated: false });
    return {
      id:   id,
      done: function () { _workerRefs.delete(id); },
    };
  }

  // ── Canvas ref tracker ───────────────────────────────────────────────────────
  var _canvasRefs = new Map();
  var _cRefNextId = 1;

  function trackCanvas(canvas, label) {
    var id = _cRefNextId++;
    _canvasRefs.set(id, { canvas: canvas, ts: Date.now(), label: label || 'canvas-' + id });
    return {
      id:   id,
      done: function () { _canvasRefs.delete(id); },
    };
  }

  // ── Sweep logic ──────────────────────────────────────────────────────────────

  function _sweepRegistry() {
    var now = Date.now();
    var cleaned = 0;
    _registry.forEach(function (entry, id) {
      var age = now - entry.ts;
      // If alive check returns false, or age exceeds maxAge → clean
      var isDead = false;
      if (typeof entry.isAlive === 'function') {
        try { isDead = !entry.isAlive(); } catch (_) { isDead = true; }
      } else if (age > entry.maxAge) {
        isDead = true;
      }
      if (isDead) {
        _registry.delete(id);
        if (typeof entry.cleanup === 'function') {
          try { entry.cleanup(); cleaned++; } catch (e) { _stats.errors++; }
        }
      }
    });
    return cleaned;
  }

  function _sweepAbortControllers() {
    var now     = Date.now();
    var cleaned = 0;
    var CTRL_MAX_AGE = 15 * 60 * 1000; // 15 min
    _controllers.forEach(function (entry, id) {
      if ((now - entry.ts) > CTRL_MAX_AGE) {
        _controllers.delete(id);
        try { entry.controller.abort('zombie-cleaner:stale'); cleaned++; } catch (_) {}
      }
    });
    return cleaned;
  }

  function _sweepListeners() {
    var now     = Date.now();
    var cleaned = 0;
    var LISTENER_MAX_AGE = 20 * 60 * 1000; // 20 min
    _listeners = _listeners.filter(function (entry) {
      if ((now - entry.ts) > LISTENER_MAX_AGE) {
        try { entry.target.removeEventListener(entry.type, entry.fn); cleaned++; } catch (_) {}
        return false;
      }
      return true;
    });
    return cleaned;
  }

  function _sweepWorkerRefs() {
    var now     = Date.now();
    var cleaned = 0;
    var WORKER_MAX_AGE = 10 * 60 * 1000; // 10 min
    _workerRefs.forEach(function (entry, id) {
      if (!entry.terminated && (now - entry.ts) > WORKER_MAX_AGE) {
        _workerRefs.delete(id);
        try { entry.worker.terminate(); entry.terminated = true; cleaned++; } catch (_) {}
      }
    });
    return cleaned;
  }

  function _sweepCanvasRefs() {
    var now     = Date.now();
    var cleaned = 0;
    var CANVAS_MAX_AGE = 5 * 60 * 1000; // 5 min
    _canvasRefs.forEach(function (entry, id) {
      if ((now - entry.ts) > CANVAS_MAX_AGE) {
        _canvasRefs.delete(id);
        try {
          entry.canvas.width  = 0;
          entry.canvas.height = 0;
          cleaned++;
        } catch (_) {}
      }
    });
    return cleaned;
  }

  // ── Full sweep ───────────────────────────────────────────────────────────────
  function sweep() {
    var total = 0;
    try { total += _sweepRegistry();          } catch (_) {}
    try { total += _sweepAbortControllers();  } catch (_) {}
    try { total += _sweepListeners();          } catch (_) {}
    try { total += _sweepWorkerRefs();         } catch (_) {}
    try { total += _sweepCanvasRefs();         } catch (_) {}
    if (total > 0) {
      _stats.cleaned += total;
      console.info(LOG, 'sweep cleaned', total, 'zombies');
      try {
        if (window.RuntimeEventBus) window.RuntimeEventBus.emit('zombie:swept', { count: total });
      } catch (_) {}
    }
    return total;
  }

  // ── Nuke everything (used by soft-reset / panic) ────────────────────────────
  function nukeAll(reason) {
    _registry.forEach(function (entry) {
      try { if (entry.cleanup) entry.cleanup(); } catch (_) {}
    });
    _registry.clear();
    _controllers.forEach(function (entry) {
      try { entry.controller.abort('nukeAll:' + (reason || 'reset')); } catch (_) {}
    });
    _controllers.clear();
    _listeners.forEach(function (entry) {
      try { entry.target.removeEventListener(entry.type, entry.fn); } catch (_) {}
    });
    _listeners = [];
    _workerRefs.forEach(function (entry) {
      try { entry.worker.terminate(); } catch (_) {}
    });
    _workerRefs.clear();
    _canvasRefs.forEach(function (entry) {
      try { entry.canvas.width = 0; entry.canvas.height = 0; } catch (_) {}
    });
    _canvasRefs.clear();
    console.info(LOG, 'nukeAll complete. Reason:', reason);
  }

  function getStats() {
    return Object.assign({}, _stats, {
      registry:    _registry.size,
      controllers: _controllers.size,
      listeners:   _listeners.length,
      workerRefs:  _workerRefs.size,
      canvasRefs:  _canvasRefs.size,
      version:     VERSION,
    });
  }

  // ── Sweep loop (every 2 min) ─────────────────────────────────────────────────
  var SWEEP_INTERVAL = 2 * 60 * 1000;
  var _sweepTimer = setInterval(function () {
    try { sweep(); } catch (_) {}
  }, SWEEP_INTERVAL);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeZombieCleaner', _sweepTimer);

  window.addEventListener('pagehide', function () {
    try { nukeAll('pagehide'); } catch (_) {}
  }, { passive: true });

  window.RuntimeZombieCleaner = {
    register:             register,
    trackAbortController: trackAbortController,
    trackListener:        trackListener,
    trackWorker:          trackWorker,
    trackCanvas:          trackCanvas,
    sweep:                sweep,
    nukeAll:              nukeAll,
    getStats:             getStats,
    VERSION:              VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
