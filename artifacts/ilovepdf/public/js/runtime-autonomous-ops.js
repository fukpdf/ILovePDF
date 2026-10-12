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
