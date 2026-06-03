// RuntimeAutomationEngine v1.0 — Arc 15 / Phase B
// =============================================================================
// Automated action execution engine. Receives action requests from the policy
// engine, workflow engine, and autonomous ops, then routes them to the correct
// Arc 8–14 subsystems.
//
// Actions:
//   restart-subsystem    — via RuntimeFleetManager.restart()
//   pause-subsystem      — via RuntimeFleetManager.pause()
//   resume-subsystem     — via RuntimeFleetManager.resume()
//   quarantine-subsystem — via RuntimeFleetManager.quarantine()
//   run-recovery         — via RuntimeRecoveryOrchestrator.recover()
//   clear-alerts         — via RuntimeAlerts.acknowledgeAll()
//   escalate-incident    — via RuntimeIncidentCenter (raise P1)
//   log                  — console.debug only
//
// Events dispatched:
//   arc15:action-executed  — { actionId, type, target, status, ts, durationMs }
//   arc15:action-queued    — { actionId, type, target, scheduledAt }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAutomationEngine) return;

  var LOG = '[Arc15:AutomationEngine]';

  var _queue   = [];      // pending scheduled actions
  var _running = {};      // actionId → { type, target, startTs }
  var _history = [];      // completed actions (last 500)
  var MAX_HIST = 500;
  var _seq     = 0;

  var _metrics = {
    executed: 0, succeeded: 0, failed: 0, queued: 0, cancelled: 0,
    byType: {},
  };

  function _id()  { return 'act-' + (++_seq); }
  function _ts()  { return Date.now(); }

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Action handlers ────────────────────────────────────────────────────────
  var HANDLERS = {
    'restart-subsystem': function (target) {
      var fm = G.RuntimeFleetManager;
      if (!fm || !fm.restart) return { ok: false, reason: 'FleetManager not available' };
      return fm.restart(target) || { ok: true };
    },
    'pause-subsystem': function (target) {
      var fm = G.RuntimeFleetManager;
      if (!fm || !fm.pause) return { ok: false, reason: 'FleetManager not available' };
      return fm.pause(target, 'automation-policy') || { ok: true };
    },
    'resume-subsystem': function (target) {
      var fm = G.RuntimeFleetManager;
      if (!fm || !fm.resume) return { ok: false, reason: 'FleetManager not available' };
      return fm.resume(target) || { ok: true };
    },
    'quarantine-subsystem': function (target) {
      var fm = G.RuntimeFleetManager;
      if (!fm || !fm.quarantine) return { ok: false, reason: 'FleetManager not available' };
      return fm.quarantine(target, 'policy-enforcement') || { ok: true };
    },
    'run-recovery': function (target) {
      var ro = G.RuntimeRecoveryOrchestrator;
      if (!ro || !ro.recoverSubsystem) return { ok: false, reason: 'RecoveryOrchestrator not available' };
      try { ro.recoverSubsystem(target || 'memory'); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    },
    'clear-alerts': function () {
      var alt = G.RuntimeAlerts;
      if (!alt || !alt.acknowledgeAll) return { ok: false, reason: 'Alerts not available' };
      try { alt.acknowledgeAll(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    },
    'escalate-incident': function (target, opts) {
      var ic = G.RuntimeIncidentCenter;
      if (!ic || !ic.createIncident) {
        var alt = G.RuntimeAlerts;
        if (!alt || !alt.raise) return { ok: false, reason: 'IncidentCenter/Alerts not available' };
        alt.raise({ level: 'P1', source: 'automation-engine', message: (opts && opts.message) || 'Policy-triggered escalation: ' + target });
        return { ok: true };
      }
      try {
        ic.createIncident({ title: 'Policy-triggered: ' + target, severity: 'P1', source: 'automation-engine' });
        return { ok: true };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
    'log': function (target, opts) {
      console.debug(LOG, 'log action:', target, opts && opts.message);
      return { ok: true };
    },
  };

  // ── Core execute ───────────────────────────────────────────────────────────
  function executeAction(type, target, opts) {
    var id      = _id();
    var startTs = _ts();
    _metrics.executed++;
    _metrics.byType[type] = (_metrics.byType[type] || 0) + 1;
    _running[id] = { type: type, target: target, startTs: startTs };

    var handler = HANDLERS[type];
    var result;
    if (!handler) {
      result = { ok: false, reason: 'Unknown action type: ' + type };
    } else {
      try { result = handler(target, opts) || { ok: true }; }
      catch (e) { result = { ok: false, reason: e.message }; }
    }

    var durationMs = _ts() - startTs;
    delete _running[id];

    if (result.ok) _metrics.succeeded++;
    else            _metrics.failed++;

    var record = {
      actionId: id, type: type, target: target,
      status: result.ok ? 'success' : 'failed',
      reason: result.reason || null,
      ts: startTs, durationMs: durationMs,
    };
    _history.unshift(record);
    if (_history.length > MAX_HIST) _history.pop();
    _dispatch('arc15:action-executed', record);

    return record;
  }

  // ── Schedule (delayed) ─────────────────────────────────────────────────────
  function scheduleAction(type, target, delayMs, opts) {
    var id = _id();
    var scheduledAt = _ts() + (delayMs || 0);
    _metrics.queued++;
    var timer = setTimeout(function () {
      _queue = _queue.filter(function (q) { return q.id !== id; });
      executeAction(type, target, opts);
    }, delayMs || 0);
    var entry = { id: id, type: type, target: target, scheduledAt: scheduledAt, timer: timer };
    _queue.push(entry);
    _dispatch('arc15:action-queued', { actionId: id, type: type, target: target, scheduledAt: scheduledAt });
    return id;
  }

  // ── Queue action (immediate async) ────────────────────────────────────────
  function queueAction(type, target, opts) {
    return scheduleAction(type, target, 0, opts);
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  function cancelAction(id) {
    var idx = _queue.findIndex(function (q) { return q.id === id; });
    if (idx === -1) return false;
    clearTimeout(_queue[idx].timer);
    _queue.splice(idx, 1);
    _metrics.cancelled++;
    return true;
  }

  function getQueue()   { return _queue.map(function (q) { return { id: q.id, type: q.type, target: q.target, scheduledAt: q.scheduledAt }; }); }
  function getHistory(n){ return _history.slice(0, n || 50); }
  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimeAutomationEngine = Object.freeze({
    executeAction: executeAction,
    scheduleAction: scheduleAction,
    queueAction:    queueAction,
    cancelAction:   cancelAction,
    getQueue:       getQueue,
    getHistory:     getHistory,
    getMetrics:     getMetrics,
    ACTIONS: Object.freeze(Object.keys(HANDLERS)),
  });

  console.debug(LOG, 'v1.0 ready — actions:', Object.keys(HANDLERS).length);
}(window));
