// ── Arc 15 Enterprise Runtime Automation & Policy Orchestration (ERAPO) — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.881Z  BUILD_ID: mpxgtdiz
// Files: 15

// ── SOURCE: public/js/runtime-policy-engine.js ──
// RuntimePolicyEngine v1.0 — Arc 15 / Phase A
// =============================================================================
// Enterprise policy engine: register, evaluate, and enforce runtime policies
// with severity tiers, priority ordering, and automatic action dispatch.
//
// Built-in policies:
//   sla-breach         — SLA violation detected (CRITICAL, priority 10)
//   memory-spike       — Heap usage > 85% (WARN, priority 8)
//   thermal-spike      — Thermal pressure > 90% (WARN, priority 7)
//   incident-escalation— Open incidents > 5 (CRITICAL, priority 9)
//   circuit-breaker    — Circuit breakers open (EMERGENCY, priority 10)
//
// Events dispatched:
//   arc15:policy-triggered  — { policyId, label, severity, action, ts, data }
//   arc15:policy-registered — { id, label }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimePolicyEngine) return;

  var LOG = '[Arc15:PolicyEngine]';

  var SEV_INFO      = 'INFO';
  var SEV_WARN      = 'WARN';
  var SEV_CRITICAL  = 'CRITICAL';
  var SEV_EMERGENCY = 'EMERGENCY';

  var _policies = {};
  var _seq      = 0;
  var _history  = [];  // last 200 trigger events
  var MAX_HIST  = 200;

  var _metrics = {
    evaluated: 0, triggered: 0, suppressed: 0, errors: 0,
    bySeverity: { INFO: 0, WARN: 0, CRITICAL: 0, EMERGENCY: 0 },
  };

  // Dedup window: suppress same policy re-trigger within this interval
  var DEDUP_MS = 30 * 1000;
  var _lastTrigger = {};  // policyId → ts

  function _dedup(id) {
    var last = _lastTrigger[id] || 0;
    if (Date.now() - last < DEDUP_MS) { _metrics.suppressed++; return true; }
    _lastTrigger[id] = Date.now();
    return false;
  }

  function _dispatch(evtName, detail) {
    try { G.dispatchEvent(new CustomEvent(evtName, { detail: detail })); } catch (_) {}
  }

  // ── Built-in policy conditions ─────────────────────────────────────────────
  var BUILTIN = [
    {
      id: 'sla-breach', label: 'SLA Breach Policy',
      severity: SEV_CRITICAL, priority: 10, enabled: true, action: 'escalate-incident',
      condition: function () {
        var sla = G.RuntimeToolSLA;
        if (!sla || !sla.getMetrics) return null;
        try {
          var m = sla.getMetrics();
          if (m && m.breaches > 0)
            return { message: 'SLA breach: ' + m.breaches + ' breach(es)', breaches: m.breaches };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'memory-spike', label: 'Memory Spike Policy',
      severity: SEV_WARN, priority: 8, enabled: true, action: 'run-recovery',
      condition: function () {
        try {
          if (!G.performance || !G.performance.memory) return null;
          var mem = G.performance.memory;
          var pct = (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100;
          if (pct > 85) return { message: 'Heap at ' + pct.toFixed(1) + '%', pct: pct };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'thermal-spike', label: 'Thermal Spike Policy',
      severity: SEV_WARN, priority: 7, enabled: true, action: 'pause-subsystem',
      condition: function () {
        var analy = G.RuntimeCommandAnalytics;
        if (!analy || !analy.getTrends) return null;
        try {
          var t = analy.getTrends('5m');
          if (t && t.thermal && t.thermal.avg > 90)
            return { message: 'Thermal pressure: ' + t.thermal.avg.toFixed(0) + '%', avg: t.thermal.avg };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'incident-escalation', label: 'Incident Escalation Policy',
      severity: SEV_CRITICAL, priority: 9, enabled: true, action: 'clear-alerts',
      condition: function () {
        var ic = G.RuntimeIncidentCenter;
        if (!ic || !ic.getMetrics) return null;
        try {
          var m = ic.getMetrics();
          if (m && m.open > 5) return { message: m.open + ' open incidents', open: m.open };
        } catch (_) {}
        return null;
      },
    },
    {
      id: 'circuit-breaker', label: 'Circuit Breaker Policy',
      severity: SEV_EMERGENCY, priority: 10, enabled: true, action: 'quarantine-subsystem',
      condition: function () {
        var cb = G.RuntimeToolCircuitBreaker;
        if (!cb || !cb.getMetrics) return null;
        try {
          var m = cb.getMetrics();
          if (m && m.open > 0) return { message: m.open + ' breaker(s) open', open: m.open };
        } catch (_) {}
        return null;
      },
    },
  ];

  BUILTIN.forEach(function (p) { p.builtIn = true; p.createdAt = Date.now(); _policies[p.id] = p; });

  // ── Public API ─────────────────────────────────────────────────────────────
  function registerPolicy(opts) {
    opts = opts || {};
    var id = opts.id || ('pol-' + (++_seq));
    if (_policies[id]) return id;
    _policies[id] = {
      id:        id,
      label:     opts.label     || id,
      severity:  opts.severity  || SEV_INFO,
      priority:  opts.priority  || 1,
      enabled:   opts.enabled !== false,
      condition: typeof opts.condition === 'function' ? opts.condition : function () { return null; },
      action:    opts.action    || 'log',
      builtIn:   false,
      createdAt: Date.now(),
    };
    _dispatch('arc15:policy-registered', { id: id, label: _policies[id].label });
    return id;
  }

  function removePolicy(id) {
    if (_policies[id] && !_policies[id].builtIn) { delete _policies[id]; return true; }
    return false;
  }

  function enablePolicy(id)  { if (_policies[id]) { _policies[id].enabled = true;  return true; } return false; }
  function disablePolicy(id) { if (_policies[id]) { _policies[id].enabled = false; return true; } return false; }

  function evaluate(id) {
    var pol = _policies[id];
    if (!pol || !pol.enabled) return null;
    _metrics.evaluated++;
    try {
      var data = pol.condition();
      if (!data) return null;
      if (_dedup(id)) return null;
      _metrics.triggered++;
      if (_metrics.bySeverity[pol.severity] != null) _metrics.bySeverity[pol.severity]++;
      var evt = {
        policyId: id, label: pol.label, severity: pol.severity,
        action: pol.action, ts: Date.now(), data: data,
      };
      _history.unshift(evt);
      if (_history.length > MAX_HIST) _history.pop();
      _dispatch('arc15:policy-triggered', evt);
      return evt;
    } catch (e) {
      _metrics.errors++;
      console.warn(LOG, 'policy error [' + id + ']:', e.message);
      return null;
    }
  }

  function evaluateAll() {
    var sorted = Object.values(_policies)
      .filter(function (p) { return p.enabled; })
      .sort(function (a, b) { return b.priority - a.priority; });
    var triggered = [];
    sorted.forEach(function (p) { var r = evaluate(p.id); if (r) triggered.push(r); });
    return triggered;
  }

  function getPolicies(filter) {
    var list = Object.values(_policies);
    if (filter && filter.enabled !== undefined) list = list.filter(function (p) { return p.enabled === filter.enabled; });
    if (filter && filter.severity)             list = list.filter(function (p) { return p.severity === filter.severity; });
    return list.sort(function (a, b) { return b.priority - a.priority; });
  }

  function getHistory(n) { return _history.slice(0, n || 50); }
  function getMetrics()  { return Object.assign({}, _metrics, { total: Object.keys(_policies).length }); }

  // Auto-evaluate every 2 minutes
  setInterval(function () { try { evaluateAll(); } catch (_) {} }, 2 * 60 * 1000);

  G.RuntimePolicyEngine = Object.freeze({
    registerPolicy: registerPolicy,
    removePolicy:   removePolicy,
    enablePolicy:   enablePolicy,
    disablePolicy:  disablePolicy,
    evaluate:       evaluate,
    evaluateAll:    evaluateAll,
    getPolicies:    getPolicies,
    getHistory:     getHistory,
    getMetrics:     getMetrics,
    SEV: Object.freeze({ INFO: SEV_INFO, WARN: SEV_WARN, CRITICAL: SEV_CRITICAL, EMERGENCY: SEV_EMERGENCY }),
  });

  console.debug(LOG, 'v1.0 ready — policies:', Object.keys(_policies).length);
}(window));

// ── SOURCE: public/js/runtime-automation-engine.js ──
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

// ── SOURCE: public/js/runtime-workflow-engine.js ──
// RuntimeWorkflowEngine v1.0 — Arc 15 / Phase C
// =============================================================================
// Multi-step workflow orchestration engine with rollback support.
//
// Default workflow — Incident Response:
//   detect → diagnose → recover → verify → close
//
// Each step: { id, label, fn, rollbackFn? }
// Workflow run: PENDING → RUNNING → (step by step) → COMPLETE | FAILED | ROLLED_BACK
//
// Events dispatched:
//   arc15:workflow-started    — { runId, workflowId, ts }
//   arc15:workflow-step       — { runId, step, status, ts, durationMs }
//   arc15:workflow-complete   — { runId, workflowId, status, steps, ts, durationMs }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeWorkflowEngine) return;

  var LOG = '[Arc15:WorkflowEngine]';

  var _workflows = {};   // id → workflow definition
  var _runs      = {};   // runId → run state
  var _history   = [];   // completed runs (last 100)
  var MAX_HIST   = 100;
  var _seq       = 0;

  var _metrics = { created: 0, started: 0, completed: 0, failed: 0, rolledBack: 0 };

  function _id()  { return 'wf-' + (++_seq); }
  function _rid() { return 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
  function _ts()  { return Date.now(); }

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Built-in: Incident Response workflow ──────────────────────────────────
  var INCIDENT_RESPONSE = {
    id:    'incident-response',
    label: 'Incident Response',
    steps: [
      {
        id: 'detect', label: 'Detect',
        fn: function (ctx) {
          var ic = G.RuntimeIncidentCenter;
          ctx.detected = ic && ic.getMetrics ? ic.getMetrics() : { open: 0 };
          return { ok: true, data: ctx.detected };
        },
      },
      {
        id: 'diagnose', label: 'Diagnose',
        fn: function (ctx) {
          var de = G.RuntimeDecisionEngine;
          if (de && de.decide) {
            ctx.decision = de.decide({ source: 'incident-response', context: ctx.detected });
          } else {
            ctx.decision = { action: 'run-recovery', confidence: 60, risk: 30 };
          }
          return { ok: true, data: ctx.decision };
        },
      },
      {
        id: 'recover', label: 'Recover',
        fn: function (ctx) {
          var ae = G.RuntimeAutomationEngine;
          if (ae && ae.executeAction) {
            var action = (ctx.decision && ctx.decision.action) || 'run-recovery';
            var r = ae.executeAction(action, 'workflow-recovery', { from: 'incident-response' });
            ctx.recoveryResult = r;
            return { ok: r.status === 'success', data: r };
          }
          return { ok: true, data: { skipped: 'AutomationEngine not available' } };
        },
        rollbackFn: function (ctx) {
          var fm = G.RuntimeFleetManager;
          if (fm && fm.resume && ctx.recoveryResult && ctx.recoveryResult.target) {
            try { fm.resume(ctx.recoveryResult.target); } catch (_) {}
          }
        },
      },
      {
        id: 'verify', label: 'Verify',
        fn: function () {
          var cc = G.RuntimeCommandCenter;
          if (!cc || !cc.getSystemHealth) return { ok: true, data: { health: 'unknown' } };
          var h = cc.getSystemHealth();
          return { ok: h.score >= 60, data: h };
        },
      },
      {
        id: 'close', label: 'Close',
        fn: function (ctx) {
          var alt = G.RuntimeAlerts;
          if (alt && alt.acknowledgeAll) { try { alt.acknowledgeAll(); } catch (_) {} }
          return { ok: true, data: { closed: true, context: ctx } };
        },
      },
    ],
  };

  _workflows['incident-response'] = INCIDENT_RESPONSE;

  // ── Public API ─────────────────────────────────────────────────────────────
  function createWorkflow(def) {
    def = def || {};
    var id = def.id || _id();
    if (_workflows[id]) return id;
    if (!Array.isArray(def.steps) || !def.steps.length) throw new Error('Workflow must have at least one step');
    _workflows[id] = {
      id: id, label: def.label || id,
      steps: def.steps.map(function (s) {
        return {
          id:         s.id || _id(),
          label:      s.label || s.id,
          fn:         typeof s.fn === 'function' ? s.fn : function () { return { ok: true }; },
          rollbackFn: typeof s.rollbackFn === 'function' ? s.rollbackFn : null,
        };
      }),
    };
    _metrics.created++;
    return id;
  }

  function runWorkflow(workflowId, opts) {
    var wf = _workflows[workflowId];
    if (!wf) throw new Error('Workflow not found: ' + workflowId);

    var runId   = _rid();
    var startTs = _ts();
    _metrics.started++;

    var run = {
      runId: runId, workflowId: workflowId, label: wf.label,
      status: 'RUNNING', steps: [], ctx: opts && opts.ctx || {},
      startTs: startTs, endTs: null, cancelled: false,
    };
    _runs[runId] = run;
    _dispatch('arc15:workflow-started', { runId: runId, workflowId: workflowId, ts: startTs });

    var completedSteps = [];

    for (var i = 0; i < wf.steps.length; i++) {
      if (run.cancelled) break;
      var step     = wf.steps[i];
      var stepTs   = _ts();
      var stepResult;

      try {
        stepResult = step.fn(run.ctx) || { ok: true };
      } catch (e) {
        stepResult = { ok: false, error: e.message };
      }

      var stepRecord = {
        id: step.id, label: step.label, status: stepResult.ok ? 'success' : 'failed',
        data: stepResult.data || null, error: stepResult.error || null,
        ts: stepTs, durationMs: _ts() - stepTs,
      };
      run.steps.push(stepRecord);
      completedSteps.push({ step: step, record: stepRecord });
      _dispatch('arc15:workflow-step', Object.assign({ runId: runId }, stepRecord));

      if (!stepResult.ok) {
        run.status = 'FAILED';
        _metrics.failed++;
        // Rollback completed steps in reverse
        for (var j = completedSteps.length - 1; j >= 0; j--) {
          var cs = completedSteps[j];
          if (cs.step.rollbackFn) {
            try { cs.step.rollbackFn(run.ctx); } catch (_) {}
          }
        }
        if (completedSteps.some(function (s) { return s.step.rollbackFn; })) {
          run.status = 'ROLLED_BACK';
          _metrics.rolledBack++;
          _metrics.failed--;
        }
        break;
      }
    }

    if (run.status === 'RUNNING') {
      run.status   = 'COMPLETE';
      _metrics.completed++;
    }

    run.endTs = _ts();
    var summary = {
      runId: runId, workflowId: workflowId, status: run.status,
      steps: run.steps, ts: startTs, durationMs: run.endTs - startTs,
    };
    _dispatch('arc15:workflow-complete', summary);
    delete _runs[runId];
    _history.unshift(summary);
    if (_history.length > MAX_HIST) _history.pop();
    return summary;
  }

  function cancelWorkflow(runId) {
    if (_runs[runId]) { _runs[runId].cancelled = true; return true; }
    return false;
  }

  function getWorkflows()      { return Object.values(_workflows); }
  function getActiveRuns()     { return Object.values(_runs); }
  function getHistory(n)       { return _history.slice(0, n || 20); }
  function getMetrics()        { return Object.assign({}, _metrics, { workflows: Object.keys(_workflows).length, active: Object.keys(_runs).length }); }

  G.RuntimeWorkflowEngine = Object.freeze({
    createWorkflow:  createWorkflow,
    runWorkflow:     runWorkflow,
    cancelWorkflow:  cancelWorkflow,
    getWorkflows:    getWorkflows,
    getActiveRuns:   getActiveRuns,
    getHistory:      getHistory,
    getMetrics:      getMetrics,
  });

  console.debug(LOG, 'v1.0 ready — workflows:', Object.keys(_workflows).length);
}(window));

// ── SOURCE: public/js/runtime-decision-engine.js ──
// RuntimeDecisionEngine v1.0 — Arc 15 / Phase D
// =============================================================================
// Unified decision engine that merges signals from multiple Arc subsystems to
// produce a recommended action with confidence and risk scores.
//
// Signal sources:
//   RuntimeForecast       — upcoming risk (weight 25%)
//   RuntimeGovernance     — policy compliance (weight 25%)
//   RuntimeRecoveryMemory — historical strategy effectiveness (weight 30%)
//   RuntimeAdaptiveAI     — device/quality profile (weight 20%)
//
// Output: { action, confidence, risk, rationale, signals, ts }
//
// Events dispatched:
//   arc15:decision-made — { decisionId, action, confidence, risk, ts }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeDecisionEngine) return;

  var LOG = '[Arc15:DecisionEngine]';

  var _history = [];   // last 200 decisions
  var MAX_HIST = 200;
  var _seq     = 0;
  var _metrics = { decisions: 0, highConfidence: 0, highRisk: 0, errors: 0 };

  function _id() { return 'dec-' + (++_seq); }

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Signal collectors ──────────────────────────────────────────────────────
  function _collectForecast() {
    var fc = G.RuntimeForecast;
    if (!fc || !fc.getForecasts) return { risk: 30, action: null };
    try {
      var criticals = fc.getForecasts({ severity: 'critical' });
      var warnings  = fc.getForecasts({ severity: 'warning' });
      var risk = Math.min(100, criticals.length * 20 + warnings.length * 10);
      var action = criticals.length > 0 ? 'run-recovery' : warnings.length > 0 ? 'pause-subsystem' : null;
      return { risk: risk, action: action, criticals: criticals.length, warnings: warnings.length };
    } catch (_) { return { risk: 30, action: null }; }
  }

  function _collectGovernance() {
    var gov = G.RuntimeGovernance;
    if (!gov || !gov.getSnapshot) return { risk: 20, action: null, compliant: true };
    try {
      var snap = gov.getSnapshot();
      if (!snap) return { risk: 20, action: null, compliant: true };
      var violations = snap.violations || 0;
      return {
        risk: Math.min(100, violations * 15),
        action: violations > 2 ? 'escalate-incident' : null,
        compliant: violations === 0,
        violations: violations,
      };
    } catch (_) { return { risk: 20, action: null, compliant: true }; }
  }

  function _collectRecoveryMemory() {
    var rm = G.RuntimeRecoveryMemory;
    if (!rm || !rm.recommend) return { action: 'run-recovery', confidence: 50 };
    try {
      var rec = rm.recommend('general');
      return {
        action: rec && rec.strategy ? rec.strategy : 'run-recovery',
        confidence: rec && rec.confidence != null ? rec.confidence : 50,
        reason: rec && rec.reason,
      };
    } catch (_) { return { action: 'run-recovery', confidence: 50 }; }
  }

  function _collectAdaptiveAI() {
    var ai = G.RuntimeAdaptiveAI;
    if (!ai || !ai.getMetrics) return { conservative: false, adjustment: 0 };
    try {
      var m = ai.getMetrics();
      var conservative = m && m.qualityMode === 'safe';
      return { conservative: conservative, adjustment: conservative ? 10 : -5 };
    } catch (_) { return { conservative: false, adjustment: 0 }; }
  }

  // ── Decision logic ─────────────────────────────────────────────────────────
  function decide(opts) {
    opts = opts || {};
    _metrics.decisions++;

    var forecast  = _collectForecast();
    var governance= _collectGovernance();
    var memory    = _collectRecoveryMemory();
    var adaptiveAI= _collectAdaptiveAI();

    // Weighted risk score (0–100)
    var risk = Math.round(
      forecast.risk   * 0.25 +
      governance.risk * 0.25 +
      (100 - memory.confidence) * 0.30 +
      (adaptiveAI.conservative ? 20 : 10) * 0.20 +
      adaptiveAI.adjustment
    );
    risk = Math.max(0, Math.min(100, risk));

    // Action resolution: governance override > forecast > memory fallback
    var action =
      (governance.violations > 3 ? 'escalate-incident' : null) ||
      forecast.action ||
      (opts.forcedAction) ||
      memory.action ||
      'log';

    // Confidence: based on data availability and agreement
    var sourceCount  = [!!G.RuntimeForecast, !!G.RuntimeGovernance, !!G.RuntimeRecoveryMemory, !!G.RuntimeAdaptiveAI].filter(Boolean).length;
    var baseConf     = Math.round(memory.confidence * 0.5 + (sourceCount / 4) * 50);
    var confidence   = Math.max(10, Math.min(99, baseConf - Math.round(risk * 0.2)));

    if (confidence >= 80) _metrics.highConfidence++;
    if (risk >= 70)       _metrics.highRisk++;

    var dec = {
      decisionId:  _id(),
      action:      action,
      confidence:  confidence,
      risk:        risk,
      rationale:   _buildRationale(action, confidence, risk, governance, forecast, memory),
      signals: {
        forecast:   forecast,
        governance: governance,
        memory:     memory,
        adaptiveAI: adaptiveAI,
      },
      source: opts.source || 'decision-engine',
      ts:     Date.now(),
    };

    _history.unshift(dec);
    if (_history.length > MAX_HIST) _history.pop();
    _dispatch('arc15:decision-made', { decisionId: dec.decisionId, action: action, confidence: confidence, risk: risk, ts: dec.ts });
    return dec;
  }

  function _buildRationale(action, confidence, risk, gov, fc, mem) {
    var parts = [];
    if (gov.violations > 0)    parts.push(gov.violations + ' governance violation(s)');
    if (fc.criticals > 0)      parts.push(fc.criticals + ' critical forecast(s)');
    if (mem.reason)            parts.push('memory: ' + mem.reason);
    parts.push('risk=' + risk + '% conf=' + confidence + '%');
    return 'Action "' + action + '": ' + parts.join(', ');
  }

  function recommend(context) {
    return decide({ source: 'recommend', context: context });
  }

  function score(signals) {
    signals = signals || {};
    var risk = Math.max(0, Math.min(100,
      (signals.forecast  || 0) * 0.25 +
      (signals.governance|| 0) * 0.25 +
      (signals.memory    || 0) * 0.30 +
      (signals.device    || 0) * 0.20
    ));
    return { risk: Math.round(risk), confidence: Math.round(100 - risk * 0.6) };
  }

  function getHistory(n) { return _history.slice(0, n || 20); }
  function getMetrics()  { return Object.assign({}, _metrics); }

  G.RuntimeDecisionEngine = Object.freeze({
    decide:      decide,
    recommend:   recommend,
    score:       score,
    getHistory:  getHistory,
    getMetrics:  getMetrics,
  });

  console.debug(LOG, 'v1.0 ready');
}(window));

// ── SOURCE: public/js/runtime-resource-orchestrator.js ──
// RuntimeResourceOrchestrator v1.0 — Arc 15 / Phase E
// =============================================================================
// Runtime resource budget management and pressure scoring.
//
// Budgets managed:
//   cpu     — estimated CPU cycle budget (arbitrary units, baseline 100)
//   memory  — JS heap budget (MB)
//   workers — max concurrent worker threads
//   storage — estimated storage budget (MB)
//
// Pressure scores: 0 (free) → 100 (critical)
//
// Events dispatched:
//   arc15:resource-pressure   — { resource, score, level, ts }
//   arc15:resource-allocated  — { resource, amount, owner, ts }
//   arc15:resource-released   — { resource, amount, owner, ts }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeResourceOrchestrator) return;

  var LOG = '[Arc15:ResourceOrchestrator]';

  var BUDGETS = {
    cpu:     { total: 100, allocated: 0, unit: 'units' },
    memory:  { total: 512, allocated: 0, unit: 'MB'    },
    workers: { total: 8,   allocated: 0, unit: 'threads'},
    storage: { total: 256, allocated: 0, unit: 'MB'    },
  };

  var _allocations = {};   // owner → { cpu, memory, workers, storage }
  var _pressureLog = [];   // last 500 pressure readings
  var MAX_LOG = 500;
  var _metrics = { allocations: 0, releases: 0, pressureEvents: 0, overflows: 0 };

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Budget management ─────────────────────────────────────────────────────
  function allocate(resource, amount, owner) {
    var b = BUDGETS[resource];
    if (!b) return { ok: false, reason: 'Unknown resource: ' + resource };
    if (b.allocated + amount > b.total) {
      _metrics.overflows++;
      return { ok: false, reason: resource + ' budget exceeded (' + (b.allocated + amount) + '/' + b.total + ')' };
    }
    b.allocated += amount;
    if (!_allocations[owner]) _allocations[owner] = {};
    _allocations[owner][resource] = (_allocations[owner][resource] || 0) + amount;
    _metrics.allocations++;
    _dispatch('arc15:resource-allocated', { resource: resource, amount: amount, owner: owner, ts: Date.now() });
    return { ok: true, available: b.total - b.allocated };
  }

  function release(resource, amount, owner) {
    var b = BUDGETS[resource];
    if (!b) return { ok: false, reason: 'Unknown resource: ' + resource };
    var released = Math.min(amount, b.allocated);
    b.allocated = Math.max(0, b.allocated - released);
    if (_allocations[owner]) {
      _allocations[owner][resource] = Math.max(0, (_allocations[owner][resource] || 0) - released);
    }
    _metrics.releases++;
    _dispatch('arc15:resource-released', { resource: resource, amount: released, owner: owner, ts: Date.now() });
    return { ok: true, released: released };
  }

  function releaseAll(owner) {
    var alloc = _allocations[owner];
    if (!alloc) return;
    Object.keys(alloc).forEach(function (resource) {
      if (alloc[resource] > 0) release(resource, alloc[resource], owner);
    });
    delete _allocations[owner];
  }

  // ── Pressure scoring ──────────────────────────────────────────────────────
  function _livePressure() {
    var scores = {};

    // Memory: live from performance.memory if available
    try {
      if (G.performance && G.performance.memory) {
        var mem = G.performance.memory;
        scores.memory = Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
      }
    } catch (_) {}

    // Workers: from RuntimeFleetManager state
    try {
      var fm = G.RuntimeFleetManager;
      if (fm && fm.getState) {
        var state  = fm.getState();
        var paused = Object.values(state).filter(function (s) { return s.paused; }).length;
        scores.workers = Math.min(100, paused * 20);
      }
    } catch (_) {}

    // CPU/Storage: from budget allocations
    Object.keys(BUDGETS).forEach(function (r) {
      if (scores[r] == null) {
        var b = BUDGETS[r];
        scores[r] = b.total > 0 ? Math.round((b.allocated / b.total) * 100) : 0;
      }
    });

    return scores;
  }

  function getPressure() {
    var scores  = _livePressure();
    var overall = Math.round(Object.values(scores).reduce(function (s, v) { return s + v; }, 0) / Object.keys(scores).length);
    var level   = overall >= 80 ? 'CRITICAL' : overall >= 60 ? 'HIGH' : overall >= 40 ? 'MODERATE' : 'LOW';

    if (overall >= 60) {
      _metrics.pressureEvents++;
      var rec = { ts: Date.now(), scores: scores, overall: overall, level: level };
      _pressureLog.unshift(rec);
      if (_pressureLog.length > MAX_LOG) _pressureLog.pop();
      _dispatch('arc15:resource-pressure', { resource: 'all', score: overall, level: level, ts: Date.now() });
    }

    return { scores: scores, overall: overall, level: level };
  }

  function getBudgets() {
    var out = {};
    Object.keys(BUDGETS).forEach(function (r) {
      var b = BUDGETS[r];
      out[r] = {
        total: b.total, allocated: b.allocated, free: b.total - b.allocated,
        pct: Math.round((b.allocated / b.total) * 100), unit: b.unit,
      };
    });
    return out;
  }

  function getAllocations() { return JSON.parse(JSON.stringify(_allocations)); }
  function getPressureLog(n) { return _pressureLog.slice(0, n || 20); }
  function getMetrics()    { return Object.assign({}, _metrics); }

  // Periodic pressure snapshot (every 60 s)
  setInterval(function () { try { getPressure(); } catch (_) {} }, 60 * 1000);

  G.RuntimeResourceOrchestrator = Object.freeze({
    allocate:       allocate,
    release:        release,
    releaseAll:     releaseAll,
    getPressure:    getPressure,
    getBudgets:     getBudgets,
    getAllocations:  getAllocations,
    getPressureLog: getPressureLog,
    getMetrics:     getMetrics,
  });

  console.debug(LOG, 'v1.0 ready — budgets:', Object.keys(BUDGETS).join(', '));
}(window));

