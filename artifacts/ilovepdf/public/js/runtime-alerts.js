(function (G) {
  'use strict';
  if (G.RuntimeAlerts) return;

  var LOG = '[Arc14:Alerts]';

  var LVL_INFO = 'INFO';
  var LVL_WARN = 'WARN';
  var LVL_P2   = 'P2';
  var LVL_P1   = 'P1';
  var LVL_P0   = 'P0';

  var _alerts  = [];
  var _seq     = 0;
  var MAX_ALTS = 300;
  var _metrics = { raised: 0, acknowledged: 0, byLevel: { INFO:0, WARN:0, P2:0, P1:0, P0:0 } };
  var DEDUP_MS = 60 * 1000;   // suppress duplicate alert from same source within 60s

  var _lastBySource = {};   // sourceKey → ts

  function _dedup(sourceKey) {
    var last = _lastBySource[sourceKey] || 0;
    if (Date.now() - last < DEDUP_MS) return true;
    _lastBySource[sourceKey] = Date.now();
    return false;
  }

  function raise(opts) {
    opts = opts || {};
    var level  = opts.level  || LVL_INFO;
    var source = opts.source || 'unknown';
    var msg    = opts.message || '';
    var toolId = opts.toolId || null;

    var key = source + ':' + (toolId || '') + ':' + msg.slice(0, 40);
    if (_dedup(key)) return null;

    var alert = {
      id:           'alt-' + (++_seq),
      level:        level,
      source:       source,
      message:      msg,
      toolId:       toolId,
      ts:           Date.now(),
      acknowledged: false,
    };
    _alerts.unshift(alert);
    if (_alerts.length > MAX_ALTS) _alerts.pop();
    _metrics.raised++;
    if (_metrics.byLevel[level] != null) _metrics.byLevel[level]++;

    try {
      G.dispatchEvent(new CustomEvent('arc14:alert-raised', { detail: alert }));
    } catch (_) {}

    if (level === LVL_P0 || level === LVL_P1) {
      console.warn(LOG, '[' + level + ']', source, '—', msg);
    }
    return alert;
  }

  function acknowledge(alertId) {
    var a = _alerts.find(function (x) { return x.id === alertId; });
    if (a && !a.acknowledged) { a.acknowledged = true; _metrics.acknowledged++; }
  }

  function acknowledgeAll() {
    _alerts.forEach(function (a) { if (!a.acknowledged) { a.acknowledged = true; _metrics.acknowledged++; } });
  }

  function getAlerts(opts) {
    opts = opts || {};
    var result = _alerts.slice();
    if (opts.level)        result = result.filter(function (a) { return a.level === opts.level; });
    if (opts.source)       result = result.filter(function (a) { return a.source === opts.source; });
    if (opts.unacknowledged) result = result.filter(function (a) { return !a.acknowledged; });
    if (opts.toolId)       result = result.filter(function (a) { return a.toolId === opts.toolId; });
    if (opts.limit)        result = result.slice(0, opts.limit);
    return result;
  }

  function getMetrics() { return JSON.parse(JSON.stringify(_metrics)); }

  // ── Arc 13 listeners → raise alerts ─────────────────────────────────────────
  G.addEventListener('arc13:circuit-opened', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: LVL_P1, source: 'circuit-breaker', toolId: d.toolId,
      message: 'Circuit breaker OPEN: ' + d.toolId + ' — ' + (d.reason || '') });
  });

  G.addEventListener('arc13:sla-violated', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: d.critical ? LVL_P1 : LVL_P2, source: 'sla', toolId: d.toolId,
      message: d.toolId + ' SLA violated: ' + d.metric + ' p' + d.percentile + ' = ' + (d.actual || 0).toFixed(0) });
  });

  G.addEventListener('arc13:anomaly-detected', function (e) {
    var d = e && e.detail;
    if (!d) return;
    raise({ level: d.severity === 'P1' ? LVL_P1 : LVL_P2, source: 'anomaly', toolId: d.toolId,
      message: d.toolId + ' ' + d.type + ' anomaly: ' + (d.actual || 0).toFixed(0) + ' (baseline ' + (d.baseline || 0).toFixed(0) + ')' });
  });

  G.addEventListener('arc12:health-refreshed', function (e) {
    var scores = e && e.detail && e.detail.scores;
    if (!scores) return;
    Object.keys(scores).forEach(function (id) {
      if (scores[id].level === 'CRITICAL') {
        raise({ level: LVL_P1, source: 'tool-health', toolId: id, message: id + ' health is CRITICAL' });
      }
    });
  });

  G.addEventListener('arc14:heatmap-updated', function () {
    var hm = G.RuntimeHeatmaps;
    if (!hm) return;
    var curr = hm.getCurrent();
    if (!curr) return;
    if (curr.memory && curr.memory.level === 'RED')
      raise({ level: LVL_P2, source: 'heatmap', message: 'Memory pressure RED: ' + curr.memory.pct + '% of heap limit' });
    if (curr.incidents && curr.incidents.level === 'RED')
      raise({ level: LVL_P1, source: 'heatmap', message: 'High incident count: ' + curr.incidents.active + ' active incidents' });
    if (curr.circuitBreakers && curr.circuitBreakers.open > 0)
      raise({ level: LVL_P2, source: 'circuit-breaker', message: curr.circuitBreakers.open + ' circuit breaker(s) OPEN' });
  });

  G.RuntimeAlerts = Object.freeze({
    raise:         raise,
    acknowledge:   acknowledge,
    acknowledgeAll: acknowledgeAll,
    getAlerts:     getAlerts,
    getMetrics:    getMetrics,
    LEVELS: Object.freeze({ INFO:LVL_INFO, WARN:LVL_WARN, P2:LVL_P2, P1:LVL_P1, P0:LVL_P0 }),
  });

}(typeof window !== 'undefined' ? window : this));
