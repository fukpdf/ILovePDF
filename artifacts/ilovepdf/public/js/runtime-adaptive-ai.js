// RuntimeAdaptiveAI v1.0 — Arc 9 / Phase E
// =====================================================================
// Runtime execution prediction and user behavior learning engine.
//
// Capabilities:
//   - Tool usage frequency map (per-session + lifetime)
//   - Processor pre-activation: warm up top-N predicted processors
//   - Worker prewarm intelligence: start worker 500ms ahead of need
//   - Thermal prediction: linear regression on last 10 thermal samples
//   - Memory prediction: per-tool allocation running average
//   - Per-device adaptation: aggressiveness scales with device tier
//   - Per-session model update: learns within the current session
//
// Integrates: RuntimePredictiveLoader, RuntimeProcessorLoader,
//   RuntimeTaskOrchestrator, RuntimeMobileHardening, RuntimeStreamTelemetry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAdaptiveAI) return;

  var LOG     = '[AdaptiveAI]';
  var VERSION = '1.0';

  // ── Device tier ───────────────────────────────────────────────────
  function _deviceTier() {
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh && mh.getDeviceTier) return mh.getDeviceTier();
    } catch (_) {}
    var mem = (navigator.deviceMemory || 4);
    var cpu = (navigator.hardwareConcurrency || 4);
    if (mem >= 8 && cpu >= 8) return 'high';
    if (mem >= 4 && cpu >= 4) return 'mid';
    return 'low';
  }

  // ── Config by device tier ─────────────────────────────────────────
  var TIER_CONFIG = {
    high: { topN: 5, prewarmMs: 300, maxPredictions: 10, aggressiveness: 1.0 },
    mid:  { topN: 3, prewarmMs: 500, maxPredictions: 6,  aggressiveness: 0.7 },
    low:  { topN: 2, prewarmMs: 800, maxPredictions: 4,  aggressiveness: 0.4 },
  };

  var _tier   = _deviceTier();
  var _config = TIER_CONFIG[_tier] || TIER_CONFIG['mid'];

  // ── Usage model ───────────────────────────────────────────────────
  var _toolUsage = {};
  // toolId → { sessionCount, lifetimeCount, lastUsed, sequenceAfter: {toolId: count} }

  function _ensureTool(toolId) {
    if (!_toolUsage[toolId]) {
      _toolUsage[toolId] = { sessionCount: 0, lifetimeCount: 0, lastUsed: 0, sequenceAfter: {} };
    }
    return _toolUsage[toolId];
  }

  var _lastTool = null;

  function recordToolUse(toolId) {
    var t = _ensureTool(toolId);
    t.sessionCount++;
    t.lifetimeCount++;
    t.lastUsed = Date.now();

    // Sequence model: track which tools follow which
    if (_lastTool && _lastTool !== toolId) {
      var lt = _ensureTool(_lastTool);
      lt.sequenceAfter[toolId] = (lt.sequenceAfter[toolId] || 0) + 1;
    }
    _lastTool = toolId;

    // Trigger pre-activation for predicted next tools
    var predicted = predictNext(toolId);
    if (predicted.length > 0) _preActivate(predicted);

    try {
      G.dispatchEvent(new CustomEvent('arc9:tool-recorded', { detail: { toolId: toolId, predicted: predicted } }));
    } catch (_) {}
  }

  // ── Prediction: top-N by session frequency ────────────────────────
  function getTopTools(n) {
    return Object.keys(_toolUsage)
      .sort(function (a, b) { return _toolUsage[b].sessionCount - _toolUsage[a].sessionCount; })
      .slice(0, n || _config.topN);
  }

  // ── Sequence prediction: most likely next after current ───────────
  function predictNext(toolId) {
    var t = _toolUsage[toolId];
    if (!t || !Object.keys(t.sequenceAfter).length) {
      // Fall back to global top tools
      return getTopTools(_config.topN);
    }
    var seq = t.sequenceAfter;
    return Object.keys(seq)
      .sort(function (a, b) { return seq[b] - seq[a]; })
      .slice(0, _config.topN);
  }

  // ── Processor pre-activation ──────────────────────────────────────
  function _preActivate(toolIds) {
    if (_config.aggressiveness < 0.5 && _deviceTier() === 'low') return;
    toolIds.forEach(function (toolId) {
      setTimeout(function () {
        try {
          var pl = G.RuntimePredictiveLoader;
          if (pl && pl.preload) pl.preload(toolId, 'adaptive-ai');
        } catch (_) {}
        try {
          G.dispatchEvent(new CustomEvent('arc9:preactivate', { detail: { toolId: toolId } }));
        } catch (_) {}
      }, _config.prewarmMs);
    });
  }

  // ── Worker prewarm intelligence ───────────────────────────────────
  function prewarmWorker(toolId) {
    setTimeout(function () {
      try {
        var pw = G.RuntimeProcessorWorkers;
        if (pw && pw.prewarm) pw.prewarm(toolId);
      } catch (_) {}
      try {
        G.dispatchEvent(new CustomEvent('arc9:worker-prewarm', { detail: { toolId: toolId } }));
      } catch (_) {}
    }, _config.prewarmMs);
  }

  // ── Thermal prediction ────────────────────────────────────────────
  var _thermalSamples = [];  // { ts, tier }
  var TIER_SCORE = { nominal: 0, warm: 1, hot: 2, critical: 3 };
  var SCORE_TIER = ['nominal', 'warm', 'hot', 'critical'];

  function _recordThermal(tier) {
    _thermalSamples.push({ ts: Date.now(), score: TIER_SCORE[tier] || 0 });
    if (_thermalSamples.length > 10) _thermalSamples.shift();
  }

  function predictThermal() {
    if (_thermalSamples.length < 3) return 'nominal';
    // Linear regression slope
    var n = _thermalSamples.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    _thermalSamples.forEach(function (s, i) { sumX += i; sumY += s.score; sumXY += i * s.score; sumXX += i * i; });
    var slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) || 0;
    var lastScore = _thermalSamples[_thermalSamples.length - 1].score;
    var predicted = Math.round(Math.max(0, Math.min(3, lastScore + slope)));
    return SCORE_TIER[predicted] || 'nominal';
  }

  // ── Memory prediction ─────────────────────────────────────────────
  var _memSamples = {};  // toolId → [heapMb values]

  function recordMemoryUsage(toolId, heapMb) {
    if (!_memSamples[toolId]) _memSamples[toolId] = [];
    _memSamples[toolId].push(heapMb);
    if (_memSamples[toolId].length > 20) _memSamples[toolId].shift();
  }

  function predictMemory(toolId) {
    var samples = _memSamples[toolId];
    if (!samples || !samples.length) return 0;
    return Math.round(samples.reduce(function (a, b) { return a + b; }, 0) / samples.length);
  }

  // ── Predictive throttling ─────────────────────────────────────────
  function shouldThrottle(toolId) {
    var predictedThermal = predictThermal();
    var predictedMem     = predictMemory(toolId);
    var heapLimit        = 400;  // MB
    if (predictedThermal === 'critical' || predictedThermal === 'hot') return true;
    if (predictedMem > heapLimit) return true;
    return false;
  }

  // ── Predictive cleanup ────────────────────────────────────────────
  function shouldCleanupBefore(toolId) {
    var predicted = predictMemory(toolId);
    var currentMb = 0;
    try { var pm = performance.memory; currentMb = pm ? pm.usedJSHeapSize / 1024 / 1024 : 0; } catch (_) {}
    return (currentMb + predicted) > 600;  // 600MB combined threshold
  }

  // ── Predictive hydration ──────────────────────────────────────────
  function predictiveHydrate() {
    var top = getTopTools(_config.topN);
    top.forEach(function (toolId) {
      try {
        var pl = G.RuntimePredictiveLoader;
        if (pl && pl.preload) pl.preload(toolId, 'predictive-hydrate');
      } catch (_) {}
    });
    return top;
  }

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('processor-hydration:activated', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.toolId) recordToolUse(d.toolId);
    } catch (_) {}
  });

  G.addEventListener('task-orchestrator:throttled', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.tier) _recordThermal(d.tier);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.pct === 100 && d.toolId) {
        var heapMb = 0;
        try { var pm = performance.memory; heapMb = pm ? pm.usedJSHeapSize / 1024 / 1024 : 0; } catch (_) {}
        recordMemoryUsage(d.toolId, heapMb);
      }
    } catch (_) {}
  });

  // Thermal sample from stream telemetry
  setInterval(function () {
    try {
      var to = G.RuntimeTaskOrchestrator;
      if (to && to.getThermalTier) _recordThermal(to.getThermalTier());
    } catch (_) {}
  }, 30000);

  // ── Session init: predictive hydration of top tools ───────────────
  setTimeout(function () {
    if (_config.aggressiveness >= 0.7) predictiveHydrate();
  }, 5000);

  G.RuntimeAdaptiveAI = Object.freeze({
    VERSION:            VERSION,
    recordToolUse:      recordToolUse,
    recordMemoryUsage:  recordMemoryUsage,
    predictNext:        predictNext,
    getTopTools:        getTopTools,
    predictThermal:     predictThermal,
    predictMemory:      predictMemory,
    shouldThrottle:     shouldThrottle,
    shouldCleanupBefore: shouldCleanupBefore,
    predictiveHydrate:  predictiveHydrate,
    prewarmWorker:      prewarmWorker,
    getDeviceTier:      function () { return _tier; },
    getConfig:          function () { return Object.assign({}, _config); },
    getModel: function () {
      return {
        tier:       _tier,
        toolCount:  Object.keys(_toolUsage).length,
        topTools:   getTopTools(5),
        thermal:    predictThermal(),
        lastTool:   _lastTool,
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — device tier:', _tier, '| aggressiveness:', _config.aggressiveness);

}(window));
