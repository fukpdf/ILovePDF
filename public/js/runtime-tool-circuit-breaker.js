(function (G) {
  'use strict';
  if (G.RuntimeToolCircuitBreaker) return;

  var LOG = '[Arc13:CircuitBreaker]';

  var STATE_CLOSED    = 'CLOSED';
  var STATE_OPEN      = 'OPEN';
  var STATE_HALF_OPEN = 'HALF_OPEN';

  // Per-tool breaker state
  // _breakers[toolId] = { state, openedAt, halfOpenAt, testRequest, windowFailures, windowTs }
  var _breakers = {};
  var _metrics  = { opened: 0, closed: 0, halfOpened: 0, denied: 0 };

  var FAILURE_RATE_THRESH  = 0.20;   // 20% failure rate triggers OPEN
  var CRASH_COUNT_THRESH   = 5;      // 5 crashes in window triggers OPEN
  var CRASH_WINDOW_MS      = 10 * 60 * 1000; // 10 minutes
  var HALF_OPEN_DELAY_MS   = 30 * 1000;      // 30s before half-open probe
  var SUCCESS_TO_CLOSE     = 2;              // consecutive successes to re-close

  function _breaker(toolId) {
    if (!_breakers[toolId]) {
      _breakers[toolId] = {
        state:         STATE_CLOSED,
        openedAt:      0,
        halfOpenAt:    0,
        consecutiveOk: 0,
        windowFailures: 0,
        windowTs:      Date.now(),
        crashWindow:   [],   // timestamps of crashes in window
      };
    }
    return _breakers[toolId];
  }

  function _dispatch(event, detail) {
    try { G.dispatchEvent(new CustomEvent(event, { detail: detail })); } catch (_) {}
  }

  function _open(toolId, reason) {
    var b = _breaker(toolId);
    if (b.state === STATE_OPEN) return;
    b.state         = STATE_OPEN;
    b.openedAt      = Date.now();
    b.consecutiveOk = 0;
    _metrics.opened++;
    console.warn(LOG, 'OPEN:', toolId, '—', reason);
    _dispatch('arc13:circuit-opened', { toolId: toolId, reason: reason, ts: b.openedAt });
    // Schedule half-open probe
    setTimeout(function () { _halfOpen(toolId); }, HALF_OPEN_DELAY_MS);
  }

  function _halfOpen(toolId) {
    var b = _breaker(toolId);
    if (b.state !== STATE_OPEN) return;
    b.state      = STATE_HALF_OPEN;
    b.halfOpenAt = Date.now();
    _metrics.halfOpened++;
    console.debug(LOG, 'HALF_OPEN:', toolId);
    _dispatch('arc13:circuit-half-open', { toolId: toolId, ts: b.halfOpenAt });
  }

  function _close(toolId) {
    var b = _breaker(toolId);
    if (b.state === STATE_CLOSED) return;
    b.state         = STATE_CLOSED;
    b.consecutiveOk = 0;
    b.windowFailures = 0;
    b.crashWindow    = [];
    _metrics.closed++;
    console.debug(LOG, 'CLOSED:', toolId);
    _dispatch('arc13:circuit-closed', { toolId: toolId, ts: Date.now() });
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function getState(toolId) {
    return _breaker(toolId).state;
  }

  function canExecute(toolId) {
    var b = _breaker(toolId);
    if (b.state === STATE_CLOSED) return true;
    if (b.state === STATE_HALF_OPEN) {
      // Allow exactly one test request
      if (!b.testPending) {
        b.testPending = true;
        return true;
      }
      _metrics.denied++;
      return false;
    }
    // STATE_OPEN — check if half-open delay has elapsed
    if (Date.now() - b.openedAt >= HALF_OPEN_DELAY_MS) {
      _halfOpen(toolId);
      b.testPending = true;
      return true;
    }
    _metrics.denied++;
    return false;
  }

  function recordSuccess(toolId) {
    var b = _breaker(toolId);
    b.testPending   = false;
    b.consecutiveOk++;
    if (b.state === STATE_HALF_OPEN && b.consecutiveOk >= SUCCESS_TO_CLOSE) {
      _close(toolId);
    } else if (b.state === STATE_CLOSED) {
      b.windowFailures = Math.max(0, b.windowFailures - 1);
    }
  }

  function recordFailure(toolId, opts) {
    var b   = _breaker(toolId);
    var now = Date.now();
    opts    = opts || {};
    b.testPending    = false;
    b.consecutiveOk  = 0;

    // Slide crash window
    b.crashWindow = b.crashWindow.filter(function (t) { return now - t < CRASH_WINDOW_MS; });
    if (opts.crash) b.crashWindow.push(now);

    // Count failures in rate window (reset every 60s)
    if (now - b.windowTs > 60000) { b.windowFailures = 0; b.windowTs = now; }
    b.windowFailures++;

    if (b.state === STATE_HALF_OPEN) {
      _open(toolId, 'half-open test failed');
      return;
    }
    if (b.state === STATE_OPEN) return;

    // Evaluate triggers
    var tool = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getTool
      ? G.RuntimeToolRegistry.getTool(toolId) : null;
    var total    = tool ? (tool.successes + tool.failures) : 0;
    var failRate = total > 10 ? (tool.failures / total) : 0;
    var health   = G.RuntimeToolHealth && G.RuntimeToolHealth.getHealth
      ? G.RuntimeToolHealth.getHealth(toolId) : null;
    var isCritical = health && health.level === 'CRITICAL';

    if (b.crashWindow.length >= CRASH_COUNT_THRESH)         { _open(toolId, 'crash threshold'); return; }
    if (failRate > FAILURE_RATE_THRESH && total > 10)        { _open(toolId, 'failure rate ' + Math.round(failRate * 100) + '%'); return; }
    if (isCritical)                                          { _open(toolId, 'health CRITICAL'); return; }
  }

  function getAll() {
    var result = {};
    Object.keys(_breakers).forEach(function (id) {
      var b = _breakers[id];
      result[id] = {
        state:          b.state,
        openedAt:       b.openedAt,
        consecutiveOk:  b.consecutiveOk,
        crashesInWindow: b.crashWindow.length,
      };
    });
    return result;
  }

  function getMetrics() { return Object.assign({}, _metrics); }

  // ── Listen to Arc 12 events ─────────────────────────────────────────────────
  G.addEventListener('arc12:metrics-updated', function (e) {
    var d = e && e.detail;
    if (!d || !d.toolId) return;
    var t = G.RuntimeToolRegistry && G.RuntimeToolRegistry.getTool
      ? G.RuntimeToolRegistry.getTool(d.toolId) : null;
    if (!t) return;
    if (d.crash || (t.crashCount > 0 && d.failure)) {
      recordFailure(d.toolId, { crash: !!d.crash });
    } else if (d.success) {
      recordSuccess(d.toolId);
    }
  });

  G.addEventListener('arc12:health-refreshed', function (e) {
    var scores = e && e.detail && e.detail.scores;
    if (!scores) return;
    Object.keys(scores).forEach(function (id) {
      if (scores[id].level === 'CRITICAL') {
        recordFailure(id, {});
      }
    });
  });

  G.RuntimeToolCircuitBreaker = Object.freeze({
    getState:      getState,
    canExecute:    canExecute,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    getAll:        getAll,
    getMetrics:    getMetrics,
    STATES: Object.freeze({ CLOSED: STATE_CLOSED, OPEN: STATE_OPEN, HALF_OPEN: STATE_HALF_OPEN }),
  });

}(typeof window !== 'undefined' ? window : this));
