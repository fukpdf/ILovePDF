// RuntimeResourceOrchestrator v1.0 — Arc 15 / Phase E
// =============================================================================
// Runtime resource budget management and pressure scoring.
//
// Budgets managed:
//   cpu     — estimated CPU cycle budget (arbitrary units, baseline 100)
//   memory  — JS heap budget (MB)
//   workers — max concurrent worker threads
//   storage — estimated storage budget (MB)
//
// Pressure scores: 0 (free) → 100 (critical)
//
// Events dispatched:
//   arc15:resource-pressure   — { resource, score, level, ts }
//   arc15:resource-allocated  — { resource, amount, owner, ts }
//   arc15:resource-released   — { resource, amount, owner, ts }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeResourceOrchestrator) return;

  var LOG = '[Arc15:ResourceOrchestrator]';
  var VERSION = '1.1';

  var BUDGETS = {
    cpu:     { total: 100, allocated: 0, unit: 'units' },
    memory:  { total: 512, allocated: 0, unit: 'MB'    },
    workers: { total: 8,   allocated: 0, unit: 'threads'},
    storage: { total: 256, allocated: 0, unit: 'MB'    },
  };

  var _allocations = {};   // owner → { cpu, memory, workers, storage }
  var _pressureLog = [];   // last 500 pressure readings
  var MAX_LOG = 500;
  var _metrics = { allocations: 0, releases: 0, pressureEvents: 0, overflows: 0, invalidRequests: 0 };

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Budget management ─────────────────────────────────────────────────────
  function allocate(resource, amount, owner) {
    var b = BUDGETS[resource];
    if (!b) return { ok: false, reason: 'Unknown resource: ' + resource };
    if (!owner || typeof owner !== 'string' || !isFinite(amount) || amount <= 0) {
      _metrics.invalidRequests++;
      return { ok: false, reason: 'Invalid allocation request' };
    }
    if (b.allocated + amount > b.total) {
      _metrics.overflows++;
      return { ok: false, reason: resource + ' budget exceeded (' + (b.allocated + amount) + '/' + b.total + ')' };
    }
    b.allocated += amount;
    if (!_allocations[owner]) _allocations[owner] = {};
    _allocations[owner][resource] = (_allocations[owner][resource] || 0) + amount;
    _metrics.allocations++;
    _dispatch('arc15:resource-allocated', { resource: resource, amount: amount, owner: owner, ts: Date.now() });
    return { ok: true, available: b.total - b.allocated };
  }

  function release(resource, amount, owner) {
    var b = BUDGETS[resource];
    if (!b) return { ok: false, reason: 'Unknown resource: ' + resource };
    if (!owner || typeof owner !== 'string' || !isFinite(amount) || amount <= 0) {
      _metrics.invalidRequests++;
      return { ok: false, reason: 'Invalid release request' };
    }
    var ownerAlloc = _allocations[owner] && (_allocations[owner][resource] || 0);
    if (ownerAlloc <= 0) return { ok: false, released: 0, reason: 'Owner has no allocation' };
    var released = Math.min(amount, ownerAlloc);
    b.allocated = Math.max(0, b.allocated - released);
    _allocations[owner][resource] = ownerAlloc - released;
    _metrics.releases++;
    _dispatch('arc15:resource-released', { resource: resource, amount: released, owner: owner, ts: Date.now() });
    return { ok: true, released: released };
  }

  function releaseAll(owner) {
    if (!owner || typeof owner !== 'string') return { ok: false, reason: 'Invalid owner' };
    var alloc = _allocations[owner];
    if (!alloc) return { ok: true, released: 0 };
    Object.keys(alloc).forEach(function (resource) {
      if (alloc[resource] > 0) release(resource, alloc[resource], owner);
    });
    delete _allocations[owner];
    return { ok: true, released: 1 };
  }

  // ── Pressure scoring ──────────────────────────────────────────────────────
  function _livePressure() {
    var scores = {};

    // Memory: live from performance.memory if available
    try {
      if (G.performance && G.performance.memory) {
        var mem = G.performance.memory;
        scores.memory = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
      }
    } catch (_) {}

    // Workers: from RuntimeFleetManager state
    try {
      var fm = G.RuntimeFleetManager;
      if (fm && fm.getState) {
        var state  = fm.getState();
        var paused = Object.values(state).filter(function (s) { return s.paused; }).length;
        scores.workers = Math.min(100, paused * 20);
      }
    } catch (_) {}

    // CPU/Storage: from budget allocations
    Object.keys(BUDGETS).forEach(function (r) {
      if (scores[r] == null) {
        var b = BUDGETS[r];
        scores[r] = b.total > 0 ? Math.round((b.allocated / b.total) * 100) : 0;
      }
    });

    return scores;
  }

  function getPressure() {
    var scores  = _livePressure();
    var overall = Math.round(Object.values(scores).reduce(function (s, v) { return s + v; }, 0) / Object.keys(scores).length);
    var level   = overall >= 80 ? 'CRITICAL' : overall >= 60 ? 'HIGH' : overall >= 40 ? 'MODERATE' : 'LOW';

    if (overall >= 60) {
      _metrics.pressureEvents++;
      var rec = { ts: Date.now(), scores: scores, overall: overall, level: level };
      _pressureLog.unshift(rec);
      if (_pressureLog.length > MAX_LOG) _pressureLog.pop();
      _dispatch('arc15:resource-pressure', { resource: 'all', score: overall, level: level, ts: Date.now() });
    }

    return { scores: scores, overall: overall, level: level };
  }

  function getBudgets() {
    var out = {};
    Object.keys(BUDGETS).forEach(function (r) {
      var b = BUDGETS[r];
      out[r] = {
        total: b.total, allocated: b.allocated, free: b.total - b.allocated,
        pct: Math.round((b.allocated / b.total) * 100), unit: b.unit,
      };
    });
    return out;
  }

  function getAllocations() { return JSON.parse(JSON.stringify(_allocations)); }
  function getPressureLog(n) {
    var limit = Number.isFinite(Number(n)) && Number(n) > 0 ? Math.min(500, Math.floor(Number(n))) : 20;
    return _pressureLog.slice(0, limit);
  }
  function getMetrics()    { return Object.assign({}, _metrics); }

  // Periodic pressure snapshot (every 60 s)
  setInterval(function () { try { getPressure(); } catch (_) {} }, 60 * 1000);

  G.RuntimeResourceOrchestrator = Object.freeze({
    allocate:       allocate,
    release:        release,
    releaseAll:     releaseAll,
    getPressure:    getPressure,
    getBudgets:     getBudgets,
    getAllocations:  getAllocations,
    getPressureLog: getPressureLog,
    getMetrics:     getMetrics,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — budgets:', Object.keys(BUDGETS).join(', '));
}(window));
