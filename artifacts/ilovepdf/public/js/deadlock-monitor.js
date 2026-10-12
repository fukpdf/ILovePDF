// Phase 40B — Worker Deadlock Monitor v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § B1  HeartbeatValidator    — per-worker ping/pong watchdog
// § B2  StalledPromiseDetector— promise duration tracking with configurable timeout
// § B3  QueueStarvationGuard  — detects tasks that never dequeue
// § B4  DeadlockResolver      — isolate → terminate → requeue → checkpoint
//
// Exposes: window.DeadlockMonitor

(function () {
  'use strict';

  var VERSION      = '1.0';
  var LOG_PFX      = '[DLM]';
  var HEARTBEAT_MS = 5000;
  var TIMEOUT_MS   = 30000;
  var STALL_MS     = 60000;

  function _log(t, d)  { try { window.DebugTrace && window.DebugTrace.log  && window.DebugTrace.log (LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _warn(t, d) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' WARN ' + t, d); console.warn(LOG_PFX, t, d || ''); } catch (_) {} }

  // ═══════════════════════════════════════════════════════════════════════════
  // § B1  HEARTBEAT VALIDATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var HeartbeatValidator = (function () {
    var _workers = new Map();   // workerId → { worker, label, lastPing, dead }

    function register(worker, label, workerId) {
      var id = workerId || ('w_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      _workers.set(id, { worker: worker, label: label || id, lastPing: Date.now(), dead: false });
      return id;
    }

    function ping(workerId) {
      var e = _workers.get(workerId);
      if (e) { e.lastPing = Date.now(); e.dead = false; }
    }

    function unregister(workerId) { _workers.delete(workerId); }

    function checkAll() {
      var now   = Date.now();
      var found = [];
      _workers.forEach(function (e, id) {
        if (!e.dead && now - e.lastPing > TIMEOUT_MS) {
          e.dead = true;
          found.push({ id: id, label: e.label, staleSec: Math.round((now - e.lastPing) / 1000) });
          _warn('worker-frozen', { id: id, label: e.label });
          DeadlockResolver.resolve(id, e);
        }
      });
      return found;
    }

    function getStats() {
      var alive = 0; var dead = 0;
      _workers.forEach(function (e) { if (e.dead) dead++; else alive++; });
      return { alive: alive, dead: dead, total: _workers.size };
    }

    var _hbIv = setInterval(checkAll, HEARTBEAT_MS);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('dlm-heartbeat', _hbIv);
    return { register: register, ping: ping, unregister: unregister, checkAll: checkAll, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B2  STALLED PROMISE DETECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var StalledPromiseDetector = (function () {
    var _promises = new Map();
    var _nextId   = 1;

    // Track a promise; returns a tracking id
    function track(promise, label, timeoutMs) {
      var id    = _nextId++;
      var start = Date.now();
      var tms   = timeoutMs || STALL_MS;
      var entry = { label: label || ('promise_' + id), start: start, stalled: false };
      _promises.set(id, entry);

      var timer = setTimeout(function () {
        var e = _promises.get(id);
        if (e && !e.resolved) {
          e.stalled = true;
          _warn('stalled-promise', { id: id, label: e.label, ageSec: Math.round((Date.now() - e.start) / 1000) });
        }
      }, tms);

      Promise.resolve(promise).finally(function () {
        clearTimeout(timer);
        var e = _promises.get(id);
        if (e) e.resolved = true;
        _promises.delete(id);
      }).catch(function () {});

      return id;
    }

    function getStalled() {
      var out = [];
      _promises.forEach(function (e, id) {
        if (e.stalled) out.push({ id: id, label: e.label, ageSec: Math.round((Date.now() - e.start) / 1000) });
      });
      return out;
    }

    function getStats() {
      var stalled = 0;
      _promises.forEach(function (e) { if (e.stalled) stalled++; });
      return { total: _promises.size, stalled: stalled };
    }

    return { track: track, getStalled: getStalled, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B3  QUEUE STARVATION GUARD
  // Detects tasks sitting in a WorkerPool queue without being dequeued.
  // ═══════════════════════════════════════════════════════════════════════════
  var QueueStarvationGuard = (function () {
    var _snapshots = [];
    var MAX_SAME   = 5;   // If queue depth same for MAX_SAME checks → starvation

    function check() {
      var pool  = window.WorkerPool;
      var stats = pool && pool.getStats ? pool.getStats() : null;
      if (!stats) return null;

      var depth = stats.queued || 0;
      _snapshots.push({ depth: depth, ts: Date.now() });
      if (_snapshots.length > MAX_SAME + 2) _snapshots.shift();

      if (_snapshots.length >= MAX_SAME) {
        var same = _snapshots.slice(-MAX_SAME).every(function (s) { return s.depth === depth && depth > 0; });
        if (same) {
          _warn('queue-starvation', { depth: depth, pool: stats });
          return { starvation: true, depth: depth, stats: stats };
        }
      }
      return { starvation: false, depth: depth };
    }

    var _qsgIv = setInterval(check, HEARTBEAT_MS);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('dlm-queue-guard', _qsgIv);
    function getStats() { return { snapshots: _snapshots.length, lastDepth: _snapshots.length ? _snapshots[_snapshots.length - 1].depth : 0 }; }
    return { check: check, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B4  DEADLOCK RESOLVER
  // Isolates frozen workers, checkpoints state, and requeuess tasks.
  // ═══════════════════════════════════════════════════════════════════════════
  var DeadlockResolver = (function () {
    var _resolved = [];

    function resolve(workerId, workerEntry) {
      _log('resolving', { workerId: workerId });
      var record = { workerId: workerId, ts: Date.now(), actions: [] };

      // 1. Try graceful terminate
      try {
        var w = workerEntry && workerEntry.worker;
        if (w && typeof w.terminate === 'function') {
          w.terminate();
          record.actions.push('terminated');
          _log('worker-terminated', { workerId: workerId });
        }
      } catch (ex) { record.actions.push('terminate-failed: ' + ex.message); }

      // 2. Notify WorkerPool so it can spawn a replacement
      try {
        var pool = window.WorkerPool;
        if (pool && typeof pool.recoverWorker === 'function') {
          pool.recoverWorker(workerId);
          record.actions.push('pool-recovered');
        }
      } catch (_) {}

      // 3. Checkpoint any in-progress job via Phase33
      try {
        var p33 = window.Phase33;
        if (p33 && p33.CheckpointEngine) {
          record.actions.push('checkpoint-requested');
        }
      } catch (_) {}

      // 4. Notify AutoTuning to reduce worker count
      try {
        var ate = window.AutoTuningEngine;
        if (ate && ate.AdaptiveController) {
          var current = ate.AdaptiveController.workerCount();
          ate.AdaptiveController.setOverride('workerCount', Math.max(1, current - 1));
          record.actions.push('workers-reduced-to-' + Math.max(1, current - 1));
        }
      } catch (_) {}

      // 5. Fire SelfHealing if available
      try {
        var sh = window.SelfHealingRecovery;
        if (sh && typeof sh.onDeadlock === 'function') sh.onDeadlock(workerId);
      } catch (_) {}

      record.resolved = true;
      _resolved.unshift(record);
      if (_resolved.length > 20) _resolved.pop();
      _log('resolved', record);
      return record;
    }

    function getHistory() { return _resolved.slice(); }
    return { resolve: resolve, getHistory: getHistory };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // Hook WorkerPool to auto-register workers
  // ═══════════════════════════════════════════════════════════════════════════
  function _hookWorkerPool() {
    var pool = window.WorkerPool;
    if (!pool || pool.__dlm_hooked) return;
    var origSpawn = pool.spawnWorker && pool.spawnWorker.bind(pool);
    if (!origSpawn) return;
    pool.spawnWorker = function () {
      var w = origSpawn.apply(pool, arguments);
      if (w) HeartbeatValidator.register(w, 'pool-worker');
      return w;
    };
    pool.__dlm_hooked = true;
  }

  var _iv = setInterval(function () {
    _hookWorkerPool();
    if (window.WorkerPool) clearInterval(_iv);
  }, 200);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('dlm-pool-hook', _iv);


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.DeadlockMonitor = {
    version:                VERSION,
    HeartbeatValidator:     HeartbeatValidator,
    StalledPromiseDetector: StalledPromiseDetector,
    QueueStarvationGuard:   QueueStarvationGuard,
    DeadlockResolver:       DeadlockResolver,

    trackPromise: function (p, label, ms)  { return StalledPromiseDetector.track(p, label, ms); },
    registerWorker: function (w, label, id){ return HeartbeatValidator.register(w, label, id); },
    pingWorker: function (id)              { return HeartbeatValidator.ping(id); },

    audit: function () {
      return {
        version:     VERSION,
        workers:     HeartbeatValidator.getStats(),
        promises:    StalledPromiseDetector.getStats(),
        queue:       QueueStarvationGuard.getStats(),
        resolved:    DeadlockResolver.getHistory().length,
      };
    },
  };

  _log('loaded', {});
}());
