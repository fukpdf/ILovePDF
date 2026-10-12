// RuntimeRecoveryFirewalls v1.0 — Arc 5 / Phase D / Target 4
// =====================================================================
// Per-tool recovery escalation tree + independent retry budgets.
//
// Arc 3 gap: RuntimeRecoveryDomains has per-tool circuit breakers, but
// the escalation is flat (isolate/restart/reload). There are no retry
// budgets — a tool exhausts retries and either stays broken or escalates
// to a page reload that can affect ALL tools. There is no independent
// recovery telemetry per tool.
//
// Solution: Each tool gets an independent recovery escalation tree:
//
//   Level 0 (isolate): show warning badge, retry up to RETRY_L0 times
//   Level 1 (restart): terminate + respawn only this tool's workers
//   Level 2 (degrade): disable tool UI, show graceful degradation banner
//   Level 3 (quarantine): fully isolate — tool unavailable until reset
//
// Each level has an independent retry budget (countdown counter).
// When a level's budget is exhausted, escalation moves to level+1.
// NO path leads to a global page reload.
//
// Independent recovery telemetry: every escalation is recorded per tool
// and reported to RuntimeAnalyticsDomains + RuntimeIncidentEngine.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryFirewalls) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[RecoveryFW]';
  var VERSION = '1.0';

  // ── Escalation level definitions ──────────────────────────────────────────
  var LEVELS = [
    { name: 'isolate',    retries: 3, action: '_isolate'    },
    { name: 'restart',    retries: 2, action: '_restart'    },
    { name: 'degrade',    retries: 1, action: '_degrade'    },
    { name: 'quarantine', retries: 0, action: '_quarantine' },
  ];

  // ── Per-tool recovery state ───────────────────────────────────────────────
  // toolId → { level, budgets: [3,2,1,0], escalationCount, telemetry }
  var _states = {};

  function _ensure(toolId) {
    if (!_states[toolId]) {
      _states[toolId] = {
        toolId:          toolId,
        level:           0,
        budgets:         [3, 2, 1, 0],
        escalationCount: 0,
        failCount:       0,
        lastFailAt:      null,
        telemetry:       [],
      };
    }
    return _states[toolId];
  }

  // ── Record telemetry (capped ring) ────────────────────────────────────────
  function _tele(state, event, detail) {
    state.telemetry.push({ ts: Date.now(), event: event, level: state.level, detail: detail || {} });
    if (state.telemetry.length > 50) state.telemetry.shift();
  }

  // ── Escalation level actions ──────────────────────────────────────────────
  function _isolate(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:isolate', { detail: { toolId: toolId } }));
    } catch (_) {}
    // Ensure circuit is open in RuntimeRecoveryDomains
    try { var rd = G.RuntimeRecoveryDomains; if (rd) rd.openCircuit(toolId); } catch (_) {}
  }

  function _restart(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:restart', { detail: { toolId: toolId } }));
    } catch (_) {}
    // Terminate only this tool's workers via WorkerMesh
    try {
      var mesh = G.RuntimeToolWorkerMesh;
      var node = mesh && mesh.getNode(toolId);
      if (node && node.workerUrl) {
        var wp = G.WorkerPool;
        if (wp && typeof wp.terminatePool === 'function') wp.terminatePool(node.workerUrl);
      }
    } catch (_) {}
    // Signal memory firewall to reclaim
    try {
      var mf = G.RuntimeMemoryFirewalls;
      if (mf) mf.panic(toolId, 'recovery-restart');
    } catch (_) {}
  }

  function _degrade(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:degrade', {
        detail: { toolId: toolId, message: 'Tool is temporarily degraded. Please try again.' },
      }));
    } catch (_) {}
    console.debug(LOG, 'tool degraded:', toolId);
  }

  function _quarantine(toolId) {
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:quarantine', {
        detail: { toolId: toolId, message: 'Tool is unavailable. Please refresh the page.' },
      }));
    } catch (_) {}
    // Report to incident engine
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report({ type: 'tool-quarantined', toolId: toolId, ts: Date.now() });
      }
    } catch (_) {}
    console.debug(LOG, 'tool QUARANTINED:', toolId);
  }

  // ── Perform escalation action ─────────────────────────────────────────────
  var _actions = { '_isolate': _isolate, '_restart': _restart, '_degrade': _degrade, '_quarantine': _quarantine };

  function _doEscalation(toolId, state) {
    var lvl    = LEVELS[state.level] || LEVELS[LEVELS.length - 1];
    var action = _actions[lvl.action];
    if (action) action(toolId);
    state.escalationCount++;
    _tele(state, 'escalate', { levelName: lvl.name });

    // Report analytics
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) ad.record(toolId, 'recovery-escalate', { level: lvl.name, escalationCount: state.escalationCount });
    } catch (_) {}
  }

  // ── Record a failure for a tool ───────────────────────────────────────────
  function recordFailure(toolId, reason) {
    var state = _ensure(toolId);
    state.failCount++;
    state.lastFailAt = Date.now();
    _tele(state, 'fail', { reason: reason });

    var budgets = state.budgets;
    // Check current level budget
    if (budgets[state.level] > 0) {
      budgets[state.level]--;
      _doEscalation(toolId, state);
    } else {
      // Budget exhausted — escalate to next level
      if (state.level < LEVELS.length - 1) {
        state.level++;
        // Reset new level's budget
        budgets[state.level] = LEVELS[state.level].retries;
        console.debug(LOG, 'escalating to level', state.level, ':', LEVELS[state.level].name, '— tool:', toolId);
        _doEscalation(toolId, state);
      } else {
        // Already at maximum — quarantine
        _quarantine(toolId);
        _tele(state, 'quarantined', {});
      }
    }
  }

  // ── Reset recovery state ──────────────────────────────────────────────────
  function reset(toolId) {
    var state = _ensure(toolId);
    state.level   = 0;
    state.budgets = [3, 2, 1, 0];
    state.failCount = 0;
    _tele(state, 'reset', {});
    // Close circuit in RuntimeRecoveryDomains
    try { var rd = G.RuntimeRecoveryDomains; if (rd) rd.closeCircuit(toolId); } catch (_) {}
    // Reset mesh node
    try { var mesh = G.RuntimeToolWorkerMesh; if (mesh) mesh.resetTool(toolId); } catch (_) {}
    console.debug(LOG, 'recovery reset:', toolId);
    try {
      G.dispatchEvent(new CustomEvent('recovery-fw:reset', { detail: { toolId: toolId } }));
    } catch (_) {}
  }

  // ── Listen for worker mesh crash events ───────────────────────────────────
  G.addEventListener('tool-mesh:crash', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) recordFailure(toolId, 'worker-crash');
    } catch (_) {}
  });

  G.addEventListener('tool-mesh:isolated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) recordFailure(toolId, 'tool-isolated');
    } catch (_) {}
  });

  G.RuntimeRecoveryFirewalls = Object.freeze({
    VERSION:       VERSION,
    recordFailure: recordFailure,
    reset:         reset,
    getState:      function (toolId) {
      var s = _states[toolId];
      if (!s) return null;
      var lvl = LEVELS[s.level] || LEVELS[LEVELS.length - 1];
      return {
        toolId:          s.toolId,
        level:           s.level,
        levelName:       lvl.name,
        budgets:         s.budgets.slice(),
        failCount:       s.failCount,
        escalationCount: s.escalationCount,
      };
    },
    getAllStates: function () {
      var out = {};
      Object.keys(_states).forEach(function (k) { out[k] = G.RuntimeRecoveryFirewalls.getState(k); });
      return out;
    },
    getTelemetry: function (toolId) {
      var s = _states[toolId];
      return s ? s.telemetry.slice() : [];
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool recovery escalation trees active');

}(window));
