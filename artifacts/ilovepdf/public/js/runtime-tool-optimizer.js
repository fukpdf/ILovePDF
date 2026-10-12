// RuntimeToolOptimizer v1.0 — Arc 12 / Phase H / Enterprise Tool Intelligence Layer
// Tool startup optimization: preload hot tools, unload dormant tools, warm predicted next.
// Integrates: RuntimeAdaptiveBundles, RuntimeAdaptiveAI, RuntimeWorkloadIntelligence,
//             RuntimeToolRegistry, RuntimeToolPredictor, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolOptimizer) return;

  var LOG = '[ToolOptimizer]';

  // ── Classification tiers ──────────────────────────────────────────────────────
  var TIER_HOT     = 'hot';       // top-N by usage; preloaded eagerly
  var TIER_WARM    = 'warm';      // predicted next; warmed on demand
  var TIER_COLD    = 'cold';      // infrequent; loaded on-demand only
  var TIER_DORMANT = 'dormant';   // not used for DORMANT_MS; candidate for advisory unload

  var HOT_TOP_N   = 5;
  var DORMANT_MS  = 30 * 60 * 1000;   // 30 min

  // ── State ─────────────────────────────────────────────────────────────────────
  var _classifications = {};   // toolId → tier
  var _preloaded       = {};   // toolId → true  (advisory preload issued)
  var _metrics = {
    preloaded:    0,
    unloaded:     0,
    warmed:       0,
    classified:   0,
    savingsMs:    0,   // estimated startup savings (startupMs of hot tools * launches)
  };
  var _interval = null;

  // ── Classify a tool ───────────────────────────────────────────────────────────
  function classify(toolId) {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return TIER_COLD;
    var tool = reg.getTool(toolId);
    if (!tool) return TIER_COLD;

    var tier;
    var now = Date.now();

    // Dormant: not used recently
    if (tool.lastUsed && (now - tool.lastUsed) > DORMANT_MS && tool.launches > 0) {
      tier = TIER_DORMANT;
    } else {
      // Use launch count and recency for hot vs cold classification
      // Top N most-launched tools are HOT (will be resolved in _refreshAll)
      tier = tool.launches > 10 ? TIER_WARM : TIER_COLD;
    }

    _classifications[toolId] = tier;
    return tier;
  }

  // ── Refresh all classifications ───────────────────────────────────────────────
  function _refreshAll() {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return;
    var tools = reg.getAllTools();
    if (!tools.length) return;

    // Sort by launches desc to find top-N hot tools
    var sorted = tools.slice().sort(function (a, b) { return b.launches - a.launches; });
    var hotIds  = {};
    sorted.slice(0, HOT_TOP_N).forEach(function (t) {
      if (t.launches > 0) hotIds[t.id] = true;
    });

    var now = Date.now();
    tools.forEach(function (t) {
      var tier;
      if (hotIds[t.id]) {
        tier = TIER_HOT;
      } else if (t.lastUsed && (now - t.lastUsed) > DORMANT_MS && t.launches > 0) {
        tier = TIER_DORMANT;
      } else if (t.launches > 5) {
        tier = TIER_WARM;
      } else {
        tier = TIER_COLD;
      }
      _classifications[t.id] = tier;
    });

    _metrics.classified = tools.length;

    // Act on hot tools
    sorted.slice(0, HOT_TOP_N).forEach(function (t) {
      if (hotIds[t.id] && !_preloaded[t.id]) preload(t.id);
    });

    // Advisory unload dormant
    tools.forEach(function (t) {
      if (_classifications[t.id] === TIER_DORMANT) _advisoryUnload(t.id);
    });
  }

  // ── Preload ───────────────────────────────────────────────────────────────────
  function preload(toolId) {
    if (_preloaded[toolId]) return;
    _preloaded[toolId] = true;
    _metrics.preloaded++;

    // Advisory preload via RuntimeAdaptiveBundles
    try {
      var ab = G.RuntimeAdaptiveBundles;
      if (ab && ab.predictivePreload) ab.predictivePreload(toolId);
    } catch (_) {}

    _tel('preload', { toolId: toolId });
    try {
      G.dispatchEvent(new CustomEvent('arc12:tool-preloaded', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  // ── Advisory unload ───────────────────────────────────────────────────────────
  function _advisoryUnload(toolId) {
    if (!_preloaded[toolId]) return;
    delete _preloaded[toolId];
    _metrics.unloaded++;

    try {
      G.dispatchEvent(new CustomEvent('arc12:tool-unloaded', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  // ── Warm predicted next tool ───────────────────────────────────────────────────
  function warmNext(currentToolId) {
    try {
      var pred = G.RuntimeToolPredictor;
      if (!pred) return;
      var predictions = pred.predictNextTool(currentToolId) || [];
      predictions.slice(0, 2).forEach(function (p) {
        if (p && p.toolId && !_preloaded[p.toolId]) {
          var ab = G.RuntimeAdaptiveBundles;
          if (ab && ab.predictivePreload) ab.predictivePreload(p.toolId);
          _metrics.warmed++;
          _tel('warm', { toolId: p.toolId, from: currentToolId });
        }
      });
    } catch (_) {}
  }

  // ── Query ─────────────────────────────────────────────────────────────────────
  function getClassifications() {
    return Object.assign({}, _classifications);
  }

  function getByTier(tier) {
    return Object.keys(_classifications).filter(function (id) {
      return _classifications[id] === tier;
    });
  }

  function getPreloaded() {
    return Object.keys(_preloaded);
  }

  function estimateSavingsMs() {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return 0;
    var hot    = getByTier(TIER_HOT);
    var saving = 0;
    hot.forEach(function (id) {
      var t = reg.getTool(id);
      if (t) saving += t.startupMs * Math.max(0, t.launches - 1);
    });
    _metrics.savingsMs = saving;
    return saving;
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:optimizer:' + event, data, ['arc12', 'optimizer']);
    } catch (_) {}
  }

  // ── Periodic refresh ──────────────────────────────────────────────────────────
  function start() {
    if (_interval) return;
    _interval = setInterval(_refreshAll, 60000);   // every 60 s
    setTimeout(_refreshAll, 3000);
  }

  function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────────
  try {
    G.addEventListener('arc12:metrics-updated', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) {
        classify(id);
        warmNext(id);
      }
    });
  } catch (_) {}

  start();

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolOptimizer = Object.freeze({
    classify:          classify,
    preload:           preload,
    warmNext:          warmNext,
    getClassifications: getClassifications,
    getByTier:         getByTier,
    getPreloaded:      getPreloaded,
    estimateSavingsMs: estimateSavingsMs,
    start:             start,
    stop:              stop,
    getMetrics:        function () { return Object.assign({}, _metrics); },
    TIERS: Object.freeze({ HOT: TIER_HOT, WARM: TIER_WARM, COLD: TIER_COLD, DORMANT: TIER_DORMANT }),
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
