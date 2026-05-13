// Stability Metrics v1.0 — Final Stabilization
// Tracks render success/retry/failure rates, session invalidations, and
// general event counters. Provides a getReport() API for diagnostics.
//
// API: window.StabilityMetrics
//   .recordRender(success, elapsedMs, tag)
//   .recordRenderRetry(attempt, errorMessage)
//   .recordEvent(name)
//   .getReport()   → { renders, retries, failures, ... }
//   .reset()
(function () {
  'use strict';

  if (window.StabilityMetrics) return;

  var _startTime = Date.now();

  var _renders = {
    total:   0,
    success: 0,
    failure: 0,
    totalMs: 0,
    byTag:   {},    // tag → { count, success }
  };

  var _retries = {
    total:          0,
    byAttempt:      { 2: 0, 3: 0 },
    recentErrors:   [],   // last 20 error messages
  };

  var _events = {};   // event name → count
  var MAX_RECENT = 20;
  var MAX_TAG_KEYS = 50;

  function recordRender(success, elapsedMs, tag) {
    _renders.total++;
    if (success) {
      _renders.success++;
    } else {
      _renders.failure++;
    }
    _renders.totalMs += (elapsedMs || 0);

    if (tag) {
      if (Object.keys(_renders.byTag).length < MAX_TAG_KEYS) {
        if (!_renders.byTag[tag]) _renders.byTag[tag] = { count: 0, success: 0 };
        _renders.byTag[tag].count++;
        if (success) _renders.byTag[tag].success++;
      }
    }
  }

  function recordRenderRetry(attempt, errorMessage) {
    _retries.total++;
    var a = Math.min(attempt, 3);
    _retries.byAttempt[a] = (_retries.byAttempt[a] || 0) + 1;
    if (errorMessage) {
      _retries.recentErrors.push({ ts: Date.now(), msg: String(errorMessage).slice(0, 120) });
      if (_retries.recentErrors.length > MAX_RECENT) _retries.recentErrors.shift();
    }
  }

  function recordEvent(name) {
    if (!name) return;
    _events[name] = (_events[name] || 0) + 1;
  }

  function getReport() {
    var total   = _renders.total;
    var success = _renders.success;
    var failure = _renders.failure;
    var avgMs   = total > 0 ? Math.round(_renders.totalMs / total) : 0;
    var successRate = total > 0 ? ((success / total) * 100).toFixed(1) + '%' : 'N/A';
    var uptimeSec   = Math.round((Date.now() - _startTime) / 1000);

    return {
      uptime: uptimeSec + 's',
      renders: {
        total:       total,
        success:     success,
        failure:     failure,
        successRate: successRate,
        avgMs:       avgMs,
        byTag:       JSON.parse(JSON.stringify(_renders.byTag)),
      },
      retries: {
        total:        _retries.total,
        byAttempt:    JSON.parse(JSON.stringify(_retries.byAttempt)),
        recentErrors: _retries.recentErrors.slice(-5),
      },
      events: JSON.parse(JSON.stringify(_events)),
    };
  }

  function reset() {
    _renders = { total: 0, success: 0, failure: 0, totalMs: 0, byTag: {} };
    _retries = { total: 0, byAttempt: { 2: 0, 3: 0 }, recentErrors: [] };
    _events  = {};
    _startTime = Date.now();
  }

  // Hook into MemPressure tier-change events for observability
  if (window.MemPressure && window.MemPressure.onTierChange) {
    window.MemPressure.onTierChange(function (cur, old) {
      recordEvent('mem-tier-change:' + old + '->' + cur);
    });
  }

  window.StabilityMetrics = { recordRender, recordRenderRetry, recordEvent, getReport, reset };
  console.debug('[StabilityMetrics] ready — window.StabilityMetrics.getReport()');
}());
