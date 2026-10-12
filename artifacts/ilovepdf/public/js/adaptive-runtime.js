// Adaptive Runtime v1.0 — Final Stabilization
// Monitors render failure rates, memory pressure, and thermal signals.
// Automatically degrades quality (DPR, concurrency, tile size) and
// recovers when conditions improve.
//
// API: window.AdaptiveRuntime
//   .getProfile()              → current quality profile
//   .recordSuccess()
//   .recordFailure(reason)
//   .forceDegrade(reason)
//   .forceRecover()
//   .onProfileChange(fn)       → unsubscribe fn
//   .stats()
(function () {
  'use strict';

  if (window.AdaptiveRuntime) return;

  // ── Quality profiles ──────────────────────────────────────────────────────
  var PROFILES = {
    full: {
      name:        'full',
      dprCap:      2.0,
      scaleFactor: 1.0,
      concurrency: 2,
      thumbWidth:  220,
    },
    reduced: {
      name:        'reduced',
      dprCap:      1.5,
      scaleFactor: 0.85,
      concurrency: 1,
      thumbWidth:  180,
    },
    minimal: {
      name:        'minimal',
      dprCap:      1.0,
      scaleFactor: 0.70,
      concurrency: 1,
      thumbWidth:  140,
    },
  };

  var PROFILE_ORDER = ['full', 'reduced', 'minimal'];

  var _currentProfile = 'full';
  var _subscribers    = [];

  // Sliding window failure tracking
  var WINDOW_MS   = 60 * 1000;   // 1-minute window
  var _events     = [];          // [{ ts, success }]
  var MAX_EVENTS  = 100;

  // Auto-recover: if we've been in a degraded profile for RECOVER_MS with
  // no failures, step up one level.
  var RECOVER_MS  = 90 * 1000;
  var _degradedSince = 0;
  var _lastFailure   = 0;

  // ── Internal helpers ──────────────────────────────────────────────────────
  function _purgeOld() {
    var cutoff = Date.now() - WINDOW_MS;
    while (_events.length > 0 && _events[0].ts < cutoff) _events.shift();
  }

  function _failureRate() {
    _purgeOld();
    if (_events.length < 3) return 0;
    var failures = _events.filter(function (e) { return !e.success; }).length;
    return failures / _events.length;
  }

  function _setProfile(name, reason) {
    if (_currentProfile === name) return;
    var old = _currentProfile;
    _currentProfile = name;
    _degradedSince  = name === 'full' ? 0 : Date.now();
    console.info('[AdaptiveRuntime] profile changed: ' + old + ' → ' + name + (reason ? ' (' + reason + ')' : ''));
    if (window.StabilityMetrics) {
      try { window.StabilityMetrics.recordEvent('adaptive-profile:' + old + '->' + name); } catch (_) {}
    }
    _subscribers.forEach(function (fn) {
      try { fn(PROFILES[name], old, name); } catch (_) {}
    });
  }

  function _degrade(reason) {
    var idx = PROFILE_ORDER.indexOf(_currentProfile);
    if (idx < PROFILE_ORDER.length - 1) {
      _lastFailure = Date.now();
      _setProfile(PROFILE_ORDER[idx + 1], reason);
    }
  }

  function _recover() {
    var idx = PROFILE_ORDER.indexOf(_currentProfile);
    if (idx > 0) {
      _setProfile(PROFILE_ORDER[idx - 1], 'auto-recover');
    }
  }

  // ── Auto-recovery check ───────────────────────────────────────────────────
  var _checkTimer = setInterval(function () {
    if (_currentProfile === 'full') return;
    var now = Date.now();
    var noFailures = (now - _lastFailure) > RECOVER_MS;
    var degradedLong = _degradedSince > 0 && (now - _degradedSince) > RECOVER_MS;
    if (noFailures && degradedLong) {
      _recover();
    }

    // Also degrade if MemPressure is critical
    if (window.MemPressure) {
      var t = window.MemPressure.tier();
      if ((t === 'critical' || t === 'abort') && _currentProfile !== 'minimal') {
        _degrade('mem-pressure:' + t);
      } else if (t === 'low' && _currentProfile === 'full') {
        _degrade('mem-pressure:low');
      }
    }
  }, 15000);
  if (window.TimerRegistry) {
    window.TimerRegistry.registerInterval('AdaptiveRuntime', _checkTimer);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function getProfile() {
    return Object.assign({}, PROFILES[_currentProfile] || PROFILES.full);
  }

  function recordSuccess() {
    if (_events.length >= MAX_EVENTS) _events.shift();
    _events.push({ ts: Date.now(), success: true });
  }

  function recordFailure(reason) {
    if (_events.length >= MAX_EVENTS) _events.shift();
    _events.push({ ts: Date.now(), success: false });
    _lastFailure = Date.now();
    var rate = _failureRate();
    if (rate >= 0.5) {
      _degrade('failure-rate:' + (rate * 100).toFixed(0) + '%' + (reason ? ':' + reason : ''));
    }
  }

  function forceDegrade(reason) { _degrade(reason || 'forced'); }
  function forceRecover()       { _recover(); }

  function onProfileChange(fn) {
    if (typeof fn === 'function') _subscribers.push(fn);
    return function () {
      var i = _subscribers.indexOf(fn);
      if (i !== -1) _subscribers.splice(i, 1);
    };
  }

  function stats() {
    _purgeOld();
    return {
      profile:     _currentProfile,
      failureRate: (_failureRate() * 100).toFixed(1) + '%',
      windowEvents: _events.length,
      degradedSince: _degradedSince > 0 ? Math.round((Date.now() - _degradedSince) / 1000) + 's' : null,
    };
  }

  // Use full profile on desktop, reduced on mobile as baseline
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    _currentProfile = 'reduced';
  }

  window.AdaptiveRuntime = { getProfile, recordSuccess, recordFailure, forceDegrade, forceRecover, onProfileChange, stats, PROFILES };
  console.debug('[AdaptiveRuntime] ready — profile: ' + _currentProfile);
}());
