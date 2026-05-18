// runtime-timeout-reaper.js — Global Timeout Reaper (Phase 2D)
// ADDITIVE ONLY. Centralizes all tool timeout tracking so that when any
// timeout fires, cleanup hooks run BEFORE the promise rejects.
// Fixes "first fail / second hang" globally by ensuring every timeout
// triggers full resource cleanup before surfacing the error.
//
// window.RuntimeTimeoutReaper — public API
(function () {
  'use strict';

  if (window.RuntimeTimeoutReaper) return;

  var LOG     = '[RTR]';
  var VERSION = '1.0.0';

  // ── Registry: id → { label, url, cleanup[], timer, ts, fired } ─────────────
  var _registry = new Map();
  var _nextId   = 1;

  // ── Stats ───────────────────────────────────────────────────────────────────
  var _stats = { registered: 0, fired: 0, cancelled: 0, cleanupErrors: 0 };

  // ── Register a timeout with optional cleanup hooks ───────────────────────────
  // Returns a reaper handle { id, cancel, addCleanup }
  // When the timeout fires: runs all cleanup hooks, THEN rejects the promise.
  //
  // opts:
  //   label?      — human-readable name for diagnostics
  //   url?        — worker URL (used to terminate stuck workers)
  //   onTimeout?  — called synchronously before reject (receives id)
  function register(ms, opts) {
    opts = opts || {};
    var id      = _nextId++;
    var label   = opts.label || 'timeout-' + id;
    var url     = opts.url   || null;
    var cleanupFns = [];
    var entry   = { id: id, label: label, url: url, cleanup: cleanupFns, timer: null, ts: Date.now(), fired: false };

    var resolve, reject;
    var promise = new Promise(function (res, rej) {
      resolve = res;
      reject  = rej;
    });

    entry.timer = setTimeout(function () {
      if (entry.fired) return;
      entry.fired = true;
      _stats.fired++;

      // 1. Run all cleanup hooks before rejecting
      cleanupFns.forEach(function (fn) {
        try { fn(); } catch (e) {
          _stats.cleanupErrors++;
          console.debug(LOG, 'cleanup error for', label, ':', e.message);
        }
      });

      // 2. Auto-terminate stuck worker if URL provided
      if (url) {
        try {
          if (window.WorkerPool && window.WorkerPool.terminatePool) {
            window.WorkerPool.terminatePool(url);
          }
        } catch (_) {}
      }

      // 3. Emit event for healer/panic-manager
      try {
        if (window.RuntimeEventBus) {
          window.RuntimeEventBus.emit('timeout:fired', { id: id, label: label, url: url });
        }
      } catch (_) {}

      console.warn(LOG, 'timeout fired for', label, '(' + Math.round(ms / 1000) + 's)');

      // 4. Reject the promise
      reject(new Error('timeout:' + label + ':' + Math.round(ms / 1000) + 's'));
      _registry.delete(id);
    }, ms);

    if (window.TimerRegistry) window.TimerRegistry.registerTimeout('RuntimeTimeoutReaper', entry.timer);
    _registry.set(id, entry);
    _stats.registered++;

    // Handle object returned to caller
    var handle = {
      id: id,
      label: label,
      promise: promise,

      // Add a cleanup hook to run before rejection
      addCleanup: function (fn) {
        if (typeof fn === 'function') cleanupFns.push(fn);
        return handle;
      },

      // Cancel the timeout (task completed normally)
      cancel: function () {
        if (entry.fired) return;
        entry.fired = true;
        clearTimeout(entry.timer);
        _registry.delete(id);
        _stats.cancelled++;
        resolve('cancelled');
      },
    };

    return handle;
  }

  // ── Wrap an existing promise with a registered timeout ───────────────────────
  // Returns Promise that races the original promise against the timeout.
  // The timeout handle is auto-cancelled if the original wins.
  //
  // opts: { label?, url?, cleanup? (fn or fn[]) }
  function wrap(promise, ms, opts) {
    opts = opts || {};
    var handle = register(ms, opts);

    // Register any cleanup fns provided upfront
    var cleanup = opts.cleanup;
    if (typeof cleanup === 'function') handle.addCleanup(cleanup);
    else if (Array.isArray(cleanup)) cleanup.forEach(function (fn) { handle.addCleanup(fn); });

    return Promise.race([
      promise.then(function (result) {
        handle.cancel();
        return result;
      }, function (err) {
        handle.cancel();
        throw err;
      }),
      handle.promise,
    ]);
  }

  // ── Cancel all registered timeouts (used during soft reset / panic) ──────────
  function cancelAll(reason) {
    var count = 0;
    _registry.forEach(function (entry) {
      if (!entry.fired) {
        entry.fired = true;
        clearTimeout(entry.timer);
        count++;
      }
    });
    _registry.clear();
    console.info(LOG, 'cancelAll —', count, 'timeouts cancelled. Reason:', reason || 'manual');
    return count;
  }

  function getStats() {
    return Object.assign({}, _stats, { active: _registry.size, version: VERSION });
  }

  function getActive() {
    var now  = Date.now();
    var list = [];
    _registry.forEach(function (entry) {
      list.push({ id: entry.id, label: entry.label, url: entry.url, ageMs: now - entry.ts });
    });
    return list;
  }

  window.addEventListener('pagehide', function () {
    cancelAll('pagehide');
  }, { passive: true });

  window.RuntimeTimeoutReaper = {
    register:   register,
    wrap:       wrap,
    cancelAll:  cancelAll,
    getStats:   getStats,
    getActive:  getActive,
    VERSION:    VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
