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
