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
