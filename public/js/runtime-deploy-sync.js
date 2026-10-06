// RuntimeDeploySync v1.0 — Arc 2 / Target 1
// =====================================================================
// Cross-tab + SW BUILD_ID coordination.
//
// Responsibilities:
//   1. Extract current BUILD_ID from page's cache-busted script URLs
//   2. Listen to SW_ACTIVATED messages from the service worker
//   3. Poll /api/health every POLL_INTERVAL_MS to detect new deploys
//   4. Broadcast DEPLOY_SYNC messages via BroadcastChannel to all tabs
//   5. On stale detection: dispatch 'deploy:stale' event — let callers decide
//      whether to reload (never force-reload from this layer)
//   6. Provide stale-worker invalidation via WorkerPool.clearAll()
//
// Emits (via RuntimeEventBus + CustomEvent on window):
//   deploy:new-build  { prevBuildId, newBuildId }
//   deploy:stale      { buildId, tabBuildId }
//   deploy:sync-ready { buildId }
//
// BroadcastChannel: ilovepdf-deploy-v1
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploySync) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG           = '[DeploySync]';
  var CHANNEL       = 'ilovepdf-deploy-v1';
  var POLL_MS       = 5 * 60 * 1000; // 5 min passive poll
  var HEALTH_URL    = '/api/health';
  var VERSION       = '1.0';

  // ── Extract BUILD_ID embedded in the current page's script URLs ────────────
  var _tabBuildId = (function () {
    try {
      var tags = document.querySelectorAll('script[src*="?v="]');
      for (var i = 0; i < tags.length; i++) {
        var v = new URL(tags[i].src, location.href).searchParams.get('v');
        if (v) return v;
      }
    } catch (_) {}
    return '';
  }());

  var _serverBuildId = _tabBuildId; // updated when we detect a new deploy
  var _staleDetected = false;
  var _listeners     = [];

  // ── BroadcastChannel ──────────────────────────────────────────────────────
  var _bc = null;
  try { _bc = new BroadcastChannel(CHANNEL); } catch (_) {}

  function _broadcast(type, payload) {
    if (!_bc) return;
    try { _bc.postMessage({ type: type, buildId: _serverBuildId, tabBuildId: _tabBuildId, ts: Date.now(), payload: payload || {} }); } catch (_) {}
  }

  // ── Dispatch helpers ──────────────────────────────────────────────────────
  function _emit(name, detail) {
    try { G.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: false })); } catch (_) {}
    try {
      if (G.RuntimeEventBus && G.RuntimeEventBus.emit) G.RuntimeEventBus.emit(name, detail);
    } catch (_) {}
    _listeners.forEach(function (cb) { try { cb(name, detail); } catch (_) {} });
  }

  // ── Stale-build detection ─────────────────────────────────────────────────
  function _checkBuild(newBuildId) {
    if (!newBuildId || !_tabBuildId) return;
    if (newBuildId === _tabBuildId) return;
    if (_staleDetected) return;
    _staleDetected = true;
    var prev = _serverBuildId;
    _serverBuildId = newBuildId;

    console.debug(LOG, 'stale runtime detected — tabBuild:', _tabBuildId, '→ serverBuild:', newBuildId);

    // Invalidate stale workers (they may be running old code)
    try {
      if (G.WorkerPool && typeof G.WorkerPool.clearAll === 'function') {
        G.WorkerPool.clearAll('stale-deploy');
      }
    } catch (_) {}

    _emit('deploy:new-build', { prevBuildId: prev, newBuildId: newBuildId });
    _emit('deploy:stale',     { buildId: newBuildId, tabBuildId: _tabBuildId });
    _broadcast('DEPLOY_STALE', { prevBuildId: prev, newBuildId: newBuildId });
  }

  // ── Fetch /api/health to check server BUILD_ID ────────────────────────────
  function _poll() {
    fetch(HEALTH_URL, { method: 'HEAD', cache: 'no-store', credentials: 'omit' })
      .then(function (r) {
        var hdr = r.headers.get('X-Build-Id') || r.headers.get('x-build-id');
        if (hdr) _checkBuild(hdr);
      })
      .catch(function () {}); // silent — offline is fine
  }

  // ── SW → page messages ────────────────────────────────────────────────────
  (function () {
    try {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.addEventListener('message', function (evt) {
        var msg = evt.data;
        if (!msg) return;
        // SW_ACTIVATED: SW has activated (cache rotation happened — new deploy)
        if (msg.type === 'SW_ACTIVATED') {
          // SW doesn't carry BUILD_ID in its message; trigger a health poll
          _poll();
        }
      });
    } catch (_) {}
  }());

  // ── BroadcastChannel: receive from other tabs ─────────────────────────────
  if (_bc) {
    _bc.onmessage = function (evt) {
      var msg = evt.data;
      if (!msg) return;
      if (msg.type === 'DEPLOY_STALE' && msg.buildId) _checkBuild(msg.buildId);
      if (msg.type === 'DEPLOY_SYNC_PING') {
        // Another tab asks for our state
        _broadcast('DEPLOY_SYNC_PONG', { myBuildId: _tabBuildId });
      }
    };
  }

  // ── Boot: immediate poll + periodic ──────────────────────────────────────
  _poll();
  var _pollId = setInterval(_poll, POLL_MS);

  // Ping other tabs so stale tabs learn the current BUILD_ID
  _broadcast('DEPLOY_SYNC_PING', {});

  // Cleanup on page unload
  try {
    G.addEventListener('pagehide', function () {
      clearInterval(_pollId);
      if (_bc) { try { _bc.close(); } catch (_) {} }
    }, { once: true });
  } catch (_) {}

  _emit('deploy:sync-ready', { buildId: _tabBuildId });

  G.RuntimeDeploySync = Object.freeze({
    VERSION:        VERSION,
    getBuildId:     function () { return _tabBuildId; },
    getServerBuild: function () { return _serverBuildId; },
    isStale:        function () { return _staleDetected; },
    poll:           _poll,
    on:             function (cb) { if (typeof cb === 'function') _listeners.push(cb); },
  });

}(window));
