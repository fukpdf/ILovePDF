// Cleanup Contracts v1.0 — Phase 1C Stabilization (T012)
// Shared, named contracts that define how every resource type is destroyed.
// Any subsystem registers a contract once; pagehide, memory-pressure, and
// navigation events fire them automatically — no ad-hoc cleanup code scattered
// across files.
//
// DESIGN PRINCIPLE: additive registry. Existing cleanup hooks (TimerRegistry,
// ObjectURLRegistry, WorkerLeakDetector, etc.) are NOT replaced — they are
// wrapped into named contracts so that a single CleanupContracts.runAll()
// call can coordinate a full, ordered teardown.
//
// Integrates with: TimerRegistry, ObjectURLRegistry, WorkerLeakDetector,
//                  MemPressure, LifecycleManager, NavCancel, AdaptiveDegradation
//
// Exposed as: window.CleanupContracts
//
// [FUTURE: ResourceManager] When a centralized ResourceManager is introduced,
// each contract becomes a ResourceManager.releasePolicy(). The registration
// surface stays identical — callers don't change.
(function () {
  'use strict';

  if (window.CleanupContracts) return;

  var LOG = '[CC]';

  // ── Phase ordering ─────────────────────────────────────────────────────────
  // Teardown runs in this order to avoid dangling references:
  //   1. worker    — stop producing new data
  //   2. preview   — release GPU/canvas textures
  //   3. blob      — revoke object URLs / free ArrayBuffers
  //   4. listener  — detach DOM / message listeners
  //   5. timer     — cancel pending callbacks
  //   6. canvas    — zero dimensions, release GPU memory
  //   7. generic   — any other resource
  var PHASES = ['worker', 'preview', 'blob', 'listener', 'timer', 'canvas', 'generic'];

  // ── Registry ───────────────────────────────────────────────────────────────
  // Map<name, { phase, destroy, cleanup, cancel, release, priority }>
  // priority: lower number runs first within a phase (default 50)
  var _registry = new Map();

  // ── Registration ───────────────────────────────────────────────────────────
  // contract: {
  //   phase?:   'worker'|'preview'|'blob'|'listener'|'timer'|'canvas'|'generic'
  //   destroy?: fn()   — full teardown, non-recoverable
  //   cleanup?: fn()   — light cleanup (e.g., clear caches), recoverable
  //   cancel?:  fn()   — cancel in-flight operations only
  //   release?: fn()   — release pooled/shared resources back to pool
  //   priority?: number  — execution order within phase (lower = earlier)
  // }
  // Returns an unregister function.
  function register(name, contract) {
    if (!name || typeof contract !== 'object') {
      console.warn(LOG, 'register() requires a name and contract object');
      return function () {};
    }
    var phase    = PHASES.includes(contract.phase) ? contract.phase : 'generic';
    var priority = typeof contract.priority === 'number' ? contract.priority : 50;

    _registry.set(name, {
      phase:    phase,
      destroy:  typeof contract.destroy  === 'function' ? contract.destroy  : null,
      cleanup:  typeof contract.cleanup  === 'function' ? contract.cleanup  : null,
      cancel:   typeof contract.cancel   === 'function' ? contract.cancel   : null,
      release:  typeof contract.release  === 'function' ? contract.release  : null,
      priority: priority,
    });

    return function () { _registry.delete(name); };
  }

  // ── Execution helpers ──────────────────────────────────────────────────────
  // Runs all registered contracts that have the given method, in phase order,
  // then by priority within each phase.
  function _run(method, reason) {
    var entries = [];
    _registry.forEach(function (c, name) {
      if (typeof c[method] === 'function') {
        entries.push({ name: name, phase: c.phase, priority: c.priority, fn: c[method] });
      }
    });

    // Sort: phase order first, then priority ascending
    entries.sort(function (a, b) {
      var pi = PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase);
      if (pi !== 0) return pi;
      return a.priority - b.priority;
    });

    var ran = 0;
    entries.forEach(function (e) {
      try { e.fn(reason); ran++; } catch (err) {
        console.warn(LOG, method + '() error in contract "' + e.name + '":', err.message);
      }
    });

    return ran;
  }

  // ── Public run methods ─────────────────────────────────────────────────────

  // Full teardown — runs all destroy() functions.
  // Call on: pagehide, fatal error, explicit "start over".
  function destroy(reason) {
    var n = _run('destroy', reason || 'destroy');
    console.debug(LOG, 'destroy(' + (reason || '') + ') —', n, 'contracts ran');
    return n;
  }

  // Light cleanup — runs all cleanup() functions.
  // Call on: memory pressure, idle GC, low-priority housekeeping.
  function cleanup(reason) {
    var n = _run('cleanup', reason || 'cleanup');
    console.debug(LOG, 'cleanup(' + (reason || '') + ') —', n, 'contracts ran');
    return n;
  }

  // Cancel in-flight operations only — runs all cancel() functions.
  // Call on: SPA navigation, user-initiated abort.
  function cancel(reason) {
    var n = _run('cancel', reason || 'cancel');
    console.debug(LOG, 'cancel(' + (reason || '') + ') —', n, 'contracts ran');
    return n;
  }

  // Release pooled resources — runs all release() functions.
  // Call on: tool completion, resource pool pressure.
  function release(reason) {
    var n = _run('release', reason || 'release');
    console.debug(LOG, 'release(' + (reason || '') + ') —', n, 'contracts ran');
    return n;
  }

  // runAll: run a specific method or all methods
  function runAll(method, reason) {
    if (method && ['destroy','cleanup','cancel','release'].includes(method)) {
      return _run(method, reason);
    }
    // Run all four in the safest order
    cancel(reason);
    release(reason);
    cleanup(reason);
    destroy(reason);
  }

  // ── Built-in contracts for existing Phase 1 subsystems ────────────────────
  // These wrap the existing cleanup APIs so a single runAll('destroy') call
  // covers every subsystem without needing per-subsystem teardown code.

  // TimerRegistry contract
  register('timers', {
    phase: 'timer',
    priority: 10,
    destroy: function () {
      if (window.TimerRegistry && window.TimerRegistry.clearAll) {
        try { window.TimerRegistry.clearAll(); } catch (_) {}
      }
    },
  });

  // ObjectURLRegistry contract
  register('objectURLs', {
    phase: 'blob',
    priority: 10,
    destroy: function () {
      if (window.ObjectURLRegistry && window.ObjectURLRegistry.revokeAll) {
        try { window.ObjectURLRegistry.revokeAll(); } catch (_) {}
      }
    },
    cleanup: function () {
      if (window.ObjectURLRegistry && window.ObjectURLRegistry.revokeOld) {
        try { window.ObjectURLRegistry.revokeOld(5 * 60 * 1000); } catch (_) {}
      }
    },
  });

  // WorkerLeakDetector contract
  register('workerLeakDetector', {
    phase: 'worker',
    priority: 10,
    destroy: function () {
      if (window.WorkerLeakDetector && window.WorkerLeakDetector.terminateZombies) {
        try { window.WorkerLeakDetector.terminateZombies(); } catch (_) {}
      }
    },
  });

  // WorkerLifecycle contract (Phase 1C)
  register('workerLifecycle', {
    phase: 'worker',
    priority: 20,
    cancel: function (reason) {
      if (window.WorkerLifecycle && window.WorkerLifecycle.cancelAllTokens) {
        try { window.WorkerLifecycle.cancelAllTokens(reason || 'cleanup-cancel'); } catch (_) {}
      }
    },
  });

  // NavCancel contract (Phase 1C)
  register('navCancel', {
    phase: 'listener',
    priority: 10,
    cancel: function (reason) {
      if (window.NavCancel && window.NavCancel.cancelAll) {
        try { window.NavCancel.cancelAll(reason || 'cleanup-cancel'); } catch (_) {}
      }
    },
  });

  // DownloadManager contract (Phase 1C)
  register('downloadManager', {
    phase: 'blob',
    priority: 20,
    destroy: function () {
      if (window.DownloadManager && window.DownloadManager.revokeAllPending) {
        try { window.DownloadManager.revokeAllPending(); } catch (_) {}
      }
    },
  });

  // MemPressure emergency cleanup contract
  register('memPressure', {
    phase: 'generic',
    priority: 5,
    cleanup: function () {
      if (window.MemPressure && window.MemPressure.emergencyCleanup) {
        try { window.MemPressure.emergencyCleanup(); } catch (_) {}
      }
    },
  });

  // CanvasPool contract (if available)
  register('canvasPool', {
    phase: 'canvas',
    priority: 10,
    cleanup: function () {
      if (window.CanvasPool && window.CanvasPool.releaseAll) {
        try { window.CanvasPool.releaseAll(); } catch (_) {}
      }
    },
  });

  // OPFS eviction contract (if available)
  register('opfsEviction', {
    phase: 'generic',
    priority: 20,
    cleanup: function () {
      if (window.EvictionManager && window.EvictionManager.evict) {
        try { window.EvictionManager.evict(); } catch (_) {}
      }
    },
  });

  // Burst/particle animations contract (cleanup on teardown)
  register('burstAnimations', {
    phase: 'canvas',
    priority: 30,
    cleanup: function () {
      if (window.clearAllBursts) {
        try { window.clearAllBursts(); } catch (_) {}
      }
    },
  });

  // ── Event integrations ─────────────────────────────────────────────────────

  // pagehide: full destroy (no recovery needed — page is leaving)
  window.addEventListener('pagehide', function () {
    destroy('pagehide');
  }, { passive: true });

  // MemPressure critical: emergency cleanup only (not full destroy)
  if (window.MemPressure && window.MemPressure.onTierChange) {
    window.MemPressure.onTierChange(function (newTier) {
      if (newTier === 'critical' || newTier === 'abort') {
        cleanup('mem-' + newTier);
      }
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var byPhase = {};
    PHASES.forEach(function (p) { byPhase[p] = 0; });
    _registry.forEach(function (c) {
      byPhase[c.phase] = (byPhase[c.phase] || 0) + 1;
    });
    return {
      totalContracts: _registry.size,
      byPhase:        byPhase,
      phases:         PHASES,
    };
  }

  function list() {
    var out = [];
    _registry.forEach(function (c, name) {
      out.push({
        name: name, phase: c.phase, priority: c.priority,
        methods: ['destroy','cleanup','cancel','release'].filter(function (m) { return !!c[m]; }),
      });
    });
    return out;
  }

  window.CleanupContracts = {
    register: register,
    destroy:  destroy,
    cleanup:  cleanup,
    cancel:   cancel,
    release:  release,
    runAll:   runAll,
    getStats: getStats,
    list:     list,
    PHASES:   PHASES,
  };

  console.debug('[CleanupContracts] ready — T012 shared cleanup contracts active (' +
    _registry.size + ' built-in contracts)');
}());
