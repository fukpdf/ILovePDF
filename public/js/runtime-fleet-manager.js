(function (G) {
  'use strict';
  if (G.RuntimeFleetManager) return;

  var LOG = '[Arc14:FleetManager]';

  // Known controllable subsystem IDs (maps to RuntimeCommandCenter subsystem ids)
  var _state   = {};   // subsystemId → { paused, isolated, lastAction, lastActionTs }
  var _metrics = { paused: 0, resumed: 0, restarted: 0, isolated: 0, quarantined: 0 };

  function _entry(id) {
    if (!_state[id]) _state[id] = { paused: false, isolated: false, lastAction: null, lastActionTs: 0 };
    return _state[id];
  }

  function _log(id, action, detail) {
    var s = _entry(id);
    s.lastAction   = action;
    s.lastActionTs = Date.now();
    console.debug(LOG, action + ':', id, detail || '');
    try {
      G.dispatchEvent(new CustomEvent('arc14:fleet-action', {
        detail: { subsystem: id, action: action, detail: detail, ts: s.lastActionTs },
      }));
    } catch (_) {}
  }

  // ── Pause ────────────────────────────────────────────────────────────────────
  function pause(subsystemId, reason) {
    var s = _entry(subsystemId);
    if (s.paused) return { ok: false, reason: 'already paused' };
    s.paused = true;
    _metrics.paused++;
    _log(subsystemId, 'pause', reason || '');
    // If it's a circuit-breaker target, open the breaker
    var cb = G.RuntimeToolCircuitBreaker;
    if (cb && cb.recordFailure) {
      try { cb.recordFailure(subsystemId, { crash: false }); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Resume ───────────────────────────────────────────────────────────────────
  function resume(subsystemId) {
    var s = _entry(subsystemId);
    s.paused = false;
    _metrics.resumed++;
    _log(subsystemId, 'resume');
    return { ok: true };
  }

  // ── Restart ──────────────────────────────────────────────────────────────────
  function restart(subsystemId) {
    var s = _entry(subsystemId);
    s.paused   = false;
    s.isolated = false;
    _metrics.restarted++;
    _log(subsystemId, 'restart');
    // For tool isolation: attempt restore
    var iso = G.RuntimeToolIsolation;
    if (iso && iso.restoreTool) {
      try { iso.restoreTool(subsystemId); } catch (_) {}
    }
    // For circuit-breaker: can't force-close, but record a success probe
    var cb = G.RuntimeToolCircuitBreaker;
    if (cb && cb.recordSuccess) {
      try { cb.recordSuccess(subsystemId); cb.recordSuccess(subsystemId); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Isolate ──────────────────────────────────────────────────────────────────
  function isolate(subsystemId, reason) {
    var s = _entry(subsystemId);
    s.isolated = true;
    _metrics.isolated++;
    _log(subsystemId, 'isolate', reason || '');
    var iso = G.RuntimeToolIsolation;
    if (iso && iso.isolateTool) {
      try { iso.isolateTool(subsystemId, reason || 'arc14:fleet-isolate'); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Quarantine ───────────────────────────────────────────────────────────────
  function quarantine(subsystemId, reason) {
    var s = _entry(subsystemId);
    s.paused   = true;
    s.isolated = true;
    _metrics.quarantined++;
    _log(subsystemId, 'quarantine', reason || '');
    var gov = G.RuntimeGovernance;
    if (gov && gov.quarantine) {
      try { gov.quarantine(subsystemId, reason || 'arc14:fleet-quarantine'); } catch (_) {}
    }
    return { ok: true };
  }

  // ── Status ───────────────────────────────────────────────────────────────────
  function getStatus(subsystemId) {
    var s = _entry(subsystemId);
    var glob = subsystemId.split('-').map(function (p, i) {
      return i === 0 ? 'Runtime' + p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1);
    }).join('');
    return {
      subsystem:   subsystemId,
      paused:      s.paused,
      isolated:    s.isolated,
      present:     !!G[glob],
      lastAction:  s.lastAction,
      lastActionTs: s.lastActionTs,
    };
  }

  function getFleetStatus() {
    var cc  = G.RuntimeCommandCenter;
    var subs = cc && cc.getSubsystems ? cc.getSubsystems() : [];
    return subs.map(function (sub) {
      var s = _entry(sub.id);
      return Object.assign({}, sub, {
        paused:      s.paused,
        isolated:    s.isolated,
        lastAction:  s.lastAction,
        lastActionTs: s.lastActionTs,
      });
    });
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeFleetManager = Object.freeze({
    pause:          pause,
    resume:         resume,
    restart:        restart,
    isolate:        isolate,
    quarantine:     quarantine,
    getStatus:      getStatus,
    getFleetStatus: getFleetStatus,
    getMetrics:     getMetrics,
  });

}(typeof window !== 'undefined' ? window : this));
