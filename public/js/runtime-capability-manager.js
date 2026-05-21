// RuntimeCapabilityManager v1.0 — Phase 6 / Task 4 (Capability Management)
// =============================================================================
// Central authority for runtime capability grants and revocations.
// Provides a unified API for checking, granting, and revoking runtime
// capabilities across all Phase 6 systems.
//
// Capability model:
//   • Capabilities are named strings (e.g. 'wasm:pdf-module', 'worker:ocr')
//   • Each capability has a scope, tier requirement, and expiry
//   • Capabilities can be session-scoped or permanent
//   • Revocation is immediate and propagates to dependent systems
//   • Audit trail for all grants/revocations
//
// Sources of capability grants:
//   1. Boot grants (always-on capabilities for the device tier)
//   2. Ticket grants (from RuntimeHybridExecution tickets)
//   3. Attestation grants (from RuntimeEdgeAttestation)
//   4. User action grants (from user consent flows)
//
// window.RuntimeCapabilityManager
//   .grant(cap, opts)               → CapabilityEntry
//   .revoke(cap)                    → void
//   .has(cap)                       → boolean
//   .require(cap)                   → Promise<boolean>
//   .listActive()                   → CapabilityEntry[]
//   .status()                       → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCapabilityManager) return;

  var VERSION     = '1.0';
  var LOG         = '[CapManager]';
  var DEFAULT_TTL = 10 * 60_000;  // 10 minutes

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');
  var _liteTier = _score < 40;

  // ── Capability store ───────────────────────────────────────────────────────
  // cap → { cap, scope, source, granted, exp, permanent, meta }
  var _caps    = typeof Map !== 'undefined' ? new Map() : null;
  var _audit   = [];
  var MAX_AUDIT = 300;

  function _log(action, cap, detail) {
    var entry = { action: action, cap: cap, detail: detail || null, ts: Date.now() };
    _audit.push(entry);
    if (_audit.length > MAX_AUDIT) _audit.shift();
  }

  // ── Capability tier requirements ───────────────────────────────────────────
  var CAP_TIER = {
    'wasm:basic':          'MEDIUM',
    'wasm:simd':           'HIGH',
    'wasm:threads':        'HIGH',
    'worker:spawn':        'MEDIUM',
    'worker:shared':       'HIGH',
    'fetch:external':      'MEDIUM',
    'fetch:ai':            'HIGH',
    'storage:read':        'LOW',
    'storage:write':       'MEDIUM',
    'canvas:2d':           'LOW',
    'canvas:gpu':          'HIGH',
    'crypto:subtle':       'MEDIUM',
    'audio:process':       'MEDIUM',
    'perf:measure':        'LOW',
    'telemetry:write':     'HIGH',
    'hybrid:ticket':       'MEDIUM',
    'session:rotate':      'HIGH',
    'exec-ticket:premium': 'MEDIUM',
  };

  function _tierScore(tier) {
    if (tier === 'HIGH')   return 70;
    if (tier === 'MEDIUM') return 40;
    return 0;
  }

  // ── grant ──────────────────────────────────────────────────────────────────
  function grant(cap, opts) {
    if (!_caps) return null;
    opts = opts || {};

    var required = CAP_TIER[cap] || 'LOW';
    if (_score < _tierScore(required)) {
      console.debug(LOG, 'grant denied (tier):', cap, '| needs:', required, '| has:', _tier);
      _log('grant-denied-tier', cap, { required: required, actual: _tier });
      return null;
    }

    var entry = {
      cap:       cap,
      scope:     opts.scope     || 'session',
      source:    opts.source    || 'boot',
      granted:   Date.now(),
      exp:       opts.permanent ? Infinity : (Date.now() + (opts.ttl || DEFAULT_TTL)),
      permanent: !!opts.permanent,
      meta:      opts.meta || null,
    };

    _caps.set(cap, entry);
    _log('granted', cap, { source: entry.source, scope: entry.scope });
    console.debug(LOG, 'granted:', cap, '| source:', entry.source);

    // Notify interested systems
    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('capability:granted', { cap: cap, source: entry.source });
      }
    });

    return entry;
  }

  // ── revoke ────────────────────────────────────────────────────────────────
  function revoke(cap) {
    if (!_caps || !_caps.has(cap)) return;
    _caps.delete(cap);
    _log('revoked', cap);
    console.debug(LOG, 'revoked:', cap);

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('capability:revoked', { cap: cap });
      }
    });
  }

  // ── has ───────────────────────────────────────────────────────────────────
  function has(cap) {
    if (!_caps) return true;  // degenerate mode
    if (!_caps.has(cap)) return false;
    var entry = _caps.get(cap);
    if (!entry.permanent && entry.exp < Date.now()) {
      _caps.delete(cap);
      _log('expired', cap);
      return false;
    }
    return true;
  }

  // ── require ───────────────────────────────────────────────────────────────
  // If the capability is missing, attempts to obtain it via HybridExecution ticket.
  function require(cap) {
    if (has(cap)) return Promise.resolve(true);

    // Try to get an execution ticket for this capability
    return _s(function () {
      var he = G.RuntimeHybridExecution;
      if (!he || typeof he.gate !== 'function') return Promise.resolve(false);
      return he.gate(cap).then(function (ok) {
        if (ok) {
          grant(cap, { source: 'hybrid-ticket', ttl: 90_000 });
          return true;
        }
        _log('require-denied', cap, { reason: 'ticket-gate-failed' });
        return false;
      });
    }, Promise.resolve(false));
  }

  // ── listActive ────────────────────────────────────────────────────────────
  function listActive() {
    if (!_caps) return [];
    var now    = Date.now();
    var active = [];
    _caps.forEach(function (entry, cap) {
      if (entry.permanent || entry.exp > now) {
        active.push(Object.assign({}, entry));
      }
    });
    return active;
  }

  // ── Bootstrap grants ──────────────────────────────────────────────────────
  function _bootGrants() {
    // Always-on LOW capabilities
    grant('storage:read',   { permanent: true, source: 'boot' });
    grant('canvas:2d',      { permanent: true, source: 'boot' });
    grant('perf:measure',   { permanent: true, source: 'boot' });

    // MEDIUM+ capabilities
    if (_score >= 40) {
      grant('wasm:basic',         { permanent: true,  source: 'boot' });
      grant('worker:spawn',       { permanent: true,  source: 'boot' });
      grant('fetch:external',     { permanent: true,  source: 'boot' });
      grant('storage:write',      { permanent: true,  source: 'boot' });
      grant('crypto:subtle',      { permanent: true,  source: 'boot' });
      grant('audio:process',      { permanent: true,  source: 'boot' });
      grant('hybrid:ticket',      { permanent: true,  source: 'boot' });
      grant('exec-ticket:premium',{ permanent: true,  source: 'boot' });
    }

    // HIGH capabilities
    if (_score >= 70) {
      grant('wasm:simd',          { permanent: true, source: 'boot' });
      grant('wasm:threads',       _s(function () {
        var we = G.RuntimeWasmEnterprise;
        var cp = we && typeof we.getCapabilityProfile === 'function' ? we.getCapabilityProfile() : null;
        var threadsOk = cp && cp.features && cp.features.wasmThreads;
        return { permanent: true, source: 'boot', meta: { threadsAvailable: !!threadsOk } };
      }, { permanent: true, source: 'boot' }));
      grant('worker:shared',      { permanent: true, source: 'boot' });
      grant('canvas:gpu',         { permanent: true, source: 'boot' });
      grant('telemetry:write',    { permanent: true, source: 'boot' });
      grant('session:rotate',     { permanent: true, source: 'boot' });
    }
  }

  // ── Subscribe to security events that should revoke capabilities ──────────
  function _installRevocationHooks() {
    _s(function () {
      if (!G.RuntimeEventBus) return;

      // Seal failure → revoke premium execution
      G.RuntimeEventBus.on('seal:failure', function () {
        revoke('exec-ticket:premium');
        revoke('wasm:simd');
        revoke('worker:shared');
        console.warn(LOG, 'capabilities revoked: seal failure');
      });

      // Tamper response → revoke sensitive caps
      G.RuntimeEventBus.on('shield:tamper-response', function () {
        revoke('telemetry:write');
        revoke('session:rotate');
        console.warn(LOG, 'capabilities revoked: tamper response');
      });

      // Foreign deploy → revoke AI + premium
      G.RuntimeEventBus.on('security:foreign-deploy', function () {
        revoke('fetch:ai');
        revoke('exec-ticket:premium');
        console.warn(LOG, 'capabilities revoked: foreign deploy');
      });
    });
  }

  // ── Periodic expiry sweep ──────────────────────────────────────────────────
  function _sweepExpired() {
    if (!_caps) return;
    var now = Date.now();
    _caps.forEach(function (entry, cap) {
      if (!entry.permanent && entry.exp < now) {
        _caps.delete(cap);
      }
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _bootGrants();
    _installRevocationHooks();
    setInterval(_sweepExpired, 60_000);

    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| active caps:', listActive().length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2200); }, { once: true });
  } else {
    setTimeout(_boot, 2200);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeCapabilityManager = Object.freeze({
    VERSION:    VERSION,
    grant:      grant,
    revoke:     revoke,
    has:        has,
    require:    require,
    listActive: listActive,
    CAP_TIER:   Object.freeze(Object.assign({}, CAP_TIER)),
    status: function () {
      return {
        version:      VERSION,
        tier:         _tier,
        score:        _score,
        activeCaps:   listActive().length,
        auditEntries: _audit.length,
        recentAudit:  _audit.slice(-10),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');

}(window));
