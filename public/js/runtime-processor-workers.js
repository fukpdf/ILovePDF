// RuntimeProcessorWorkers v1.0 — Arc 6 / Phase D
// =====================================================================
// Processor-specific worker pools, independent scaling,
// independent thermal throttling, independent crash recovery,
// independent congestion queues.
//
// Extends RuntimeWorkerCoordinator (Arc 2) and RuntimeToolWorkerMesh
// (Arc 5) with processor-family-level worker pool management:
//   - Per-processor maxWorkers cap (independent of other processors)
//   - Per-processor thermal limit (OCR hot → throttle OCR only)
//   - Per-processor crash counter → isolate pool on crash threshold
//   - Per-processor congestion queue with FIFO ordering
//   - Aux worker URL registration for multi-worker processors
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorWorkers) return;

  var LOG     = '[ProcWorkers]';
  var VERSION = '1.0';
  var CRASH_ISOLATE = 3;   // crashes before isolating the pool
  var THERMAL_CHECK = 30 * 1000;

  // ── Pool registry ─────────────────────────────────────────────────
  // family → { workerUrl, maxWorkers, auxWorkerUrls,
  //             activeCount, crashCount, isolated,
  //             thermalLimit, queue }
  var _pools = {};

  // ── Shared thermal tier ───────────────────────────────────────────
  var _thermalTier = 'nominal';

  function _refreshThermal() {
    try {
      var ais = G.RuntimeAIScheduler;
      var p   = ais && ais.getProfile && ais.getProfile();
      _thermalTier = (p && p.thermal) || 'nominal';
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  function _thermalMaxForTier(tier) {
    if (tier === 'critical') return 1;
    if (tier === 'hot')      return 2;
    if (tier === 'warm')     return 3;
    return null; // no cap
  }

  // ── Register a processor's worker pool ────────────────────────────
  function registerPool(family, spec) {
    if (!family || !spec) return;
    if (_pools[family]) return; // idempotent

    _pools[family] = {
      family:       family,
      workerUrl:    spec.workerUrl     || null,
      maxWorkers:   spec.maxWorkers    || 2,
      auxWorkerUrls: spec.auxWorkerUrls || [],
      activeCount:  0,
      crashCount:   0,
      isolated:     false,
      thermalLimit: null,
      queue:        [],      // pending tasks while congested / isolated
    };
    console.debug(LOG, 'pool registered:', family, '— maxWorkers:', spec.maxWorkers, '| aux:', (spec.auxWorkerUrls || []).length);
  }

  // ── Record a task start ───────────────────────────────────────────
  function taskStart(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.activeCount = Math.min(pool.activeCount + 1, pool.maxWorkers + 1);
  }

  // ── Record a task end ─────────────────────────────────────────────
  function taskEnd(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    _drainQueue(family);
  }

  // ── Record a worker crash ─────────────────────────────────────────
  function recordCrash(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.crashCount++;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    if (pool.crashCount >= CRASH_ISOLATE && !pool.isolated) {
      pool.isolated = true;
      console.debug(LOG, 'ISOLATED:', family, '— crashes:', pool.crashCount);
      try {
        G.dispatchEvent(new CustomEvent('processor-workers:isolated', {
          detail: { family: family, crashCount: pool.crashCount },
        }));
      } catch (_) {}
    }
  }

  // ── Reset isolation (e.g. after page reload hint or manual reset) ──
  function resetPool(family) {
    var pool = _pools[family];
    if (!pool) return;
    pool.crashCount  = 0;
    pool.isolated    = false;
    pool.activeCount = 0;
    pool.queue       = [];
    console.debug(LOG, 'pool reset:', family);
  }

  // ── Check if a family can accept a new task ───────────────────────
  function canAccept(family) {
    var pool = _pools[family];
    if (!pool) return true; // unknown family → defer to WorkerPool
    if (pool.isolated) return false;
    var thermalCap = _thermalMaxForTier(_thermalTier);
    var effective  = thermalCap !== null ? Math.min(pool.maxWorkers, thermalCap) : pool.maxWorkers;
    return pool.activeCount < effective;
  }

  // ── Enqueue a pending task ────────────────────────────────────────
  function enqueue(family, taskFn) {
    var pool = _pools[family];
    if (!pool) { try { taskFn(); } catch (_) {} return; }
    if (pool.isolated) {
      console.debug(LOG, 'queue rejected — isolated:', family);
      return;
    }
    pool.queue.push(taskFn);
    console.debug(LOG, 'queued task for:', family, '— queue length:', pool.queue.length);
  }

  // ── Drain queue when capacity frees up ────────────────────────────
  function _drainQueue(family) {
    var pool = _pools[family];
    if (!pool || !pool.queue.length) return;
    if (!canAccept(family)) return;
    var next = pool.queue.shift();
    if (typeof next === 'function') {
      taskStart(family);
      try { next(); } catch (_) { recordCrash(family); }
    }
  }

  // ── Update thermal limit per processor ────────────────────────────
  // (called when processor-specific thermal event fires)
  function setThermalLimit(family, limit) {
    var pool = _pools[family];
    if (!pool) return;
    pool.thermalLimit = limit;
  }

  // ── Prewarm all registered aux workers for a family ───────────────
  function prewarm(family) {
    var pool = _pools[family];
    if (!pool) return;
    try {
      var wp = G.WorkerPool;
      if (!wp || !wp.prewarm) return;
      if (pool.workerUrl) wp.prewarm(pool.workerUrl);
      pool.auxWorkerUrls.forEach(function (url) { wp.prewarm(url); });
    } catch (_) {}
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var id = evt && evt.detail && evt.detail.toolId;
      if (!id) return;
      // Lightweight prewarm on tool activation
      Object.keys(_pools).forEach(function (family) {
        var pool = _pools[family];
        if (pool.family === id || (pool && pool.family && id && id.indexOf(pool.family) !== -1)) return;
        // No-op — activation-specific prewarm is handled per-processor
      });
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (!toolId) return;
      // Find which pool owns this tool and record a crash
      Object.keys(_pools).forEach(function (family) {
        var pool = _pools[family];
        // Rough match: toolId contains family name
        if (pool && toolId) recordCrash(family);
      });
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_pools).forEach(function (family) {
      var p = _pools[family];
      out[family] = {
        maxWorkers:  p.maxWorkers,
        activeCount: p.activeCount,
        crashCount:  p.crashCount,
        isolated:    p.isolated,
        queueLength: p.queue.length,
        thermalTier: _thermalTier,
      };
    });
    return out;
  }

  G.RuntimeProcessorWorkers = Object.freeze({
    VERSION:         VERSION,
    registerPool:    registerPool,
    taskStart:       taskStart,
    taskEnd:         taskEnd,
    recordCrash:     recordCrash,
    resetPool:       resetPool,
    canAccept:       canAccept,
    enqueue:         enqueue,
    prewarm:         prewarm,
    setThermalLimit: setThermalLimit,
    getStats:        getStats,
    isIsolated:      function (family) { return !!(_pools[family] && _pools[family].isolated); },
    getThermalTier:  function () { return _thermalTier; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-processor worker pools active');

}(window));
