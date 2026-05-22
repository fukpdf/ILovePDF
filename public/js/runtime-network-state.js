// runtime-network-state.js — Phase 9 network quality monitoring
// Monitors connection type, effective bandwidth, RTT, and online/offline
// transitions. Other modules read window.RuntimeNetworkState.getState()
// to adapt concurrency and chunk sizes dynamically.
(function () {
  'use strict';
  var G = window;
  if (G.RuntimeNetworkState) return;

  var _state = {
    online:        navigator.onLine !== false,
    type:          'unknown',
    effectiveType: '4g',
    downlinkMbps:  10,
    rttMs:         50,
    saveData:      false,
    degraded:      false,
    since:         Date.now(),
  };

  var _listeners = [];
  var _history   = []; // last 20 state changes

  function _snapshot() {
    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        _state.type          = conn.type          || 'unknown';
        _state.effectiveType = conn.effectiveType  || '4g';
        _state.downlinkMbps  = conn.downlink       || 10;
        _state.rttMs         = conn.rtt            || 50;
        _state.saveData      = !!conn.saveData;
      }
    } catch (_) {}
    _state.degraded = (_state.effectiveType === 'slow-2g' ||
                       _state.effectiveType === '2g'      ||
                       _state.rttMs > 800                 ||
                       _state.downlinkMbps < 0.5);
  }

  function _fire(event) {
    _history.push({ event: event, state: Object.assign({}, _state), ts: Date.now() });
    if (_history.length > 20) _history.shift();
    _listeners.forEach(function (fn) {
      try { fn(event, Object.assign({}, _state)); } catch (_) {}
    });
    if (_state.degraded) {
      try {
        var ss = G.RuntimeSecurityStream;
        if (ss && typeof ss.push === 'function') {
          ss.push('network-degraded', 'network-state', 'INFO',
            'Network quality degraded: ' + _state.effectiveType,
            { rtt: _state.rttMs, downlink: _state.downlinkMbps });
        }
      } catch (_) {}
    }
  }

  function _onOnline()  { _state.online = true;  _state.since = Date.now(); _snapshot(); _fire('online');  }
  function _onOffline() { _state.online = false; _state.since = Date.now(); _fire('offline'); }

  try { window.addEventListener('online',  _onOnline);  } catch (_) {}
  try { window.addEventListener('offline', _onOffline); } catch (_) {}

  try {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', function () { _snapshot(); _fire('connection-change'); });
    }
  } catch (_) {}

  _snapshot();

  // ── Adaptive chunk size helper ────────────────────────────────────────────
  // Returns recommended upload/download chunk size in bytes based on network.
  function recommendedChunkBytes() {
    if (!_state.online) return 512 * 1024;
    var mbps = _state.downlinkMbps || 10;
    if (mbps < 0.5) return  256 * 1024;   // 256 KB — slow-2g
    if (mbps < 2)   return  512 * 1024;   // 512 KB — 2g
    if (mbps < 10)  return 2048 * 1024;   //   2 MB — 3g/4g moderate
    return               8192 * 1024;     //   8 MB — fast connection
  }

  G.RuntimeNetworkState = Object.freeze({
    getState:               function () { return Object.assign({}, _state); },
    isDegraded:             function () { return _state.degraded; },
    isOnline:               function () { return _state.online; },
    recommendedChunkBytes:  recommendedChunkBytes,
    onStateChange:          function (fn) { if (typeof fn === 'function') _listeners.push(fn); },
    getHistory:             function () { return _history.slice(); },
  });
}());
