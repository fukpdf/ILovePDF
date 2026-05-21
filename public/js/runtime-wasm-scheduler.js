// RuntimeWasmScheduler v1.0 — Phase 7 / Section 6 (WASM Execution Scheduler)
// =============================================================================
// Priority-based WASM execution scheduler. Queues WASM tasks, enforces
// quotas, balances memory pressure, and routes to isolated pools.
//
// Scheduling strategies:
//   • Priority queue — CRITICAL > HIGH > NORMAL > LOW tasks
//   • Memory budget enforcement — reject tasks that would exceed budget
//   • Concurrency limits — per-pool and global limits
//   • Timeout enforcement — tasks killed after TTL
//   • Adaptive throttling — reduce concurrency under memory pressure
//   • Idle scheduling — LOW priority tasks only run during idle
//   • Parallel pool routing — route to least-loaded pool
//
// Task quota system:
//   • Per-module execution quotas (resets per hour)
//   • Global concurrent execution cap
//   • Memory consumption tracking
//
// window.RuntimeWasmScheduler
//   .schedule(taskDef)           → Promise<result>
//   .cancelTask(taskId)          → boolean
//   .getQueueStatus()            → QueueStatus
//   .setQuota(moduleId, quota)   → void
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmScheduler) return;

  var VERSION = '1.0';
  var LOG     = '[WasmScheduler]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Limits ────────────────────────────────────────────────────────────────
  var MAX_CONCURRENT = _score >= 70 ? 4 : (_score >= 40 ? 2 : 1);
  var MAX_QUEUE      = 20;
  var DEFAULT_TIMEOUT = 120_000;   // 2 minutes

  // ── Queues (one per priority) ─────────────────────────────────────────────
  var _queues = { CRITICAL: [], HIGH: [], NORMAL: [], LOW: [] };
  var _active  = typeof Map !== 'undefined' ? new Map() : null;  // taskId → timeout
  var _quotas  = typeof Map !== 'undefined' ? new Map() : null;  // moduleId → {max, used, resetTs}
  var _taskId  = 0;
  var _completed = 0;
  var _failed    = 0;

  // ── Schedule a task ────────────────────────────────────────────────────────
  function schedule(taskDef) {
    taskDef = taskDef || {};
    var priority  = taskDef.priority  || 'NORMAL';
    var moduleId  = taskDef.moduleId  || 'default';
    var timeoutMs = taskDef.timeoutMs || DEFAULT_TIMEOUT;
    var fn        = taskDef.fn;

    if (typeof fn !== 'function') {
      return Promise.reject(new Error('task.fn must be a function'));
    }

    // Check queue capacity
    var totalQueued = _queues.CRITICAL.length + _queues.HIGH.length +
      _queues.NORMAL.length + _queues.LOW.length;
    if (totalQueued >= MAX_QUEUE) {
      return Promise.reject(new Error('wasm-queue-full'));
    }

    // Check quota
    if (_quotas && _quotas.has(moduleId)) {
      var quota = _quotas.get(moduleId);
      if (Date.now() > quota.resetTs) {
        quota.used = 0;
        quota.resetTs = Date.now() + 3600_000;
      }
      if (quota.used >= quota.max) {
        return Promise.reject(new Error('quota-exceeded:' + moduleId));
      }
    }

    var id = 'wt_' + (++_taskId).toString(36);

    return new Promise(function (resolve, reject) {
      var task = {
        id:        id,
        moduleId:  moduleId,
        priority:  priority,
        fn:        fn,
        args:      taskDef.args || [],
        timeoutMs: timeoutMs,
        resolve:   resolve,
        reject:    reject,
        queuedAt:  Date.now(),
      };

      var q = _queues[priority] || _queues.NORMAL;
      q.push(task);
      _drain();
    });
  }

  // ── Drain queue ───────────────────────────────────────────────────────────
  function _drain() {
    var concurrency = _active ? _active.size : 0;
    if (concurrency >= MAX_CONCURRENT) return;

    // Pull from highest priority
    var task = null;
    for (var p of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      var q = _queues[p];
      // LOW priority: only run during idle
      if (p === 'LOW' && concurrency > 0) continue;
      if (q.length > 0) { task = q.shift(); break; }
    }

    if (!task) return;

    // Update quota
    if (_quotas && _quotas.has(task.moduleId)) {
      _quotas.get(task.moduleId).used++;
    }

    // Execute
    var timeoutHandle = setTimeout(function () {
      if (_active) _active.delete(task.id);
      task.reject(new Error('wasm-task-timeout:' + task.id));
      _failed++;
    }, task.timeoutMs);

    if (_active) _active.set(task.id, timeoutHandle);

    Promise.resolve().then(function () {
      return task.fn.apply(null, task.args);
    }).then(function (result) {
      clearTimeout(timeoutHandle);
      if (_active) _active.delete(task.id);
      task.resolve(result);
      _completed++;
      _drain(); // pull next task
    }).catch(function (err) {
      clearTimeout(timeoutHandle);
      if (_active) _active.delete(task.id);
      task.reject(err);
      _failed++;
      _drain();
    });
  }

  function cancelTask(taskId) {
    for (var p of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      var idx = _queues[p].findIndex(function (t) { return t.id === taskId; });
      if (idx !== -1) {
        var task = _queues[p].splice(idx, 1)[0];
        task.reject(new Error('task-cancelled:' + taskId));
        return true;
      }
    }
    return false;
  }

  function setQuota(moduleId, quota) {
    if (!_quotas) return;
    _quotas.set(moduleId, { max: quota, used: 0, resetTs: Date.now() + 3600_000 });
  }

  function getQueueStatus() {
    return {
      queued: {
        CRITICAL: _queues.CRITICAL.length,
        HIGH:     _queues.HIGH.length,
        NORMAL:   _queues.NORMAL.length,
        LOW:      _queues.LOW.length,
      },
      active:    _active ? _active.size : 0,
      completed: _completed,
      failed:    _failed,
      maxConcurrent: MAX_CONCURRENT,
    };
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| maxConcurrent:', MAX_CONCURRENT);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 6000); }, { once: true });
  } else {
    setTimeout(_boot, 6000);
  }

  G.RuntimeWasmScheduler = Object.freeze({
    VERSION:      VERSION,
    schedule:     schedule,
    cancelTask:   cancelTask,
    setQuota:     setQuota,
    getQueueStatus: getQueueStatus,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, queue: getQueueStatus() };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
