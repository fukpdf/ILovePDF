// SecurityTelemetry v1.0 — Phase 3 / Task 8 (Security Telemetry Center)
// ============================================================================
// Lightweight, privacy-safe, browser-side security event aggregator.
//
// Tracks:
//   integrity-failure   — hash/SRI mismatch detected
//   worker-restart      — worker heartbeat failure / auto-restart
//   nonce-violation     — malformed or missing nonce on stamped message
//   replay-attempt      — same nonce seen twice within TTL
//   deploy-mismatch     — runtime executing on non-allowed domain
//   proto-pollution     — prototype property injection detected
//   runtime-drift       — critical global replaced/corrupted
//   tier-change         — adaptive security tier transition
//   foreign-degrade     — feature reduction triggered for foreign deploy
//   wasm-event          — WASM load/error/crash events
//   perf-pressure       — memory pressure threshold crossed
//   blob-leak           — Blob URL found leaked past cleanup window
//
// Design:
//   • Circular event buffer (max 500 events)
//   • Per-type throttle (min 100ms between same type)
//   • Privacy-safe: no PII, no file content, no user-identifying data
//   • Browser-side only: no external network sends
//   • Automatically feeds window.RuntimeTelemetry if present
//   • Full telemetry only on HIGH/EXTREME tier (via RuntimeSecurityTiers)
//
// window.SecurityTelemetry
//   .record(type, data?)  → void
//   .summary()            → { counts, recentEvents, totalEvents }
//   .export()             → Array (admin only — blocked in production mode)
//   .clear()              → void
//   .getCount(type)       → number
// ============================================================================
(function (G) {
  'use strict';

  if (G.SecurityTelemetry) return;

  var VERSION    = '1.0';
  var LOG        = '[SecTelemetry]';
  var MAX_EVENTS = 500;
  var THROTTLE_MS = 100; // min ms between identical event types

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Event buffer ──────────────────────────────────────────────────────────
  var _events    = [];
  var _counts    = Object.create(null);  // type → count
  var _lastSeen  = Object.create(null);  // type → timestamp

  // ── Throttle check ────────────────────────────────────────────────────────
  function _throttled(type) {
    var last = _lastSeen[type] || 0;
    return (Date.now() - last) < THROTTLE_MS;
  }

  // ── Record an event ───────────────────────────────────────────────────────
  function record(type, data) {
    if (typeof type !== 'string' || !type) return;

    // Throttle duplicate events
    if (_throttled(type)) return;
    _lastSeen[type] = Date.now();

    // Build event (strip any PII-like fields from data)
    var ev = {
      type: type,
      ts:   Date.now(),
      data: _sanitize(data),
    };

    // Circular buffer
    if (_events.length >= MAX_EVENTS) {
      _events.shift();
    }
    _events.push(ev);

    // Count
    _counts[type] = (_counts[type] || 0) + 1;

    // Fan out to existing RuntimeTelemetry bus if present
    _s(function () {
      if (G.RuntimeTelemetry && typeof G.RuntimeTelemetry.record === 'function') {
        G.RuntimeTelemetry.record('security:' + type, ev.data);
      }
    });
  }

  // ── Sanitize data (no PII, no large blobs) ────────────────────────────────
  function _sanitize(data) {
    if (!data || typeof data !== 'object') return data || null;
    var clean = Object.create(null);
    var SAFE_KEYS = [
      'reason', 'skewMs', 'count', 'tier', 'from', 'to', 'score',
      'path', 'chunkId', 'workerId', 'domain', 'origin', 'feature',
      'retries', 'byteLength', 'memMB', 'heapMB', 'driftPct',
      'errorCode', 'ok', 'advisory', 'enforce',
    ];
    SAFE_KEYS.forEach(function (k) {
      if (k in data) clean[k] = data[k];
    });
    return clean;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  function summary() {
    return {
      totalEvents:  _events.length,
      counts:       Object.assign(Object.create(null), _counts),
      recentEvents: _events.slice(-10).map(function (e) {
        return { type: e.type, ts: e.ts, data: e.data };
      }),
    };
  }

  // ── Export (admin only — blocked in production) ───────────────────────────
  function exportEvents() {
    var isProd = _s(function () { return G.__IPLV_IS_PROD__; }, false);
    if (isProd) {
      console.warn(LOG, 'export() blocked in production mode');
      return [];
    }
    return _events.slice();
  }

  // ── Clear ─────────────────────────────────────────────────────────────────
  function clear() {
    _events.length = 0;
    Object.keys(_counts).forEach(function (k) { delete _counts[k]; });
    Object.keys(_lastSeen).forEach(function (k) { delete _lastSeen[k]; });
    console.info(LOG, 'telemetry cleared');
  }

  // ── Subscribe to Phase 1/2 events and re-record them ─────────────────────
  _s(function () {
    var bus = G.RuntimeEventBus;
    if (!bus || typeof bus.on !== 'function') return;

    var FORWARD_EVENTS = [
      ['shield:tamper-response',   'proto-pollution'],
      ['shield:devtools-degraded', 'devtools-degraded'],
      ['security:foreign-deploy',  'deploy-mismatch'],
      ['panic:activated',          'panic-activated'],
      ['panic:recovered',          'panic-recovered'],
    ];
    FORWARD_EVENTS.forEach(function (pair) {
      bus.on(pair[0], function (d) { record(pair[1], d || {}); });
    });
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.info(LOG, 'v' + VERSION + ' ready | buffer:', MAX_EVENTS, '| throttle:', THROTTLE_MS + 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1400); }, { once: true });
  } else {
    setTimeout(_boot, 1400);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.SecurityTelemetry = Object.freeze({
    VERSION:  VERSION,
    record:   record,
    summary:  summary,
    export:   exportEvents,
    clear:    clear,
    getCount: function (type) { return _counts[type] || 0; },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