// ── SOURCE: public/js/runtime-autonomous-ops.js ──
// RuntimeAutonomousOps v1.0 — Arc 15 / Phase F
// =============================================================================
// Self-healing autonomous operations loop. Detects runtime degradation,
// runs diagnosis, dispatches recovery, and verifies health — all without
// manual intervention.
//
// Integrates:
//   RuntimePolicyEngine       — evaluates active policies
//   RuntimeAutomationEngine   — executes remediation actions
//   RuntimeWorkflowEngine     — runs multi-step recovery workflows
//   RuntimeDecisionEngine     — selects best action
//   RuntimeRecoveryOrchestrator — executes recovery sequences
//   RuntimeRecoveryMemory     — records outcomes
//   RuntimeIncidentCenter     — incident tracking
//
// Loop states: IDLE → DETECTING → DIAGNOSING → RECOVERING → VERIFYING → IDLE
//
// Events dispatched:
//   arc15:ops-heal-cycle — { cycleId, state, result, durationMs, ts }
//   arc15:ops-started    — { ts }
//   arc15:ops-stopped    — { ts, cycles }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimeAutonomousOps) return;

  var LOG = '[Arc15:AutonomousOps]';

  var STATE_IDLE       = 'IDLE';
  var STATE_DETECTING  = 'DETECTING';
  var STATE_DIAGNOSING = 'DIAGNOSING';
  var STATE_RECOVERING = 'RECOVERING';
  var STATE_VERIFYING  = 'VERIFYING';

  var _state       = STATE_IDLE;
  var _running     = false;
  var _timer       = null;
  var _cycleSeq    = 0;
  var _cycles      = [];    // last 100 cycle records
  var MAX_CYCLES   = 100;

  var _metrics = {
    totalCycles: 0, healCycles: 0, noActionCycles: 0,
    successfulHeals: 0, failedHeals: 0, startedAt: null,
  };

  var LOOP_INTERVAL_MS = 3 * 60 * 1000;   // run every 3 minutes
  var VERIFY_TIMEOUT   = 5 * 1000;        // wait 5s after action before verifying

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  // ── Detect: probe for degradation signals ─────────────────────────────────
  function _detect() {
    var signals = [];

    // Policy violations
    var pe = G.RuntimePolicyEngine;
    if (pe && pe.evaluateAll) {
      try {
        var triggered = pe.evaluateAll();
        triggered.forEach(function (t) {
          signals.push({ type: 'policy', severity: t.severity, action: t.action, label: t.label });
        });
      } catch (_) {}
    }

    // Direct health check
    var cc = G.RuntimeCommandCenter;
    if (cc && cc.getSystemHealth) {
      try {
        var h = cc.getSystemHealth();
        if (h.score < 70) {
          signals.push({ type: 'health', severity: h.score < 50 ? 'CRITICAL' : 'WARN',
            action: 'run-recovery', label: 'Health score: ' + h.score + '%' });
        }
      } catch (_) {}
    }

    return signals;
  }

  // ── Diagnose: pick best action ─────────────────────────────────────────────
  function _diagnose(signals) {
    var de = G.RuntimeDecisionEngine;
    if (de && de.decide) {
      try {
        return de.decide({ source: 'autonomous-ops', signals: signals });
      } catch (_) {}
    }
    // Fallback: use highest-severity signal's action
    var critical = signals.filter(function (s) { return s.severity === 'CRITICAL' || s.severity === 'EMERGENCY'; });
    var target   = critical.length ? critical[0] : (signals.length ? signals[0] : null);
    return target ? { action: target.action, confidence: 55, risk: 60 } : null;
  }

  // ── Recover: execute action ────────────────────────────────────────────────
  function _recover(decision, signals) {
    // Try the workflow engine first for multi-step recovery
    var wfe = G.RuntimeWorkflowEngine;
    if (wfe && wfe.runWorkflow) {
      try {
        var result = wfe.runWorkflow('incident-response', { ctx: { signals: signals, decision: decision } });
        return { source: 'workflow', ok: result.status === 'COMPLETE', result: result };
      } catch (_) {}
    }

    // Fallback: direct action via automation engine
    var ae = G.RuntimeAutomationEngine;
    if (ae && ae.executeAction) {
      var action = (decision && decision.action) || 'run-recovery';
      try {
        var r = ae.executeAction(action, 'autonomous-ops', { decision: decision });
        return { source: 'automation', ok: r.status === 'success', result: r };
      } catch (_) {}
    }

    return { source: 'none', ok: false, result: null };
  }

  // ── Verify: check health improved ─────────────────────────────────────────
  function _verify() {
    var cc = G.RuntimeCommandCenter;
    if (!cc || !cc.getSystemHealth) return { ok: true, score: 100 };
    try {
      var h = cc.getSystemHealth();
      return { ok: h.score >= 60, score: h.score, level: h.level };
    } catch (_) { return { ok: true, score: 75 }; }
  }

  // ── Main heal loop ─────────────────────────────────────────────────────────
  function _runCycle() {
    if (!_running) return;
    var cycleId  = 'cyc-' + (++_cycleSeq);
    var startTs  = Date.now();
    _metrics.totalCycles++;

    _state = STATE_DETECTING;
    var signals = _detect();

    if (!signals.length) {
      _state = STATE_IDLE;
      _metrics.noActionCycles++;
      var noActionRecord = { cycleId: cycleId, state: 'NO_ACTION', signals: 0, result: null, durationMs: Date.now() - startTs, ts: startTs };
      _cycles.unshift(noActionRecord);
      if (_cycles.length > MAX_CYCLES) _cycles.pop();
      return;
    }

    _metrics.healCycles++;
    _state = STATE_DIAGNOSING;
    var decision = _diagnose(signals);

    _state = STATE_RECOVERING;
    var recovery = _recover(decision, signals);

    // Brief pause before verify
    _state = STATE_VERIFYING;

    var verify   = _verify();
    var ok       = recovery.ok && verify.ok;

    if (ok) _metrics.successfulHeals++;
    else    _metrics.failedHeals++;

    // Record outcome in RecoveryMemory
    var rm = G.RuntimeRecoveryMemory;
    if (rm && rm.recordOutcome && decision) {
      try {
        rm.recordOutcome({
          strategy:   decision.action || 'run-recovery',
          category:   'autonomous-ops',
          outcome:    ok ? 'success' : 'failed',
          durationMs: Date.now() - startTs,
        });
      } catch (_) {}
    }

    _state = STATE_IDLE;
    var record = {
      cycleId: cycleId, state: ok ? 'HEALED' : 'FAILED',
      signals: signals.length, decision: decision,
      recovery: { source: recovery.source, ok: recovery.ok },
      verify: verify, durationMs: Date.now() - startTs, ts: startTs,
    };
    _cycles.unshift(record);
    if (_cycles.length > MAX_CYCLES) _cycles.pop();
    _dispatch('arc15:ops-heal-cycle', record);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function start() {
    if (_running) return { ok: false, reason: 'already running' };
    _running = true;
    _metrics.startedAt = Date.now();
    _timer   = setInterval(_runCycle, LOOP_INTERVAL_MS);
    _dispatch('arc15:ops-started', { ts: Date.now() });
    // Run first cycle immediately after a short boot delay
    setTimeout(_runCycle, 5000);
    console.debug(LOG, 'started — interval:', LOOP_INTERVAL_MS / 1000 + 's');
    return { ok: true };
  }

  function stop() {
    if (!_running) return { ok: false, reason: 'not running' };
    clearInterval(_timer);
    _timer   = null;
    _running = false;
    _state   = STATE_IDLE;
    _dispatch('arc15:ops-stopped', { ts: Date.now(), cycles: _metrics.totalCycles });
    return { ok: true };
  }

  function getLoopStatus() {
    return {
      running:  _running,
      state:    _state,
      interval: LOOP_INTERVAL_MS,
      metrics:  Object.assign({}, _metrics),
    };
  }

  function getCycles(n) { return _cycles.slice(0, n || 20); }
  function getMetrics() { return Object.assign({}, _metrics, { running: _running, state: _state }); }

  // Auto-start after a short boot delay
  setTimeout(function () { try { if (!_running) start(); } catch (_) {} }, 8000);

  G.RuntimeAutonomousOps = Object.freeze({
    start:         start,
    stop:          stop,
    getLoopStatus: getLoopStatus,
    getCycles:     getCycles,
    getMetrics:    getMetrics,
  });

  console.debug(LOG, 'v1.0 ready — auto-start in 8s');
}(window));

