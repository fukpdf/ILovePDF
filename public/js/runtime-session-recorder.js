// RuntimeSessionRecorder v1.0 — Phase 7 / Section 8 (Session Reconstruction)
// =============================================================================
// Privacy-safe session recording for incident reconstruction.
// Records security-relevant session events (no user content, no PII).
//
// Recorded event types:
//   session_start, session_rotate, session_idle, session_end
//   worker_spawn, worker_quarantine, worker_heartbeat_fail
//   ticket_issued, ticket_expired, ticket_fail
//   capability_granted, capability_revoked
//   threat_detected, incident_created, incident_resolved
//   attestation_pass, attestation_fail
//   seal_ok, seal_fail, foreign_deploy
//
// Privacy rules:
//   • NO user identifiers (no email, no name, no IP)
//   • NO file content, file names, or document data
//   • NO behavioral patterns that could re-identify users
//   • Only security system state transitions
//
// window.RuntimeSessionRecorder
//   .record(eventType, meta)        → void
//   .getRecording()                 → SessionRecording
//   .export()                       → ExportedRecording (privacy-safe)
//   .clear()                        → void
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSessionRecorder) return;

  var VERSION  = '1.0';
  var LOG      = '[SessionRec]';
  var MAX_EVENTS = 500;

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  // ── Recording state ────────────────────────────────────────────────────────
  var _events   = [];
  var _startTs  = Date.now();
  var _recId    = 'rec_' + Date.now().toString(36);

  // ── Allowed event types (whitelist) ────────────────────────────────────────
  var ALLOWED_TYPES = {
    session_start: 1, session_rotate: 1, session_idle: 1, session_end: 1,
    worker_spawn: 1, worker_quarantine: 1, worker_heartbeat_fail: 1,
    ticket_issued: 1, ticket_expired: 1, ticket_fail: 1,
    capability_granted: 1, capability_revoked: 1,
    threat_detected: 1, incident_created: 1, incident_resolved: 1,
    attestation_pass: 1, attestation_fail: 1,
    seal_ok: 1, seal_fail: 1, foreign_deploy: 1,
    deployment_channel: 1, build_chain_link: 1,
    wasm_attested: 1, wasm_revoked: 1,
    crypto_rotation: 1, packet_replay: 1,
  };

  // ── Privacy-safe meta scrubbing ────────────────────────────────────────────
  var SAFE_META_KEYS = [
    'type', 'reason', 'state', 'severity', 'score', 'tier', 'channel',
    'workerId', 'incidentId', 'moduleId', 'cap', 'patternId', 'duration',
    'ok', 'count', 'health', 'poolId',
  ];

  function _scrub(meta) {
    if (!meta || typeof meta !== 'object') return null;
    var safe = {};
    for (var k of SAFE_META_KEYS) {
      if (k in meta) {
        var v = meta[k];
        if (typeof v === 'string') safe[k] = v.slice(0, 80);
        else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
      }
    }
    return safe;
  }

  // ── Record an event ────────────────────────────────────────────────────────
  function record(eventType, meta) {
    if (!_enabled) return;
    if (!ALLOWED_TYPES[eventType]) return;

    _events.push({
      t:    eventType,
      m:    _scrub(meta),
      ts:   Date.now(),
      rel:  Date.now() - _startTs,  // relative timestamp (ms since session start)
    });

    if (_events.length > MAX_EVENTS) _events.shift();
  }

  function getRecording() {
    return {
      id:       _recId,
      startTs:  _startTs,
      duration: Date.now() - _startTs,
      events:   _events.slice(),
      tier:     _tier,
    };
  }

  function exportRecording() {
    var rec = getRecording();
    // Additional scrub for export
    return {
      id:       rec.id,
      duration: rec.duration,
      eventCount: rec.events.length,
      events:   rec.events.map(function (e) { return { t: e.t, rel: e.rel, m: e.m }; }),
      tier:     rec.tier,
      exportedAt: Date.now(),
    };
  }

  function clear() {
    _events = [];
    _startTs = Date.now();
    _recId   = 'rec_' + Date.now().toString(36);
    console.debug(LOG, 'recording cleared');
  }

  // ── Subscribe to system events ────────────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;

      var EVENT_MAP = {
        'session:init':           'session_start',
        'session:rotated':        'session_rotate',
        'session:idle':           'session_idle',
        'seal:failure':           'seal_fail',
        'security:foreign-deploy':'foreign_deploy',
        'capability:granted':     'capability_granted',
        'capability:revoked':     'capability_revoked',
        'security:anomaly':       'threat_detected',
        'mesh:worker-quarantined':'worker_quarantine',
        'crypto:keys-rotated':    'crypto_rotation',
        'deployment:channel-detected': 'deployment_channel',
      };

      for (var evtName in EVENT_MAP) {
        (function (src, dest) {
          eb.on(src, function (data) { record(dest, data || {}); });
        }(evtName, EVENT_MAP[evtName]));
      }
    });
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 4000);
    record('session_start', { tier: _tier });
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier, '| rec:', _recId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5000); }, { once: true });
  } else {
    setTimeout(_boot, 5000);
  }

  G.RuntimeSessionRecorder = Object.freeze({
    VERSION:   VERSION,
    record:    record,
    getRecording: getRecording,
    export:    exportRecording,
    clear:     clear,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, events: _events.length, recId: _recId };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
