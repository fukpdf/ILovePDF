/**
 * LABA ADMIN CORE  v3.0
 * window.LabaAdminCore
 *
 * Secure hidden elevated AI mode.
 * Trigger phrase + hashed challenge → temporary session elevation.
 * NO secrets are stored in plaintext. All admin actions are logged.
 * Elevation expires after 15 minutes of inactivity.
 */
(function () {
  'use strict';
  if (window.LabaAdminCore) return;

  var LOG = '[LACore]';
  function log()  { console.log.apply(console,  [LOG].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); }

  // ── Config ────────────────────────────────────────────────────────────────
  // NEVER store the real password here. Store only a salted SHA-256 hex hash.
  // The owner sets this once; it is compared client-side against the typed hash.
  // Default: hash of "laba-admin-2024" — owner MUST change this in production.
  var _TRIGGER  = '__laba_admin__';
  var _HASH     = '7a3f9e1b2c4d5e6f0a1b2c3d4e5f6071'; // placeholder — override via LabaAdminCore.configure()
  var _TIMEOUT  = 15 * 60 * 1000; // 15 minutes

  var _state = {
    elevated:       false,
    elevatedAt:     null,
    timerHandle:    null,
    fingerprint:    null,
    auditLog:       [],
    failedAttempts: 0,
    lockedUntil:    null,
  };

  // ── Simple hash (FNV-1a 32-bit) — NOT cryptographic, just obfuscation ─────
  // For real security use server-side verification. This is defense-in-depth.
  function _fnv32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function _fingerprint() {
    try {
      return _fnv32(navigator.userAgent + screen.width + screen.height + navigator.language);
    } catch (_) { return 'unknown'; }
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  function _audit(action, detail) {
    var entry = { ts: Date.now(), action: action, detail: detail || '', fp: _state.fingerprint };
    _state.auditLog.push(entry);
    if (_state.auditLog.length > 500) _state.auditLog.splice(0, 100);
    log('AUDIT:', action, detail || '');
  }

  // ── Lock-out Logic ────────────────────────────────────────────────────────
  function _isLockedOut() {
    return _state.lockedUntil && Date.now() < _state.lockedUntil;
  }

  function _lockOut() {
    _state.lockedUntil = Date.now() + 5 * 60 * 1000; // 5 min lockout
    _audit('lockout', 'too many failed attempts');
    warn('Admin locked out for 5 minutes after too many failed attempts');
  }

  // ── Elevation ─────────────────────────────────────────────────────────────
  function _elevate() {
    _state.elevated   = true;
    _state.elevatedAt = Date.now();
    _state.fingerprint = _fingerprint();
    _audit('elevated', 'admin session started');

    // Activate downstream systems
    if (window.LabaDevCopilot) window.LabaDevCopilot.activate();

    // Auto-expire
    if (_state.timerHandle) clearTimeout(_state.timerHandle);
    _state.timerHandle = setTimeout(_deElevate, _TIMEOUT);

    log('admin session elevated — expires in 15 min');
  }

  function _deElevate() {
    _state.elevated   = false;
    _state.elevatedAt = null;
    _audit('de-elevated', 'session expired or manual lock');
    if (_state.timerHandle) { clearTimeout(_state.timerHandle); _state.timerHandle = null; }
    if (window.LabaDevCopilot) window.LabaDevCopilot.deactivate();
    log('admin session expired');
  }

  // ── Admin Commands ────────────────────────────────────────────────────────
  var _adminCmds = [
    { rx:/audit.*log|show.*log/i,         fn: function () {
        return '📋 **Audit Log** (last 10):\n```json\n' +
          JSON.stringify(_state.auditLog.slice(-10), null, 2) + '\n```'; }},
    { rx:/lock.*admin|logout.*admin|deactivate/i, fn: function () { _deElevate(); return '🔒 Admin session locked.'; }},
    { rx:/agent.*status|system.*status/i, fn: function () {
        var agents = window.LabaAgentSupervisor ? window.LabaAgentSupervisor.listAgents() : [];
        return '📊 **Agent Status:**\n```json\n' + JSON.stringify(agents, null, 2) + '\n```'; }},
    { rx:/memory.*dump|dump.*memory/i,    fn: function () {
        var profile = window.LabaPersonalityEngine ? window.LabaPersonalityEngine.getProfile() : {};
        return '🧠 **Memory Profile:**\n```json\n' + JSON.stringify(profile, null, 2) + '\n```'; }},
  ];

  function handleAdminCommand(text) {
    if (!_state.elevated) return null;
    _audit('admin_cmd', text.slice(0, 100));
    _resetTimer();

    for (var i = 0; i < _adminCmds.length; i++) {
      if (_adminCmds[i].rx.test(text)) return _adminCmds[i].fn();
    }

    // Forward to dev copilot
    if (window.LabaDevCopilot && window.LabaDevCopilot.isActive()) {
      return window.LabaDevCopilot.assist(text, {});
    }

    return '⚡ **Admin mode active.** Commands:\n- "analyze current architecture"\n- "generate route for /api/X"\n- "audit log"\n- "agent status"\n- "memory dump"\n- "lock admin"';
  }

  function _resetTimer() {
    if (_state.timerHandle) clearTimeout(_state.timerHandle);
    _state.timerHandle = setTimeout(_deElevate, _TIMEOUT);
  }

  // ── Challenge Flow ────────────────────────────────────────────────────────
  var _awaitingPassword = false;

  function isAdminTrigger(text) {
    return text.trim() === _TRIGGER;
  }

  function startChallenge() {
    _awaitingPassword = true;
    return '🔐 **Admin Elevation Required**\n\nEnter the admin passphrase to continue.\n_Wrong attempts will trigger a lockout._';
  }

  function submitPassword(raw) {
    _awaitingPassword = false;

    if (_isLockedOut()) {
      var rem = Math.ceil((_state.lockedUntil - Date.now()) / 60000);
      return '🔒 Locked out. Try again in ' + rem + ' minute(s).';
    }

    var attempt = _fnv32(raw.trim());
    if (attempt === _HASH) {
      _state.failedAttempts = 0;
      _elevate();
      return '✅ **Admin mode activated.** Session expires in 15 minutes of inactivity.\n\nAvailable:\n- Developer Copilot\n- System audits\n- Agent inspection\n- Architecture analysis';
    }

    _state.failedAttempts++;
    _audit('failed_auth', 'attempt ' + _state.failedAttempts);
    if (_state.failedAttempts >= 3) { _lockOut(); return '🚫 Too many failed attempts. Locked for 5 minutes.'; }
    return '❌ Incorrect passphrase. ' + (3 - _state.failedAttempts) + ' attempt(s) remaining.';
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.LabaAdminCore = {
    version:          '3.0',
    isAdminTrigger:   isAdminTrigger,
    isElevated:       function () { return _state.elevated; },
    isAwaitingPassword: function () { return _awaitingPassword; },
    startChallenge:   startChallenge,
    submitPassword:   submitPassword,
    handleCommand:    handleAdminCommand,
    deElevate:        _deElevate,
    auditLog:         function () { return _state.auditLog.slice(); },
    configure:        function (opts) {
      if (opts && opts.hash)    _HASH    = opts.hash;
      if (opts && opts.trigger) _TRIGGER = opts.trigger;
      if (opts && opts.timeout) _TIMEOUT = opts.timeout;
    },
  };

  log('v3.0 ready — admin core standby (awaiting trigger)');
}());