// ── SOURCE: public/js/runtime-policy-analytics.js ──
// RuntimePolicyAnalytics v1.0 — Arc 15 / Phase G
// =============================================================================
// Tracks policy execution history and generates success/failure/rollback rates,
// execution rankings, and trend analysis.
//
// Listens to:
//   arc15:policy-triggered   — records each policy trigger
//   arc15:action-executed    — records each action outcome
//   arc15:workflow-complete  — records each workflow outcome
//
// Events dispatched:
//   arc15:analytics-updated — { ts, snapshot }
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimePolicyAnalytics) return;

  var LOG = '[Arc15:PolicyAnalytics]';

  var _records  = [];   // { policyId, action, status, ts, durationMs? }
  var MAX_REC   = 2000;
  var _metrics  = { tracked: 0, successes: 0, failures: 0, rollbacks: 0 };
  var _snapshot = null;
  var _snapshotTs = 0;
  var SNAPSHOT_TTL = 30 * 1000;

  function _dispatch(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {}
  }

  function recordExecution(opts) {
    opts = opts || {};
    var rec = {
      policyId:   opts.policyId   || 'unknown',
      action:     opts.action     || 'unknown',
      status:     opts.status     || 'success',  // 'success' | 'failed' | 'rollback'
      severity:   opts.severity   || 'INFO',
      ts:         opts.ts         || Date.now(),
      durationMs: opts.durationMs || 0,
    };
    _records.unshift(rec);
    if (_records.length > MAX_REC) _records.pop();
    _metrics.tracked++;
    if (rec.status === 'success')  _metrics.successes++;
    if (rec.status === 'failed')   _metrics.failures++;
    if (rec.status === 'rollback') _metrics.rollbacks++;
    _snapshot = null;  // invalidate cache
  }

  // ── Rate calculations ──────────────────────────────────────────────────────
  function _rateFor(policyId, status) {
    var all = _records.filter(function (r) { return r.policyId === policyId; });
    if (!all.length) return 0;
    var match = all.filter(function (r) { return r.status === status; }).length;
    return Math.round((match / all.length) * 100);
  }

  function getSuccessRate(policyId) { return _rateFor(policyId, 'success'); }
  function getFailureRate(policyId) { return _rateFor(policyId, 'failed');  }
  function getRollbackRate(policyId){ return _rateFor(policyId, 'rollback');}

  // ── Rankings ───────────────────────────────────────────────────────────────
  function _buildRankings() {
    var byPolicy = {};
    _records.forEach(function (r) {
      var p = byPolicy[r.policyId];
      if (!p) { p = { policyId: r.policyId, total: 0, success: 0, failed: 0, rollback: 0 }; byPolicy[r.policyId] = p; }
      p.total++;
      if (r.status === 'success')  p.success++;
      if (r.status === 'failed')   p.failed++;
      if (r.status === 'rollback') p.rollback++;
    });

    var list = Object.values(byPolicy).map(function (p) {
      return Object.assign({}, p, {
        successRate:  p.total ? Math.round(p.success  / p.total * 100) : 0,
        failureRate:  p.total ? Math.round(p.failed   / p.total * 100) : 0,
        rollbackRate: p.total ? Math.round(p.rollback / p.total * 100) : 0,
      });
    });

    return {
      byExecutions: list.slice().sort(function (a, b) { return b.total      - a.total;       }).slice(0, 10),
      bySuccess:    list.slice().sort(function (a, b) { return b.successRate - a.successRate; }).slice(0, 10),
      byFailure:    list.slice().sort(function (a, b) { return b.failureRate - a.failureRate; }).slice(0, 10),
    };
  }

  function getRankings() { return _buildRankings(); }

  // ── Snapshot (cached 30s) ─────────────────────────────────────────────────
  function getSnapshot() {
    var now = Date.now();
    if (_snapshot && now - _snapshotTs < SNAPSHOT_TTL) return _snapshot;

    var rankings = _buildRankings();
    _snapshot = {
      total:       _records.length,
      metrics:     Object.assign({}, _metrics),
      rankings:    rankings,
      recentRate: {
        success:  _records.length ? Math.round(_metrics.successes  / _records.length * 100) : 0,
        failure:  _records.length ? Math.round(_metrics.failures   / _records.length * 100) : 0,
        rollback: _records.length ? Math.round(_metrics.rollbacks  / _records.length * 100) : 0,
      },
      ts: now,
    };
    _snapshotTs = now;
    _dispatch('arc15:analytics-updated', { ts: now, snapshot: _snapshot });
    return _snapshot;
  }

  function getRecords(n, filter) {
    var list = _records;
    if (filter && filter.policyId) list = list.filter(function (r) { return r.policyId === filter.policyId; });
    if (filter && filter.status)   list = list.filter(function (r) { return r.status   === filter.status;   });
    return list.slice(0, n || 50);
  }

  function getMetrics() { return Object.assign({}, _metrics, { total: _records.length }); }

  // ── Event listeners ────────────────────────────────────────────────────────
  G.addEventListener('arc15:policy-triggered', function (e) {
    var d = e && e.detail;
    if (!d) return;
    recordExecution({ policyId: d.policyId, action: d.action, severity: d.severity, status: 'success', ts: d.ts });
  });

  G.addEventListener('arc15:action-executed', function (e) {
    var d = e && e.detail;
    if (!d) return;
    recordExecution({ policyId: d.type, action: d.type, status: d.status === 'success' ? 'success' : 'failed', ts: d.ts, durationMs: d.durationMs });
  });

  G.addEventListener('arc15:workflow-complete', function (e) {
    var d = e && e.detail;
    if (!d) return;
    var status = d.status === 'COMPLETE' ? 'success' : d.status === 'ROLLED_BACK' ? 'rollback' : 'failed';
    recordExecution({ policyId: d.workflowId, action: 'workflow', status: status, ts: d.ts, durationMs: d.durationMs });
  });

  G.RuntimePolicyAnalytics = Object.freeze({
    recordExecution:  recordExecution,
    getSuccessRate:   getSuccessRate,
    getFailureRate:   getFailureRate,
    getRollbackRate:  getRollbackRate,
    getRankings:      getRankings,
    getSnapshot:      getSnapshot,
    getRecords:       getRecords,
    getMetrics:       getMetrics,
  });

  console.debug(LOG, 'v1.0 ready — listening to arc15 events');
}(window));

