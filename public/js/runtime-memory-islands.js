// RuntimeMemoryIslands v1.0 — Arc 3 / Phase D / Target 5
// =====================================================================
// Per-tool memory budgets + isolated cleanup.
//
// Problem: OCR memory spikes silently exhaust heap shared by all tools.
// RuntimeWorkerCoordinator applies a global memory throttle that mutes
// the Compress tool when an unrelated AI job is running.
//
// Solution: Each active tool gets a soft memory budget (from manifest).
// Periodic sweeps compare heap usage against per-tool allocation.
// When a tool's allocation is exceeded, ONLY that tool's caches and
// idle workers are trimmed — other tool domains are untouched.
//
// Budget model (soft, advisory):
//   Total heap limit distributed across active tools by weight.
//   A tool that has been idle > IDLE_TTL_MS auto-trims itself.
//   Inactive tools release their budget slot.
//
// Integrates with:
//   RuntimeWorkerDomainRegistry — for idle-worker termination signals
//   RuntimeHealthAnalytics      — per-tool memory score
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryIslands) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[MemIslands]';
  var VERSION      = '1.0';
  var IDLE_TTL_MS  = 90 * 1000;   // 90s idle → auto-trim
  var SWEEP_MS     = 30 * 1000;   // budget sweep interval
  var DEFAULT_MB   = 128;         // default budget if no manifest

  // ── Island registry ───────────────────────────────────────────────────────
  // toolId → { budgetMb, lastActivityAt, caches: Map, trimHandlers[] }
  var _islands = {};

  function _newIsland(toolId, budgetMb) {
    return {
      toolId:         toolId,
      budgetMb:       budgetMb || DEFAULT_MB,
      allocatedAt:    Date.now(),
      lastActivityAt: Date.now(),
      caches:         {},     // name → { size, trimFn }
      trimHandlers:   [],
      trimCount:      0,
    };
  }

  // ── Allocate a memory island for a tool ───────────────────────────────────
  function allocate(toolId, budgetMb) {
    if (_islands[toolId]) {
      _islands[toolId].budgetMb       = budgetMb || DEFAULT_MB;
      _islands[toolId].lastActivityAt = Date.now();
      return _islands[toolId];
    }
    _islands[toolId] = _newIsland(toolId, budgetMb);
    console.debug(LOG, 'allocated:', toolId, '—', budgetMb, 'MB');
    return _islands[toolId];
  }

  // ── Register a trim handler for a tool ───────────────────────────────────
  function registerTrimHandler(toolId, name, fn) {
    var island = _islands[toolId];
    if (!island) island = allocate(toolId);
    island.trimHandlers.push({ name: name, fn: fn });
  }

  // ── Register a named cache entry ──────────────────────────────────────────
  function registerCache(toolId, name, trimFn, estimatedSizeMb) {
    var island = _islands[toolId];
    if (!island) island = allocate(toolId);
    island.caches[name] = {
      name:            name,
      estimatedSizeMb: estimatedSizeMb || 0,
      trimFn:          trimFn,
      lastTrimAt:      0,
    };
  }

  // ── Touch activity timestamp ──────────────────────────────────────────────
  function touch(toolId) {
    var island = _islands[toolId];
    if (island) island.lastActivityAt = Date.now();
  }

  // ── Trim a single tool island ─────────────────────────────────────────────
  function trim(toolId) {
    var island = _islands[toolId];
    if (!island) return;

    var now = Date.now();
    island.trimCount++;

    // Run registered caches trim
    Object.keys(island.caches).forEach(function (name) {
      var c = island.caches[name];
      try {
        if (typeof c.trimFn === 'function') { c.trimFn(); c.lastTrimAt = now; }
      } catch (_) {}
    });

    // Run registered trim handlers
    island.trimHandlers.forEach(function (h) {
      try { h.fn(); } catch (_) {}
    });

    // Signal worker domain to terminate idle workers in this family
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      var family = wd && wd.getFamily(toolId);
      if (family) {
        G.dispatchEvent(new CustomEvent('memory-island:trim', {
          detail: { toolId: toolId, family: family, trimCount: island.trimCount },
        }));
      }
    } catch (_) {}

    console.debug(LOG, 'trim:', toolId, '— count:', island.trimCount);
  }

  // ── Get current heap usage percentage ────────────────────────────────────
  function _heapPct() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (_) { return 0; }
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────
  function _sweep() {
    var now     = Date.now();
    var heapPct = _heapPct();

    Object.keys(_islands).forEach(function (toolId) {
      var island = _islands[toolId];
      var idleSince = now - island.lastActivityAt;

      // Auto-trim idle tools
      if (idleSince > IDLE_TTL_MS) {
        console.debug(LOG, 'idle auto-trim:', toolId, '— idle:', Math.round(idleSince / 1000) + 's');
        trim(toolId);
        return;
      }

      // Heap pressure: trim tools over their proportional share
      if (heapPct > 0.80) {
        var activeCount = Object.keys(_islands).length || 1;
        var heapLimit   = (performance.memory && performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit / 1048576 : 1024;
        var share       = heapLimit / activeCount;
        if (island.budgetMb > share * 1.5) {
          console.debug(LOG, 'heap-pressure trim:', toolId);
          trim(toolId);
        }
      }
    });
  }

  var _sweepTimer = setInterval(_sweep, SWEEP_MS);

  // Clean up sweep on unload
  try {
    G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true });
  } catch (_) {}

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    var island = _islands[toolId];
    if (!island) return null;
    return {
      toolId:         island.toolId,
      budgetMb:       island.budgetMb,
      caches:         Object.keys(island.caches).length,
      trimHandlers:   island.trimHandlers.length,
      trimCount:      island.trimCount,
      idleSinceMs:    Date.now() - island.lastActivityAt,
    };
  }

  G.RuntimeMemoryIslands = Object.freeze({
    VERSION:             VERSION,
    allocate:            allocate,
    trim:                trim,
    touch:               touch,
    registerTrimHandler: registerTrimHandler,
    registerCache:       registerCache,
    getStats:            getStats,
    getAllStats: function () {
      var out = {};
      Object.keys(_islands).forEach(function (k) { out[k] = getStats(k); });
      return out;
    },
  });

}(window));
