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
