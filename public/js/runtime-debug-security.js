(function (G) {
  'use strict';
  if (G.RuntimeDebugSecurity) return;

  var VERSION = '10.0.0';
  var LOG = '[DebugSecurity]';

  // ── Access gate ───────────────────────────────────────────────────────────────
  // Allowed if ANY of: ?debug=1 | sessionStorage.ilpdf_dash=1 | localStorage.ilpdf_admin=1
  function _isAllowed() {
    try {
      var qs  = window.location.search;
      if (qs.indexOf('debug=1') !== -1) return true;
      if (sessionStorage && sessionStorage.getItem('ilpdf_dash') === '1') return true;
      if (localStorage  && localStorage.getItem('ilpdf_admin')  === '1') return true;
    } catch (_) {}
    return false;
  }

  // ── Sensitive field redaction ─────────────────────────────────────────────────
  var REDACT_KEYS = [
    'token', 'jwt', 'secret', 'password', 'passwd', 'apikey', 'api_key',
    'cookie', 'session', 'auth', 'credential', 'private', 'key',
  ];

  function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var out = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach(function (k) {
      var lk = k.toLowerCase();
      var sensitive = REDACT_KEYS.some(function (r) { return lk.indexOf(r) !== -1; });
      if (sensitive) {
        out[k] = '[REDACTED]';
      } else if (obj[k] && typeof obj[k] === 'object') {
        out[k] = redact(obj[k]);
      } else {
        out[k] = obj[k];
      }
    });
    return out;
  }

  // ── Rate limiter (for export/command actions) ─────────────────────────────────
  var _rateBuckets = {};
  function checkRate(key, maxPerMin) {
    var now = Date.now();
    if (!_rateBuckets[key]) _rateBuckets[key] = [];
    _rateBuckets[key] = _rateBuckets[key].filter(function (t) { return now - t < 60000; });
    if (_rateBuckets[key].length >= maxPerMin) return false;
    _rateBuckets[key].push(now);
    return true;
  }

  // ── Command allow-list (ControlPlane commands safe to execute from debug page) ─
  var SAFE_COMMANDS = [
    'gc:hint', 'cache:clear', 'hydration:flush',
    'healing:start', 'healing:stop',
    'governance:sweep', 'workload:stop', 'workload:start',
    'session-stability:assess', 'blackbox:export',
  ];

  function isSafeCommand(cmd) {
    return SAFE_COMMANDS.indexOf(cmd) !== -1;
  }

  G.RuntimeDebugSecurity = Object.freeze({
    VERSION:      VERSION,
    isAllowed:    _isAllowed,
    redact:       redact,
    checkRate:    checkRate,
    isSafeCommand: isSafeCommand,
    SAFE_COMMANDS: SAFE_COMMANDS,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — gate active');

}(window));
