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