// ── SOURCE: public/js/runtime-policy-reports.js ──
// RuntimePolicyReports v1.0 — Arc 15 / Phase H
// =============================================================================
// Generates structured human-readable reports from Arc 15 subsystem data.
//
// Report types:
//   daily     — policy triggers, action outcomes, top policies for last 24h
//   weekly    — 7-day trend, most triggered, most failed, heal-cycle summary
//   incident  — per-incident: signals, diagnosis, recovery action, outcome
//   recovery  — per-heal-cycle: what triggered, what ran, health before/after
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimePolicyReports) return;

  var LOG = '[Arc15:PolicyReports]';

  var _reports  = [];   // generated reports cache (last 50)
  var MAX_REP   = 50;
  var _seq      = 0;
  var _metrics  = { generated: 0, daily: 0, weekly: 0, incident: 0, recovery: 0 };

  function _id()   { return 'rpt-' + (++_seq); }
  function _now()  { return Date.now(); }
  function _fmt(ts){ return new Date(ts).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'; }

  function _base(type) {
    return { id: _id(), type: type, generatedAt: _now(), generatedAtStr: _fmt(_now()) };
  }

  function _analytics() {
    var pa = G.RuntimePolicyAnalytics;
    return pa && pa.getSnapshot ? pa.getSnapshot() : null;
  }

  function _ops() {
    var ao = G.RuntimeAutonomousOps;
    return ao && ao.getMetrics ? ao.getMetrics() : null;
  }

  function _health() {
    var cc = G.RuntimeCommandCenter;
    return cc && cc.getSystemHealth ? cc.getSystemHealth() : { score: 0, level: 'unknown' };
  }

  function _alerts() {
    var alt = G.RuntimeAlerts;
    return alt && alt.getAlerts ? alt.getAlerts() : [];
  }

  // ── Daily report ──────────────────────────────────────────────────────────
  function generateDailyReport() {
    var rpt  = _base('daily');
    var analy= _analytics();
    var ops  = _ops();
    var h    = _health();
    var alts = _alerts();

    var last24h = _now() - 24 * 3600 * 1000;
    var recentAlts = alts.filter(function (a) { return a.ts > last24h; });

    rpt.period    = '24h';
    rpt.health    = h;
    rpt.analytics = analy ? {
      totalExecutions: analy.total,
      successRate:     analy.recentRate.success,
      failureRate:     analy.recentRate.failure,
      topPolicies:     analy.rankings.byExecutions.slice(0, 5),
    } : null;
    rpt.alerts    = { total: recentAlts.length, byLevel: _countByLevel(recentAlts) };
    rpt.healCycles= ops ? { total: ops.healCycles, success: ops.successfulHeals, failed: ops.failedHeals } : null;
    rpt.summary   = _dailySummary(rpt);

    _store(rpt);
    _metrics.daily++;
    _metrics.generated++;
    return rpt;
  }

  function _dailySummary(rpt) {
    var parts = ['Daily Policy Report — ' + rpt.generatedAtStr + '.'];
    if (rpt.health) parts.push('System health: ' + rpt.health.score + '% (' + rpt.health.level + ').');
    if (rpt.analytics) {
      parts.push('Policy executions: ' + rpt.analytics.totalExecutions +
        ' (success: ' + rpt.analytics.successRate + '%, failure: ' + rpt.analytics.failureRate + '%).');
    }
    if (rpt.healCycles) {
      parts.push('Heal cycles: ' + rpt.healCycles.total + ' (' + rpt.healCycles.success + ' successful, ' + rpt.healCycles.failed + ' failed).');
    }
    return parts.join(' ');
  }

  // ── Weekly report ─────────────────────────────────────────────────────────
  function generateWeeklyReport() {
    var rpt  = _base('weekly');
    var analy= _analytics();
    var ops  = _ops();
    var h    = _health();

    rpt.period    = '7d';
    rpt.health    = h;
    rpt.analytics = analy ? {
      totalExecutions: analy.total,
      successRate:     analy.recentRate.success,
      failureRate:     analy.recentRate.failure,
      rollbackRate:    analy.recentRate.rollback,
      mostTriggered:   analy.rankings.byExecutions.slice(0, 5),
      mostFailed:      analy.rankings.byFailure.slice(0, 5),
    } : null;
    rpt.autonomousOps = ops;
    rpt.summary = 'Weekly Automation Report — ' + rpt.generatedAtStr +
      '. Policies executed: ' + (analy ? analy.total : 'N/A') +
      '. Autonomous heal cycles: ' + (ops ? ops.totalCycles : 'N/A') + '.';

    _store(rpt);
    _metrics.weekly++;
    _metrics.generated++;
    return rpt;
  }

  // ── Incident report ───────────────────────────────────────────────────────
  function generateIncidentReport(opts) {
    opts = opts || {};
    var rpt  = _base('incident');
    var alts = _alerts();
    var h    = _health();
    var analy= _analytics();

    rpt.incidentId  = opts.incidentId  || null;
    rpt.title       = opts.title       || 'Runtime Incident';
    rpt.health      = h;
    rpt.signals     = opts.signals     || [];
    rpt.decision    = opts.decision    || null;
    rpt.recovery    = opts.recovery    || null;
    rpt.alerts      = alts.filter(function (a) { return !a.acknowledged; }).slice(0, 20);
    rpt.topFailures = analy ? analy.rankings.byFailure.slice(0, 5) : [];
    rpt.summary     = 'Incident Report — ' + rpt.generatedAtStr +
      '. Title: ' + rpt.title +
      '. Health: ' + h.score + '% (' + h.level + ').' +
      ' Unacked alerts: ' + rpt.alerts.length + '.';

    _store(rpt);
    _metrics.incident++;
    _metrics.generated++;
    return rpt;
  }

  // ── Recovery report ───────────────────────────────────────────────────────
  function generateRecoveryReport(opts) {
    opts = opts || {};
    var rpt  = _base('recovery');
    var ao   = G.RuntimeAutonomousOps;
    var h    = _health();

    rpt.cycleId     = opts.cycleId  || null;
    rpt.action      = opts.action   || null;
    rpt.outcome     = opts.outcome  || 'unknown';
    rpt.healthBefore= opts.healthBefore || null;
    rpt.healthAfter = h;
    rpt.cycles      = ao && ao.getCycles ? ao.getCycles(10) : [];
    rpt.summary     = 'Recovery Report — ' + rpt.generatedAtStr +
      '. Outcome: ' + rpt.outcome +
      '. Health after: ' + h.score + '%.';

    _store(rpt);
    _metrics.recovery++;
    _metrics.generated++;
    return rpt;
  }

  function _countByLevel(alerts) {
    var m = {};
    alerts.forEach(function (a) { m[a.level] = (m[a.level] || 0) + 1; });
    return m;
  }

  function _store(rpt) {
    _reports.unshift(rpt);
    if (_reports.length > MAX_REP) _reports.pop();
  }

  function getReports(n, type) {
    var list = _reports;
    if (type) list = list.filter(function (r) { return r.type === type; });
    return list.slice(0, n || 20);
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimePolicyReports = Object.freeze({
    generateDailyReport:    generateDailyReport,
    generateWeeklyReport:   generateWeeklyReport,
    generateIncidentReport: generateIncidentReport,
    generateRecoveryReport: generateRecoveryReport,
    getReports:             getReports,
    getMetrics:             getMetrics,
  });

  console.debug(LOG, 'v1.0 ready');
}(window));

