// RuntimeBlackbox v1.0 — Arc 9 / Phase G
// =====================================================================
// Continuous rolling runtime recorder — the browser's "flight recorder".
//
// Records all runtime events in a 15-minute rolling buffer. On panic
// or crash, automatically exports the buffer and hands it to the
// RuntimeReplayEngine for post-mortem replay.
//
// Distinct from:
//   - RuntimeSessionRecorder (Arc 7 — user interaction recording)
//   - RuntimeForensicsReplay (Arc 7 — security attack forensics)
//   - RuntimeEventTimeline (Arc 8 — live event ring buffer for search)
//
// Features:
//   - Rolling 15-minute recording (configurable)
//   - Bounded storage: max 10,000 events (~10 MB estimate)
//   - Auto-export blob on memory panic / P0 incident
//   - Crash replay handoff to RuntimeReplayEngine
//   - Named session snapshots (exportable)
//   - Event type coverage: all arc8 + worker + memory + hydration
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeBlackbox) return;

  var LOG     = '[Blackbox]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var MAX_EVENTS   = 10000;
  var WINDOW_MS    = 15 * 60 * 1000;  // 15-minute rolling window
  var MAX_SESSIONS = 5;               // named session snapshots

  // ── Rolling buffer ────────────────────────────────────────────────
  var _buffer  = [];   // { ts, type, data }
  var _running = true;
  var _metrics = { recorded: 0, exports: 0, panics: 0, crashes: 0, handoffs: 0 };

  // ── Record an event ───────────────────────────────────────────────
  function record(type, data) {
    if (!_running) return;
    var now = Date.now();

    // Evict events older than WINDOW_MS
    var cutoff = now - WINDOW_MS;
    while (_buffer.length > 0 && _buffer[0].ts < cutoff) _buffer.shift();

    // Evict if over max
    if (_buffer.length >= MAX_EVENTS) _buffer.shift();

    _buffer.push({ ts: now, type: type, data: data ? Object.assign({}, data) : null });
    _metrics.recorded++;
  }

  // ── Event capture: subscribe to all key runtime events ───────────
  var RECORD_EVENTS = [
    // Arc 8 events
    'arc8:command', 'arc8:incident', 'arc8:snapshot',
    // Arc 9 events
    'arc9:heal-applied', 'arc9:heal-rollback', 'arc9:starvation',
    'arc9:congestion', 'arc9:stability-level', 'arc9:stability-intervention',
    'arc9:recovery-complete', 'arc9:safe-mode-active', 'arc9:governance-sweep',
    'arc9:quarantine', 'arc9:tool-recorded', 'arc9:preactivate',
    // Arc 7 events
    'streaming-hydration:viewport', 'predictive-loader:preload',
    'stream-workers:progress', 'self-optimizer:adapt',
    'extreme-mode:activate', 'extreme-mode:deactivate',
    // Memory events
    'processor-memory:panic', 'memory-firewall:budget-exceeded',
    // Worker events
    'processor-workers:isolated', 'tool:worker-crash',
    // Hydration events
    'processor-hydration:activated', 'arc7:streaming-hydration-ready',
    // Recovery events
    'recovery:escalated',
    // Deploy events
    'deploy:sync-ready',
    // Task events
    'task-orchestrator:throttled',
  ];

  RECORD_EVENTS.forEach(function (evType) {
    G.addEventListener(evType, function (evt) {
      try { record(evType, evt && evt.detail); } catch (_) {}
    });
  });

  // ── Auto-export on panic / P0 incident ───────────────────────────
  G.addEventListener('processor-memory:panic', function (evt) {
    _metrics.panics++;
    record('__blackbox:panic', evt && evt.detail);
    try { _autoExport('memory-panic'); } catch (_) {}
  });

  G.addEventListener('arc8:incident', function (evt) {
    try {
      var d = evt && evt.detail;
      if (d && d.severity === 0) {  // P0 critical
        record('__blackbox:p0-incident', d);
        _autoExport('p0-incident:' + d.category);
      }
    } catch (_) {}
  });

  // ── Named sessions ────────────────────────────────────────────────
  var _sessions = [];

  function saveSession(label) {
    var session = {
      id:      'bb_' + Date.now().toString(36),
      label:   label || 'session-' + Date.now(),
      ts:      Date.now(),
      count:   _buffer.length,
      events:  _buffer.slice(),
    };
    _sessions.push(session);
    if (_sessions.length > MAX_SESSIONS) _sessions.shift();
    console.debug(LOG, 'session saved:', session.id, '|', session.count, 'events');
    return session.id;
  }

  // ── Export ────────────────────────────────────────────────────────
  function exportBuffer(label) {
    _metrics.exports++;
    var data = {
      version:  VERSION,
      label:    label || 'blackbox-export',
      ts:       Date.now(),
      windowMs: WINDOW_MS,
      count:    _buffer.length,
      events:   _buffer.slice(),
    };
    var json = JSON.stringify(data);
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      console.debug(LOG, 'exported:', data.count, 'events | url:', url);
      return { url: url, count: data.count, json: json };
    } catch (_) {
      return { url: null, count: data.count, json: json };
    }
  }

  function _autoExport(reason) {
    try {
      var result = exportBuffer('auto:' + reason);
      _metrics.exports++;
      try {
        G.dispatchEvent(new CustomEvent('arc9:blackbox-export', {
          detail: { reason: reason, count: result.count, url: result.url },
        }));
      } catch (_) {}
    } catch (_) {}
  }

  // ── Crash replay handoff ──────────────────────────────────────────
  function handoffToReplay(opts) {
    _metrics.handoffs++;
    try {
      var re = G.RuntimeReplayEngine;
      if (!re) return { ok: false, reason: 'RuntimeReplayEngine not available' };
      // Filter to last N minutes if requested
      var events = _buffer.slice();
      if (opts && opts.lastMinutes) {
        var since = Date.now() - opts.lastMinutes * 60000;
        events = events.filter(function (e) { return e.ts >= since; });
      }
      var count = re.load(events, opts || {});
      console.debug(LOG, 'handoff to replay:', count, 'events');
      return { ok: true, count: count };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── Query ─────────────────────────────────────────────────────────
  function query(opts) {
    opts = opts || {};
    var result = _buffer.slice();
    if (opts.type)    result = result.filter(function (e) { return e.type === opts.type; });
    if (opts.since)   result = result.filter(function (e) { return e.ts >= opts.since; });
    if (opts.keyword) {
      var kw = String(opts.keyword).toLowerCase();
      result = result.filter(function (e) { return e.type.toLowerCase().includes(kw); });
    }
    if (opts.limit)   result = result.slice(-opts.limit);
    return result;
  }

  G.RuntimeBlackbox = Object.freeze({
    VERSION:        VERSION,
    record:         record,
    saveSession:    saveSession,
    export:         exportBuffer,
    handoffToReplay: handoffToReplay,
    query:          query,
    getSessions:    function () { return _sessions.slice(); },
    getCount:       function () { return _buffer.length; },
    getMetrics:     function () { return Object.assign({}, _metrics); },
    pause:          function () { _running = false; },
    resume:         function () { _running = true; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — rolling', WINDOW_MS / 60000 + '-min recorder |', RECORD_EVENTS.length, 'event types | auto-export on panic');

}(window));
