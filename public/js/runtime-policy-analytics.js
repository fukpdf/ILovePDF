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
