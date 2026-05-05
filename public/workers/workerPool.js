// Worker Pool v3.0 — persistent workers, smart queue, auto-restart on crash.
// Phase 1: Workers are REUSED across tasks — no spawn/terminate overhead.
// Phase 4: SharedArrayBuffer zero-copy transfer when COOP+COEP headers are active.
(function () {
  'use strict';

  var MAX_PER_URL  = Math.min(navigator.hardwareConcurrency || 4, 8);
  var TIMEOUT_MS   = 120000; // 2-minute hard cap per task
  var MAX_CRASHES  = 3;      // auto-restart limit before slot is retired

  // Detect SAB support (requires COOP + COEP headers)
  var HAS_SAB = (function () {
    try { return typeof SharedArrayBuffer !== 'undefined' && !!new SharedArrayBuffer(1); }
    catch (_) { return false; }
  }());

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
      // Auto-restart within crash limit — pool entry stays valid
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
    var slot = { worker: w, busy: false, crashes: 0, timer: null, resolve: null, reject: null };
    attachHandlers(pool, slot);
    return slot;
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

    // Immediately serve next queued task on this now-free worker
    drainOne(pool, slot);
  }

  function dispatch(pool, slot, task) {
    slot.busy    = true;
    slot.resolve = task.resolve;
    slot.reject  = task.reject;

    slot.timer = setTimeout(function () {
      settle(pool, slot, new Error('Worker task timed out after ' + (TIMEOUT_MS / 1000) + 's'), null);
      // Restart worker after timeout — it may be in an unrecoverable state
      var w = spawnWorker(pool.url);
      if (w) {
        try { slot.worker.terminate(); } catch (_) {}
        slot.worker = w;
        attachHandlers(pool, slot);
      }
    }, TIMEOUT_MS);

    if (!slot.worker || slot.crashes >= MAX_CRASHES) {
      settle(pool, slot, new Error('Worker unavailable — crash limit reached'), null);
      return;
    }

    var msg = task.message;
    var xfr = task.transferables || [];

    // Phase 4: If SAB available and transferables contain large ArrayBuffers,
    // wrap them in a SharedArrayBuffer so both sides share the same memory
    // (avoids copy overhead for large payloads when multiple workers need the data).
    if (HAS_SAB && xfr.length > 0) {
      try {
        var sabXfr = [];
        xfr.forEach(function (buf) {
          if (buf instanceof ArrayBuffer && buf.byteLength > 512 * 1024) {
            // Copy into SAB — no re-copy needed on worker side
            var sab = new SharedArrayBuffer(buf.byteLength);
            new Uint8Array(sab).set(new Uint8Array(buf));
            sabXfr.push(sab);
          } else {
            sabXfr.push(buf);
          }
        });
        // Patch message to reference SABs by position
        msg = Object.assign({}, msg, { _sabMode: true, _sabCount: sabXfr.length });
        slot.worker.postMessage(msg, sabXfr.filter(function (b) { return b instanceof ArrayBuffer; }));
        return;
      } catch (_) { /* SAB failed — fall through to standard transfer */ }
    }

    try {
      slot.worker.postMessage(msg, xfr);
    } catch (_) {
      try {
        slot.worker.postMessage(msg); // fallback: structured-clone (no transfer)
      } catch (e2) {
        settle(pool, slot, new Error('postMessage failed: ' + e2.message), null);
      }
    }
  }

  // Give a specific (just-freed) slot the next queued task, if any
  function drainOne(pool, slot) {
    if (pool.queue.length === 0) return;
    if (slot.busy || slot.crashes >= MAX_CRASHES) return;
    var task = pool.queue.shift();
    if (task) dispatch(pool, slot, task);
  }

  // Drain the queue across all free slots
  function drainAll(pool) {
    for (var i = 0; i < pool.slots.length && pool.queue.length > 0; i++) {
      var s = pool.slots[i];
      if (!s.busy && s.crashes < MAX_CRASHES) {
        drainOne(pool, s);
      }
    }
    // Spawn new slots if under limit and queue remains
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
      var task = { message: message, transferables: transferables || [], resolve: resolve, reject: reject };

      // Phase 1: try to use an existing free, healthy slot (no new spawn needed)
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

      // All slots busy / at limit → queue and wait
      pool.queue.push(task);
    });
  }

  function getStats() {
    var out = {};
    Object.keys(pools).forEach(function (url) {
      var p = pools[url];
      out[url] = {
        total:   p.slots.length,
        busy:    p.slots.filter(function (s) { return s.busy; }).length,
        queued:  p.queue.length,
        crashed: p.slots.filter(function (s) { return s.crashes >= MAX_CRASHES; }).length,
      };
    });
    return out;
  }

  // Pre-warm a worker URL (creates one idle slot in advance)
  function prewarm(workerUrl) {
    var pool = getPool(workerUrl);
    if (pool.slots.length === 0) {
      var slot = makeSlot(pool);
      if (slot) pool.slots.push(slot);
    }
  }

  window.WorkerPool = { run: run, getStats: getStats, prewarm: prewarm, MAX_WORKERS: MAX_PER_URL };
}());