// ── SOURCE: public/js/runtime-policy-export.js ──
// RuntimePolicyExport v1.0 — Arc 15 / Phase J
// =============================================================================
// Enterprise export engine for Arc 15 ERAPO data.
//
// Exports:
//   policies     — from RuntimePolicyEngine
//   workflows    — from RuntimeWorkflowEngine
//   executions   — from RuntimePolicyAnalytics
//   reports      — from RuntimePolicyReports
//   analytics    — from RuntimePolicyAnalytics snapshot
//   decisions    — from RuntimeDecisionEngine
//   heal-cycles  — from RuntimeAutonomousOps
//
// Formats: JSON (structured) | CSV (flat)
// =============================================================================
(function (G) {
  'use strict';
  if (G.RuntimePolicyExport) return;

  var LOG = '[Arc15:PolicyExport]';
  var _metrics = { json: 0, csv: 0, errors: 0 };

  // ── Data collectors ────────────────────────────────────────────────────────
  function _collectAll() {
    var out = { exportedAt: new Date().toISOString(), arc: 15 };

    try {
      var pe = G.RuntimePolicyEngine;
      out.policies = pe && pe.getPolicies ? pe.getPolicies() : [];
    } catch (_) { out.policies = []; }

    try {
      var wfe = G.RuntimeWorkflowEngine;
      out.workflows = wfe && wfe.getWorkflows ? wfe.getWorkflows() : [];
    } catch (_) { out.workflows = []; }

    try {
      var pa = G.RuntimePolicyAnalytics;
      out.executions = pa && pa.getRecords  ? pa.getRecords(500)  : [];
      out.analytics  = pa && pa.getSnapshot ? pa.getSnapshot()    : null;
    } catch (_) { out.executions = []; out.analytics = null; }

    try {
      var rpr = G.RuntimePolicyReports;
      out.reports = rpr && rpr.getReports ? rpr.getReports(50) : [];
    } catch (_) { out.reports = []; }

    try {
      var de = G.RuntimeDecisionEngine;
      out.decisions = de && de.getHistory ? de.getHistory(100) : [];
    } catch (_) { out.decisions = []; }

    try {
      var ao = G.RuntimeAutonomousOps;
      out.healCycles = ao && ao.getCycles ? ao.getCycles(100) : [];
    } catch (_) { out.healCycles = []; }

    try {
      var re = G.RuntimePolicyEngine;
      out.metrics = re && re.getMetrics ? re.getMetrics() : {};
    } catch (_) { out.metrics = {}; }

    return out;
  }

  // ── CSV helpers ────────────────────────────────────────────────────────────
  function _esc(v) {
    if (v == null) return '';
    var s = String(v).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? '"' + s + '"' : s;
  }

  function _toCsv(rows, keys) {
    if (!rows || !rows.length) return keys.join(',') + '\n';
    return [keys.join(',')]
      .concat(rows.map(function (r) { return keys.map(function (k) { return _esc(r[k]); }).join(','); }))
      .join('\n') + '\n';
  }

  function _policiesCsv(policies) {
    return _toCsv(policies, ['id', 'label', 'severity', 'priority', 'enabled', 'action', 'builtIn', 'createdAt']);
  }

  function _executionsCsv(records) {
    return _toCsv(records, ['policyId', 'action', 'status', 'severity', 'ts', 'durationMs']);
  }

  function _decisionsCsv(decisions) {
    return _toCsv(decisions, ['decisionId', 'action', 'confidence', 'risk', 'rationale', 'source', 'ts']);
  }

  function _healCyclesCsv(cycles) {
    return _toCsv(cycles.map(function (c) {
      return {
        cycleId:    c.cycleId,
        state:      c.state,
        signals:    c.signals,
        action:     c.decision && c.decision.action,
        confidence: c.decision && c.decision.confidence,
        healOk:     c.recovery && c.recovery.ok,
        healthScore:c.verify   && c.verify.score,
        durationMs: c.durationMs,
        ts:         c.ts,
      };
    }), ['cycleId', 'state', 'signals', 'action', 'confidence', 'healOk', 'healthScore', 'durationMs', 'ts']);
  }

  // ── Trigger download ───────────────────────────────────────────────────────
  function _download(content, filename, mime) {
    try {
      var blob = new Blob([content], { type: mime });
      var url  = URL.createObjectURL(blob);
      var a    = G.document.createElement('a');
      a.href     = url;
      a.download = filename;
      G.document.body.appendChild(a);
      a.click();
      G.document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      console.warn(LOG, 'download failed:', e.message);
      return false;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function exportJSON(section) {
    try {
      var data = _collectAll();
      var payload = section ? (data[section] || {}) : data;
      var json = JSON.stringify(payload, null, 2);
      var fname = 'arc15-' + (section || 'full') + '-' + Date.now() + '.json';
      var ok = _download(json, fname, 'application/json');
      if (ok) _metrics.json++;
      return { ok: ok, bytes: json.length, filename: fname };
    } catch (e) {
      _metrics.errors++;
      return { ok: false, error: e.message };
    }
  }

  function exportCSV(section) {
    try {
      var data = _collectAll();
      var csv, fname;

      if (section === 'policies' || !section) {
        csv   = _policiesCsv(data.policies);
        fname = 'arc15-policies-' + Date.now() + '.csv';
      } else if (section === 'executions') {
        csv   = _executionsCsv(data.executions);
        fname = 'arc15-executions-' + Date.now() + '.csv';
      } else if (section === 'decisions') {
        csv   = _decisionsCsv(data.decisions);
        fname = 'arc15-decisions-' + Date.now() + '.csv';
      } else if (section === 'heal-cycles') {
        csv   = _healCyclesCsv(data.healCycles);
        fname = 'arc15-heal-cycles-' + Date.now() + '.csv';
      } else {
        return { ok: false, error: 'CSV not supported for section: ' + section };
      }

      var ok = _download(csv, fname, 'text/csv');
      if (ok) _metrics.csv++;
      return { ok: ok, rows: csv.split('\n').length - 1, filename: fname };
    } catch (e) {
      _metrics.errors++;
      return { ok: false, error: e.message };
    }
  }

  function getPayload(section) {
    try {
      var data = _collectAll();
      return section ? (data[section] || null) : data;
    } catch (e) {
      _metrics.errors++;
      return null;
    }
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  G.RuntimePolicyExport = Object.freeze({
    exportJSON:  exportJSON,
    exportCSV:   exportCSV,
    getPayload:  getPayload,
    getMetrics:  getMetrics,
    SECTIONS: Object.freeze(['policies', 'workflows', 'executions', 'reports', 'analytics', 'decisions', 'heal-cycles']),
  });

  console.debug(LOG, 'v1.0 ready — sections:', 7);
}(window));

// ── SOURCE: public/js/panel-policy-engine.js ──
(function (G) {
  'use strict';
  if (G.PanelPolicyEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _sevColor(sev) {
    return sev === 'EMERGENCY' ? '#e74c3c' : sev === 'CRITICAL' ? '#e67e22' : sev === 'WARN' ? '#f39c12' : '#3498db';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var pe = G.RuntimePolicyEngine;
    if (!pe) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimePolicyEngine not loaded</p>'; return; }

    var m        = pe.getMetrics();
    var policies = pe.getPolicies();
    var history  = pe.getHistory(10);
    var enabled  = policies.filter(function (p) { return p.enabled; }).length;

    var polRows = policies.slice(0, 20).map(function (p) {
      var dot    = p.enabled ? '🟢' : '⚫';
      var sCol   = _sevColor(p.severity);
      return '<tr style="border-bottom:1px solid #222">' +
        '<td style="padding:3px 6px">' + dot + '</td>' +
        '<td style="padding:3px 8px;font-size:12px">' + p.label + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:' + sCol + '">' + p.severity + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#888">P' + p.priority + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#aaa">' + (p.action || '—') + '</td>' +
        '<td style="padding:3px 4px">' +
          '<button onclick="(function(){var pe=window.RuntimePolicyEngine;if(!pe)return;pe.' + (p.enabled ? 'disablePolicy' : 'enablePolicy') + '(\'' + p.id + '\');})()" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #444;background:#2a2a3e;color:#ccc">' +
          (p.enabled ? 'Disable' : 'Enable') + '</button></td>' +
        '</tr>';
    }).join('');

    var histRows = history.map(function (h) {
      var sCol = _sevColor(h.severity);
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + h.severity + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + h.label + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#888">' + h.action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#666">' + new Date(h.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Policies', m.total, '#3498db') +
        _kpi('Enabled', enabled, '#2ecc71') +
        _kpi('Triggered', m.triggered, m.triggered > 0 ? '#f39c12' : '#888') +
        _kpi('Errors', m.errors, m.errors > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Evaluated', m.evaluated, '#9b59b6') +
        _kpi('Suppressed', m.suppressed, '#888') +
        _kpi('By CRITICAL', m.bySeverity && m.bySeverity.CRITICAL || 0, '#e67e22') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Policies (' + policies.length + ')</summary>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr style="color:#888;font-size:10px"><th>St</th><th style="text-align:left">Label</th><th>Sev</th><th>Pri</th><th>Action</th><th></th></tr></thead>' +
        '<tbody>' + polRows + '</tbody></table></div></details>' +
      (history.length ? '<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Triggers (' + history.length + ')</summary>' +
        '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Sev</th><th style="text-align:left">Policy</th><th>Action</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' : '') +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimePolicyEngine)window.RuntimePolicyEngine.evaluateAll()" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Evaluate All</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'policies\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
      '</div></div>';
  }

  G.PanelPolicyEngine = Object.freeze({ render: render, refresh: refresh });
}(window));

// ── SOURCE: public/js/panel-automation-engine.js ──
(function (G) {
  'use strict';
  if (G.PanelAutomationEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var ae = G.RuntimeAutomationEngine;
    if (!ae) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeAutomationEngine not loaded</p>'; return; }

    var m       = ae.getMetrics();
    var queue   = ae.getQueue();
    var history = ae.getHistory(15);

    var rate = m.executed > 0 ? Math.round(m.succeeded / m.executed * 100) : 0;
    var rateColor = rate >= 80 ? '#2ecc71' : rate >= 60 ? '#f39c12' : '#e74c3c';

    var queueRows = queue.length ? queue.map(function (q) {
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 6px;font-size:11px;color:#9b59b6">' + q.id + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + q.type + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#888">' + (q.target || '—') + '</td>' +
        '<td style="padding:3px 4px"><button onclick="window.RuntimeAutomationEngine&&window.RuntimeAutomationEngine.cancelAction(\'' + q.id + '\')" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #e74c3c;background:#2a0a0a;color:#e74c3c">Cancel</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="4" style="padding:8px;color:#555;text-align:center;font-size:11px">Queue empty</td></tr>';

    var histRows = history.map(function (h) {
      var sCol = h.status === 'success' ? '#2ecc71' : '#e74c3c';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + h.status + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + h.type + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#888">' + (h.target || '—') + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#666">' + h.durationMs + 'ms</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + new Date(h.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var typeRows = Object.entries(m.byType || {}).map(function (kv) {
      return '<tr style="border-bottom:1px solid #1a1a2e"><td style="padding:2px 8px;font-size:11px">' + kv[0] + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#3498db">' + kv[1] + '</td></tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Executed', m.executed, '#3498db') +
        _kpi('Succeeded', m.succeeded, '#2ecc71') +
        _kpi('Failed', m.failed, m.failed > 0 ? '#e74c3c' : '#888') +
        _kpi('Success Rate', rate + '%', rateColor) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Queued', m.queued, '#9b59b6') +
        _kpi('Pending', queue.length, queue.length > 0 ? '#f39c12' : '#888') +
        _kpi('Cancelled', m.cancelled, '#888') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Action Queue (' + queue.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>ID</th><th style="text-align:left">Type</th><th>Target</th><th></th></tr></thead>' +
        '<tbody>' + queueRows + '</tbody></table></details>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Actions</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Type</th><th>Target</th><th>ms</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      (typeRows ? '<details><summary style="cursor:pointer;font-weight:bold;padding:4px">By Action Type</summary>' +
        '<table style="width:100%;border-collapse:collapse"><tbody>' + typeRows + '</tbody></table></details>' : '') +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimeAutomationEngine)window.RuntimeAutomationEngine.executeAction(\'log\',\'panel-test\')" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Test Log Action</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'executions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelAutomationEngine = Object.freeze({ render: render, refresh: refresh });
}(window));

// ── SOURCE: public/js/panel-workflow-engine.js ──
(function (G) {
  'use strict';
  if (G.PanelWorkflowEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _statusColor(s) {
    return s === 'COMPLETE' ? '#2ecc71' : s === 'FAILED' ? '#e74c3c' : s === 'ROLLED_BACK' ? '#e67e22' :
           s === 'RUNNING'  ? '#3498db' : '#888';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var wfe = G.RuntimeWorkflowEngine;
    if (!wfe) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeWorkflowEngine not loaded</p>'; return; }

    var m       = wfe.getMetrics();
    var active  = wfe.getActiveRuns();
    var history = wfe.getHistory(10);
    var wfs     = wfe.getWorkflows();

    var activeRows = active.length ? active.map(function (r) {
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 6px;font-size:11px;color:#3498db">' + r.runId + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + r.workflowId + '</td>' +
        '<td style="padding:3px 6px;font-size:11px;color:#f39c12">RUNNING</td>' +
        '<td style="padding:3px 4px"><button onclick="window.RuntimeWorkflowEngine&&window.RuntimeWorkflowEngine.cancelWorkflow(\'' + r.runId + '\')" ' +
          'style="font-size:10px;padding:1px 6px;cursor:pointer;border-radius:3px;border:1px solid #e74c3c;background:#2a0a0a;color:#e74c3c">Cancel</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="4" style="padding:8px;color:#555;text-align:center;font-size:11px">No active runs</td></tr>';

    var histRows = history.map(function (h) {
      var sCol  = _statusColor(h.status);
      var steps = h.steps ? h.steps.map(function (s) {
        var sc = s.status === 'success' ? '#2ecc71' : '#e74c3c';
        return '<span style="font-size:10px;padding:1px 4px;border-radius:3px;background:#111;color:' + sc + ';margin:1px">' + s.label + '</span>';
      }).join(' → ') : '';
      return '<tr style="border-bottom:1px solid #111">' +
        '<td style="padding:3px 6px;font-size:11px;color:' + sCol + '">' + h.status + '</td>' +
        '<td style="padding:3px 8px;font-size:11px">' + h.workflowId + '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#888">' + h.durationMs + 'ms</td>' +
        '<td style="padding:3px 6px;font-size:10px">' + steps + '</td>' +
        '</tr>';
    }).join('');

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Workflows', m.workflows, '#3498db') +
        _kpi('Completed', m.completed, '#2ecc71') +
        _kpi('Failed', m.failed, m.failed > 0 ? '#e74c3c' : '#888') +
        _kpi('Active', m.active, m.active > 0 ? '#f39c12' : '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Started', m.started, '#9b59b6') +
        _kpi('Rolled Back', m.rolledBack, m.rolledBack > 0 ? '#e67e22' : '#888') +
        _kpi('Created', m.created, '#888') +
      '</div>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Active Runs (' + active.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Run ID</th><th style="text-align:left">Workflow</th><th>Status</th><th></th></tr></thead>' +
        '<tbody>' + activeRows + '</tbody></table></details>' +
      '<details open style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Runs</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Workflow</th><th>ms</th><th>Steps</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      '<details style="margin-bottom:8px"><summary style="cursor:pointer;font-weight:bold;padding:4px">Registered Workflows (' + wfs.length + ')</summary>' +
        wfs.map(function (w) { return '<div style="padding:4px 8px;font-size:11px;color:#aaa">▸ <b>' + w.label + '</b> (' + w.steps.length + ' steps)</div>'; }).join('') +
      '</details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="try{window.RuntimeWorkflowEngine&&window.RuntimeWorkflowEngine.runWorkflow(\'incident-response\')}catch(e){}" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Run Incident Response</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'workflows\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
      '</div></div>';
  }

  G.PanelWorkflowEngine = Object.freeze({ render: render, refresh: refresh });
}(window));

// ── SOURCE: public/js/panel-autonomous-ops.js ──
(function (G) {
  'use strict';
  if (G.PanelAutonomousOps) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _stateColor(s) {
    return s === 'IDLE' ? '#2ecc71' : s === 'RECOVERING' ? '#f39c12' : s === 'DETECTING' ? '#3498db' : '#888';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var ao = G.RuntimeAutonomousOps;
    if (!ao) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeAutonomousOps not loaded</p>'; return; }

    var status = ao.getLoopStatus();
    var m      = status.metrics || {};
    var cycles = ao.getCycles(15);

    var healRate = m.healCycles > 0 ? Math.round(m.successfulHeals / m.healCycles * 100) : 0;
    var healColor = healRate >= 80 ? '#2ecc71' : healRate >= 60 ? '#f39c12' : '#e74c3c';
    var stateColor = _stateColor(status.state);

    var cycleRows = cycles.length ? cycles.map(function (c) {
      var sCol    = c.state === 'HEALED' ? '#2ecc71' : c.state === 'FAILED' ? '#e74c3c' : c.state === 'NO_ACTION' ? '#888' : '#f39c12';
      var action  = c.decision && c.decision.action ? c.decision.action : '—';
      var conf    = c.decision && c.decision.confidence != null ? c.decision.confidence + '%' : '—';
      var health  = c.verify && c.verify.score != null ? c.verify.score + '%' : '—';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + c.state + '</td>' +
        '<td style="padding:2px 6px;font-size:11px;color:#888">' + (c.signals || 0) + ' signals</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#9b59b6">' + conf + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#2ecc71">' + health + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + (c.durationMs || 0) + 'ms</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="6" style="padding:8px;color:#555;text-align:center;font-size:11px">No cycles yet</td></tr>';

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:8px;background:#1a1a2e;border-radius:6px">' +
        '<div style="font-size:22px">' + (status.running ? '🔄' : '⏸') + '</div>' +
        '<div>' +
          '<div style="font-weight:700;color:' + (status.running ? '#2ecc71' : '#888') + '">' + (status.running ? 'RUNNING' : 'STOPPED') + '</div>' +
          '<div style="font-size:11px;color:' + stateColor + '">' + status.state + '</div>' +
        '</div>' +
        '<div style="margin-left:auto;font-size:11px;color:#666">Interval: ' + Math.round((status.interval || 0) / 1000) + 's</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Cycles', m.totalCycles || 0, '#3498db') +
        _kpi('Heal Cycles', m.healCycles || 0, '#9b59b6') +
        _kpi('Heal Rate', healRate + '%', healColor) +
        _kpi('No Action', m.noActionCycles || 0, '#888') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Successful Heals', m.successfulHeals || 0, '#2ecc71') +
        _kpi('Failed Heals', m.failedHeals || 0, (m.failedHeals || 0) > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px">Heal Cycles (' + cycles.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th>State</th><th>Signals</th><th style="text-align:left">Action</th><th>Conf</th><th>Health</th><th>ms</th></tr></thead>' +
        '<tbody>' + cycleRows + '</tbody></table></details>' +
      '<div style="margin-top:10px;display:flex;gap:8px">' +
        '<button onclick="if(window.RuntimeAutonomousOps)' + (status.running ? 'window.RuntimeAutonomousOps.stop()' : 'window.RuntimeAutonomousOps.start()') + '" ' +
          'style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">' + (status.running ? '⏸ Stop' : '▶ Start') + '</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'heal-cycles\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelAutonomousOps = Object.freeze({ render: render, refresh: refresh });
}(window));

// ── SOURCE: public/js/panel-policy-analytics.js ──
(function (G) {
  'use strict';
  if (G.PanelPolicyAnalytics) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var pa = G.RuntimePolicyAnalytics;
    if (!pa) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimePolicyAnalytics not loaded</p>'; return; }

    var snap     = pa.getSnapshot();
    var m        = pa.getMetrics();
    var records  = pa.getRecords(20);

    var successRate  = snap && snap.recentRate ? snap.recentRate.success  : 0;
    var failureRate  = snap && snap.recentRate ? snap.recentRate.failure  : 0;
    var rollbackRate = snap && snap.recentRate ? snap.recentRate.rollback : 0;

    var sColor  = successRate  >= 80 ? '#2ecc71' : successRate  >= 60 ? '#f39c12' : '#e74c3c';
    var fColor  = failureRate  > 20  ? '#e74c3c' : failureRate  > 10  ? '#f39c12' : '#2ecc71';
    var rbColor = rollbackRate > 10  ? '#e67e22' : '#888';

    function _rankRows(list, label) {
      if (!list || !list.length) return '<tr><td colspan="4" style="padding:4px;color:#555;font-size:11px">No data</td></tr>';
      return list.map(function (r, i) {
        return '<tr style="border-bottom:1px solid #1a1a2e">' +
          '<td style="padding:2px 6px;font-size:11px;color:#888">#' + (i + 1) + '</td>' +
          '<td style="padding:2px 8px;font-size:11px">' + r.policyId + '</td>' +
          '<td style="padding:2px 6px;font-size:11px;color:#3498db">' + r.total + '</td>' +
          '<td style="padding:2px 6px;font-size:10px;color:#2ecc71">' + r.successRate + '%</td>' +
          '</tr>';
      }).join('');
    }

    var recRows = records.map(function (r) {
      var sCol = r.status === 'success' ? '#2ecc71' : r.status === 'rollback' ? '#e67e22' : '#e74c3c';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:2px 6px;font-size:11px;color:' + sCol + '">' + r.status + '</td>' +
        '<td style="padding:2px 8px;font-size:11px">' + r.policyId + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#888">' + r.action + '</td>' +
        '<td style="padding:2px 6px;font-size:10px;color:#555">' + new Date(r.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var rankings = snap && snap.rankings ? snap.rankings : {};

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Total Tracked', m.total || 0, '#3498db') +
        _kpi('Success Rate', successRate + '%', sColor) +
        _kpi('Failure Rate', failureRate + '%', fColor) +
        _kpi('Rollback Rate', rollbackRate + '%', rbColor) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Successes', m.tracked > 0 ? Math.round(m.successes || 0) : 0, '#2ecc71') +
        _kpi('Failures', m.tracked > 0 ? Math.round(m.failures  || 0) : 0, '#e74c3c') +
        _kpi('Rollbacks', m.tracked > 0 ? Math.round(m.rollbacks || 0) : 0, '#e67e22') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">' +
        '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px;font-size:11px">Top by Executions</summary>' +
        '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>#</th><th style="text-align:left">Policy</th><th>Runs</th><th>S%</th></tr></thead>' +
        '<tbody>' + _rankRows(rankings.byExecutions, 'executions') + '</tbody></table></details>' +
        '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px;font-size:11px">Top by Failure</summary>' +
        '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>#</th><th style="text-align:left">Policy</th><th>Runs</th><th>S%</th></tr></thead>' +
        '<tbody>' + _rankRows(rankings.byFailure, 'failure') + '</tbody></table></details>' +
      '</div>' +
      '<details><summary style="cursor:pointer;font-weight:bold;padding:4px">Recent Executions (' + records.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse"><thead><tr style="color:#888;font-size:10px"><th>Status</th><th style="text-align:left">Policy</th><th>Action</th><th>Time</th></tr></thead>' +
      '<tbody>' + recRows + '</tbody></table></details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportJSON(\'analytics\')" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export JSON</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'executions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelPolicyAnalytics = Object.freeze({ render: render, refresh: refresh });
}(window));

// ── SOURCE: public/js/panel-decision-engine.js ──
(function (G) {
  'use strict';
  if (G.PanelDecisionEngine) return;

  var _el = null;

  function _kpi(label, value, color) {
    return '<div style="background:#1a1a2e;border-radius:6px;padding:8px;text-align:center">' +
      '<div style="font-size:18px;font-weight:700;color:' + (color || '#3498db') + '">' + value + '</div>' +
      '<div style="font-size:10px;color:#888;margin-top:2px">' + label + '</div></div>';
  }

  function _bar(pct, color) {
    return '<div style="height:6px;background:#111;border-radius:3px;width:100%;margin-top:3px">' +
      '<div style="height:6px;background:' + color + ';border-radius:3px;width:' + Math.min(100, pct) + '%"></div></div>';
  }

  function render(container) { _el = container; refresh(); }

  function refresh() {
    if (!_el) return;
    var de = G.RuntimeDecisionEngine;
    if (!de) { _el.innerHTML = '<p style="color:#e74c3c;padding:8px">RuntimeDecisionEngine not loaded</p>'; return; }

    var m       = de.getMetrics();
    var history = de.getHistory(15);

    var avgConf = history.length ? Math.round(history.reduce(function (s, d) { return s + d.confidence; }, 0) / history.length) : 0;
    var avgRisk = history.length ? Math.round(history.reduce(function (s, d) { return s + d.risk; }, 0) / history.length) : 0;

    var confColor = avgConf >= 80 ? '#2ecc71' : avgConf >= 60 ? '#f39c12' : '#e74c3c';
    var riskColor = avgRisk >= 70 ? '#e74c3c' : avgRisk >= 40 ? '#f39c12' : '#2ecc71';

    var histRows = history.map(function (d) {
      var cCol = d.confidence >= 80 ? '#2ecc71' : d.confidence >= 60 ? '#f39c12' : '#e74c3c';
      var rCol = d.risk >= 70 ? '#e74c3c' : d.risk >= 40 ? '#f39c12' : '#2ecc71';
      return '<tr style="border-bottom:1px solid #1a1a2e">' +
        '<td style="padding:3px 8px;font-size:11px">' + (d.action || '—') + '</td>' +
        '<td style="padding:3px 6px;min-width:80px">' +
          '<div style="font-size:11px;color:' + cCol + '">' + d.confidence + '%</div>' +
          _bar(d.confidence, cCol) +
        '</td>' +
        '<td style="padding:3px 6px;min-width:80px">' +
          '<div style="font-size:11px;color:' + rCol + '">' + d.risk + '%</div>' +
          _bar(d.risk, rCol) +
        '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#888">' + (d.source || '—') + '</td>' +
        '<td style="padding:3px 6px;font-size:10px;color:#555">' + new Date(d.ts).toLocaleTimeString() + '</td>' +
        '</tr>';
    }).join('');

    var lastDec = history[0];
    var signalSummary = '';
    if (lastDec && lastDec.signals) {
      var sig = lastDec.signals;
      signalSummary =
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-bottom:12px">' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">FORECAST</div>' +
            '<div style="font-size:11px;color:#f39c12">risk: ' + (sig.forecast && sig.forecast.risk || 0) + '%</div>' +
            (sig.forecast && sig.forecast.criticals ? '<div style="font-size:10px;color:#e74c3c">' + sig.forecast.criticals + ' critical</div>' : '') +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">GOVERNANCE</div>' +
            '<div style="font-size:11px;color:' + (sig.governance && sig.governance.compliant ? '#2ecc71' : '#e74c3c') + '">' +
              (sig.governance && sig.governance.compliant ? 'Compliant' : sig.governance && sig.governance.violations + ' violations') + '</div>' +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">MEMORY REC.</div>' +
            '<div style="font-size:11px;color:#9b59b6">' + (sig.memory && sig.memory.action || 'unknown') + '</div>' +
            '<div style="font-size:10px;color:#666">conf: ' + (sig.memory && sig.memory.confidence || 0) + '%</div>' +
          '</div>' +
          '<div style="background:#1a1a2e;border-radius:6px;padding:8px">' +
            '<div style="font-size:10px;color:#888;margin-bottom:4px">ADAPTIVE AI</div>' +
            '<div style="font-size:11px;color:#3498db">' + (sig.adaptiveAI && sig.adaptiveAI.conservative ? 'Conservative' : 'Normal') + '</div>' +
          '</div>' +
        '</div>';
    }

    _el.innerHTML =
      '<div style="font-family:monospace;font-size:13px;padding:8px">' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">' +
        _kpi('Decisions', m.decisions, '#3498db') +
        _kpi('Avg Confidence', avgConf + '%', confColor) +
        _kpi('Avg Risk', avgRisk + '%', riskColor) +
        _kpi('High Risk', m.highRisk, m.highRisk > 0 ? '#e74c3c' : '#888') +
      '</div>' +
      (signalSummary ? '<div style="font-size:10px;color:#888;margin-bottom:4px;font-weight:bold">LAST DECISION SIGNALS</div>' + signalSummary : '') +
      '<details open><summary style="cursor:pointer;font-weight:bold;padding:4px">Decision History (' + history.length + ')</summary>' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr style="color:#888;font-size:10px"><th style="text-align:left">Action</th><th>Confidence</th><th>Risk</th><th>Source</th><th>Time</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table></details>' +
      '<div style="margin-top:10px">' +
        '<button onclick="try{var d=window.RuntimeDecisionEngine;if(d)d.decide({source:\'panel-test\'});}catch(e){}" style="padding:4px 10px;cursor:pointer;margin-right:6px;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">▶ Run Decision</button>' +
        '<button onclick="if(window.RuntimePolicyExport)window.RuntimePolicyExport.exportCSV(\'decisions\')" style="padding:4px 10px;cursor:pointer;border-radius:4px;border:1px solid #444;background:#2a2a3e;color:#ccc">⬇ Export CSV</button>' +
      '</div></div>';
  }

  G.PanelDecisionEngine = Object.freeze({ render: render, refresh: refresh });
}(window));

