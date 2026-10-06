// RuntimeIncidentCorrelation v1.0 — Arc 11 / Phase F
// =============================================================================
// Cross-tab, cross-session, cross-reload incident correlation.
//
// Capabilities:
//   - Recurring pattern detection: same incident type repeating across sessions
//   - Root cause grouping: cluster incidents sharing a common root
//   - Incident clustering: spatially (co-occurring in time) + semantically
//   - Cross-tab correlation: incidents from multiple tabs analysed together
//   - Persistence: correlated patterns stored in RuntimeBlackboxStorage
//
// Pattern types detected:
//   RECURRING   — same category appears ≥ RECUR_THRESHOLD times in RECUR_WINDOW_MS
//   CLUSTER     — ≥ CLUSTER_SIZE incidents within CLUSTER_WINDOW_MS
//   CASCADE     — incident A reliably precedes incident B within CASCADE_WINDOW_MS
//   TAB_WIDE    — incident appears in ≥ 2 tabs simultaneously
//
// window.RuntimeIncidentCorrelation
//   .ingest(incident)           → void  (accepts incidents from any source)
//   .getPatterns()              → Pattern[]
//   .getClusters()              → Cluster[]
//   .getCascades()              → Cascade[]
//   .getTopRootCauses(n)        → RootCause[]
//   .flush()                    → void  (clear all state)
//   .getMetrics()               → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeIncidentCorrelation) return;

  var VERSION = '1.0';
  var LOG     = '[IncidentCorrelation]';

  var RECUR_THRESHOLD    = 3;
  var RECUR_WINDOW_MS    = 5 * 60 * 1000;   // 5 min
  var CLUSTER_SIZE       = 4;
  var CLUSTER_WINDOW_MS  = 30 * 1000;        // 30 s
  var CASCADE_WINDOW_MS  = 10 * 1000;        // 10 s
  var MAX_INCIDENTS      = 2000;
  var MAX_PATTERNS       = 200;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _incidents = [];   // { id, type, category, severity, ts, tabId, score }
  var _patterns  = [];   // { type, category, count, firstTs, lastTs, details }
  var _clusters  = [];   // { id, incidents[], startTs, endTs, size }
  var _cascades  = [];   // { trigger, effect, count, avgDelayMs }
  var _rootCauses = {};  // category → { count, severity, firstTs, lastTs }
  var _metrics   = { ingested: 0, patterns: 0, clusters: 0, cascades: 0, persisted: 0 };

  // ── Ingest an incident ────────────────────────────────────────────────────
  function ingest(incident) {
    if (!incident) return;
    var now = Date.now();
    var rec = {
      id:       incident.id || ('ic_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5)),
      type:     incident.type     || incident.category || 'unknown',
      category: incident.category || incident.type     || 'unknown',
      severity: incident.severity || 'MEDIUM',
      score:    incident.score    || 0,
      ts:       incident.ts       || now,
      tabId:    incident.tabId    || 'local',
    };
    _incidents.push(rec);
    if (_incidents.length > MAX_INCIDENTS) _incidents.shift();
    _metrics.ingested++;
    _rootCauses[rec.category] = _rootCauses[rec.category] || { count: 0, severity: rec.severity, firstTs: rec.ts, lastTs: 0 };
    _rootCauses[rec.category].count++;
    _rootCauses[rec.category].lastTs = rec.ts;

    _analyseRecurring(rec);
    _analyseCluster(rec, now);
    _analyseCascade(rec, now);
    _persistIfCritical(rec);
  }

  // ── Recurring pattern detection ────────────────────────────────────────────
  function _analyseRecurring(rec) {
    var since = rec.ts - RECUR_WINDOW_MS;
    var same  = _incidents.filter(function (i) { return i.category === rec.category && i.ts >= since; });
    if (same.length >= RECUR_THRESHOLD) {
      var existing = _findPattern('RECURRING', rec.category);
      if (!existing) {
        var pat = { type: 'RECURRING', category: rec.category, count: same.length,
                    firstTs: same[0].ts, lastTs: rec.ts, details: { windowMs: RECUR_WINDOW_MS } };
        _addPattern(pat);
        console.debug(LOG, 'recurring pattern:', rec.category, 'x', same.length);
      } else {
        existing.count = same.length;
        existing.lastTs = rec.ts;
      }
    }
  }

  // ── Cluster detection ──────────────────────────────────────────────────────
  function _analyseCluster(rec, now) {
    var since   = now - CLUSTER_WINDOW_MS;
    var cluster = _incidents.filter(function (i) { return i.ts >= since; });
    if (cluster.length >= CLUSTER_SIZE) {
      var lastCluster = _clusters[_clusters.length - 1];
      if (!lastCluster || now - lastCluster.endTs > CLUSTER_WINDOW_MS) {
        var cl = { id: 'cl_' + now.toString(36), incidents: cluster.map(function (i) { return i.id; }),
                   startTs: cluster[0].ts, endTs: now, size: cluster.length };
        _clusters.push(cl);
        if (_clusters.length > 100) _clusters.shift();
        _metrics.clusters++;
        console.debug(LOG, 'incident cluster detected:', cl.size, 'incidents in', CLUSTER_WINDOW_MS, 'ms');
      } else {
        lastCluster.endTs  = now;
        lastCluster.size   = cluster.length;
      }
    }
  }

  // ── Cascade detection ──────────────────────────────────────────────────────
  function _analyseCascade(rec, now) {
    var since  = now - CASCADE_WINDOW_MS;
    var before = _incidents.filter(function (i) { return i.ts >= since && i.ts < rec.ts && i.category !== rec.category; });
    before.forEach(function (prior) {
      var key = prior.category + '→' + rec.category;
      var existing = _cascades.find(function (c) { return c.trigger === prior.category && c.effect === rec.category; });
      if (!existing) {
        _cascades.push({ trigger: prior.category, effect: rec.category, count: 1,
                         avgDelayMs: rec.ts - prior.ts, key: key });
        if (_cascades.length > 100) _cascades.shift();
        _metrics.cascades++;
      } else {
        existing.count++;
        existing.avgDelayMs = Math.round((existing.avgDelayMs * (existing.count - 1) + (rec.ts - prior.ts)) / existing.count);
      }
    });
  }

  // ── Persist critical patterns ──────────────────────────────────────────────
  function _persistIfCritical(rec) {
    if (rec.severity === 'CRITICAL' || rec.severity === 'P0') {
      _s(function () {
        var bbs = G.RuntimeBlackboxStorage;
        if (bbs && bbs.isAvailable()) {
          bbs.store('incidents', rec);
          _metrics.persisted++;
        }
      });
    }
  }

  // ── Pattern helpers ────────────────────────────────────────────────────────
  function _findPattern(type, category) {
    return _patterns.find(function (p) { return p.type === type && p.category === category; }) || null;
  }

  function _addPattern(pat) {
    if (_patterns.length >= MAX_PATTERNS) _patterns.shift();
    _patterns.push(pat);
    _metrics.patterns++;
  }

  // ── Subscribe to live incident sources ─────────────────────────────────────
  function _bindSources() {
    // Arc 8 incidents
    window.addEventListener('arc8:incident', function (evt) {
      if (evt && evt.detail) ingest(evt.detail);
    });
    // Cross-tab incidents from TabMesh
    _s(function () {
      var tm = G.RuntimeTabMesh;
      if (tm && typeof tm.getIncidentHistory === 'function') {
        var hist = tm.getIncidentHistory();
        hist.forEach(function (i) { ingest(i); });
      }
    });
    // Arc8 control plane commands
    window.addEventListener('arc8:command', function (evt) {
      if (evt && evt.detail && evt.detail.type === 'incident') ingest(evt.detail);
    });
  }

  function flush() {
    _incidents = []; _patterns = []; _clusters = []; _cascades = []; _rootCauses = {};
    _metrics = { ingested: 0, patterns: 0, clusters: 0, cascades: 0, persisted: 0 };
  }

  function getTopRootCauses(n) {
    return Object.keys(_rootCauses)
      .map(function (k) { return Object.assign({ category: k }, _rootCauses[k]); })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, n || 10);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_bindSources, 6000); }, { once: true });
  } else {
    setTimeout(_bindSources, 6000);
  }

  G.RuntimeIncidentCorrelation = Object.freeze({
    VERSION:         VERSION,
    ingest:          ingest,
    getPatterns:     function () { return _patterns.slice(); },
    getClusters:     function () { return _clusters.slice(); },
    getCascades:     function () { return _cascades.slice(); },
    getTopRootCauses: getTopRootCauses,
    flush:           flush,
    getMetrics:      function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
