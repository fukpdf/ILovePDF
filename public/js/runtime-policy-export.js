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
