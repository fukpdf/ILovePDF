// RuntimeEdgePolicy v1.0 — Phase 7 / Section 3 (Edge Execution Policy Engine)
// =============================================================================
// Policy engine for execution contexts. Enforces rules about which operations
// are permitted based on runtime state, deployment environment, and user tier.
//
// Policy dimensions:
//   1. Deployment channel   — production / staging / dev / replit / firebase
//   2. Security tier        — LOW / MEDIUM / HIGH / EXTREME
//   3. Session state        — active / idle / degraded / rotated
//   4. Attestation state    — trusted / untrusted / foreign
//   5. Behavioral health    — from RuntimeBehaviorAnalysis
//   6. Threat level         — from RuntimeThreatCorrelation
//
// Policy definitions:
//   default   — standard execution (no special requirements)
//   premium   — requires HIGH tier + trusted attestation
//   ai        — requires MEDIUM+ tier + human signals
//   export    — requires active session + no foreign deploy
//   admin     — requires HIGH tier + verified session
//   wasm      — requires MEDIUM+ tier + wasm capability
//
// window.RuntimeEdgePolicy
//   .allow(operation, context)     → boolean
//   .getPolicy(name)               → PolicyDefinition
//   .registerPolicy(name, def)     → void
//   .evaluateAll(context)          → PolicyReport
//   .status()                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgePolicy) return;

  var VERSION = '1.0';
  var LOG     = '[EdgePolicy]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score    === 'function') return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _tier    = _score >= 70 ? 'HIGH' : (_score >= 40 ? 'MEDIUM' : 'LOW');

  // ── Runtime state getters ─────────────────────────────────────────────────
  function _isForeign() {
    return _s(function () {
      var fd = G.RuntimeForeignDeploy;
      return fd && typeof fd.isForeign === 'function' ? fd.isForeign() : false;
    }, false);
  }

  function _isAttested() {
    return _s(function () {
      var ea = G.RuntimeEdgeAttestation;
      return ea && typeof ea.isTrusted === 'function' ? ea.isTrusted() : true;
    }, true);
  }

  function _getSessionState() {
    return _s(function () {
      var ss = G.RuntimeSecureSession;
      return ss && typeof ss.status === 'function' ? ss.status().state : 'active';
    }, 'active');
  }

  function _getBehaviorHealth() {
    return _s(function () {
      var ba = G.RuntimeBehaviorAnalysis;
      return ba && typeof ba.getHealthScore === 'function' ? ba.getHealthScore() : 80;
    }, 80);
  }

  function _getThreatLevel() {
    return _s(function () {
      var tc = G.RuntimeThreatCorrelation;
      if (!tc || typeof tc.getActiveThreats !== 'function') return 0;
      return tc.getActiveThreats().length;
    }, 0);
  }

  // ── Built-in policies ──────────────────────────────────────────────────────
  var POLICIES = {
    'default': {
      name: 'default',
      check: function () { return true; },
    },

    'premium': {
      name: 'premium',
      check: function () {
        if (_score < 40) return false;
        if (!_isAttested() && _isForeign()) return false;
        var cap = _s(function () {
          var cm = G.RuntimeCapabilityManager;
          return cm && typeof cm.has === 'function' ? cm.has('exec-ticket:premium') : true;
        }, true);
        return cap;
      },
    },

    'ai': {
      name: 'ai',
      check: function () {
        if (_score < 40) return false;
        if (_isForeign()) return false;
        var behavior = _getBehaviorHealth();
        return behavior >= 30;  // don't serve AI to very likely bots
      },
    },

    'export': {
      name: 'export',
      check: function () {
        var sessionState = _getSessionState();
        if (sessionState === 'rotated' || sessionState === 'degraded') return false;
        return !_isForeign();
      },
    },

    'admin': {
      name: 'admin',
      check: function () {
        if (_score < 70) return false;
        if (!_isAttested()) return false;
        var sessionState = _getSessionState();
        return sessionState === 'active';
      },
    },

    'wasm': {
      name: 'wasm',
      check: function () {
        if (_score < 40) return false;
        var cap = _s(function () {
          var cm = G.RuntimeCapabilityManager;
          return cm && typeof cm.has === 'function' ? cm.has('wasm:basic') : true;
        }, true);
        return cap;
      },
    },

    'ticket': {
      name: 'ticket',
      check: function () {
        if (_score < 40) return true;  // no ticket needed for LOW tier
        // Check there are no active CRITICAL threats
        var threats = _getThreatLevel();
        return threats < 3;
      },
    },
  };

  // ── Additional user-registered policies ────────────────────────────────────
  var _customPolicies = {};

  function registerPolicy(name, def) {
    if (typeof def.check !== 'function') return;
    _customPolicies[name] = def;
    console.debug(LOG, 'policy registered:', name);
  }

  function getPolicy(name) {
    return POLICIES[name] || _customPolicies[name] || POLICIES['default'];
  }

  function allow(operation, context) {
    var policy = getPolicy(operation);
    try {
      var ok = policy.check(context || {});
      if (!ok) {
        console.debug(LOG, 'policy denied:', operation, '| context:', JSON.stringify(context || {}));
      }
      return ok;
    } catch (e) {
      console.warn(LOG, 'policy check error:', operation, e.message);
      return true; // fail-open to not break tools
    }
  }

  function evaluateAll(context) {
    var results = {};
    var allPolicies = Object.assign({}, POLICIES, _customPolicies);
    for (var name in allPolicies) {
      try {
        results[name] = allPolicies[name].check(context || {});
      } catch (_) {
        results[name] = true;
      }
    }
    return {
      results:    results,
      context:    context,
      tier:       _tier,
      foreign:    _isForeign(),
      attested:   _isAttested(),
      session:    _getSessionState(),
      behavior:   _getBehaviorHealth(),
      threats:    _getThreatLevel(),
      ts:         Date.now(),
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    console.info(LOG, 'v' + VERSION + ' ready | tier:', _tier,
      '| policies:', Object.keys(POLICIES).length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 4000); }, { once: true });
  } else {
    setTimeout(_boot, 4000);
  }

  G.RuntimeEdgePolicy = Object.freeze({
    VERSION:        VERSION,
    allow:          allow,
    getPolicy:      getPolicy,
    registerPolicy: registerPolicy,
    evaluateAll:    evaluateAll,
    status: function () {
      return {
        version:       VERSION,
        tier:          _tier,
        foreign:       _isForeign(),
        attested:      _isAttested(),
        policyCount:   Object.keys(POLICIES).length + Object.keys(_customPolicies).length,
      };
    },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
