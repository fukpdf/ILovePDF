// RuntimeAnalyticsDomains v1.0 — Arc 3 / Phase E / Target 6
// =====================================================================
// Per-tool analytics namespaces + per-tool health scoring.
//
// Problem: RuntimeHealthAnalytics produces a single global score.
// A crashing OCR job deflates the score for Merge PDF, Compress, etc.
// There is no way to know which tool is actually responsible.
//
// Solution: Each tool has its own analytics domain tracking:
//   - Tool start/success/failure events
//   - Per-tool health score (0–100)
//   - Per-tool crash telemetry (lightweight, not replacing CrashTelemetry)
//   - Per-tool startup duration
//   - Scope tag for grouping related tools (from manifest.analyticsScope)
//
// RuntimeHealthAnalytics is extended (non-destructively) to expose:
//   window.RuntimeHealthAnalytics.getToolScore(toolId)
//   window.RuntimeHealthAnalytics.getToolDashboard(toolId)
//
// This extension is injected after boot since RuntimeHealthAnalytics is
// frozen — we patch via RuntimeAnalyticsDomains.enhanceHealthAnalytics().
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeAnalyticsDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[AnalyticsDom]';
  var VERSION = '1.0';

  // ── Domain registry ───────────────────────────────────────────────────────
  // toolId → { scope, score, events[], crashes, startMs, successCount, failCount }
  var _domains = {};

  function _newDomain(toolId, scope) {
    return {
      toolId:       toolId,
      scope:        scope || toolId,
      score:        100,
      events:       [],
      crashes:      0,
      startMs:      null,
      successCount: 0,
      failCount:    0,
      openedAt:     Date.now(),
    };
  }

  // ── Open domain ───────────────────────────────────────────────────────────
  function open(toolId, scope) {
    if (!_domains[toolId]) {
      _domains[toolId] = _newDomain(toolId, scope);
      console.debug(LOG, 'opened:', toolId, '— scope:', scope || toolId);
    }
    return _domains[toolId];
  }

  // ── Record event ──────────────────────────────────────────────────────────
  function record(toolId, type, detail) {
    var domain = _domains[toolId];
    if (!domain) domain = open(toolId);

    var event = { type: type, ts: Date.now(), detail: detail || {} };
    domain.events.push(event);
    // Keep ring bounded at 100 events per tool
    if (domain.events.length > 100) domain.events.shift();

    // Update score based on event type
    if (type === 'start')   { domain.startMs = Date.now(); }
    if (type === 'success') { domain.successCount++; _adjustScore(domain, +5); }
    if (type === 'fail')    { domain.failCount++;    _adjustScore(domain, -10); }
    if (type === 'crash')   { domain.crashes++;      _adjustScore(domain, -15); }
    if (type === 'timeout') {                        _adjustScore(domain, -8); }
    if (type === 'recover') {                        _adjustScore(domain, +3); }

    try {
      G.dispatchEvent(new CustomEvent('analytics-domain:event', {
        detail: { toolId: toolId, event: event },
      }));
    } catch (_) {}
  }

  function _adjustScore(domain, delta) {
    domain.score = Math.max(0, Math.min(100, domain.score + delta));
  }

  // ── Per-tool health score ─────────────────────────────────────────────────
  function getScore(toolId) {
    var domain = _domains[toolId];
    return domain ? domain.score : 100;
  }

  function getLabel(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 55) return 'fair';
    if (score >= 35) return 'poor';
    return 'critical';
  }

  // ── Per-tool dashboard ────────────────────────────────────────────────────
  function getDashboard(toolId) {
    var domain = _domains[toolId];
    if (!domain) return { toolId: toolId, score: 100, label: 'excellent', events: 0 };
    var successRate = (domain.successCount + domain.failCount) > 0
      ? Math.round(domain.successCount / (domain.successCount + domain.failCount) * 100)
      : null;
    return {
      toolId:       toolId,
      scope:        domain.scope,
      score:        domain.score,
      label:        getLabel(domain.score),
      crashes:      domain.crashes,
      successCount: domain.successCount,
      failCount:    domain.failCount,
      successRate:  successRate,
      eventCount:   domain.events.length,
      openedAt:     domain.openedAt,
      recentEvents: domain.events.slice(-5),
    };
  }

  // ── Scope-level aggregation ───────────────────────────────────────────────
  function getScopeScore(scope) {
    var toolIds = Object.keys(_domains).filter(function (k) { return _domains[k].scope === scope; });
    if (!toolIds.length) return 100;
    var sum = toolIds.reduce(function (acc, k) { return acc + _domains[k].score; }, 0);
    return Math.round(sum / toolIds.length);
  }

  // ── Extend RuntimeHealthAnalytics (non-destructive) ──────────────────────
  // Since RuntimeHealthAnalytics is frozen, we cannot patch it directly.
  // Instead, RuntimeAnalyticsDomains provides the equivalent methods and
  // tool authors can call either module. We also attach helpers to window
  // so existing auditors can call G.getToolScore(toolId).
  function _installExtensions() {
    try {
      G.getToolScore     = getScore;
      G.getToolDashboard = getDashboard;
      console.debug(LOG, 'extensions installed: window.getToolScore, window.getToolDashboard');
    } catch (_) {}
  }
  setTimeout(_installExtensions, 500);

  G.RuntimeAnalyticsDomains = Object.freeze({
    VERSION:         VERSION,
    open:            open,
    record:          record,
    getScore:        getScore,
    getLabel:        getLabel,
    getDashboard:    getDashboard,
    getScopeScore:   getScopeScore,
    getDomains:      function () { return Object.keys(_domains); },
    getAllDashboards: function () {
      var out = {};
      Object.keys(_domains).forEach(function (k) { out[k] = getDashboard(k); });
      return out;
    },
  });

}(window));
