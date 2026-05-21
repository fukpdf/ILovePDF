// RuntimeSecurityStream v1.0 — Phase 7 / Section 1 (Live Security Stream)
// =============================================================================
// Real-time security event stream for the enterprise dashboard.
// Aggregates events from all Phase 1–7 security systems into a unified feed.
//
// Stream architecture:
//   • Subscriber pattern — dashboard registers a handler, gets all events
//   • Buffered stream — last 500 events retained for reconnects
//   • Rate-limited emission — max 20 events/second to UI
//   • Priority filtering — UI can filter by severity level
//   • Typed events — all events have a consistent schema
//
// Event schema:
//   { id, ts, type, source, severity, summary, data }
//
// window.RuntimeSecurityStream
//   .subscribe(handler, opts)       → unsubscribeFn
//   .getBuffer(limit)               → StreamEvent[]
//   .getStats()                     → StreamStats
//   .flush()                        → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityStream) return;

  var VERSION  = '1.0';
  var LOG      = '[SecStream]';
  var BUF_SIZE = 500;
  var RATE_MS  = 50;   // min ms between emits to a single subscriber

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Stream state ───────────────────────────────────────────────────────────
  var _buffer    = [];
  var _eventId   = 0;
  var _subs      = [];
  var _stats     = { emitted: 0, dropped: 0, subscribers: 0 };

  // ── Source → severity mapping ──────────────────────────────────────────────
  var SOURCE_SEV = {
    'seal:failure':            'CRITICAL',
    'proto-pollution':         'CRITICAL',
    'security:foreign-deploy': 'HIGH',
    'panic-activated':         'HIGH',
    'security:anomaly':        'HIGH',
    'sri-mismatch':            'HIGH',
    'replay-attempt':          'MEDIUM',
    'worker-blocked':          'MEDIUM',
    'integrity-failure':       'MEDIUM',
    'deploy-mismatch':         'MEDIUM',
    'nonce-violation':         'MEDIUM',
    'mesh:worker-quarantined': 'MEDIUM',
    'capability:revoked':      'LOW',
    'session:rotated':         'LOW',
    'crypto:keys-rotated':     'LOW',
    'worker:spawned':          'INFO',
    'deployment:channel-detected': 'INFO',
  };

  // ── Push an event into the stream ─────────────────────────────────────────
  function _push(type, source, severity, summary, data) {
    var evt = {
      id:       ++_eventId,
      ts:       Date.now(),
      type:     type,
      source:   source,
      severity: severity || SOURCE_SEV[type] || 'INFO',
      summary:  summary || type,
      data:     data || null,
    };

    _buffer.push(evt);
    if (_buffer.length > BUF_SIZE) _buffer.shift();

    // Notify subscribers
    _stats.emitted++;
    var now = Date.now();
    for (var i = _subs.length - 1; i >= 0; i--) {
      var sub = _subs[i];
      if (!sub.active) { _subs.splice(i, 1); continue; }

      // Rate limit per subscriber
      if (now - sub.lastEmit < RATE_MS) { _stats.dropped++; continue; }

      // Severity filter
      if (sub.minSev) {
        var sevOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
        if ((sevOrder[evt.severity] || 0) < (sevOrder[sub.minSev] || 0)) continue;
      }

      try { sub.handler(evt); } catch (_) {}
      sub.lastEmit = now;
    }

    return evt;
  }

  // ── subscribe (public) ────────────────────────────────────────────────────
  function subscribe(handler, opts) {
    if (typeof handler !== 'function') return function () {};
    opts = opts || {};

    var sub = {
      id:       'sub_' + Date.now().toString(36),
      handler:  handler,
      minSev:   opts.minSeverity || null,
      active:   true,
      lastEmit: 0,
    };

    _subs.push(sub);
    _stats.subscribers = _subs.filter(function (s) { return s.active; }).length;

    // Send buffered events to new subscriber
    if (opts.sendBuffer !== false) {
      var buf = getBuffer(opts.bufferLimit || 50);
      setTimeout(function () {
        buf.forEach(function (evt) {
          try { handler(evt); } catch (_) {}
        });
      }, 0);
    }

    return function () { sub.active = false; };
  }

  function getBuffer(limit) {
    var buf = _buffer.slice();
    if (limit) buf = buf.slice(-limit);
    return buf;
  }

  function flush() {
    _buffer = [];
    _eventId = 0;
  }

  // ── Subscribe to all security sources ────────────────────────────────────
  function _tapSources() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      var TAPPED = [
        'seal:failure', 'proto-pollution', 'security:foreign-deploy',
        'panic-activated', 'security:anomaly', 'sri-mismatch',
        'replay-attempt', 'worker-blocked', 'integrity-failure',
        'deploy-mismatch', 'nonce-violation', 'mesh:worker-quarantined',
        'capability:revoked', 'capability:granted', 'session:rotated',
        'crypto:keys-rotated', 'worker:spawned', 'deployment:channel-detected',
        'shield:tamper-response',
      ];

      TAPPED.forEach(function (evtName) {
        eb.on(evtName, function (data) {
          _push(evtName, 'event-bus', SOURCE_SEV[evtName] || 'INFO',
            evtName.replace(/[:-]/g, ' '), data);
        });
      });
    });

    // Tap SecurityTelemetry
    _s(function () {
      var st = G.SecurityTelemetry;
      if (st && typeof st.subscribe === 'function') {
        st.subscribe(function (event) {
          if (!event) return;
          _push(event.type || 'telemetry-event', 'security-telemetry',
            event.severity || 'INFO', event.type, null);
        });
      }
    });
  }

  function _boot() {
    setTimeout(_tapSources, 3000);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| buffer:', BUF_SIZE);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 3000); }, { once: true });
  } else {
    setTimeout(_boot, 3000);
  }

  G.RuntimeSecurityStream = Object.freeze({
    VERSION:   VERSION,
    subscribe: subscribe,
    getBuffer: getBuffer,
    flush:     flush,
    push:      _push, // allow external systems to push events
    getStats:  function () { return Object.assign({}, _stats, { subscribers: _subs.filter(function (s) { return s.active; }).length }); },
    status: function () {
      return { version: VERSION, tier: _tier, buffered: _buffer.length, stats: _stats };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
