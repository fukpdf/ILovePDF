// RuntimeForensics v1.0 — Phase 7 / Section 8 (Forensic Snapshots)
// =============================================================================
// Forensic snapshot system. Captures and stores privacy-safe runtime state
// snapshots at key security events for post-incident analysis.
//
// Snapshot contents (all privacy-safe, no PII, no file content):
//   • Session state at snapshot time
//   • Active capabilities
//   • Worker mesh health
//   • Threat correlation state
//   • Anomaly engine readings
//   • Deployment integrity score
//   • Open incidents
//   • Behavioral health
//   • WASM pool state
//
// Retention:
//   • Max 50 snapshots in memory
//   • Snapshots expire after 2 hours
//   • Automatic pruning on memory pressure
//
// window.RuntimeForensics
//   .snapshot(trigger, context)    → Snapshot
//   .getSnapshot(id)               → Snapshot|null
//   .getTimeline()                 → Snapshot[] (chronological)
//   .reconstruct(fromTs, toTs)     → Timeline (event sequence)
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeForensics) return;

  var VERSION  = '1.0';
  var LOG      = '[Forensics]';
  var MAX_SNAP = 50;
  var SNAP_TTL = 2 * 3600_000;  // 2 hours

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _enabled = _score >= 40;

  var _snapshots  = [];
  var _snapCount  = 0;

  // ── Capture runtime state ─────────────────────────────────────────────────
  function _captureState() {
    return {
      session:    _s(function () {
        var ss = G.RuntimeSecureSession;
        return ss && typeof ss.status === 'function' ? ss.status() : null;
      }, null),
      capabilities: _s(function () {
        var cm = G.RuntimeCapabilityManager;
        return cm && typeof cm.listActive === 'function'
          ? cm.listActive().map(function (c) { return c.cap; })
          : [];
      }, []),
      workerMesh: _s(function () {
        var wm = G.RuntimeWorkerMesh;
        return wm && typeof wm.getMeshHealth === 'function' ? wm.getMeshHealth() : null;
      }, null),
      threats:    _s(function () {
        var tc = G.RuntimeThreatCorrelation;
        return tc && typeof tc.getActiveThreats === 'function'
          ? tc.getActiveThreats().map(function (t) {
              return { id: t.patternId, severity: t.severity };
            })
          : [];
      }, []),
      anomaly:    _s(function () {
        var ae = G.RuntimeAnomalyEngine;
        return ae && typeof ae.getDeploymentScore === 'function'
          ? ae.getDeploymentScore() : null;
      }, null),
      deployment: _s(function () {
        var dr = G.RuntimeDeploymentRegistry;
        return dr && typeof dr.status === 'function' ? {
          channel: dr.status().channel,
          score:   dr.getIntegrityScore(),
        } : null;
      }, null),
      behavior:   _s(function () {
        var ba = G.RuntimeBehaviorAnalysis;
        return ba && typeof ba.getHealthScore === 'function' ? ba.getHealthScore() : null;
      }, null),
      incidents:  _s(function () {
        var ie = G.RuntimeIncidentEngine;
        return ie && typeof ie.getOpenIncidents === 'function'
          ? ie.getOpenIncidents().length : 0;
      }, 0),
      proofChain: _s(function () {
        var ep = G.RuntimeEdgeProof;
        return ep && typeof ep.getLatest === 'function' ? ep.getLatest() : null;
      }, null),
      tier:       _tier,
      ts:         Date.now(),
    };
  }

  // ── snapshot (public) ──────────────────────────────────────────────────────
  function snapshot(trigger, context) {
    var id   = 'snap_' + Date.now().toString(36) + '_' + (++_snapCount).toString(36);
    var snap = {
      id:      id,
      trigger: trigger || 'manual',
      context: context || null,
      state:   _captureState(),
      exp:     Date.now() + SNAP_TTL,
    };

    _snapshots.push(snap);

    // Evict expired or overflow
    var now = Date.now();
    _snapshots = _snapshots.filter(function (s) { return s.exp > now; });
    if (_snapshots.length > MAX_SNAP) {
      _snapshots = _snapshots.slice(-MAX_SNAP);
    }

    console.debug(LOG, 'snapshot captured | id:', id, '| trigger:', trigger);
    return snap;
  }

  function getSnapshot(id) {
    var s = _snapshots.find(function (s) { return s.id === id; });
    return s ? Object.assign({}, s) : null;
  }

  function getTimeline() {
    return _snapshots.slice().sort(function (a, b) { return a.state.ts - b.state.ts; });
  }

  // ── Timeline reconstruction ────────────────────────────────────────────────
  function reconstruct(fromTs, toTs) {
    var snaps = _snapshots.filter(function (s) {
      return s.state.ts >= (fromTs || 0) && s.state.ts <= (toTs || Date.now());
    });

    return {
      from:      fromTs || 0,
      to:        toTs   || Date.now(),
      snapshots: snaps.length,
      events:    snaps.map(function (s) {
        return {
          ts:       s.state.ts,
          trigger:  s.trigger,
          incidents: s.state.incidents,
          threats:  s.state.threats ? s.state.threats.length : 0,
          behavior: s.state.behavior,
        };
      }),
    };
  }

  // ── Auto-snapshot on critical events ─────────────────────────────────────
  function _subscribe() {
    _s(function () {
      var eb = G.RuntimeEventBus;
      if (!eb) return;
      var SNAP_TRIGGERS = [
        'seal:failure', 'security:foreign-deploy', 'panic-activated',
        'session:rotated', 'security:anomaly', 'mesh:worker-quarantined',
      ];
      SNAP_TRIGGERS.forEach(function (evt) {
        eb.on(evt, function (data) {
          snapshot(evt, data ? { type: evt } : null);
        });
      });
    });
  }

  function _boot() {
    if (!_enabled) {
      console.info(LOG, 'v' + VERSION + ' disabled (tier:', _tier + ')');
      return;
    }
    setTimeout(_subscribe, 5000);
    snapshot('boot', null);
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 5500); }, { once: true });
  } else {
    setTimeout(_boot, 5500);
  }

  G.RuntimeForensics = Object.freeze({
    VERSION:      VERSION,
    snapshot:     snapshot,
    getSnapshot:  getSnapshot,
    getTimeline:  getTimeline,
    reconstruct:  reconstruct,
    status: function () {
      return { version: VERSION, enabled: _enabled, tier: _tier, snapshots: _snapshots.length };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
