// RuntimeSWBridge v1.0 — Arc 11 / Phase D
// =============================================================================
// Service Worker ↔ Runtime diagnostics bridge.
//
// Capabilities:
//   - snapshot sync   : sends state snapshots to SW cache for offline access
//   - blackbox sync   : pushes rolling blackbox entries to SW via postMessage
//   - deploy sync     : relays BUILD_ID changes so SW knows when to update cache
//   - crash markers   : writes crash markers into SW cache for post-reload access
//   - offline persist : ensures key diagnostics survive offline periods
//
// Integration points:
//   RuntimeDeploySync  — listens to deploy:stale / deploy:new-build events
//   RuntimeBlackboxStorage — pulls snapshots to relay into SW
//
// Message protocol (window → SW):
//   { type: 'BB_SNAPSHOT',    payload: <snapshot_json> }
//   { type: 'BB_EVENTS',      payload: <events[]>      }
//   { type: 'DEPLOY_NOTIFY',  payload: { buildId, prevBuildId } }
//   { type: 'CRASH_MARKER',   payload: { type, ts }     }
//
// Message protocol (SW → window):
//   { type: 'SW_ACK',         payload: <ack_data>      }
//   { type: 'SW_CACHE_READY', payload: { cacheKey }    }
//
// window.RuntimeSWBridge
//   .syncSnapshot(snapshot)   → Promise<boolean>
//   .syncBlackbox(events)     → Promise<boolean>
//   .notifyDeploy(info)       → void
//   .writeCrashMarker(type)   → void
//   .isAvailable()            → boolean
//   .getMetrics()             → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSWBridge) return;

  var VERSION = '1.0';
  var LOG     = '[SWBridge]';

  var _sw       = null;
  var _ready    = false;
  var _metrics  = { sent: 0, acks: 0, errors: 0, deployNotifs: 0, crashMarkers: 0 };

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Service Worker acquisition ────────────────────────────────────────────
  function _acquireSW() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (reg) {
      _sw = reg.active || reg.waiting || reg.installing;
      if (_sw) {
        _ready = true;
        console.debug(LOG, 'v' + VERSION + ' SW acquired | state:', _sw.state);
      }
      // Update _sw reference when SW activates
      reg.addEventListener('statechange', function () {
        _sw = reg.active || _sw;
        if (!_ready && _sw) { _ready = true; }
      });
    }).catch(function (e) {
      console.debug(LOG, 'SW not ready:', e.message);
    });

    // Listen for messages from SW
    navigator.serviceWorker.addEventListener('message', function (evt) {
      var msg = evt && evt.data;
      if (!msg) return;
      if (msg.type === 'SW_ACK')         { _metrics.acks++; }
      if (msg.type === 'SW_CACHE_READY') { console.debug(LOG, 'SW cache ready:', msg.payload); }
    });
  }

  // ── Post message to SW ────────────────────────────────────────────────────
  function _post(type, payload) {
    if (!_ready || !_sw) return false;
    try {
      _sw.postMessage({ type: type, payload: payload, ts: Date.now() });
      _metrics.sent++;
      return true;
    } catch (e) {
      _metrics.errors++;
      console.debug(LOG, 'postMessage failed:', e.message);
      return false;
    }
  }

  // ── Sync snapshot to SW ───────────────────────────────────────────────────
  function syncSnapshot(snapshot) {
    if (!snapshot) return Promise.resolve(false);
    var ok = _post('BB_SNAPSHOT', snapshot);
    // Also persist to BlackboxStorage
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) bbs.persist(snapshot);
    });
    return Promise.resolve(ok);
  }

  // ── Sync blackbox events to SW ────────────────────────────────────────────
  function syncBlackbox(events) {
    if (!Array.isArray(events) || !events.length) return Promise.resolve(false);
    var ok = _post('BB_EVENTS', events.slice(-200));  // cap at 200 to avoid SW message overflow
    return Promise.resolve(ok);
  }

  // ── Deploy notification ───────────────────────────────────────────────────
  function notifyDeploy(info) {
    _metrics.deployNotifs++;
    _post('DEPLOY_NOTIFY', info || {});
  }

  // ── Crash marker ──────────────────────────────────────────────────────────
  function writeCrashMarker(type) {
    _metrics.crashMarkers++;
    _post('CRASH_MARKER', { type: type || 'unknown', ts: Date.now() });
  }

  // ── Integrate with RuntimeDeploySync ─────────────────────────────────────
  function _bindDeploySync() {
    window.addEventListener('deploy:new-build', function (evt) {
      if (!evt || !evt.detail) return;
      notifyDeploy(evt.detail);
    });
    window.addEventListener('deploy:stale', function (evt) {
      if (!evt || !evt.detail) return;
      notifyDeploy(Object.assign({}, evt.detail, { stale: true }));
    });
  }

  // ── Periodic blackbox relay ────────────────────────────────────────────────
  function _startPeriodicSync() {
    if (!_ready) return;
    setInterval(function () {
      if (!_ready) return;
      _s(function () {
        var bb = G.RuntimeBlackbox;
        if (bb && typeof bb.query === 'function') {
          var events = bb.query({ limit: 50 });
          if (events && events.length) syncBlackbox(events);
        }
      });
    }, 60000);  // relay last 50 events every minute
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function _boot() {
    _acquireSW();
    _bindDeploySync();
    setTimeout(_startPeriodicSync, 8000);
    console.debug(LOG, 'v' + VERSION + ' ready | SW available:', !!navigator.serviceWorker);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeSWBridge = Object.freeze({
    VERSION:        VERSION,
    syncSnapshot:   syncSnapshot,
    syncBlackbox:   syncBlackbox,
    notifyDeploy:   notifyDeploy,
    writeCrashMarker: writeCrashMarker,
    isAvailable:    function () { return _ready; },
    getMetrics:     function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
