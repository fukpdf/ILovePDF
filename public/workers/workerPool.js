// Worker Pool v3.2 — persistent workers, smart queue, idle cleanup.
// Phase 1:   Workers are REUSED across tasks — no spawn/terminate overhead.
// Phase 19A: terminatePool() for post-job cleanup; slot task-count rotation.
// SAB path REMOVED (was broken: sabBuffers never sent to worker).
(function () {
  'use strict';

  var MAX_PER_URL       = Math.min(navigator.hardwareConcurrency || 4, 4);
  var TIMEOUT_MS        = 120000; // 2-minute hard cap per task
  var MAX_CRASHES       = 3;      // auto-restart limit before slot is retired
  var IDLE_TTL_MS       = 60000;  // terminate idle workers after 60 s
  var MAX_QUEUE         = 50;     // reject tasks beyond this queue depth
  var MAX_TASKS_PER_SLOT = 60;    // Phase 19A: rotate slot after N tasks to avoid state accumulation

  // Map<workerUrl, { url, slots[], queue[] }>
  var pools = {};

  function getPool(url) {
    if (!pools[url]) pools[url] = { url: url, slots: [], queue: [] };
    return pools[url];
  }

  function spawnWorker(url) {
    try { return new Worker(url); } catch (_) { return null; }
  }

  function attachHandlers(pool, slot) {
    slot.worker.onmessage = function (e) { settle(pool, slot, null, e.data); };
    slot.worker.onerror   = function (e) {
      slot.crashes++;
      var err = new Error((e && e.message) || 'worker_error');
      settle(pool, slot, err, null);
      // Auto-restart within crash limit
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
      worker:    w,
      busy:      false,
      crashes:   0,
      taskCount: 0,     // Phase 19A: total tasks dispatched — rotate after MAX_TASKS_PER_SLOT
      timer:     null,  // task timeout
      idleTimer: null,  // idle termination
      resolve:   null,
      reject:    null,
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
    if (!slot.busy) return; // already settled (timeout or duplicate)
    clearTimeout(slot.timer);
    var res = slot.resolve;
    var rej = slot.reject;
    slot.busy    = false;
    slot.timer   = null;
    slot.resolve = null;
    slot.reject  = null;

    if (err) {
      rej(err);
    } else if (data && data.__error) {
      rej(new Error(data.__error));
    } else {
      res(data);
    }

    // Start idle timer — will terminate this slot if nothing picks it up
    _startIdleTimer(pool, slot);

    // Immediately serve next queued task on this now-free slot
    drainOne(pool, slot);
  }

  function dispatch(pool, slot, task) {
    _clearIdleTimer(slot);
    slot.busy      = true;
    slot.taskCount++;          // Phase 19A: track lifetime task count for rotation
    slot.resolve   = task.resolve;
    slot.reject    = task.reject;

    slot.timer = setTimeout(function () {
      settle(pool, slot, new Error('Worker task timed out after ' + (TIMEOUT_MS / 1000) + 's'), null);
      // Phase 19A: on timeout, only respawn if the slot isn't already being drained/rotated
      var w = spawnWorker(pool.url);
      if (w) {
        try { slot.worker.terminate(); } catch (_) {}
        slot.worker    = w;
        slot.taskCount = 0; // reset rotation counter on respawn
        attachHandlers(pool, slot);
      }
    }, TIMEOUT_MS);

    if (!slot.worker || slot.crashes >= MAX_CRASHES) {
      settle(pool, slot, new Error('Worker unavailable — crash limit reached'), null);
      return;
    }

    var msg = task.message;
    var xfr = task.transferables || [];

    // Standard structured-clone transfer (SAB path removed — was broken)
    try {
      slot.worker.postMessage(msg, xfr);
    } catch (_) {
      try {
        slot.worker.postMessage(msg); // fallback: no transfer
      } catch (e2) {
        settle(pool, slot, new Error('postMessage failed: ' + e2.message), null);
      }
    }
  }

  function drainOne(pool, slot) {
    if (pool.queue.length === 0) return;
    if (slot.busy || slot.crashes >= MAX_CRASHES) return;

    // Phase 19A: slot rotation — retire long-lived workers to prevent state accumulation
    if (slot.taskCount >= MAX_TASKS_PER_SLOT) {
      var idx = pool.slots.indexOf(slot);
      if (idx !== -1) pool.slots.splice(idx, 1);
      try { slot.worker.terminate(); } catch (_) {}
      // Spawn a fresh replacement for the queue
      var fresh = makeSlot(pool);
      if (fresh) {
        pool.slots.push(fresh);
        var task = pool.queue.shift();
        if (task) dispatch(pool, fresh, task);
      }
      return;
    }

    var task = pool.queue.shift();
    if (task) dispatch(pool, slot, task);
  }

  function drainAll(pool) {
    for (var i = 0; i < pool.slots.length && pool.queue.length > 0; i++) {
      var s = pool.slots[i];
      if (!s.busy && s.crashes < MAX_CRASHES) {
        drainOne(pool, s);
      }
    }
    while (pool.queue.length > 0 && pool.slots.length < MAX_PER_URL) {
      var slot = makeSlot(pool);
      if (!slot) break;
      pool.slots.push(slot);
      drainOne(pool, slot);
    }
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────

  function run(workerUrl, message, transferables) {
    var pool = getPool(workerUrl);

    return new Promise(function (resolve, reject) {
      // Queue overflow guard
      if (pool.queue.length >= MAX_QUEUE) {
        reject(new Error('Worker queue full — too many concurrent tasks'));
        return;
      }

      var task = { message: message, transferables: transferables || [], resolve: resolve, reject: reject };

      // Try to use an existing free, healthy slot
      for (var i = 0; i < pool.slots.length; i++) {
        var s = pool.slots[i];
        if (!s.busy && s.crashes < MAX_CRASHES) {
          dispatch(pool, s, task);
          return;
        }
      }

      // Spawn a new slot if under the per-URL limit
      if (pool.slots.length < MAX_PER_URL) {
        var slot = makeSlot(pool);
        if (slot) {
          pool.slots.push(slot);
          dispatch(pool, slot, task);
          return;
        }
      }

      // All slots busy / at limit → queue
      pool.queue.push(task);
    });
  }

  function getStats() {
    var out = {};
    Object.keys(pools).forEach(function (url) {
      var p = pools[url];
      out[url] = {
        total:      p.slots.length,
        busy:       p.slots.filter(function (s) { return s.busy; }).length,
        queued:     p.queue.length,
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

  // Phase 19A: terminate all workers for a given URL — call after a large OCR batch
  // to immediately reclaim memory rather than waiting for idle TTL.
  function terminatePool(workerUrl) {
    var pool = pools[workerUrl];
    if (!pool) return;
    // Clear idle timers and terminate every slot
    pool.slots.forEach(function (slot) {
      if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
      if (slot.timer)     { clearTimeout(slot.timer);     slot.timer     = null; }
      try { slot.worker.terminate(); } catch (_) {}
      // Reject any in-flight task so callers don't hang
      if (slot.busy && slot.reject) {
        slot.reject(new Error('pool_terminated'));
        slot.busy = false; slot.resolve = null; slot.reject = null;
      }
    });
    pool.slots = [];
    // Drain remaining queue — reject all pending tasks
    while (pool.queue.length > 0) {
      var task = pool.queue.shift();
      task.reject(new Error('pool_terminated'));
    }
    delete pools[workerUrl];
  }

  window.WorkerPool = {
    run:           run,
    getStats:      getStats,
    prewarm:       prewarm,
    terminatePool: terminatePool,   // Phase 19A
    MAX_WORKERS:   MAX_PER_URL,
  };
}());
