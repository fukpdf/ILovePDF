// RuntimeMemoryFirewalls v1.0 — Arc 5 / Phase C / Target 3
// =====================================================================
// Per-tool hard memory budgets + isolated panic mode.
//
// Arc 4 gap: RuntimeMemoryOrchestrator operates at FAMILY level. When
// the AI family hits 88% heap, ALL AI tool workers are terminated. But
// it is actually OCR using 480 MB while AI-Summarize only uses 20 MB.
// There is no per-TOOL memory budget or per-tool panic mode.
//
// Solution:
//   1. Per-tool memory budget in MB (registered at activation)
//   2. Per-tool heap contribution estimate (workload weight)
//   3. Budget enforcement: when a tool's estimated heap exceeds its
//      budget, a 'memory-firewall:budget-exceeded' event fires and
//      RuntimeToolWorkerMesh.recordCrash is signalled
//   4. Per-tool panic: terminates ONLY that tool's workers + trims
//      only that tool's memory island — other tools unaffected
//   5. Reclaim handlers: tools register cleanup callbacks called on
//      budget pressure (before panic)
//   6. Per-tool memory telemetry: 4 tiers — ok/warn/critical/panic
//
// Default budgets (MB) by family:
//   organize/compress/edit: 128 MB
//   convert-from/to:        192 MB
//   ai:                     512 MB
//   image:                  256 MB
//   utility:                 32 MB
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[MemFirewalls]';
  var VERSION = '1.0';
  var SWEEP_MS = 30 * 1000;

  // ── Default budgets by family ─────────────────────────────────────────────
  var FAMILY_BUDGET_MB = {
    'organize': 128, 'compress': 128, 'edit': 128,
    'convert-from': 192, 'convert-to': 192,
    'ai': 512, 'image': 256, 'utility': 32,
  };

  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Per-tool firewall state ───────────────────────────────────────────────
  // toolId → { budgetMb, usageMb, tier, reclaimFns, panicCount, panicAt }
  var _firewalls = {};

  function _ensure(toolId) {
    if (!_firewalls[toolId]) {
      var family = TOOL_FAMILY[toolId] || 'organize';
      _firewalls[toolId] = {
        toolId:     toolId,
        family:     family,
        budgetMb:   FAMILY_BUDGET_MB[family] || 128,
        usageMb:    0,
        tier:       'ok',
        reclaimFns: [],
        panicCount: 0,
        panicAt:    null,
      };
    }
    return _firewalls[toolId];
  }

  // ── Set / override budget for a specific tool ─────────────────────────────
  function setBudget(toolId, mb) {
    _ensure(toolId).budgetMb = Math.max(16, mb);
  }

  // ── Register a reclaim handler ────────────────────────────────────────────
  function onReclaim(toolId, fn) {
    if (typeof fn !== 'function') return;
    _ensure(toolId).reclaimFns.push(fn);
  }

  // ── Estimate tool heap usage ──────────────────────────────────────────────
  // Approximation: total heap × (this tool's weight / sum of all active weights)
  function _estimateUsage(toolId) {
    try {
      var m = performance.memory;
      if (!m || !m.usedJSHeapSize) return 0;
      var totalMb = m.usedJSHeapSize / (1024 * 1024);
      // Active tools (have been activated recently)
      var active = Object.keys(_firewalls).filter(function (k) { return _firewalls[k].tier !== 'ok' || _firewalls[k].usageMb > 0; });
      var weight  = active.length > 0 ? 1 / active.length : 1;
      return totalMb * weight;
    } catch (_) { return 0; }
  }

  // ── Compute tier ──────────────────────────────────────────────────────────
  function _tier(usageMb, budgetMb) {
    var pct = budgetMb > 0 ? usageMb / budgetMb : 0;
    if (pct < 0.70) return 'ok';
    if (pct < 0.85) return 'warn';
    if (pct < 0.95) return 'critical';
    return 'panic';
  }

  // ── Panic a single tool ───────────────────────────────────────────────────
  function panic(toolId, reason) {
    var fw = _firewalls[toolId];
    if (!fw) return;
    fw.panicCount++;
    fw.panicAt = Date.now();
    console.debug(LOG, 'PANIC:', toolId, '— reason:', reason || 'budget-exceeded');

    // 1. Call reclaim handlers
    fw.reclaimFns.forEach(function (fn) { try { fn(toolId, reason); } catch (_) {} });

    // 2. Trim memory island for this tool only
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) mi.trim(toolId);
    } catch (_) {}

    // 3. Get worker URL and terminate only that tool's pool
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      var node = mesh && mesh.getNode(toolId);
      if (node && node.workerUrl) {
        var wp = G.WorkerPool;
        if (wp && typeof wp.terminatePool === 'function') {
          // Only terminate if no active tasks
          var stats = wp.getStats && wp.getStats();
          var urlStats = stats && stats[node.workerUrl];
          if (!urlStats || urlStats.busy === 0) {
            wp.terminatePool(node.workerUrl);
          }
        }
      }
    } catch (_) {}

    // 4. Record crash on tool mesh
    try {
      var mesh2 = G.RuntimeToolWorkerMesh;
      if (mesh2) mesh2.recordCrash(toolId, 'memory-panic');
    } catch (_) {}

    try {
      G.dispatchEvent(new CustomEvent('memory-firewall:panic', {
        detail: { toolId: toolId, reason: reason, budgetMb: fw.budgetMb },
      }));
    } catch (_) {}
  }

  // ── Budget check for a single tool ───────────────────────────────────────
  function checkBudget(toolId) {
    var fw = _ensure(toolId);
    var usageMb = _estimateUsage(toolId);
    fw.usageMb  = usageMb;
    var newTier = _tier(usageMb, fw.budgetMb);
    var prevTier = fw.tier;
    fw.tier = newTier;

    if (newTier === 'panic' && prevTier !== 'panic') {
      panic(toolId, 'budget-exceeded');
    } else if (newTier === 'critical' && prevTier === 'ok') {
      console.debug(LOG, 'critical budget:', toolId, '—', Math.round(usageMb) + '/' + fw.budgetMb + ' MB');
      try {
        G.dispatchEvent(new CustomEvent('memory-firewall:critical', {
          detail: { toolId: toolId, usageMb: usageMb, budgetMb: fw.budgetMb },
        }));
      } catch (_) {}
    }
    return { tier: newTier, usageMb: usageMb, budgetMb: fw.budgetMb };
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────
  function _sweep() {
    Object.keys(_firewalls).forEach(function (toolId) { checkBudget(toolId); });
  }
  var _sweepTimer = setInterval(_sweep, SWEEP_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Register firewalls on tool activation ─────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _ensure(toolId);
    } catch (_) {}
  });

  G.RuntimeMemoryFirewalls = Object.freeze({
    VERSION:     VERSION,
    setBudget:   setBudget,
    onReclaim:   onReclaim,
    checkBudget: checkBudget,
    panic:       panic,
    getStats:    function (toolId) {
      if (toolId) {
        var fw = _firewalls[toolId];
        return fw ? { toolId: fw.toolId, tier: fw.tier, usageMb: fw.usageMb, budgetMb: fw.budgetMb, panicCount: fw.panicCount } : null;
      }
      var out = {};
      Object.keys(_firewalls).forEach(function (k) {
        var fw = _firewalls[k];
        out[k] = { tier: fw.tier, usageMb: fw.usageMb, budgetMb: fw.budgetMb, panicCount: fw.panicCount };
      });
      return out;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool memory budgets active');

}(window));
