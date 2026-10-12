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
