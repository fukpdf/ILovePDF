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
