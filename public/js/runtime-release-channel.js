// RuntimeReleaseChannel v1.0 — Phase 7 / Section 5 (Release Channel Management)
// =============================================================================
// Release channel management and environment-aware policy switching.
// Ensures the correct feature set is active for the current deployment channel.
//
// Channel-to-feature mapping:
//   production     → full feature set, strict policies, HTTPS required
//   firebase       → full feature set, relaxed CSP (firebase hosting headers)
//   replit-app     → full feature set, replit proxy headers
//   replit-dev     → dev mode, relaxed policies, extra debug info
//   local          → dev mode, all features unlocked, verbose logging
//
// window.RuntimeReleaseChannel
//   .getFeatureFlags()           → FeatureFlags
//   .isFeatureEnabled(name)      → boolean
//   .getChannelPolicy()          → ChannelPolicy
//   .status()                    → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeReleaseChannel) return;

  var VERSION = '1.0';
  var LOG     = '[ReleaseChannel]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Get current channel ────────────────────────────────────────────────────
  var _channelName = _s(function () {
    var dr = G.RuntimeDeploymentRegistry;
    return dr && typeof dr.getChannel === 'function' ? dr.getChannel().name : 'unknown';
  }, 'unknown');

  // ── Feature flag matrices per channel ─────────────────────────────────────
  var CHANNEL_FLAGS = {
    'production':     {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      true,  workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'production-www': {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      true,  workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'firebase':       {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'firebase-app':   {
      ai:             true,  premium: true,  analytics: true,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'replit-app':     {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: true, edgeProof: true,
      verboseLog:     false, debugPanel: false,
    },
    'replit-dev':     {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: true, edgeProof: false,
      verboseLog:     true,  debugPanel: true,
    },
    'local':          {
      ai:             true,  premium: true,  analytics: false,
      strictCSP:      false, workerMesh: false, edgeProof: false,
      verboseLog:     true,  debugPanel: true,
    },
  };

  var DEFAULT_FLAGS = {
    ai:         false, premium: false, analytics: false,
    strictCSP:  false, workerMesh: false, edgeProof: false,
    verboseLog: false, debugPanel: false,
  };

  function getFeatureFlags() {
    return Object.assign({}, CHANNEL_FLAGS[_channelName] || DEFAULT_FLAGS);
  }

  function isFeatureEnabled(name) {
    var flags = getFeatureFlags();
    return flags[name] === true;
  }

  // ── Channel policy ─────────────────────────────────────────────────────────
  var CHANNEL_POLICIES = {
    'production':     { rateLimit: 'strict',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'production-www': { rateLimit: 'strict',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'firebase':       { rateLimit: 'normal',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'firebase-app':   { rateLimit: 'normal',  fileSizeCapMB: 100, quotaMultiplier: 1.0 },
    'replit-app':     { rateLimit: 'normal',  fileSizeCapMB: 50,  quotaMultiplier: 0.8 },
    'replit-dev':     { rateLimit: 'relaxed', fileSizeCapMB: 50,  quotaMultiplier: 2.0 },
    'local':          { rateLimit: 'none',    fileSizeCapMB: 999, quotaMultiplier: 10.0 },
  };

  function getChannelPolicy() {
    return Object.assign({ channel: _channelName },
      CHANNEL_POLICIES[_channelName] || { rateLimit: 'strict', fileSizeCapMB: 20, quotaMultiplier: 0.5 });
  }

  function _boot() {
    var flags  = getFeatureFlags();
    var policy = getChannelPolicy();
    console.info(LOG, 'v' + VERSION + ' ready | channel:', _channelName,
      '| rateLimit:', policy.rateLimit,
      '| debugPanel:', flags.debugPanel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 2500); }, { once: true });
  } else {
    setTimeout(_boot, 2500);
  }

  G.RuntimeReleaseChannel = Object.freeze({
    VERSION:          VERSION,
    getFeatureFlags:  getFeatureFlags,
    isFeatureEnabled: isFeatureEnabled,
    getChannelPolicy: getChannelPolicy,
    status: function () {
      return {
        version: VERSION, channel: _channelName,
        flags: getFeatureFlags(), policy: getChannelPolicy(),
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded | channel:', _channelName);
}(window));
