// RuntimeToolRegistry v1.0 — Arc 12 / Phase A / Enterprise Tool Intelligence Layer
// Unified registry: every tool is a self-aware runtime entity with full metrics tracking.
// Integrates: RuntimeEventTimeline, RuntimeBlackbox (optional telemetry)
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolRegistry) return;

  var LOG = '[ToolRegistry]';

  // ── Schema ────────────────────────────────────────────────────────────────────
  // tool record shape:
  // {
  //   id, category, bundle, processorFamily,
  //   startupMs, avgExecutionMs, avgMemoryMb,
  //   launches, successes, failures, crashCount,
  //   healthScore,              // 0-100, managed by RuntimeToolHealth
  //   lastUsed,                 // timestamp
  //   registered                // timestamp
  // }

  var _tools   = {};   // id → record
  var _metrics = { registered: 0, updated: 0, lookups: 0 };

  // ── Default record ────────────────────────────────────────────────────────────
  function _defaults(spec) {
    return {
      id:              spec.id              || 'unknown',
      category:        spec.category        || 'pdf',
      bundle:          spec.bundle          || null,
      processorFamily: spec.processorFamily || null,
      startupMs:       spec.startupMs       || 0,
      avgExecutionMs:  spec.avgExecutionMs  || 0,
      avgMemoryMb:     spec.avgMemoryMb     || 0,
      launches:        spec.launches        || 0,
      successes:       spec.successes       || 0,
      failures:        spec.failures        || 0,
      crashCount:      spec.crashCount      || 0,
      healthScore:     spec.healthScore     || 100,
      lastUsed:        spec.lastUsed        || null,
      registered:      Date.now(),
    };
  }

  // ── Register ──────────────────────────────────────────────────────────────────
  function registerTool(spec) {
    if (!spec || !spec.id) {
      console.warn(LOG, 'registerTool: missing id');
      return null;
    }
    if (_tools[spec.id]) {
      // Merge — preserve existing metrics
      var existing = _tools[spec.id];
      _tools[spec.id] = Object.assign({}, existing, {
        category:        spec.category        || existing.category,
        bundle:          spec.bundle          !== undefined ? spec.bundle          : existing.bundle,
        processorFamily: spec.processorFamily !== undefined ? spec.processorFamily : existing.processorFamily,
      });
      return _tools[spec.id];
    }
    _tools[spec.id] = _defaults(spec);
    _metrics.registered++;
    _tel('register', { id: spec.id, category: _tools[spec.id].category });
    return _tools[spec.id];
  }

  // ── Get ───────────────────────────────────────────────────────────────────────
  function getTool(id) {
    _metrics.lookups++;
    return _tools[id] ? Object.assign({}, _tools[id]) : null;
  }

  function getAllTools() {
    return Object.keys(_tools).map(function (id) {
      return Object.assign({}, _tools[id]);
    });
  }

  // ── Update metrics ────────────────────────────────────────────────────────────
  // delta shape: { startupMs?, executionMs?, memoryMb?, success?, failure?, crash? }
  function updateMetrics(id, delta) {
    if (!delta) return;
    var t = _tools[id];
    if (!t) {
      // Auto-register on first update
      t = _defaults({ id: id });
      _tools[id] = t;
      _metrics.registered++;
    }

    t.lastUsed = Date.now();

    if (delta.startupMs !== undefined) {
      t.startupMs = t.launches === 0
        ? delta.startupMs
        : Math.round((t.startupMs * 0.8) + (delta.startupMs * 0.2));  // EMA
    }
    if (delta.executionMs !== undefined) {
      t.avgExecutionMs = t.launches === 0
        ? delta.executionMs
        : Math.round((t.avgExecutionMs * 0.8) + (delta.executionMs * 0.2));
    }
    if (delta.memoryMb !== undefined) {
      t.avgMemoryMb = t.launches === 0
        ? delta.memoryMb
        : parseFloat(((t.avgMemoryMb * 0.8) + (delta.memoryMb * 0.2)).toFixed(2));
    }

    if (delta.launch)   { t.launches++; }
    if (delta.success)  { t.successes++; }
    if (delta.failure)  { t.failures++;  }
    if (delta.crash)    { t.crashCount++; t.failures++; }

    _metrics.updated++;
    _tel('update', { id: id, delta: Object.keys(delta) });

    // Broadcast so RuntimeToolHealth can refresh
    try {
      G.dispatchEvent(new CustomEvent('arc12:metrics-updated', {
        detail: { toolId: id, delta: delta }
      }));
    } catch (_) {}
  }

  // ── Bulk seed from tools-config.js ───────────────────────────────────────────
  function seedFromConfig() {
    var cfg = G.TOOL_DEFINITIONS || G.ToolsConfig || G.TOOLS_CONFIG;
    if (!cfg) return 0;
    var list = Array.isArray(cfg) ? cfg : Object.values(cfg);
    var count = 0;
    list.forEach(function (t) {
      if (t && t.id) { registerTool({ id: t.id, category: t.category || 'pdf' }); count++; }
    });
    console.debug(LOG, 'seeded', count, 'tools from config');
    return count;
  }

  // ── Internal telemetry ────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:registry:' + event, data, ['arc12', 'registry']);
    } catch (_) {}
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  function getMetrics() {
    return Object.assign({}, _metrics, { totalTools: Object.keys(_tools).length });
  }

  // ── Listen for tool use events ────────────────────────────────────────────────
  try {
    G.addEventListener('arc9:tool-recorded', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) updateMetrics(id, { launch: true });
    });
  } catch (_) {}

  // Auto-seed after a short delay (TOOL_DEFINITIONS may not be defined yet)
  setTimeout(function () { seedFromConfig(); }, 500);

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolRegistry = Object.freeze({
    registerTool:   registerTool,
    getTool:        getTool,
    getAllTools:     getAllTools,
    updateMetrics:  updateMetrics,
    seedFromConfig: seedFromConfig,
    getMetrics:     getMetrics,
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolHealth v1.0 — Arc 12 / Phase B / Enterprise Tool Intelligence Layer
// Live health scoring for every registered tool.
// Score factors: startup speed, execution speed, memory usage, crash frequency, recovery frequency.
// Integrates: RuntimeToolRegistry, RuntimeIncidentCenter (incident auto-creation).
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolHealth) return;

  var LOG = '[ToolHealth]';

  // ── Health levels ─────────────────────────────────────────────────────────────
  var LEVEL_EXCELLENT = 'EXCELLENT';   // score ≥ 90
  var LEVEL_GOOD      = 'GOOD';        // score ≥ 70
  var LEVEL_DEGRADED  = 'DEGRADED';    // score ≥ 40
  var LEVEL_CRITICAL  = 'CRITICAL';    // score  < 40

  // ── State ─────────────────────────────────────────────────────────────────────
  var _scores   = {};   // toolId → { score, level, lastScored, prevLevel }
  var _metrics  = { scored: 0, incidents: 0, refreshes: 0 };
  var _interval = null;
  var REFRESH_MS = 30000;   // re-score every 30 s

  // ── Scoring weights ───────────────────────────────────────────────────────────
  // Higher score = healthier. Penalties subtract from 100.
  function _computeScore(tool) {
    var score = 100;

    // Crash penalty: each crash = -15, capped at -60
    var crashPen = Math.min(tool.crashCount * 15, 60);
    score -= crashPen;

    // Failure rate penalty: failure% above 20% gets penalised
    if (tool.launches > 0) {
      var failRate = (tool.failures - tool.crashCount) / tool.launches;
      if (failRate > 0.2) score -= Math.min(Math.round((failRate - 0.2) * 100), 30);
    }

    // Startup slowness: > 500ms = -5, > 2000ms = -15
    if (tool.startupMs > 2000)      score -= 15;
    else if (tool.startupMs > 500)  score -= 5;

    // Memory pressure: > 200MB = -10, > 500MB = -20
    if (tool.avgMemoryMb > 500)      score -= 20;
    else if (tool.avgMemoryMb > 200) score -= 10;

    // Execution slowness: > 10s = -5, > 30s = -10
    if (tool.avgExecutionMs > 30000)      score -= 10;
    else if (tool.avgExecutionMs > 10000) score -= 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function _level(score) {
    if (score >= 90) return LEVEL_EXCELLENT;
    if (score >= 70) return LEVEL_GOOD;
    if (score >= 40) return LEVEL_DEGRADED;
    return LEVEL_CRITICAL;
  }

  // ── Score a single tool ───────────────────────────────────────────────────────
  function scoreFor(toolId) {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return 100;
    var tool = reg.getTool(toolId);
    if (!tool) return 100;

    var score     = _computeScore(tool);
    var lvl       = _level(score);
    var prev      = _scores[toolId];
    var prevLevel = prev ? prev.level : lvl;

    _scores[toolId] = { score: score, level: lvl, lastScored: Date.now(), prevLevel: prevLevel };
    _metrics.scored++;

    // Persist health score back into registry
    if (reg.updateMetrics) {
      try {
        G.RuntimeToolRegistry;  // guard access
        tool._healthScore = score;
      } catch (_) {}
    }

    // Auto-create incident on level transition to CRITICAL or DEGRADED
    if (lvl !== prevLevel && (lvl === LEVEL_CRITICAL || lvl === LEVEL_DEGRADED)) {
      _raiseIncident(toolId, lvl, score, tool);
    }

    return score;
  }

  function _raiseIncident(toolId, level, score, tool) {
    var ic = G.RuntimeIncidentCenter;
    if (!ic || !ic.record) return;
    var P1 = 1, P2 = 2;
    var sev = level === LEVEL_CRITICAL ? P1 : P2;
    try {
      ic.record(
        'tool-health-degraded',
        sev,
        toolId,
        { toolId: toolId, level: level, score: score, crashes: tool.crashCount, failures: tool.failures }
      );
      _metrics.incidents++;
      console.warn(LOG, toolId, 'health', level, '(score=' + score + ')');
    } catch (_) {}
  }

  // ── Score all registered tools ─────────────────────────────────────────────────
  function refresh() {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return;
    var tools = reg.getAllTools();
    tools.forEach(function (t) { scoreFor(t.id); });
    _metrics.refreshes++;
    try {
      G.dispatchEvent(new CustomEvent('arc12:health-refreshed', {
        detail: { count: tools.length, ts: Date.now() }
      }));
    } catch (_) {}
  }

  function getLevelFor(toolId) {
    var entry = _scores[toolId];
    if (!entry) { scoreFor(toolId); entry = _scores[toolId]; }
    return entry ? entry.level : LEVEL_GOOD;
  }

  function getAllHealthLevels() {
    var reg = G.RuntimeToolRegistry;
    if (!reg) return {};
    var tools = reg.getAllTools();
    var result = {};
    tools.forEach(function (t) {
      if (!_scores[t.id]) scoreFor(t.id);
      result[t.id] = _scores[t.id] || { score: 100, level: LEVEL_GOOD };
    });
    return result;
  }

  function getHealthSummary() {
    var all = getAllHealthLevels();
    var counts = { EXCELLENT: 0, GOOD: 0, DEGRADED: 0, CRITICAL: 0 };
    Object.keys(all).forEach(function (id) { counts[all[id].level] = (counts[all[id].level] || 0) + 1; });
    return { counts: counts, total: Object.keys(all).length, metrics: Object.assign({}, _metrics) };
  }

  // ── Listen for metric updates ─────────────────────────────────────────────────
  try {
    G.addEventListener('arc12:metrics-updated', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) scoreFor(id);
    });
  } catch (_) {}

  // ── Periodic refresh ───────────────────────────────────────────────────────────
  function start() {
    if (_interval) return;
    _interval = setInterval(refresh, REFRESH_MS);
    setTimeout(refresh, 2000);   // initial score after registry seeds
  }

  function stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
  }

  start();

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolHealth = Object.freeze({
    scoreFor:          scoreFor,
    getLevelFor:       getLevelFor,
    getAllHealthLevels: getAllHealthLevels,
    getHealthSummary:  getHealthSummary,
    refresh:           refresh,
    start:             start,
    stop:              stop,
    EXCELLENT: LEVEL_EXCELLENT,
    GOOD:      LEVEL_GOOD,
    DEGRADED:  LEVEL_DEGRADED,
    CRITICAL:  LEVEL_CRITICAL,
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolDependencies v1.0 — Arc 12 / Phase C / Enterprise Tool Intelligence Layer
// Dependency graph: tracks upstream/downstream relationships between tools.
// Allows understanding which tools depend on which processors/bundles/tools.
// Integrates: RuntimeToolRegistry, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolDependencies) return;

  var LOG = '[ToolDependencies]';

  // ── Graph storage ─────────────────────────────────────────────────────────────
  // _deps[toolId]  = Set of IDs that toolId depends ON  (upstream)
  // _deps_of[toolId] = Set of IDs that depend ON toolId (downstream)
  var _deps    = {};   // toolId → [dependsOn, ...]
  var _depsOf  = {};   // toolId → [dependentId, ...]
  var _meta    = {};   // edge key (a→b) → { type, addedAt }
  var _metrics = { edges: 0, lookups: 0, removals: 0 };

  function _ensureNode(id) {
    if (!_deps[id])   _deps[id]   = [];
    if (!_depsOf[id]) _depsOf[id] = [];
  }

  // ── Add dependency ────────────────────────────────────────────────────────────
  // toolId depends on dependsOn (toolId is downstream, dependsOn is upstream)
  function addDependency(toolId, dependsOn, type) {
    if (!toolId || !dependsOn || toolId === dependsOn) return;
    _ensureNode(toolId);
    _ensureNode(dependsOn);

    var key = toolId + '→' + dependsOn;
    if (_meta[key]) return;   // already exists

    _deps[toolId].push(dependsOn);
    _depsOf[dependsOn].push(toolId);
    _meta[key] = { type: type || 'generic', addedAt: Date.now() };
    _metrics.edges++;

    _tel('add', { toolId: toolId, dependsOn: dependsOn, type: type });

    try {
      G.dispatchEvent(new CustomEvent('arc12:dependency-added', {
        detail: { toolId: toolId, dependsOn: dependsOn }
      }));
    } catch (_) {}
  }

  // ── Remove dependency ─────────────────────────────────────────────────────────
  function removeDependency(toolId, dependsOn) {
    var key = toolId + '→' + dependsOn;
    if (!_meta[key]) return;
    delete _meta[key];
    _deps[toolId]    = (_deps[toolId]    || []).filter(function (d) { return d !== dependsOn; });
    _depsOf[dependsOn] = (_depsOf[dependsOn] || []).filter(function (d) { return d !== toolId;  });
    _metrics.removals++;
  }

  // ── Query ─────────────────────────────────────────────────────────────────────
  // Returns IDs that toolId depends on (upstream)
  function getDependencies(toolId) {
    _metrics.lookups++;
    return (_deps[toolId] || []).slice();
  }

  // Returns IDs that depend ON toolId (downstream)
  function getDependents(toolId) {
    _metrics.lookups++;
    return (_depsOf[toolId] || []).slice();
  }

  function getDependencyCount(toolId) {
    return (_deps[toolId] || []).length;
  }

  function getDependentCount(toolId) {
    return (_depsOf[toolId] || []).length;
  }

  // ── Full graph export ─────────────────────────────────────────────────────────
  function getGraph() {
    var nodes = Object.keys(_deps).concat(Object.keys(_depsOf))
      .filter(function (v, i, a) { return a.indexOf(v) === i; });  // unique

    return {
      nodes: nodes.map(function (id) {
        return {
          id: id,
          upstreamCount:   getDependencyCount(id),
          downstreamCount: getDependentCount(id),
        };
      }),
      edges: Object.keys(_meta).map(function (key) {
        var parts = key.split('→');
        return {
          from: parts[0],
          to:   parts[1],
          type: _meta[key].type,
          addedAt: _meta[key].addedAt,
        };
      }),
      metrics: Object.assign({}, _metrics),
    };
  }

  // ── Seed common tool dependency patterns ──────────────────────────────────────
  function seedDefaults() {
    var PATTERNS = [
      // OCR enables translation
      ['ai-translate', 'ocr-pdf',        'processor'],
      // Merge often needs compress downstream
      ['compress-pdf', 'merge-pdf',      'workflow'],
      // Split → merge common loop
      ['merge-pdf',    'split-pdf',      'workflow'],
      // PDF to Word → Word to PDF round-trip
      ['word-to-pdf',  'pdf-to-word',    'conversion'],
      // AI Summarizer depends on OCR for scanned docs
      ['ai-summarizer', 'ocr-pdf',       'processor'],
      // Protect depends on base PDF
      ['protect-pdf',  'merge-pdf',      'workflow'],
      // Watermark similar
      ['watermark-pdf', 'merge-pdf',     'workflow'],
    ];
    PATTERNS.forEach(function (p) { addDependency(p[0], p[1], p[2]); });
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:deps:' + event, data, ['arc12', 'deps']);
    } catch (_) {}
  }

  // Seed after short delay
  setTimeout(seedDefaults, 800);

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolDependencies = Object.freeze({
    addDependency:      addDependency,
    removeDependency:   removeDependency,
    getDependencies:    getDependencies,
    getDependents:      getDependents,
    getDependencyCount: getDependencyCount,
    getDependentCount:  getDependentCount,
    getGraph:           getGraph,
    seedDefaults:       seedDefaults,
    getMetrics:         function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolIsolation v1.0 — Arc 12 / Phase D / Enterprise Tool Intelligence Layer
// Automatic tool quarantine on repeated crashes, memory violations, or recoveries.
// Integrates: RuntimeToolRegistry, RuntimeGovernance, RuntimeRecoveryOrchestrator,
//             RuntimeIncidentCenter, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolIsolation) return;

  var LOG = '[ToolIsolation]';

  // ── Thresholds ────────────────────────────────────────────────────────────────
  var CRASH_THRESHOLD    = 3;    // isolate after N crashes
  var FAILURE_THRESHOLD  = 5;    // isolate after N consecutive failures
  var RECOVERY_THRESHOLD = 4;    // isolate if needed N recoveries
  var COOLDOWN_MS        = 5 * 60 * 1000;   // 5 min before auto-restore attempt

  // ── State ─────────────────────────────────────────────────────────────────────
  var _isolated  = {};   // toolId → { reason, ts, crashCount, autoRestore }
  var _failStreak = {};  // toolId → consecutive failure count
  var _metrics   = { isolated: 0, restored: 0, autoRestored: 0 };

  // ── Isolate ───────────────────────────────────────────────────────────────────
  function isolateTool(toolId, reason) {
    if (_isolated[toolId]) return;   // already isolated

    _isolated[toolId] = {
      reason:      reason || 'manual',
      ts:          Date.now(),
      autoRestore: true,
    };
    _metrics.isolated++;

    // Forward to RuntimeGovernance quarantine
    var gov = G.RuntimeGovernance;
    if (gov && gov.quarantine) {
      try { gov.quarantine('tool:' + toolId, reason || 'arc12-isolation'); } catch (_) {}
    }

    // Create incident
    var ic = G.RuntimeIncidentCenter;
    if (ic && ic.record) {
      try { ic.record('tool-isolated', 1, toolId, { toolId: toolId, reason: reason }); } catch (_) {}
    }

    console.warn(LOG, 'isolated:', toolId, '(' + (reason || 'manual') + ')');

    try {
      G.dispatchEvent(new CustomEvent('arc12:tool-isolated', {
        detail: { toolId: toolId, reason: reason }
      }));
    } catch (_) {}

    // Schedule auto-restore
    setTimeout(function () {
      if (_isolated[toolId] && _isolated[toolId].autoRestore) {
        _autoRestore(toolId);
      }
    }, COOLDOWN_MS);
  }

  // ── Restore ───────────────────────────────────────────────────────────────────
  function restoreTool(toolId) {
    if (!_isolated[toolId]) return;
    delete _isolated[toolId];
    _failStreak[toolId] = 0;
    _metrics.restored++;

    var gov = G.RuntimeGovernance;
    if (gov && gov.lift) {
      try { gov.lift('tool:' + toolId); } catch (_) {}
    }

    console.debug(LOG, 'restored:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('arc12:tool-restored', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  function _autoRestore(toolId) {
    var reg = G.RuntimeToolRegistry;
    if (!reg) { restoreTool(toolId); return; }
    var tool = reg.getTool(toolId);
    if (!tool) { restoreTool(toolId); return; }

    // Only auto-restore if health has improved (fewer crashes recently)
    var ok = tool.crashCount < CRASH_THRESHOLD || (Date.now() - (_isolated[toolId] || {}).ts) > COOLDOWN_MS * 2;
    if (ok) {
      _metrics.autoRestored++;
      restoreTool(toolId);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────────
  function isIsolated(toolId) { return !!_isolated[toolId]; }
  function getIsolated()      { return Object.assign({}, _isolated); }

  // ── Watch for violations ──────────────────────────────────────────────────────
  function _checkTool(toolId, delta) {
    var reg = G.RuntimeToolRegistry;
    if (!reg || _isolated[toolId]) return;
    var tool = reg.getTool(toolId);
    if (!tool) return;

    // Crash threshold
    if (tool.crashCount >= CRASH_THRESHOLD) {
      isolateTool(toolId, 'crash-threshold:' + tool.crashCount);
      return;
    }

    // Recovery frequency (approximated by failures - crashes)
    var softFails = Math.max(0, tool.failures - tool.crashCount);
    if (softFails >= RECOVERY_THRESHOLD && tool.launches > 0) {
      var failRate = tool.failures / tool.launches;
      if (failRate > 0.5) {
        isolateTool(toolId, 'high-failure-rate:' + Math.round(failRate * 100) + '%');
        return;
      }
    }

    // Consecutive failure streak
    if (delta && delta.failure) {
      _failStreak[toolId] = (_failStreak[toolId] || 0) + 1;
      if (_failStreak[toolId] >= FAILURE_THRESHOLD) {
        isolateTool(toolId, 'consecutive-failures:' + _failStreak[toolId]);
      }
    } else if (delta && delta.success) {
      _failStreak[toolId] = 0;
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────────
  try {
    G.addEventListener('arc12:metrics-updated', function (e) {
      var d = e && e.detail;
      if (d && d.toolId) _checkTool(d.toolId, d.delta);
    });

    G.addEventListener('arc12:health-refreshed', function () {
      var reg = G.RuntimeToolRegistry;
      if (!reg) return;
      reg.getAllTools().forEach(function (t) { _checkTool(t.id, null); });
    });
  } catch (_) {}

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:isolation:' + event, data, ['arc12', 'isolation']);
    } catch (_) {}
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolIsolation = Object.freeze({
    isolateTool:  isolateTool,
    restoreTool:  restoreTool,
    isIsolated:   isIsolated,
    getIsolated:  getIsolated,
    getMetrics:   function () { return Object.assign({}, _metrics); },
    thresholds: Object.freeze({
      crash:     CRASH_THRESHOLD,
      failure:   FAILURE_THRESHOLD,
      recovery:  RECOVERY_THRESHOLD,
      cooldownMs: COOLDOWN_MS,
    }),
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolPredictor v1.0 — Arc 12 / Phase E / Enterprise Tool Intelligence Layer
// Next-tool prediction engine. Learns tool-to-tool transition sequences.
// Integrates: RuntimeAdaptiveAI (base predictions), RuntimeToolRegistry,
//             RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolPredictor) return;

  var LOG = '[ToolPredictor]';

  // ── Sequence model ────────────────────────────────────────────────────────────
  // _model[fromId][toId] = count of transitions
  var _model    = {};
  var _history  = [];    // recent tool sequence, ring buffer cap=20
  var _metrics  = { recorded: 0, predicted: 0, hits: 0 };
  var MAX_HIST  = 20;
  var TOP_N     = 5;

  // ── Seed known patterns ───────────────────────────────────────────────────────
  var SEED_SEQUENCES = [
    ['merge-pdf',    'compress-pdf'],
    ['compress-pdf', 'merge-pdf'],
    ['ocr-pdf',      'ai-summarizer'],
    ['ocr-pdf',      'ai-translate'],
    ['split-pdf',    'merge-pdf'],
    ['pdf-to-word',  'word-to-pdf'],
    ['pdf-to-jpg',   'jpg-to-pdf'],
    ['jpg-to-pdf',   'merge-pdf'],
    ['merge-pdf',    'watermark-pdf'],
    ['merge-pdf',    'protect-pdf'],
  ];

  function _seed() {
    SEED_SEQUENCES.forEach(function (pair) {
      _record(pair[0], pair[1]);
    });
  }

  // ── Record a transition (internal, no metrics increment) ─────────────────────
  function _record(from, to) {
    if (!from || !to || from === to) return;
    if (!_model[from]) _model[from] = {};
    _model[from][to] = (_model[from][to] || 0) + 1;
  }

  // ── Record tool usage (public) ────────────────────────────────────────────────
  function recordUsage(toolId) {
    if (!toolId) return;
    var prev = _history.length > 0 ? _history[_history.length - 1] : null;

    _history.push(toolId);
    if (_history.length > MAX_HIST) _history.shift();

    if (prev && prev !== toolId) {
      _record(prev, toolId);
      _metrics.recorded++;
    }

    // Also sync with RuntimeAdaptiveAI
    try {
      var ai = G.RuntimeAdaptiveAI;
      if (ai && ai.recordToolUse) ai.recordToolUse(toolId);
    } catch (_) {}

    // Update registry
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.updateMetrics) reg.updateMetrics(toolId, { launch: true });
    } catch (_) {}

    _tel('usage', { toolId: toolId, prev: prev });
  }

  // ── Predict next tool ─────────────────────────────────────────────────────────
  function predictNextTool(toolId) {
    _metrics.predicted++;
    var predictions = [];

    // 1. Own model
    var transitions = _model[toolId];
    if (transitions) {
      var sorted = Object.keys(transitions).sort(function (a, b) {
        return transitions[b] - transitions[a];
      });
      sorted.forEach(function (id) {
        predictions.push({ toolId: id, score: transitions[id], source: 'learned' });
      });
    }

    // 2. Merge with RuntimeAdaptiveAI predictions
    try {
      var ai = G.RuntimeAdaptiveAI;
      if (ai && ai.predictNext) {
        var aiPreds = ai.predictNext(toolId) || [];
        aiPreds.forEach(function (id, i) {
          var existing = predictions.find(function (p) { return p.toolId === id; });
          if (existing) {
            existing.score += (aiPreds.length - i);   // boost if confirmed by AI
            existing.source = 'learned+ai';
          } else {
            predictions.push({ toolId: id, score: aiPreds.length - i, source: 'ai' });
          }
        });
      }
    } catch (_) {}

    // Sort by score descending, return top N
    predictions.sort(function (a, b) { return b.score - a.score; });
    return predictions.slice(0, TOP_N);
  }

  // ── Top sequences ─────────────────────────────────────────────────────────────
  function getTopSequences(n) {
    var pairs = [];
    Object.keys(_model).forEach(function (from) {
      Object.keys(_model[from]).forEach(function (to) {
        pairs.push({ from: from, to: to, count: _model[from][to] });
      });
    });
    pairs.sort(function (a, b) { return b.count - a.count; });
    return pairs.slice(0, n || 10);
  }

  function getHistory() { return _history.slice(); }
  function getModel()   { return JSON.parse(JSON.stringify(_model)); }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:predictor:' + event, data, ['arc12', 'predictor']);
    } catch (_) {}
  }

  // ── Event wiring ──────────────────────────────────────────────────────────────
  try {
    G.addEventListener('arc9:tool-recorded', function (e) {
      var id = e && e.detail && e.detail.toolId;
      if (id) recordUsage(id);
    });
  } catch (_) {}

  // Seed on load
  _seed();

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolPredictor = Object.freeze({
    recordUsage:    recordUsage,
    predictNextTool: predictNextTool,
    getTopSequences: getTopSequences,
    getHistory:     getHistory,
    getModel:       getModel,
    getMetrics:     function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolProfiler v1.0 — Arc 12 / Phase F / Enterprise Tool Intelligence Layer
// Per-tool execution profiling: startupMs, executionMs, memoryMb, workerUsage, thermalImpact.
// Computes p50/p90/p99 statistics per tool.
// Integrates: RuntimePerformanceProfiler, RuntimeToolRegistry, RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolProfiler) return;

  var LOG = '[ToolProfiler]';

  // ── Per-tool sample storage ───────────────────────────────────────────────────
  // _data[toolId] = {
  //   startupMs:   [sample, ...]  (cap 100)
  //   executionMs: [sample, ...]  (cap 100)
  //   memoryMb:    [sample, ...]  (cap 100)
  //   workerCount: [sample, ...]  (cap 50)
  //   thermalImpact: [0-3, ...]   (cap 50)
  //   sessions:    N              (total profile sessions)
  // }
  var _data    = {};
  var _active  = {};   // toolId → { startTs, startHeap, startThermal }
  var _metrics = { begun: 0, completed: 0, lookups: 0 };
  var MAX_SAMP = 100;

  function _ensure(toolId) {
    if (!_data[toolId]) {
      _data[toolId] = {
        startupMs:     [],
        executionMs:   [],
        memoryMb:      [],
        workerCount:   [],
        thermalImpact: [],
        sessions:      0,
      };
    }
  }

  function _push(arr, val, cap) {
    arr.push(val);
    if (arr.length > cap) arr.shift();
  }

  // ── Percentile ────────────────────────────────────────────────────────────────
  function _pct(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  function _stats(arr) {
    if (!arr.length) return { p50: 0, p90: 0, p99: 0, avg: 0, min: 0, max: 0, n: 0 };
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var sum    = sorted.reduce(function (acc, v) { return acc + v; }, 0);
    return {
      p50: _pct(sorted, 50),
      p90: _pct(sorted, 90),
      p99: _pct(sorted, 99),
      avg: Math.round(sum / sorted.length),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      n:   sorted.length,
    };
  }

  // ── Begin profiling a tool ────────────────────────────────────────────────────
  function beginProfile(toolId) {
    if (!toolId) return;
    _ensure(toolId);
    var heap    = 0;
    var thermal = 0;
    try {
      if (performance && performance.memory) heap = performance.memory.usedJSHeapSize / (1024 * 1024);
    } catch (_) {}
    _active[toolId] = { startTs: performance.now(), startHeap: heap, startThermal: thermal };
    _metrics.begun++;
  }

  // ── End profiling ─────────────────────────────────────────────────────────────
  // opts: { startupMs?, workerCount?, thermalImpact? }
  function endProfile(toolId, opts) {
    if (!toolId) return;
    _ensure(toolId);
    var sess = _active[toolId];
    opts = opts || {};

    var execMs  = 0;
    var memMb   = 0;
    var heap2   = 0;

    if (sess) {
      execMs = Math.round(performance.now() - sess.startTs);
      try {
        if (performance && performance.memory) heap2 = performance.memory.usedJSHeapSize / (1024 * 1024);
        memMb = Math.max(0, heap2 - sess.startHeap);
      } catch (_) {}
      delete _active[toolId];
    }

    var d = _data[toolId];
    d.sessions++;
    _push(d.executionMs,   execMs,               MAX_SAMP);
    _push(d.memoryMb,      parseFloat(memMb.toFixed(2)), MAX_SAMP);
    if (opts.startupMs !== undefined)    _push(d.startupMs,     opts.startupMs,     MAX_SAMP);
    if (opts.workerCount !== undefined)  _push(d.workerCount,   opts.workerCount,   50);
    if (opts.thermalImpact !== undefined) _push(d.thermalImpact, opts.thermalImpact, 50);

    _metrics.completed++;

    // Forward to RuntimePerformanceProfiler
    try {
      var pp = G.RuntimePerformanceProfiler;
      if (pp && pp.recordCost) pp.recordCost(toolId, 'arc12', execMs);
    } catch (_) {}

    // Update registry
    try {
      var reg = G.RuntimeToolRegistry;
      if (reg && reg.updateMetrics) {
        reg.updateMetrics(toolId, {
          executionMs: execMs,
          memoryMb:    parseFloat(memMb.toFixed(2)),
          startupMs:   opts.startupMs,
        });
      }
    } catch (_) {}

    _tel('profile', { toolId: toolId, execMs: execMs });
  }

  // ── Get stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    _metrics.lookups++;
    var d = _data[toolId];
    if (!d) return null;
    return {
      toolId:        toolId,
      sessions:      d.sessions,
      startupMs:     _stats(d.startupMs),
      executionMs:   _stats(d.executionMs),
      memoryMb:      _stats(d.memoryMb),
      workerCount:   _stats(d.workerCount),
      thermalImpact: _stats(d.thermalImpact),
    };
  }

  function getAllStats() {
    return Object.keys(_data).map(function (id) { return getStats(id); }).filter(Boolean);
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:profiler:' + event, data, ['arc12', 'profiler']);
    } catch (_) {}
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolProfiler = Object.freeze({
    beginProfile: beginProfile,
    endProfile:   endProfile,
    getStats:     getStats,
    getAllStats:   getAllStats,
    getMetrics:   function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// RuntimeToolRecovery v1.0 — Arc 12 / Phase G / Enterprise Tool Intelligence Layer
// Tool-level recovery memory: tracks per-tool failure types and best recovery strategies.
// Integrates: RuntimeRecoveryMemory, RuntimeToolRegistry, RuntimeIncidentCenter,
//             RuntimeEventTimeline.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolRecovery) return;

  var LOG = '[ToolRecovery]';

  // ── State ─────────────────────────────────────────────────────────────────────
  // _history[toolId] = [{ failureType, recoveryUsed, success, durationMs, ts }, ...]
  var _history  = {};    // toolId → recovery records (cap 50 per tool)
  var _patterns = {};    // toolId → { failureType → { best, wins, total } }
  var _metrics  = { recorded: 0, recommended: 0 };
  var MAX_HIST  = 50;

  function _ensureTool(toolId) {
    if (!_history[toolId])  _history[toolId]  = [];
    if (!_patterns[toolId]) _patterns[toolId] = {};
  }

  // ── Record a recovery attempt ─────────────────────────────────────────────────
  // opts: { toolId, failureType, recoveryUsed, success, durationMs? }
  function recordRecovery(opts) {
    if (!opts || !opts.toolId) return;
    var toolId      = opts.toolId;
    var failureType = opts.failureType  || 'unknown';
    var recovery    = opts.recoveryUsed || 'default';
    var success     = !!opts.success;
    var durationMs  = opts.durationMs   || 0;

    _ensureTool(toolId);

    var entry = {
      failureType:  failureType,
      recoveryUsed: recovery,
      success:      success,
      durationMs:   durationMs,
      ts:           Date.now(),
    };

    _history[toolId].push(entry);
    if (_history[toolId].length > MAX_HIST) _history[toolId].shift();

    // Update per-tool pattern
    var pat = _patterns[toolId];
    if (!pat[failureType]) pat[failureType] = {};
    if (!pat[failureType][recovery]) pat[failureType][recovery] = { wins: 0, total: 0 };
    pat[failureType][recovery].total++;
    if (success) pat[failureType][recovery].wins++;

    _metrics.recorded++;

    // Also report to RuntimeRecoveryMemory for cross-tool learning
    try {
      var rm = G.RuntimeRecoveryMemory;
      if (rm && rm.recordOutcome) {
        rm.recordOutcome({
          strategy:   recovery,
          category:   failureType,
          outcome:    success ? 'success' : 'failure',
          durationMs: durationMs,
        });
      }
    } catch (_) {}

    _tel('record', { toolId: toolId, failureType: failureType, success: success });
  }

  // ── Get best recovery for a tool + failure type ───────────────────────────────
  function getBestRecovery(toolId, failureType) {
    _metrics.recommended++;

    // 1. Check per-tool learned patterns first
    _ensureTool(toolId);
    var pat = _patterns[toolId][failureType] || _patterns[toolId]['unknown'];
    if (pat) {
      var best = null;
      var bestRate = -1;
      Object.keys(pat).forEach(function (strategy) {
        var entry = pat[strategy];
        if (entry.total > 0) {
          var rate = entry.wins / entry.total;
          if (rate > bestRate || (rate === bestRate && entry.wins > (best ? pat[best].wins : 0))) {
            bestRate = rate;
            best     = strategy;
          }
        }
      });
      if (best && bestRate >= 0) {
        return { strategy: best, confidence: bestRate, source: 'tool-learned', toolId: toolId };
      }
    }

    // 2. Fall back to RuntimeRecoveryMemory (cross-tool)
    try {
      var rm = G.RuntimeRecoveryMemory;
      if (rm && rm.recommend) {
        var rec = rm.recommend(failureType || 'unknown');
        if (rec && rec.strategy) {
          return Object.assign({}, rec, { source: 'global-memory', toolId: toolId });
        }
      }
    } catch (_) {}

    return { strategy: 'default-reload', confidence: 0, source: 'fallback', toolId: toolId };
  }

  // ── History ───────────────────────────────────────────────────────────────────
  function getHistory(toolId, n) {
    var h = _history[toolId] || [];
    return h.slice(-(n || 10));
  }

  function getSuccessRate(toolId, failureType) {
    var h = (failureType
      ? (_history[toolId] || []).filter(function (r) { return r.failureType === failureType; })
      : (_history[toolId] || []));
    if (!h.length) return null;
    var wins = h.filter(function (r) { return r.success; }).length;
    return { rate: wins / h.length, wins: wins, total: h.length };
  }

  function getPatterns(toolId) {
    return JSON.parse(JSON.stringify(_patterns[toolId] || {}));
  }

  function getAllHistory() {
    var result = {};
    Object.keys(_history).forEach(function (id) { result[id] = _history[id].slice(); });
    return result;
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  function _tel(event, data) {
    try {
      var et = G.RuntimeEventTimeline;
      if (et && et.capture) et.capture('arc12:recovery:' + event, data, ['arc12', 'recovery']);
    } catch (_) {}
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolRecovery = Object.freeze({
    recordRecovery:  recordRecovery,
    getBestRecovery: getBestRecovery,
    getHistory:      getHistory,
    getSuccessRate:  getSuccessRate,
    getPatterns:     getPatterns,
    getAllHistory:    getAllHistory,
    getMetrics:      function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
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
// RuntimeToolExport v1.0 — Arc 12 / Phase J / Enterprise Tool Intelligence Layer
// Export layer: health reports, dependency graphs, tool statistics, prediction models.
// Formats: JSON and CSV.
// Integrates: RuntimeToolRegistry, RuntimeToolHealth, RuntimeToolDependencies,
//             RuntimeToolProfiler, RuntimeToolPredictor, RuntimeToolRecovery,
//             RuntimeToolOptimizer.
// Singleton guard — safe to concatenate in any bundle.

(function (G) {
  'use strict';
  if (G.RuntimeToolExport) return;

  var LOG = '[ToolExport]';

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function _get(global) { return G[global] || null; }

  function _csvRow(values) {
    return values.map(function (v) {
      var s = (v === null || v === undefined) ? '' : String(v);
      return s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',');
  }

  function _toCsv(rows, headers) {
    var lines = [headers.join(',')];
    rows.forEach(function (r) {
      lines.push(_csvRow(headers.map(function (h) { return r[h]; })));
    });
    return lines.join('\n');
  }

  // ── Health report ─────────────────────────────────────────────────────────────
  function exportHealth(format) {
    var reg    = _get('RuntimeToolRegistry');
    var health = _get('RuntimeToolHealth');
    if (!reg) return null;

    var tools  = reg.getAllTools();
    var levels = health ? health.getAllHealthLevels() : {};

    var rows = tools.map(function (t) {
      var h = levels[t.id] || {};
      return {
        id:          t.id,
        category:    t.category,
        healthScore: h.score  !== undefined ? h.score  : 100,
        healthLevel: h.level  || 'GOOD',
        launches:    t.launches,
        successes:   t.successes,
        failures:    t.failures,
        crashCount:  t.crashCount,
        startupMs:   t.startupMs,
        avgExecMs:   t.avgExecutionMs,
        avgMemMb:    t.avgMemoryMb,
        lastUsed:    t.lastUsed ? new Date(t.lastUsed).toISOString() : '',
      };
    });

    var result = {
      type:      'health-report',
      exportedAt: new Date().toISOString(),
      toolCount:  rows.length,
      data:       rows,
    };

    if (format === 'csv') {
      return _toCsv(rows, ['id','category','healthScore','healthLevel','launches',
                           'successes','failures','crashCount','startupMs','avgExecMs','avgMemMb','lastUsed']);
    }
    return JSON.stringify(result, null, 2);
  }

  // ── Dependency graph ──────────────────────────────────────────────────────────
  function exportDependencies(format) {
    var dep = _get('RuntimeToolDependencies');
    if (!dep) return null;

    var graph = dep.getGraph();

    if (format === 'csv') {
      var edgeRows = graph.edges.map(function (e) {
        return { from: e.from, to: e.to, type: e.type, addedAt: new Date(e.addedAt).toISOString() };
      });
      return _toCsv(edgeRows, ['from','to','type','addedAt']);
    }

    return JSON.stringify({
      type:       'dependency-graph',
      exportedAt: new Date().toISOString(),
      nodeCount:  graph.nodes.length,
      edgeCount:  graph.edges.length,
      graph:      graph,
    }, null, 2);
  }

  // ── Tool statistics ───────────────────────────────────────────────────────────
  function exportStats(format) {
    var prof = _get('RuntimeToolProfiler');
    if (!prof) return null;

    var stats = prof.getAllStats();

    if (format === 'csv') {
      var rows = stats.map(function (s) {
        return {
          toolId:      s.toolId,
          sessions:    s.sessions,
          startupP50:  s.startupMs.p50,
          startupP99:  s.startupMs.p99,
          execP50:     s.executionMs.p50,
          execP90:     s.executionMs.p90,
          execP99:     s.executionMs.p99,
          memP50:      s.memoryMb.p50,
          memP99:      s.memoryMb.p99,
        };
      });
      return _toCsv(rows, ['toolId','sessions','startupP50','startupP99',
                            'execP50','execP90','execP99','memP50','memP99']);
    }

    return JSON.stringify({
      type:       'tool-statistics',
      exportedAt: new Date().toISOString(),
      toolCount:  stats.length,
      data:       stats,
    }, null, 2);
  }

  // ── Prediction models ─────────────────────────────────────────────────────────
  function exportPredictions(format) {
    var pred = _get('RuntimeToolPredictor');
    if (!pred) return null;

    var sequences = pred.getTopSequences(50);
    var model     = pred.getModel();

    if (format === 'csv') {
      return _toCsv(sequences, ['from','to','count']);
    }

    return JSON.stringify({
      type:       'prediction-model',
      exportedAt: new Date().toISOString(),
      sequences:  sequences,
      model:      model,
    }, null, 2);
  }

  // ── Recovery history ──────────────────────────────────────────────────────────
  function exportRecovery(format) {
    var rec = _get('RuntimeToolRecovery');
    if (!rec) return null;

    var all = rec.getAllHistory();
    var rows = [];
    Object.keys(all).forEach(function (toolId) {
      all[toolId].forEach(function (entry) {
        rows.push({
          toolId:       toolId,
          failureType:  entry.failureType,
          recoveryUsed: entry.recoveryUsed,
          success:      entry.success,
          durationMs:   entry.durationMs,
          ts:           new Date(entry.ts).toISOString(),
        });
      });
    });

    if (format === 'csv') {
      return _toCsv(rows, ['toolId','failureType','recoveryUsed','success','durationMs','ts']);
    }

    return JSON.stringify({
      type:       'recovery-history',
      exportedAt: new Date().toISOString(),
      entryCount: rows.length,
      data:       rows,
    }, null, 2);
  }

  // ── Full export bundle ────────────────────────────────────────────────────────
  function exportAll(format) {
    var bundle = {
      type:       'arc12-full-export',
      exportedAt: new Date().toISOString(),
      health:     null,
      deps:       null,
      stats:      null,
      predictions: null,
      recovery:   null,
    };

    if (format === 'csv') {
      // CSV: return health as primary export for the bundle mode
      return exportHealth('csv');
    }

    try { bundle.health      = JSON.parse(exportHealth()      || 'null'); } catch (_) {}
    try { bundle.deps        = JSON.parse(exportDependencies() || 'null'); } catch (_) {}
    try { bundle.stats       = JSON.parse(exportStats()       || 'null'); } catch (_) {}
    try { bundle.predictions = JSON.parse(exportPredictions() || 'null'); } catch (_) {}
    try { bundle.recovery    = JSON.parse(exportRecovery()    || 'null'); } catch (_) {}

    return JSON.stringify(bundle, null, 2);
  }

  // ── Trigger browser download ──────────────────────────────────────────────────
  function download(data, filename, mime) {
    if (!data || typeof document === 'undefined') return;
    try {
      var blob = new Blob([data], { type: mime || 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = filename || 'arc12-export.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    } catch (e) { console.warn(LOG, 'download failed:', e.message); }
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  G.RuntimeToolExport = Object.freeze({
    exportHealth:       exportHealth,
    exportDependencies: exportDependencies,
    exportStats:        exportStats,
    exportPredictions:  exportPredictions,
    exportRecovery:     exportRecovery,
    exportAll:          exportAll,
    download:           download,
  });

  console.debug(LOG, 'ready');

}(typeof window !== 'undefined' ? window : this));
// PanelToolRegistry — Arc 12 debug panel
// Shows all registered tools with category, launch count, health level, and isolation state.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolRegistry) return;

  var STYLES = [
    '.ptr-table{width:100%;border-collapse:collapse;font-size:12px}',
    '.ptr-table th,.ptr-table td{padding:4px 8px;text-align:left;border-bottom:1px solid #333}',
    '.ptr-table th{background:#1e2030;color:#aaa;font-weight:600}',
    '.ptr-table tr:hover td{background:#1a1e2e}',
    '.ptr-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600}',
    '.ptr-badge.EXCELLENT{background:#14532d;color:#86efac}',
    '.ptr-badge.GOOD{background:#1e3a5f;color:#93c5fd}',
    '.ptr-badge.DEGRADED{background:#78350f;color:#fcd34d}',
    '.ptr-badge.CRITICAL{background:#7f1d1d;color:#fca5a5}',
    '.ptr-badge.isolated{background:#3b0764;color:#e9d5ff}',
    '.ptr-summary{display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap}',
    '.ptr-stat{background:#1e2030;border-radius:6px;padding:6px 12px;font-size:12px}',
    '.ptr-stat-val{font-size:20px;font-weight:700;color:#818cf8}',
  ].join('');

  function PanelToolRegistry(el) {
    this._el = el;
    this._styleInjected = false;
  }

  PanelToolRegistry.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolRegistry.prototype.refresh = function () {
    var reg  = G.RuntimeToolRegistry;
    var hlth = G.RuntimeToolHealth;
    var iso  = G.RuntimeToolIsolation;

    if (!reg) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolRegistry not loaded</p>';
      return;
    }

    var tools  = reg.getAllTools();
    var levels = hlth ? hlth.getAllHealthLevels() : {};
    var isolated = iso ? iso.getIsolated() : {};
    var regM   = reg.getMetrics();

    // Summary
    var counts = { EXCELLENT: 0, GOOD: 0, DEGRADED: 0, CRITICAL: 0 };
    tools.forEach(function (t) {
      var l = (levels[t.id] && levels[t.id].level) || 'GOOD';
      counts[l] = (counts[l] || 0) + 1;
    });

    var html = '<div class="ptr-summary">'
      + '<div class="ptr-stat"><div class="ptr-stat-val">' + tools.length + '</div>Tools</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#86efac">' + counts.EXCELLENT + '</div>Excellent</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#93c5fd">' + counts.GOOD + '</div>Good</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#fcd34d">' + counts.DEGRADED + '</div>Degraded</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#fca5a5">' + counts.CRITICAL + '</div>Critical</div>'
      + '<div class="ptr-stat"><div class="ptr-stat-val" style="color:#e9d5ff">' + Object.keys(isolated).length + '</div>Isolated</div>'
      + '</div>';

    // Table
    html += '<table class="ptr-table"><thead><tr>'
      + '<th>ID</th><th>Category</th><th>Launches</th><th>Failures</th>'
      + '<th>Crashes</th><th>Health</th><th>Startup ms</th><th>Status</th>'
      + '</tr></thead><tbody>';

    tools.sort(function (a, b) { return b.launches - a.launches; }).forEach(function (t) {
      var lvl  = (levels[t.id] && levels[t.id].level) || 'GOOD';
      var sc   = (levels[t.id] && levels[t.id].score !== undefined) ? levels[t.id].score : '—';
      var isol = !!isolated['tool:' + t.id] || !!isolated[t.id];
      html += '<tr>'
        + '<td style="font-family:monospace">' + t.id + '</td>'
        + '<td>' + t.category + '</td>'
        + '<td>' + t.launches + '</td>'
        + '<td>' + t.failures + '</td>'
        + '<td>' + t.crashCount + '</td>'
        + '<td><span class="ptr-badge ' + lvl + '">' + sc + ' ' + lvl + '</span></td>'
        + '<td>' + (t.startupMs || '—') + '</td>'
        + '<td>' + (isol ? '<span class="ptr-badge isolated">ISOLATED</span>' : '<span style="color:#6b7280">active</span>') + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += '<p style="font-size:11px;color:#6b7280;margin-top:8px">Registered: ' + regM.registered + ' | Updated: ' + regM.updated + ' | Lookups: ' + regM.lookups + '</p>';
    this._el.innerHTML = html;
  };

  G.PanelToolRegistry = PanelToolRegistry;

}(typeof window !== 'undefined' ? window : this));
// PanelToolHealth — Arc 12 debug panel
// Shows live health scores, failure rates, crash counts, and recovery frequency per tool.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolHealth) return;

  var STYLES = [
    '.pth-bar{height:8px;border-radius:4px;background:#1e2030;overflow:hidden;margin-top:3px}',
    '.pth-bar-fill{height:100%;border-radius:4px;transition:width .4s}',
    '.pth-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px}',
    '.pth-card{background:#1e2030;border-radius:8px;padding:10px;border:1px solid #2d3150}',
    '.pth-card-id{font-family:monospace;font-size:11px;color:#818cf8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pth-card-score{font-size:24px;font-weight:700;margin-bottom:2px}',
    '.pth-card-level{font-size:11px;font-weight:600;margin-bottom:6px}',
    '.pth-card-stats{font-size:11px;color:#9ca3af;display:flex;gap:8px;flex-wrap:wrap}',
    '.pth-filter{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
    '.pth-filter-btn{padding:3px 10px;border-radius:4px;border:1px solid #374151;background:transparent;color:#9ca3af;cursor:pointer;font-size:12px}',
    '.pth-filter-btn.active{background:#3730a3;border-color:#6366f1;color:#fff}',
  ].join('');

  var LEVEL_COLORS = {
    EXCELLENT: '#86efac',
    GOOD:      '#93c5fd',
    DEGRADED:  '#fcd34d',
    CRITICAL:  '#fca5a5',
  };

  function PanelToolHealth(el) {
    this._el     = el;
    this._filter = 'ALL';
    this._styleInjected = false;
  }

  PanelToolHealth.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolHealth.prototype.refresh = function () {
    var self  = this;
    var hlth  = G.RuntimeToolHealth;
    var reg   = G.RuntimeToolRegistry;

    if (!hlth || !reg) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolHealth not loaded</p>';
      return;
    }

    var levels = hlth.getAllHealthLevels();
    var tools  = reg.getAllTools();
    var summary = hlth.getHealthSummary();

    // Filter buttons
    var html = '<div class="pth-filter">';
    ['ALL','EXCELLENT','GOOD','DEGRADED','CRITICAL'].forEach(function (f) {
      html += '<button class="pth-filter-btn' + (self._filter === f ? ' active' : '')
            + '" data-filter="' + f + '">' + f
            + (f !== 'ALL' ? ' (' + (summary.counts[f] || 0) + ')' : ' (' + tools.length + ')')
            + '</button>';
    });
    html += '</div>';

    // Cards
    html += '<div class="pth-grid">';
    tools
      .filter(function (t) {
        if (self._filter === 'ALL') return true;
        var l = (levels[t.id] && levels[t.id].level) || 'GOOD';
        return l === self._filter;
      })
      .sort(function (a, b) {
        var sa = (levels[a.id] && levels[a.id].score) || 100;
        var sb = (levels[b.id] && levels[b.id].score) || 100;
        return sa - sb;  // worst first
      })
      .forEach(function (t) {
        var h    = levels[t.id] || { score: 100, level: 'GOOD' };
        var color = LEVEL_COLORS[h.level] || '#93c5fd';
        var pct  = h.score + '%';
        html += '<div class="pth-card">'
          + '<div class="pth-card-id">' + t.id + '</div>'
          + '<div class="pth-card-score" style="color:' + color + '">' + h.score + '</div>'
          + '<div class="pth-card-level" style="color:' + color + '">' + h.level + '</div>'
          + '<div class="pth-bar"><div class="pth-bar-fill" style="width:' + pct + ';background:' + color + '"></div></div>'
          + '<div class="pth-card-stats" style="margin-top:6px">'
          + '<span>💥 ' + t.crashCount + ' crashes</span>'
          + '<span>❌ ' + t.failures + ' fails</span>'
          + '<span>🚀 ' + t.launches + ' runs</span>'
          + '</div></div>';
      });
    html += '</div>';

    this._el.innerHTML = html;

    // Filter button event delegation
    this._el.querySelectorAll('.pth-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self._filter = this.dataset.filter;
        self.refresh();
      });
    });
  };

  G.PanelToolHealth = PanelToolHealth;

}(typeof window !== 'undefined' ? window : this));
// PanelToolPredictor — Arc 12 debug panel
// Shows learned tool-to-tool transition sequences and next-tool prediction results.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolPredictor) return;

  var STYLES = [
    '.ptp-two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}',
    '.ptp-section{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150}',
    '.ptp-section h4{margin:0 0 8px;font-size:13px;color:#818cf8}',
    '.ptp-seq-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #2d3150;font-size:12px}',
    '.ptp-seq-from{font-family:monospace;color:#c4b5fd;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ptp-seq-to{font-family:monospace;color:#86efac;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ptp-seq-count{color:#6b7280;font-size:11px;white-space:nowrap}',
    '.ptp-pred-input{display:flex;gap:6px;margin-bottom:8px}',
    '.ptp-pred-input input{flex:1;background:#111827;border:1px solid #374151;color:#e5e7eb;padding:4px 8px;border-radius:4px;font-size:12px}',
    '.ptp-pred-input button{padding:4px 10px;background:#3730a3;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:12px}',
    '.ptp-pred-result{font-size:12px}',
    '.ptp-pred-item{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #2d3150}',
    '.ptp-pred-tool{font-family:monospace;color:#93c5fd}',
    '.ptp-pred-src{color:#6b7280;font-size:11px}',
    '.ptp-hist{font-size:12px;color:#9ca3af;font-family:monospace;line-height:2}',
  ].join('');

  function PanelToolPredictor(el) {
    this._el = el;
    this._queryTool = '';
    this._queryResult = null;
    this._styleInjected = false;
  }

  PanelToolPredictor.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolPredictor.prototype.refresh = function () {
    var self  = this;
    var pred  = G.RuntimeToolPredictor;

    if (!pred) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolPredictor not loaded</p>';
      return;
    }

    var sequences = pred.getTopSequences(15);
    var history   = pred.getHistory();
    var metrics   = pred.getMetrics();

    var html = '<div class="ptp-two-col">';

    // Left: top sequences
    html += '<div class="ptp-section"><h4>📊 Top Learned Sequences</h4>';
    if (sequences.length === 0) {
      html += '<p style="color:#6b7280;font-size:12px">No sequences recorded yet</p>';
    } else {
      sequences.forEach(function (s) {
        html += '<div class="ptp-seq-row">'
          + '<span class="ptp-seq-from">' + s.from + '</span>'
          + '<span style="color:#6b7280">→</span>'
          + '<span class="ptp-seq-to">' + s.to + '</span>'
          + '<span class="ptp-seq-count">×' + s.count + '</span>'
          + '</div>';
      });
    }
    html += '</div>';

    // Right: prediction query
    html += '<div class="ptp-section"><h4>🔮 Predict Next Tool</h4>';
    html += '<div class="ptp-pred-input">'
      + '<input id="ptp-query-input" type="text" placeholder="e.g. merge-pdf" value="' + this._queryTool + '">'
      + '<button id="ptp-query-btn">Predict</button>'
      + '</div>';

    if (this._queryResult && this._queryResult.length > 0) {
      html += '<div class="ptp-pred-result">';
      this._queryResult.forEach(function (p) {
        html += '<div class="ptp-pred-item">'
          + '<span class="ptp-pred-tool">' + p.toolId + '</span>'
          + '<span><span class="ptp-pred-src">' + p.source + '</span>'
          + ' <span style="color:#818cf8">score:' + p.score + '</span></span>'
          + '</div>';
      });
      html += '</div>';
    } else if (this._queryResult) {
      html += '<p style="color:#6b7280;font-size:12px">No predictions for "' + this._queryTool + '"</p>';
    }
    html += '</div>';

    html += '</div>';  // two-col

    // Recent history
    html += '<div class="ptp-section"><h4>🕐 Recent Tool History</h4>'
      + '<div class="ptp-hist">'
      + (history.length ? history.join(' → ') : '<span style="color:#6b7280">No history yet</span>')
      + '</div></div>';

    html += '<p style="font-size:11px;color:#6b7280;margin-top:8px">Recorded: '
      + metrics.recorded + ' | Predicted: ' + metrics.predicted + '</p>';

    this._el.innerHTML = html;

    // Wire predict button
    var btn   = this._el.querySelector('#ptp-query-btn');
    var input = this._el.querySelector('#ptp-query-input');
    if (btn && input) {
      btn.addEventListener('click', function () {
        self._queryTool   = input.value.trim();
        self._queryResult = pred.predictNextTool(self._queryTool);
        self.refresh();
      });
    }
  };

  G.PanelToolPredictor = PanelToolPredictor;

}(typeof window !== 'undefined' ? window : this));
// PanelToolRecovery — Arc 12 debug panel
// Shows per-tool recovery history, success rates, and best recovery strategy per tool.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolRecovery) return;

  var STYLES = [
    '.ptr2-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px}',
    '.ptr2-table th,.ptr2-table td{padding:5px 8px;text-align:left;border-bottom:1px solid #333}',
    '.ptr2-table th{background:#1e2030;color:#aaa;font-weight:600}',
    '.ptr2-table tr:hover td{background:#1a1e2e}',
    '.ptr2-hist{max-height:200px;overflow-y:auto;background:#111827;border-radius:6px;padding:8px;font-size:11px;font-family:monospace;margin-top:8px}',
    '.ptr2-hist-row{padding:2px 0;border-bottom:1px solid #1f2937;display:flex;gap:8px}',
    '.ptr2-ok{color:#86efac}',
    '.ptr2-fail{color:#fca5a5}',
    '.ptr2-section{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150;margin-bottom:10px}',
    '.ptr2-section h4{margin:0 0 8px;font-size:13px;color:#818cf8}',
    '.ptr2-rate-bar{height:6px;border-radius:3px;background:#374151;overflow:hidden;margin-top:2px;width:100px;display:inline-block;vertical-align:middle}',
    '.ptr2-rate-fill{height:100%;border-radius:3px;background:#22c55e}',
  ].join('');

  function PanelToolRecovery(el) {
    this._el = el;
    this._selected = null;
    this._styleInjected = false;
  }

  PanelToolRecovery.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolRecovery.prototype.refresh = function () {
    var self  = this;
    var rec   = G.RuntimeToolRecovery;
    var reg   = G.RuntimeToolRegistry;

    if (!rec) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolRecovery not loaded</p>';
      return;
    }

    var allHistory = rec.getAllHistory();
    var tools      = Object.keys(allHistory);
    var metrics    = rec.getMetrics();

    var html = '<div class="ptr2-section"><h4>🔧 Per-Tool Best Recovery Strategy</h4>';

    if (!tools.length) {
      html += '<p style="color:#6b7280;font-size:12px">No recovery records yet.</p>';
    } else {
      html += '<table class="ptr2-table"><thead><tr>'
        + '<th>Tool ID</th><th>Attempts</th><th>Success Rate</th><th>Best Strategy</th>'
        + '</tr></thead><tbody>';

      tools.forEach(function (toolId) {
        var rate = rec.getSuccessRate(toolId);
        var best = rec.getBestRecovery(toolId, null);
        var pct  = rate ? Math.round(rate.rate * 100) : 0;
        html += '<tr style="cursor:pointer" data-tool="' + toolId + '">'
          + '<td style="font-family:monospace;color:#c4b5fd">' + toolId + '</td>'
          + '<td>' + (rate ? rate.total : 0) + '</td>'
          + '<td>'
          + '<div class="ptr2-rate-bar"><div class="ptr2-rate-fill" style="width:' + pct + '%"></div></div>'
          + ' <span style="color:' + (pct >= 70 ? '#86efac' : pct >= 40 ? '#fcd34d' : '#fca5a5') + '">' + pct + '%</span>'
          + '</td>'
          + '<td style="font-family:monospace;font-size:11px;color:#93c5fd">'
          + (best ? best.strategy : '—') + ' <span style="color:#6b7280">(' + (best ? best.source : '') + ')</span>'
          + '</td>'
          + '</tr>';
      });

      html += '</tbody></table>';
    }
    html += '</div>';

    // Recent entries for selected tool or all
    var displayTool = this._selected && allHistory[this._selected] ? this._selected : (tools[0] || null);
    if (displayTool) {
      var entries = allHistory[displayTool] || [];
      html += '<div class="ptr2-section"><h4>📜 Recovery Log — ' + displayTool + '</h4>'
        + '<div class="ptr2-hist">';
      if (!entries.length) {
        html += '<span style="color:#6b7280">No entries</span>';
      } else {
        entries.slice().reverse().slice(0, 20).forEach(function (e) {
          html += '<div class="ptr2-hist-row">'
            + '<span class="' + (e.success ? 'ptr2-ok' : 'ptr2-fail') + '">'
            + (e.success ? '✓' : '✗') + '</span>'
            + '<span style="color:#818cf8">' + e.failureType + '</span>'
            + '<span style="color:#e5e7eb">' + e.recoveryUsed + '</span>'
            + '<span style="color:#6b7280">' + e.durationMs + 'ms</span>'
            + '</div>';
        });
      }
      html += '</div></div>';
    }

    html += '<p style="font-size:11px;color:#6b7280">Recorded: ' + metrics.recorded + ' | Recommended: ' + metrics.recommended + '</p>';
    this._el.innerHTML = html;

    // Row click to select tool
    this._el.querySelectorAll('tr[data-tool]').forEach(function (row) {
      row.addEventListener('click', function () {
        self._selected = this.dataset.tool;
        self.refresh();
      });
    });
  };

  G.PanelToolRecovery = PanelToolRecovery;

}(typeof window !== 'undefined' ? window : this));
// PanelToolOptimizer — Arc 12 debug panel
// Shows tool startup optimization: preloaded tools, dormant tools, and estimated savings.
// Lazy-loaded by RuntimeDebugShell when the tab is first activated.

(function (G) {
  'use strict';
  if (G.PanelToolOptimizer) return;

  var STYLES = [
    '.pto-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:14px}',
    '.pto-stat{background:#1e2030;border-radius:8px;padding:12px;border:1px solid #2d3150;text-align:center}',
    '.pto-stat-val{font-size:28px;font-weight:700;color:#818cf8}',
    '.pto-stat-label{font-size:12px;color:#9ca3af;margin-top:2px}',
    '.pto-tiers{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}',
    '.pto-tier{background:#1e2030;border-radius:8px;padding:10px;border:1px solid #2d3150}',
    '.pto-tier h4{margin:0 0 6px;font-size:12px;font-weight:600}',
    '.pto-tier-hot h4{color:#f97316}',
    '.pto-tier-warm h4{color:#facc15}',
    '.pto-tier-cold h4{color:#60a5fa}',
    '.pto-tier-dormant h4{color:#9ca3af}',
    '.pto-list{font-size:11px;font-family:monospace;color:#e5e7eb;line-height:1.8}',
    '.pto-list .empty{color:#6b7280}',
    '.pto-savings{background:#0f2d1f;border:1px solid #16a34a;border-radius:8px;padding:12px;margin-bottom:12px}',
    '.pto-savings-val{font-size:22px;font-weight:700;color:#86efac}',
    '.pto-savings-label{font-size:12px;color:#4ade80}',
  ].join('');

  var TIER_LABELS = {
    hot:     '🔥 Hot (Preloaded)',
    warm:    '♨️ Warm (Predicted)',
    cold:    '❄️ Cold (On-demand)',
    dormant: '💤 Dormant (Unloading)',
  };

  function PanelToolOptimizer(el) {
    this._el = el;
    this._styleInjected = false;
  }

  PanelToolOptimizer.prototype.init = function () {
    if (!this._styleInjected) {
      var s = document.createElement('style');
      s.textContent = STYLES;
      document.head.appendChild(s);
      this._styleInjected = true;
    }
    this.refresh();
  };

  PanelToolOptimizer.prototype.refresh = function () {
    var opt = G.RuntimeToolOptimizer;
    var reg = G.RuntimeToolRegistry;

    if (!opt) {
      this._el.innerHTML = '<p style="color:#6b7280;padding:16px">RuntimeToolOptimizer not loaded</p>';
      return;
    }

    var classes   = opt.getClassifications();
    var preloaded = opt.getPreloaded();
    var metrics   = opt.getMetrics();
    var savings   = opt.estimateSavingsMs();

    var hot     = opt.getByTier('hot');
    var warm    = opt.getByTier('warm');
    var cold    = opt.getByTier('cold');
    var dormant = opt.getByTier('dormant');
    var total   = Object.keys(classes).length;

    // Summary stats
    var html = '<div class="pto-grid">'
      + _stat(total,           'Total Tools',        '#818cf8')
      + _stat(hot.length,      '🔥 Hot',             '#f97316')
      + _stat(warm.length,     '♨️ Warm',            '#facc15')
      + _stat(dormant.length,  '💤 Dormant',         '#9ca3af')
      + _stat(preloaded.length,'Preloaded',           '#86efac')
      + '</div>';

    // Savings
    var savingsSec = (savings / 1000).toFixed(1);
    html += '<div class="pto-savings">'
      + '<div class="pto-savings-val">' + savingsSec + 's</div>'
      + '<div class="pto-savings-label">Estimated total startup savings (hot tool preloading)</div>'
      + '</div>';

    // Tier breakdown
    html += '<div class="pto-tiers">';
    [
      { tier: 'hot',     tools: hot,     cls: 'pto-tier-hot'     },
      { tier: 'warm',    tools: warm,    cls: 'pto-tier-warm'    },
      { tier: 'cold',    tools: cold,    cls: 'pto-tier-cold'    },
      { tier: 'dormant', tools: dormant, cls: 'pto-tier-dormant' },
    ].forEach(function (group) {
      html += '<div class="pto-tier ' + group.cls + '"><h4>' + TIER_LABELS[group.tier] + ' (' + group.tools.length + ')</h4>'
        + '<div class="pto-list">';
      if (!group.tools.length) {
        html += '<span class="empty">none</span>';
      } else {
        group.tools.slice(0, 8).forEach(function (id) {
          html += id + '<br>';
        });
        if (group.tools.length > 8) html += '<span style="color:#6b7280">… +' + (group.tools.length - 8) + ' more</span>';
      }
      html += '</div></div>';
    });
    html += '</div>';

    // Metrics
    html += '<p style="font-size:11px;color:#6b7280">Preloaded: ' + metrics.preloaded
      + ' | Unloaded: ' + metrics.unloaded
      + ' | Warmed: '   + metrics.warmed
      + ' | Classified: ' + metrics.classified
      + '</p>';

    this._el.innerHTML = html;
  };

  function _stat(val, label, color) {
    return '<div class="pto-stat">'
      + '<div class="pto-stat-val" style="color:' + (color || '#818cf8') + '">' + val + '</div>'
      + '<div class="pto-stat-label">' + label + '</div>'
      + '</div>';
  }

  G.PanelToolOptimizer = PanelToolOptimizer;

}(typeof window !== 'undefined' ? window : this));
