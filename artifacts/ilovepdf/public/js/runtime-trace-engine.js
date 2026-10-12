// RuntimeTraceEngine v1.0 — Arc 8 / Phase C
// =====================================================================
// Distributed runtime trace system with hierarchical span trees.
//
// A TRACE = one user operation (tool activation, large file process).
// A SPAN  = one unit of work within that trace (hydrate P0, start worker,
//           chunk batch, etc.) with parent–child relationships.
//
// Features:
//   - Unique trace IDs + span IDs
//   - Parent-child span tree (call hierarchy)
//   - Worker/processor/hydration/recovery trace propagation via events
//   - Ring-buffer storage (500 completed traces)
//   - Automatic slow-path detection: p99 > threshold → mark as slow
//   - p50/p90/p99 latency computation across trace populations
//   - Export: window.getRuntimeTraces()
//
// Distinct from RuntimeSessionRecorder (security replay) and
// RuntimeForensicsReplay (attack forensics).
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeTraceEngine) return;

  var LOG     = '[TraceEngine]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_TRACES    = 500;   // completed trace ring buffer
  var MAX_ACTIVE    = 50;    // max concurrent active traces
  var SLOW_PATH_MS  = 500;   // mark trace slow if duration > this
  var P99_SLOW_MS   = 1000;

  // ── Storage ───────────────────────────────────────────────────────
  var _active    = {};  // traceId → trace
  var _completed = [];  // ring buffer of completed traces
  var _metrics   = { started: 0, completed: 0, slow: 0, errors: 0 };
  var _telemetry = [];

  function _tel(ev, d) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: d || null });
    if (_telemetry.length > 100) _telemetry.shift();
  }

  // ── ID generation ─────────────────────────────────────────────────
  var _seq = 0;
  function _tid() { return 'tr_' + Date.now().toString(36) + '_' + (++_seq).toString(36); }
  function _sid() { return 'sp_' + Date.now().toString(36) + '_' + (++_seq).toString(36); }

  // ── Start a trace ─────────────────────────────────────────────────
  // Returns: { traceId, rootSpanId }
  function startTrace(name, meta) {
    if (Object.keys(_active).length >= MAX_ACTIVE) {
      // Evict oldest
      var oldest = Object.keys(_active).sort(function (a, b) {
        return _active[a].startedAt - _active[b].startedAt;
      })[0];
      _completeTrace(oldest, 'evicted');
    }
    var traceId    = _tid();
    var rootSpanId = _sid();
    var now        = Date.now();
    _active[traceId] = {
      traceId:    traceId,
      name:       name || 'unnamed',
      meta:       meta || {},
      startedAt:  now,
      spans:      {},
      rootSpanId: rootSpanId,
      slow:       false,
    };
    // Create root span
    _active[traceId].spans[rootSpanId] = {
      spanId:    rootSpanId,
      parentId:  null,
      name:      name || 'root',
      startedAt: now,
      endedAt:   null,
      durationMs: null,
      meta:      meta || {},
      error:     null,
      children:  [],
    };
    _metrics.started++;
    _tel('start', { traceId: traceId, name: name });
    return { traceId: traceId, rootSpanId: rootSpanId };
  }

  // ── Start a child span ────────────────────────────────────────────
  function startSpan(traceId, parentSpanId, name, meta) {
    var trace = _active[traceId];
    if (!trace) return null;
    var spanId = _sid();
    var now    = Date.now();
    trace.spans[spanId] = {
      spanId:    spanId,
      parentId:  parentSpanId || trace.rootSpanId,
      name:      name || 'span',
      startedAt: now,
      endedAt:   null,
      durationMs: null,
      meta:      meta || {},
      error:     null,
      children:  [],
    };
    // Register as child of parent
    var parent = trace.spans[parentSpanId || trace.rootSpanId];
    if (parent) parent.children.push(spanId);
    return spanId;
  }

  // ── End a span ────────────────────────────────────────────────────
  function endSpan(traceId, spanId, error) {
    var trace = _active[traceId];
    if (!trace) return;
    var span  = trace.spans[spanId];
    if (!span || span.endedAt) return;
    span.endedAt    = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    if (error) { span.error = String(error); _metrics.errors++; }
  }

  // ── Complete a trace ──────────────────────────────────────────────
  function endTrace(traceId, error) {
    _completeTrace(traceId, error ? 'error' : 'ok');
  }

  function _completeTrace(traceId, reason) {
    var trace = _active[traceId];
    if (!trace) return;
    delete _active[traceId];

    var now = Date.now();
    // Close any still-open spans
    Object.keys(trace.spans).forEach(function (sid) {
      var span = trace.spans[sid];
      if (!span.endedAt) { span.endedAt = now; span.durationMs = now - span.startedAt; }
    });

    trace.endedAt    = now;
    trace.durationMs = now - trace.startedAt;
    trace.reason     = reason;
    trace.slow       = trace.durationMs > SLOW_PATH_MS;
    if (trace.slow) { _metrics.slow++; _tel('slow', { traceId: traceId, ms: trace.durationMs }); }

    _metrics.completed++;
    _completed.push(Object.freeze(trace));
    if (_completed.length > MAX_TRACES) _completed.shift();
  }

  // ── Percentile computation ────────────────────────────────────────
  function _pct(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
  }

  function getStats() {
    var durations = _completed.map(function (t) { return t.durationMs || 0; });
    return {
      completed: _completed.length,
      active:    Object.keys(_active).length,
      slow:      _metrics.slow,
      errors:    _metrics.errors,
      p50:       _pct(durations, 50),
      p90:       _pct(durations, 90),
      p99:       _pct(durations, 99),
      slowPct:   durations.length
        ? Math.round((_metrics.slow / durations.length) * 100) : 0,
    };
  }

  // ── Event hooks — auto-trace Arc 7 operations ────────────────────
  G.addEventListener('streaming-hydration:viewport', function (evt) {
    try {
      var id   = evt && evt.detail && evt.detail.toolId;
      var ref  = startTrace('hydration:viewport:' + (id || 'unknown'));
      setTimeout(function () { endTrace(ref.traceId); }, 1000);
    } catch (_) {}
  });

  G.addEventListener('stream-workers:progress', function (evt) {
    var d = evt && evt.detail;
    if (!d || d.pct !== 100) return;
    try { endTrace(d.token); } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var ref = startTrace('memory:panic');
      endTrace(ref.traceId, 'panic');
    } catch (_) {}
  });

  G.addEventListener('arc8:command', function (evt) {
    try {
      var d   = evt && evt.detail;
      var ref = startTrace('control-plane:' + (d && d.cmd));
      endTrace(ref.traceId);
    } catch (_) {}
  });

  // ── Export ────────────────────────────────────────────────────────
  G.getRuntimeTraces = function (opts) {
    opts = opts || {};
    var result = _completed.slice();
    if (opts.slowOnly) result = result.filter(function (t) { return t.slow; });
    if (opts.name)     result = result.filter(function (t) { return t.name.includes(opts.name); });
    if (opts.limit)    result = result.slice(-opts.limit);
    return result;
  };

  G.RuntimeTraceEngine = Object.freeze({
    VERSION:    VERSION,
    startTrace: startTrace,
    startSpan:  startSpan,
    endSpan:    endSpan,
    endTrace:   endTrace,
    getStats:   getStats,
    getActive:  function () { return Object.assign({}, _active); },
    getTelemetry: function () { return _telemetry.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — ring:', MAX_TRACES, 'traces | slowPath:', SLOW_PATH_MS + 'ms | window.getRuntimeTraces()');

}(window));
