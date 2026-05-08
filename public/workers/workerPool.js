// Worker Pool v4.0 — Phase 23A enhancement of v3.2.
// v3.x: persistent workers, idle TTL, crash recovery, slot rotation.
// v4.0 NEW: priority queues (high/normal/low), task cancellation tokens,
//           worker heartbeat monitoring, richer stats API.
(function () {
  'use strict';

  var MAX_PER_URL        = Math.min(navigator.hardwareConcurrency || 4, 4);
  var TIMEOUT_MS         = 120000; // 2-minute hard cap per task
  var MAX_CRASHES        = 3;      // auto-restart limit before slot is retired
  var IDLE_TTL_MS        = 60000;  // terminate idle workers after 60 s
  var MAX_QUEUE          = 50;     // reject tasks beyond this queue depth
  var MAX_TASKS_PER_SLOT = 60;     // rotate slot after N tasks to avoid accumulation
  var HEARTBEAT_MS       = 30000;  // check for stuck workers every 30 s

  // Map<workerUrl, { url, queues: {high,normal,low}, slots[] }>
  var pools = {};

  // ── Token factory for task cancellation ───────────────────────────────────
  function CancelToken() {
    var _cancelled = false;
    var _cbs       = [];
    return {
      get cancelled() { return _cancelled; },
      cancel: function () {
        if (_cancelled) return;
        _cancelled = true;
        _cbs.forEach(function (fn) { try { fn(); } catch (_) {} });
        _cbs = [];
      },
      onCancel: function (fn) {
        if (_cancelled) { try { fn(); } catch (_) {} }
        else _cbs.push(fn);
      },
    };
  }

  function getPool(url) {
    if (!pools[url]) {
      pools[url] = {
        url:    url,
        slots:  [],
        queues: { high: [], normal: [], low: [] },
      };
    }
    return pools[url];
  }

  // ── Queue helpers ─────────────────────────────────────────────────────────
  function queueLength(pool) {
    return pool.queues.high.length + pool.queues.normal.length + pool.queues.low.length;
  }

  function dequeueNext(pool) {
    if (pool.queues.high.length)   return pool.queues.high.shift();
    if (pool.queues.normal.length) return pool.queues.normal.shift();
    if (pool.queues.low.length)    return pool.queues.low.shift();
    return null;
  }

  function rejectAllQueued(pool, err) {
    ['high', 'normal', 'low'].forEach(function (p) {
      while (pool.queues[p].length > 0) {
        var t = pool.queues[p].shift();
        try { t.reject(err); } catch (_) {}
      }
    });
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────────
  function spawnWorker(url) {
    try { return new Worker(url); } catch (_) { return null; }
  }

  function attachHandlers(pool, slot) {
    slot.worker.onmessage = function (e) { settle(pool, slot, null, e.data); };
    slot.worker.onerror   = function (e) {
      slot.crashes++;
      var err = new Error((e && e.message) || 'worker_error');
      settle(pool, slot, err, null);
      if (slot.crashes < MAX_CRASHES) {
        var w = spawnWorker(pool.url);
        if (w) { slot.worker = w; attachHandlers(pool, slot); }
      }
    };
    slot.worker.onmessageerror = function () {
      slot.crashes++;
      settle(pool, slot, new Error('worker_message_error'), null);
    };
  }

  function makeSlot(pool) {
    var w = spawnWorker(pool.url);
    if (!w) return null;
    var slot = {
      worker:      w,
      busy:        false,
      crashes:     0,
      taskCount:   0,
      timer:       null,
      idleTimer:   null,
      lastActive:  Date.now(),
      currentTask: null,
      resolve:     null,
      reject:      null,
    };
    attachHandlers(pool, slot);
    return slot;
  }

  function _startIdleTimer(pool, slot) {
    _clearIdleTimer(slot);
    slot.idleTimer = setTimeout(function () {
      if (slot.busy) return;
      var idx = pool.slots.indexOf(slot);
      if (idx !== -1) pool.slots.splice(idx, 1);
      try { slot.worker.terminate(); } catch (_) {}
    }, IDLE_TTL_MS);
  }

  function _clearIdleTimer(slot) {
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
  }

  function settle(pool, slot, err, data) {
    if (!slot.busy) return;
    clearTimeout(slot.timer);
    var res = slot.resolve;
    var rej = slot.reject;
    slot.busy        = false;
    slot.timer       = null;
    slot.resolve     = null;
    slot.reject      = null;
    slot.currentTask = null;
    slot.lastActive  = Date.now();

    if (err) {
      rej(err);
    } else if (data && data.__error) {
      rej(new Error(data.__error));
    } else {
      res(data);
    }

    _startIdleTimer(pool, slot);
    drainOne(pool, slot);
  }

  function dispatch(pool, slot, task) {
    // Honour cancellation before dispatch
    if (task.token && task.token.cancelled) {
      task.reject(new Error('task_cancelled'));
      drainOne(pool, slot);
      return;
    }

    _clearIdleTimer(slot);
    slot.busy        = true;
    slot.taskCount++;
    slot.lastActive  = Date.now();
    slot.currentTask = task;
    slot.resolve     = task.resolve;
    slot.reject      = task.reject;

    // Register cancellation handler
    if (task.token) {
      task.token.onCancel(function () {
        settle(pool, slot, new Error('task_cancelled'), null);
      });
    }

    slot.timer = setTimeout(function () {
      settle(pool, slot, new Error('Worker task timed out after ' + (TIMEOUT_MS / 1000) + 's'), null);
      var w = spawnWorker(pool.url);
      if (w) {
        try { slot.worker.terminate(); } catch (_) {}
        slot.worker    = w;
        slot.taskCount = 0;
        attachHandlers(pool, slot);
      }
    }, TIMEOUT_MS);

    if (!slot.worker || slot.crashes >= MAX_CRASHES) {
      settle(pool, slot, new Error('Worker unavailable — crash limit reached'), null);
      return;
    }

    var msg = task.message;
    var xfr = task.transferables || [];
    try {
      slot.worker.postMessage(msg, xfr);
    } catch (_) {
      try {
        slot.worker.postMessage(msg);
      } catch (e2) {
        settle(pool, slot, new Error('postMessage failed: ' + e2.message), null);
      }
    }
  }

  function drainOne(pool, slot) {
    if (queueLength(pool) === 0) return;
    if (slot.busy || slot.crashes >= MAX_CRASHES) return;

    // Slot rotation — retire workers that have processed many tasks
    if (slot.taskCount >= MAX_TASKS_PER_SLOT) {
      var idx = pool.slots.indexOf(slot);
      if (idx !== -1) pool.slots.splice(idx, 1);
      try { slot.worker.terminate(); } catch (_) {}
      var fresh = makeSlot(pool);
      if (fresh) {
        pool.slots.push(fresh);
        var task = dequeueNext(pool);
        if (task) dispatch(pool, fresh, task);
      }
      return;
    }

    var t = dequeueNext(pool);
    if (t) dispatch(pool, slot, t);
  }

  function drainAll(pool) {
    for (var i = 0; i < pool.slots.length && queueLength(pool) > 0; i++) {
      var s = pool.slots[i];
      if (!s.busy && s.crashes < MAX_CRASHES) drainOne(pool, s);
    }
    while (queueLength(pool) > 0 && pool.slots.length < MAX_PER_URL) {
      var slot = makeSlot(pool);
      if (!slot) break;
      pool.slots.push(slot);
      drainOne(pool, slot);
    }
  }

  // ── Heartbeat: detect hung workers and respawn ─────────────────────────────
  var _heartbeatId = null;
  function _startHeartbeat() {
    if (_heartbeatId) return;
    _heartbeatId = setInterval(function () {
      var now = Date.now();
      Object.keys(pools).forEach(function (url) {
        var pool = pools[url];
        pool.slots.forEach(function (slot) {
          if (slot.busy && (now - slot.lastActive) > TIMEOUT_MS) {
            // Stuck worker — force settle with timeout error, then respawn
            try { slot.worker.terminate(); } catch (_) {}
            settle(pool, slot, new Error('Worker heartbeat timeout'), null);
            var fresh = spawnWorker(pool.url);
            if (fresh) {
              slot.worker    = fresh;
              slot.crashes   = 0;
              slot.taskCount = 0;
              slot.lastActive = Date.now();
              attachHandlers(pool, slot);
            }
          }
        });
      });
    }, HEARTBEAT_MS);
  }
  _startHeartbeat();

  // ── PUBLIC API ─────────────────────────────────────────────────────────────

  // opts: { priority?: 'high'|'normal'|'low', token?: CancelToken }
  function run(workerUrl, message, transferables, opts) {
    opts = opts || {};
    var priority = opts.priority || 'normal';
    var token    = opts.token    || null;

    var pool = getPool(workerUrl);

    return new Promise(function (resolve, reject) {
      if (queueLength(pool) >= MAX_QUEUE) {
        reject(new Error('Worker queue full — too many concurrent tasks'));
        return;
      }

      var task = {
        message:       message,
        transferables: transferables || [],
        resolve:       resolve,
        reject:        reject,
        priority:      priority,
        token:         token,
        queued:        Date.now(),
      };

      // Try a free, healthy slot
      for (var i = 0; i < pool.slots.length; i++) {
        var s = pool.slots[i];
        if (!s.busy && s.crashes < MAX_CRASHES) {
          dispatch(pool, s, task);
          return;
        }
      }

      // Spawn a new slot if under limit
      if (pool.slots.length < MAX_PER_URL) {
        var slot = makeSlot(pool);
        if (slot) {
          pool.slots.push(slot);
          dispatch(pool, slot, task);
          return;
        }
      }

      // All slots busy — enqueue with priority
      var q = pool.queues[priority] || pool.queues.normal;
      q.push(task);
    });
  }

  function getStats() {
    var out = {};
    Object.keys(pools).forEach(function (url) {
      var p = pools[url];
      out[url] = {
        total:      p.slots.length,
        busy:       p.slots.filter(function (s) { return s.busy; }).length,
        queued:     queueLength(p),
        queuedHigh:   p.queues.high.length,
        queuedNormal: p.queues.normal.length,
        queuedLow:    p.queues.low.length,
        crashed:    p.slots.filter(function (s) { return s.crashes >= MAX_CRASHES; }).length,
        taskCounts: p.slots.map(function (s) { return s.taskCount; }),
      };
    });
    return out;
  }

  function prewarm(workerUrl) {
    var pool = getPool(workerUrl);
    if (pool.slots.length === 0) {
      var slot = makeSlot(pool);
      if (slot) {
        pool.slots.push(slot);
        _startIdleTimer(pool, slot);
      }
    }
  }

  function terminatePool(workerUrl) {
    var pool = pools[workerUrl];
    if (!pool) return;
    pool.slots.forEach(function (slot) {
      if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
      if (slot.timer)     { clearTimeout(slot.timer);     slot.timer     = null; }
      try { slot.worker.terminate(); } catch (_) {}
      if (slot.busy && slot.reject) {
        slot.reject(new Error('pool_terminated'));
        slot.busy = false; slot.resolve = null; slot.reject = null;
      }
    });
    pool.slots = [];
    rejectAllQueued(pool, new Error('pool_terminated'));
    delete pools[workerUrl];
  }

  window.WorkerPool = {
    run:           run,
    getStats:      getStats,
    prewarm:       prewarm,
    terminatePool: terminatePool,
    CancelToken:   CancelToken,   // v4.0
    MAX_WORKERS:   MAX_PER_URL,
  };

}());
