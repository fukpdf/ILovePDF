// RuntimeProcessorMemory v1.0 — Arc 6 / Phase C
// =====================================================================
// Per-processor heap budget, independent memory reclaim, idle trimming,
// processor panic isolation, processor cache accounting.
//
// Extends RuntimeMemoryFirewalls (Arc 5) with:
//   - Processor-level (family) budget tracking vs tool-level
//   - Cross-tool budget aggregation per family
//   - Family-level idle trim: when ALL tools in a family are idle,
//     a reclaim callback fires after idleTrimMs
//   - Panic isolation: family budget exhausted → only that family's
//     workers terminated, not the whole runtime
//   - Cache accounting: track IDB + OPFS usage per processor
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorMemory) return;

  var LOG     = '[ProcMemory]';
  var VERSION = '1.0';
  var SWEEP_MS = 30 * 1000;

  // ── Processor registry ────────────────────────────────────────────
  // family → { budgetMb, tools, reclaimOnIdle, idleTrimMs,
  //             usageMb, tier, reclaimFns, panicCount,
  //             lastActiveAt, idleTimerId, cacheBytes }
  var _procs = {};

  // ── Tier thresholds (% of budget) ─────────────────────────────────
  var TIER_WARN     = 0.60;
  var TIER_CRITICAL = 0.80;
  var TIER_PANIC    = 0.95;

  function _tier(usageMb, budgetMb) {
    var ratio = budgetMb > 0 ? usageMb / budgetMb : 0;
    if (ratio >= TIER_PANIC)    return 'panic';
    if (ratio >= TIER_CRITICAL) return 'critical';
    if (ratio >= TIER_WARN)     return 'warn';
    return 'ok';
  }

  // ── Register a processor's memory segment ─────────────────────────
  function registerProcessor(family, spec) {
    if (!family || !spec) return;
    if (_procs[family]) return; // idempotent

    _procs[family] = {
      family:        family,
      budgetMb:      spec.budgetMb    || 128,
      tools:         spec.tools       || [],
      reclaimOnIdle: spec.reclaimOnIdle !== false,
      idleTrimMs:    spec.idleTrimMs  || (3 * 60 * 1000),
      usageMb:       0,
      tier:          'ok',
      reclaimFns:    [],
      panicCount:    0,
      lastActiveAt:  Date.now(),
      idleTimerId:   null,
      cacheBytes:    0,
    };
    console.debug(LOG, 'registered:', family, '— budget:', spec.budgetMb + 'MB |', (spec.tools || []).length, 'tools');
  }

  // ── Update usage estimate for a processor ─────────────────────────
  function updateUsage(family, usageMb) {
    var p = _procs[family];
    if (!p) return;
    p.usageMb     = usageMb;
    p.lastActiveAt = Date.now();
    var newTier   = _tier(usageMb, p.budgetMb);
    var prevTier  = p.tier;
    p.tier = newTier;

    if (newTier === 'panic' && prevTier !== 'panic') {
      _panic(family);
    } else if (newTier === 'critical' && prevTier === 'ok') {
      _reclaim(family);
    }

    // Reset idle trim timer on activity
    _resetIdleTimer(family);
  }

  // ── Register a reclaim callback ───────────────────────────────────
  function onReclaim(family, fn) {
    var p = _procs[family];
    if (!p || typeof fn !== 'function') return;
    p.reclaimFns.push(fn);
  }

  // ── Reclaim memory for a processor ────────────────────────────────
  function _reclaim(family) {
    var p = _procs[family];
    if (!p) return;
    console.debug(LOG, 'reclaiming:', family, '— tier:', p.tier, '—', p.reclaimFns.length, 'callbacks');
    p.reclaimFns.forEach(function (fn) {
      try { fn({ family: family, tier: p.tier, usageMb: p.usageMb }); } catch (_) {}
    });
    try {
      G.dispatchEvent(new CustomEvent('processor-memory:reclaim', {
        detail: { family: family, tier: p.tier, usageMb: p.usageMb },
      }));
    } catch (_) {}
  }

  // ── Panic: terminate only this processor's workers ────────────────
  function _panic(family) {
    var p = _procs[family];
    if (!p) return;
    p.panicCount++;
    console.debug(LOG, 'PANIC:', family, '— usage:', p.usageMb + 'MB /', p.budgetMb + 'MB | panic#', p.panicCount);

    // Terminate workers for this processor's tools only
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      if (mesh && mesh.evict) {
        p.tools.forEach(function (toolId) { mesh.evict(toolId); });
      }
    } catch (_) {}

    // Run reclaim callbacks
    _reclaim(family);

    // Reset usage — processor will restart on next tool use
    p.usageMb = 0;
    p.tier    = 'ok';

    try {
      G.dispatchEvent(new CustomEvent('processor-memory:panic', {
        detail: { family: family, panicCount: p.panicCount },
      }));
    } catch (_) {}
  }

  // ── Idle trim timer ───────────────────────────────────────────────
  function _resetIdleTimer(family) {
    var p = _procs[family];
    if (!p || !p.reclaimOnIdle) return;
    if (p.idleTimerId) clearTimeout(p.idleTimerId);
    p.idleTimerId = setTimeout(function () {
      if ((Date.now() - p.lastActiveAt) >= p.idleTrimMs) {
        console.debug(LOG, 'idle trim:', family, '— freeing', p.usageMb + 'MB');
        _reclaim(family);
        p.cacheBytes = 0;
        p.usageMb    = 0;
        p.tier       = 'ok';
        try {
          G.dispatchEvent(new CustomEvent('processor-memory:idle-trim', {
            detail: { family: family },
          }));
        } catch (_) {}
      }
    }, p.idleTrimMs);
  }

  // ── Track cache bytes (IDB + OPFS) ────────────────────────────────
  function updateCacheBytes(family, bytes) {
    var p = _procs[family];
    if (!p) return;
    p.cacheBytes = Math.max(0, bytes);
  }

  // ── Periodic sweep: update usage estimates from heap ──────────────
  function _sweep() {
    try {
      var heapUsed = performance && performance.memory && performance.memory.usedJSHeapSize;
      if (!heapUsed) return;
      var heapMb = heapUsed / 1048576;
      // Distribute heap across active processors proportional to their budget
      var active = Object.values(_procs).filter(function (p) { return p.tier !== 'ok' || p.usageMb > 0; });
      if (!active.length) return;
      var totalBudget = active.reduce(function (s, p) { return s + p.budgetMb; }, 0) || 1;
      active.forEach(function (p) {
        var share = heapMb * (p.budgetMb / totalBudget);
        updateUsage(p.family, Math.round(share));
      });
    } catch (_) {}
  }
  setInterval(_sweep, SWEEP_MS);

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_procs).forEach(function (family) {
      var p = _procs[family];
      out[family] = {
        budgetMb:    p.budgetMb,
        usageMb:     p.usageMb,
        cacheBytes:  p.cacheBytes,
        tier:        p.tier,
        panicCount:  p.panicCount,
        lastActiveAt: p.lastActiveAt,
        pct:         p.budgetMb > 0 ? Math.round(p.usageMb / p.budgetMb * 100) : 0,
      };
    });
    return out;
  }

  G.RuntimeProcessorMemory = Object.freeze({
    VERSION:           VERSION,
    registerProcessor: registerProcessor,
    updateUsage:       updateUsage,
    updateCacheBytes:  updateCacheBytes,
    onReclaim:         onReclaim,
    panic:             _panic,
    reclaim:           _reclaim,
    getStats:          getStats,
    getTier:           function (family) { return (_procs[family] || {}).tier || 'ok'; },
    getBudget:         function (family) { return (_procs[family] || {}).budgetMb || 0; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-processor memory segmentation active');

}(window));
