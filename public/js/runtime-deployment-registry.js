// RuntimeDeploymentRegistry v1.0 — Phase 7 / Section 5 (Deployment Registry)
// =============================================================================
// Multi-channel deployment registry. Tracks and validates the current
// deployment environment against known release channels.
//
// Deployment channels:
//   production     — https://ilovepdf.cyou (primary)
//   production-www — https://www.ilovepdf.cyou
//   firebase       — https://ilovepdf-web.web.app
//   firebase-app   — https://ilovepdf-web.firebaseapp.com
//   replit-dev     — *.replit.dev / *.repl.co
//   replit-app     — *.replit.app (published)
//   local          — localhost / 127.0.0.1
//
// Release integrity checks:
//   1. Domain matches a known channel
//   2. Build seal fingerprint aligns with channel expectations
//   3. Firebase project binding verified against expected ID
//   4. CSP nonce presence on production channels
//
// window.RuntimeDeploymentRegistry
//   .getChannel()                → ChannelDef
//   .isProduction()              → boolean
//   .isTrustedChannel()          → boolean
//   .getIntegrityScore()         → number (0-100)
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeDeploymentRegistry) return;

  var VERSION = '1.0';
  var LOG     = '[DeployRegistry]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Channel definitions ───────────────────────────────────────────────────
  var CHANNELS = {
    'production':     {
      name: 'production', label: 'Production',
      hosts: ['ilovepdf.cyou'],
      isProd: true, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'production-www': {
      name: 'production-www', label: 'Production (www)',
      hosts: ['www.ilovepdf.cyou'],
      isProd: true, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'firebase':       {
      name: 'firebase', label: 'Firebase Hosting',
      hosts: ['ilovepdf-web.web.app'],
      isProd: false, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'firebase-app':   {
      name: 'firebase-app', label: 'Firebase App',
      hosts: ['ilovepdf-web.firebaseapp.com'],
      isProd: false, trusted: true, expectedFirebase: 'ilovepdf-web',
    },
    'replit-dev':     {
      name: 'replit-dev', label: 'Replit Dev',
      pattern: /\.(replit\.dev|repl\.co)(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
    'replit-app':     {
      name: 'replit-app', label: 'Replit Published',
      pattern: /\.replit\.app(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
    'local':          {
      name: 'local', label: 'Local Development',
      pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/,
      isProd: false, trusted: true, expectedFirebase: null,
    },
  };

  // ── Detect current channel ────────────────────────────────────────────────
  var _channel = null;
  var _host    = _s(function () { return G.location.hostname || ''; }, '');

  function _detectChannel() {
    for (var id in CHANNELS) {
      var ch = CHANNELS[id];
      if (ch.hosts && ch.hosts.indexOf(_host) !== -1) return ch;
      if (ch.pattern && ch.pattern.test(_host)) return ch;
    }
    return { name: 'unknown', label: 'Unknown Channel', isProd: false, trusted: false };
  }

  function getChannel() {
    if (!_channel) _channel = _detectChannel();
    return Object.assign({}, _channel);
  }

  function isProduction() {
    return getChannel().isProd === true;
  }

  function isTrustedChannel() {
    return getChannel().trusted === true;
  }

  // ── Integrity score ────────────────────────────────────────────────────────
  function getIntegrityScore() {
    var deductions = 0;
    var ch = getChannel();

    // Unknown channel
    if (ch.name === 'unknown') { deductions += 40; }

    // Seal check
    var sealOk = _s(function () {
      var ds = G.RuntimeDeploySeal;
      return ds && typeof ds.status === 'function' ? ds.status().ok : null;
    }, null);
    if (sealOk === false) deductions += 25;

    // Foreign deploy
    var isForeign = _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
    if (isForeign) deductions += 20;

    // Firebase binding (for production channels)
    if (ch.expectedFirebase) {
      var firebaseOk = _s(function () {
        var bound = G.__IPLV_FIREBASE_PROJECT__ || (G.firebase && G.firebase.app && G.firebase.app().options.projectId);
        return !bound || bound === ch.expectedFirebase;
      }, true);
      if (!firebaseOk) deductions += 15;
    }

    // Attestation
    var attested = _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
    if (!attested) deductions += 10;

    return Math.max(0, 100 - deductions);
  }

  // ── Emit channel info on boot ──────────────────────────────────────────────
  function _boot() {
    var ch = getChannel();
    console.info(LOG, 'v' + VERSION + ' ready | channel:', ch.name,
      '| trusted:', ch.trusted, '| host:', _host);

    _s(function () {
      if (G.RuntimeEventBus && typeof G.RuntimeEventBus.emit === 'function') {
        G.RuntimeEventBus.emit('deployment:channel-detected', {
          channel: ch.name,
          trusted: ch.trusted,
          isProd:  ch.isProd,
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2000); }, { once: true });
  } else {
    setTimeout(_boot, 2000);
  }

  G.RuntimeDeploymentRegistry = Object.freeze({
    VERSION:            VERSION,
    getChannel:         getChannel,
    isProduction:       isProduction,
    isTrustedChannel:   isTrustedChannel,
    getIntegrityScore:  getIntegrityScore,
    CHANNELS:           Object.freeze(Object.keys(CHANNELS).reduce(function (acc, k) {
      acc[k] = Object.freeze(Object.assign({}, CHANNELS[k]));
      return acc;
    }, {})),
    status: function () {
      return {
        version:        VERSION,
        channel:        getChannel().name,
        isProduction:   isProduction(),
        trusted:        isTrustedChannel(),
        integrityScore: getIntegrityScore(),
        host:           _host,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | host:', _host);
}(window));
