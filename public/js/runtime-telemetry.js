// Runtime Telemetry Bus v1.0 — Phase 2 (T028)
// Browser-side-only telemetry pipeline. Collects task lifecycle, worker
// lifecycle, memory pressure, retries, cancellations, crashes, degradation
// events, cleanup timing, long tasks, and runtime stalls.
//
// Data NEVER leaves the browser — all telemetry is for local diagnostics,
// health scoring, and developer inspection only.
//
// API: window.RuntimeTelemetry
//   .record(eventName, data?)     — log a telemetry event
//   .startSpan(name, meta?)       — start a timed span, returns spanId
//   .endSpan(spanId, outcome?)    — end span, records duration
//   .getReport()                  — current session summary
//   .getRecentEvents(n?)          — last N events (default 100)
//   .onEvent(fn)                  — subscribe to all events
//
// [FUTURE: TelemetryExport] Replace in-memory ring buffer with an IDB-backed
// stream so telemetry survives page refreshes for post-crash analysis.
(function () {
  'use strict';

  if (window.RuntimeTelemetry) return;

  var MAX_EVENTS = 500;   // ring buffer cap
  var MAX_SPANS  = 200;   // active + completed span cap

  // ── Event ring buffer ─────────────────────────────────────────────────────
  var _events  = [];      // [{ ts, name, data }]
  var _spans   = new Map(); // spanId → { name, start, meta }
  var _spanLog = [];      // completed: [{ name, durationMs, outcome, meta }]
  var _spanId  = 0;

  // ── Subscriber list ───────────────────────────────────────────────────────
  var _subs = new Set();

  // ── Counters (rolling session totals) ─────────────────────────────────────
  var _counters = {
    tasks:       { started: 0, completed: 0, failed: 0, cancelled: 0 },
    workers:     { spawned: 0, released: 0, zombies: 0 },
    memory:      { tierChanges: 0, emergencies: 0, cleanups: 0 },
    retries:     { total: 0, storms: 0 },
    cancellations: { total: 0, byNav: 0, byTimeout: 0, byUser: 0 },
    progress:    { stalls: 0 },
    health:      { degradations: 0, recoveries: 0 },
  };

  // ── Core record ───────────────────────────────────────────────────────────
  function record(name, data) {
    var ev = { ts: Date.now(), name: name, data: data || null };

    _events.push(ev);
    if (_events.length > MAX_EVENTS) _events.shift();

    // Update counters
    _updateCounters(name, data);

    // Notify subscribers
    _subs.forEach(function (fn) {
      try { fn(ev); } catch (_) {}
    });

    // Forward to StabilityMetrics if available (backward compat)
    if (window.StabilityMetrics && typeof window.StabilityMetrics.recordEvent === 'function') {
      try { window.StabilityMetrics.recordEvent(name); } catch (_) {}
    }

    // Forward to RuntimeEventBus
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('telemetry', ev); } catch (_) {}
    }
    // Forward to RuntimeState counters
    if (window.RuntimeState) {
      _syncStateCounters(name);
    }
  }

  function _syncStateCounters(name) {
    try {
      var RS = window.RuntimeState;
      if (name === 'task:started')    { RS.inc('activeTasks'); RS.inc('totalTasksRun'); }
      if (name === 'task:completed')  { RS.dec('activeTasks'); }
      if (name === 'task:failed')     { RS.dec('activeTasks'); RS.inc('totalTasksFailed'); }
      if (name === 'task:cancelled')  { RS.dec('activeTasks'); RS.inc('totalTasksCancelled'); }
      if (name === 'worker:spawned')  { RS.inc('activeWorkers'); RS.inc('totalWorkersSpawned'); }
      if (name === 'worker:released') { RS.dec('activeWorkers'); }
      if (name === 'worker:zombie')   { RS.inc('zombieWorkers'); }
      if (name === 'retry:attempt')   { RS.inc('totalRetries'); }
    } catch (_) {}
  }

  function _updateCounters(name, data) {
    var c = _counters;
    if (name === 'task:started')    c.tasks.started++;
    if (name === 'task:completed')  c.tasks.completed++;
    if (name === 'task:failed')     c.tasks.failed++;
    if (name === 'task:cancelled')  c.tasks.cancelled++;
    if (name === 'worker:spawned')  c.workers.spawned++;
    if (name === 'worker:released') c.workers.released++;
    if (name === 'worker:zombie')   c.workers.zombies++;
    if (name === 'memory:tier-changed') c.memory.tierChanges++;
    if (name === 'memory:emergency')    c.memory.emergencies++;
    if (name === 'memory:cleanup')      c.memory.cleanups++;
    if (name === 'retry:attempt')       c.retries.total++;
    if (name === 'retry:storm')         c.retries.storms++;
    if (name === 'cancel:nav')          { c.cancellations.total++; c.cancellations.byNav++; }
    if (name === 'cancel:timeout')      { c.cancellations.total++; c.cancellations.byTimeout++; }
    if (name === 'cancel:user')         { c.cancellations.total++; c.cancellations.byUser++; }
    if (name === 'progress:stalled')    c.progress.stalls++;
    if (name === 'health:degraded')     c.health.degradations++;
    if (name === 'health:recovered')    c.health.recoveries++;
  }

  // ── Timed spans ───────────────────────────────────────────────────────────
  function startSpan(name, meta) {
    var id = ++_spanId;
    _spans.set(id, { name: name, start: Date.now(), meta: meta || null });
    return id;
  }

  function endSpan(spanId, outcome) {
    var span = _spans.get(spanId);
    if (!span) return -1;
    _spans.delete(spanId);
    var duration = Date.now() - span.start;
    var completed = { name: span.name, durationMs: duration, outcome: outcome || 'ok', meta: span.meta };
    _spanLog.push(completed);
    if (_spanLog.length > MAX_SPANS) _spanLog.shift();

    // Record as a telemetry event
    record('span:' + span.name, { durationMs: duration, outcome: outcome || 'ok' });

    // Long task warning: > 1 s on main thread is risky
    if (duration > 1000) {
      record('long-task:' + span.name, { durationMs: duration });
    }
    return duration;
  }

  // ── Subscription ──────────────────────────────────────────────────────────
  function onEvent(fn) {
    if (typeof fn !== 'function') return function () {};
    _subs.add(fn);
    return function () { _subs.delete(fn); };
  }

  // ── Reports ───────────────────────────────────────────────────────────────
  function getRecentEvents(n) {
    n = n || 100;
    return _events.slice(-n);
  }

  function getSpanLog(n) {
    n = n || 50;
    return _spanLog.slice(-n);
  }

  function getReport() {
    return {
      sessionMs:  Date.now() - (_events[0] ? _events[0].ts : Date.now()),
      eventCount: _events.length,
      counters:   JSON.parse(JSON.stringify(_counters)),
      activeSpans: _spans.size,
      completedSpans: _spanLog.length,
    };
  }

  // ── Integration: hook into existing Phase 1/1C systems ───────────────────
  // Subscribe to MemPressure tier changes
  if (window.MemPressure && window.MemPressure.onTierChange) {
    window.MemPressure.onTierChange(function (newTier, oldTier) {
      record('memory:tier-changed', { from: oldTier, to: newTier });
    });
  }

  // Subscribe to AdaptiveDegradation profile changes
  if (window.AdaptiveDegradation && window.AdaptiveDegradation.onChange) {
    window.AdaptiveDegradation.onChange(function (profile, newTier, oldTier) {
      if (oldTier) record('degradation:profile', { from: oldTier, to: newTier });
    });
  }

  // Subscribe to NavCancel epoch changes via event bus (wired later)
  // [FUTURE: Hook NavCancel.onEpoch when NavigationOrchestrator is added]

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    record('runtime:pagehide', { eventCount: _events.length });
    _subs.clear();
  }, { passive: true });

  window.RuntimeTelemetry = {
    record:          record,
    startSpan:       startSpan,
    endSpan:         endSpan,
    onEvent:         onEvent,
    getRecentEvents: getRecentEvents,
    getSpanLog:      getSpanLog,
    getReport:       getReport,
    counters:        _counters, // live reference for diagnostics
  };

  console.debug('[RuntimeTelemetry] ready — T028 telemetry bus active');
}());
