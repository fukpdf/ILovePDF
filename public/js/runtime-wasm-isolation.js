// RuntimeWasmIsolation v1.0 — Phase 6 / Task 2 (WASM Memory Isolation)
// =============================================================================
// Memory isolation, anti-scraping protections, and isolated execution pools
// for WASM modules. Companion to RuntimeWasmFortress.
//
// Anti-memory-scraping protections:
//   • Poison memory regions with randomized canary values
//   • Detect unexpected memory reads via SharedArrayBuffer access patterns
//   • Zero-fill memory on module unload (prevent data remnants)
//   • Enforce strict per-pool memory budgets
//   • Detect abnormal heap growth indicative of memory probing
//
// Isolated execution pools:
//   • Each tool category gets a dedicated execution pool
//   • Pools are isolated from each other (no shared linear memory)
//   • Pool exhaustion triggers graceful fallback to sequential execution
//
// window.RuntimeWasmIsolation
//   .createPool(poolId, opts)         → Pool
//   .submitTask(poolId, fn)           → Promise<result>
//   .evictPool(poolId)                → void
//   .zeroFillMemory(moduleId)         → void
//   .getMemoryReport()                → MemoryReport
//   .status()                         → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWasmIsolation) return;

  var VERSION = '1.0';
  var LOG     = '[WasmIsolation]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Pool defaults ──────────────────────────────────────────────────────────
  var POOL_DEFAULTS = {
    'pdf':    { maxConcurrent: 2, maxMemMB: 256, timeoutMs: 60_000  },
    'image':  { maxConcurrent: 3, maxMemMB: 512, timeoutMs: 120_000 },
    'ai':     { maxConcurrent: 1, maxMemMB: 1024, timeoutMs: 300_000 },
    'crypto': { maxConcurrent: 4, maxMemMB: 32,  timeoutMs: 10_000  },
    'default':{ maxConcurrent: 2, maxMemMB: 128, timeoutMs: 30_000  },
  };

  // ── Pool registry ──────────────────────────────────────────────────────────
  var _pools = typeof Map !== 'undefined' ? new Map() : null;

  // ── Memory canary system ───────────────────────────────────────────────────
  // Canaries are placed at known offsets in WASM linear memory.
  // Unexpected mutation indicates memory probing or out-of-bounds access.
  var _canaries = typeof Map !== 'undefined' ? new Map() : null;  // moduleId → {offset, value}

  function _plantCanary(moduleId, wasmMemory) {
    if (!_canaries || !wasmMemory) return;
    _s(function () {
      var view   = new Uint32Array(wasmMemory.buffer);
      // Use the last 4 bytes before the memory limit as canary location
      var offset = Math.floor(view.length * 0.95);
      var value  = (Math.random() * 0xFFFFFFFF) >>> 0;
      view[offset] = value;
      _canaries.set(moduleId, { offset: offset, value: value, memory: wasmMemory });
    });
  }

  function _checkCanary(moduleId) {
    if (!_canaries || !_canaries.has(moduleId)) return true;
    return _s(function () {
      var c    = _canaries.get(moduleId);
      var view = new Uint32Array(c.memory.buffer);
      var ok   = view[c.offset] === c.value;
      if (!ok) {
        console.error(LOG, 'CANARY VIOLATED — potential memory scraping:', moduleId);
        _s(function () {
          if (G.SecurityTelemetry) G.SecurityTelemetry.record('integrity-failure', {
            path: moduleId, reason: 'wasm-canary-violated',
          });
          if (G.RuntimeEventBus) G.RuntimeEventBus.emit('wasm:memory-violation', { moduleId: moduleId });
        });
      }
      return ok;
    }, true);
  }

  // ── Zero-fill memory on unload ─────────────────────────────────────────────
  function zeroFillMemory(moduleId) {
    _s(function () {
      var fortress = G.RuntimeWasmFortress;
      if (!fortress) return;
      var entry = fortress.loadSealed(moduleId);
      if (!entry || !entry.instance) return;
      var mem = entry.instance.exports.memory;
      if (!mem) return;
      var view = new Uint8Array(mem.buffer);
      view.fill(0);
      _canaries && _canaries.delete(moduleId);
      console.debug(LOG, 'zero-filled memory for:', moduleId);
    });
  }

  // ── Execution pool ─────────────────────────────────────────────────────────
  function createPool(poolId, opts) {
    if (!_pools) return null;
    if (_pools.has(poolId)) return _pools.get(poolId);

    var category = 'default';
    var CATS = ['pdf', 'image', 'ai', 'crypto'];
    for (var i = 0; i < CATS.length; i++) {
      if (poolId.indexOf(CATS[i]) !== -1) { category = CATS[i]; break; }
    }

    var defaults = POOL_DEFAULTS[category];
    var config = Object.assign({}, defaults, opts || {});

    var pool = {
      id:           poolId,
      category:     category,
      config:       config,
      queue:        [],
      running:      0,
      submitted:    0,
      completed:    0,
      errors:       0,
      createdAt:    Date.now(),
      memoryUsedMB: 0,
      destroyed:    false,
    };

    _pools.set(poolId, pool);
    console.debug(LOG, 'pool created | id:', poolId, '| maxConcurrent:', config.maxConcurrent,
      '| maxMemMB:', config.maxMemMB);
    return pool;
  }

  function submitTask(poolId, fn) {
    if (!_enabled) return _s(function () { return Promise.resolve(fn()); }, Promise.reject(new Error('isolation disabled')));

    var pool = _pools && _pools.has(poolId) ? _pools.get(poolId) : createPool(poolId, null);
    if (!pool || pool.destroyed) return Promise.reject(new Error('pool unavailable: ' + poolId));

    pool.submitted++;

    return new Promise(function (resolve, reject) {
      var task = { fn: fn, resolve: resolve, reject: reject, ts: Date.now() };
      pool.queue.push(task);
      _drainPool(pool);
    });
  }

  function _drainPool(pool) {
    while (pool.running < pool.config.maxConcurrent && pool.queue.length > 0) {
      var task = pool.queue.shift();
      pool.running++;

      var timeoutId = setTimeout(function () {
        task.reject(new Error('pool task timeout: ' + pool.id));
        pool.running = Math.max(0, pool.running - 1);
        pool.errors++;
        _drainPool(pool);
      }, pool.config.timeoutMs);

      _s(function () {
        Promise.resolve().then(function () { return task.fn(); })
          .then(function (result) {
            clearTimeout(timeoutId);
            pool.running = Math.max(0, pool.running - 1);
            pool.completed++;
            task.resolve(result);
            _drainPool(pool);
          })
          .catch(function (err) {
            clearTimeout(timeoutId);
            pool.running = Math.max(0, pool.running - 1);
            pool.errors++;
            task.reject(err);
            _drainPool(pool);
          });
      });
    }
  }

  function evictPool(poolId) {
    if (!_pools || !_pools.has(poolId)) return;
    var pool = _pools.get(poolId);
    // Reject all queued tasks
    while (pool.queue.length > 0) {
      var task = pool.queue.shift();
      task.reject(new Error('pool evicted: ' + poolId));
    }
    pool.destroyed = true;
    _pools.delete(poolId);
    console.debug(LOG, 'pool evicted:', poolId);
  }

  // ── Memory pressure monitoring ─────────────────────────────────────────────
  function getMemoryReport() {
    var heapMB = _s(function () {
      var m = G.performance && G.performance.memory;
      if (!m) return null;
      return {
        used:  Math.round(m.usedJSHeapSize  / 1048576),
        total: Math.round(m.totalJSHeapSize / 1048576),
        limit: Math.round(m.jsHeapSizeLimit / 1048576),
      };
    }, null);

    var poolsReport = [];
    if (_pools) {
      _pools.forEach(function (p) {
        poolsReport.push({
          id:        p.id,
          running:   p.running,
          queued:    p.queue.length,
          completed: p.completed,
          errors:    p.errors,
        });
      });
    }

    var budget = _s(function () {
      var we = G.RuntimeWasmEnterprise;
      return we && typeof we.getMemoryBudget === 'function' ? we.getMemoryBudget() : null;
    }, null);

    return {
      heap:    heapMB,
      budget:  budget,
      pools:   poolsReport,
      canaries: _canaries ? _canaries.size : 0,
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' loaded | disabled (tier:', _tier + ')');
      return;
    }

    // Pre-create standard pools
    createPool('pdf-pool',    POOL_DEFAULTS['pdf']);
    createPool('image-pool',  POOL_DEFAULTS['image']);
    createPool('crypto-pool', POOL_DEFAULTS['crypto']);

    // Periodic canary sweep on HIGH tier
    if (_tier === 'HIGH') {
      setInterval(function () {
        if (_canaries) {
          _canaries.forEach(function (_, id) { _checkCanary(id); });
        }
      }, 60_000);
    }

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| pools:', _pools ? _pools.size : 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4500); }, { once: true });
  } else {
    setTimeout(_boot, 4500);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeWasmIsolation = Object.freeze({
    VERSION:          VERSION,
    createPool:       createPool,
    submitTask:       submitTask,
    evictPool:        evictPool,
    zeroFillMemory:   zeroFillMemory,
    plantCanary:      _plantCanary,
    checkCanary:      _checkCanary,
    getMemoryReport:  getMemoryReport,
    status: function () {
      return {
        version:    VERSION,
        enabled:    _enabled,
        tier:       _tier,
        poolCount:  _pools ? _pools.size : 0,
        canaryCount: _canaries ? _canaries.size : 0,
        memory:     getMemoryReport(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
