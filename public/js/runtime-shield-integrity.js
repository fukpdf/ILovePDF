// RuntimeShieldIntegrity v1.0 — Enterprise Runtime Shield Layer / Tasks 3, 7, 8
// ============================================================================
// Prototype pollution detection, runtime integrity sweeps, honeypot trap
// objects, session flagging, tamper response, and DevTools degradation.
//
// ADDITIVE ONLY — responds by degrading diagnostics, never breaks processing.
//
// Systems:
//   A. Prototype pollution detector — checks Object/Array/Function/String/Number
//      prototypes for unexpected own properties. Runs at boot + periodically.
//   B. Runtime integrity sweep — re-validates critical global references.
//   C. Honeypot traps — fake debug/admin globals that flag on access.
//   D. Session flagging + tamper response — graceful degradation only.
//   E. DevTools degradation — size heuristic detection; clears metadata.
//
// Low-end devices: skip expensive periodic sweeps, skip honeypots.
// Mid-end devices: sweeps at 60s intervals; basic honeypots.
// High-end devices: sweeps at 20s intervals; full honeypots + decoys.
//
// Exposes: window.RuntimeShieldIntegrity (minimal status only)
// ============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeShieldIntegrity) return;

  var VERSION = '1.0';
  var LOG     = '[ShieldInt]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ───────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 80;
  }, 80);
  var _lite = _score < 40;
  var _mid  = _score >= 40 && _score < 70;

  // Sweep interval: lighter on weak devices
  var SWEEP_INTERVAL_MS = _lite ? 0 : (_mid ? 60000 : 20000);

  // ── Session flag state ────────────────────────────────────────────────────
  var _flags          = 0;
  var _devtoolsCount  = 0;
  var _tamperResponse = false;
  var FLAG_THRESHOLD  = 3; // flag count before triggering tamper response

  function _flagSession(reason) {
    _flags++;
    console.debug(LOG, 'session flagged (' + _flags + '/' + FLAG_THRESHOLD + '):', reason);
    _s(function () {
      if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:flag:' + reason, { count: _flags });
    });
    _s(function () {
      var reg = G.RuntimeShieldCore && G.RuntimeShieldCore.registry;
      if (reg) reg.set('core:flagged', true);
    });
    if (_flags >= FLAG_THRESHOLD && !_tamperResponse) {
      _triggerTamperResponse('threshold:' + reason);
    }
  }

  // ── A. Prototype Pollution Detection ─────────────────────────────────────
  // Baseline: capture expected prototype own-property names at boot.
  // Subsequent sweeps compare against baseline to detect injections.

  var _protoBaselines = {};

  var PROTO_TARGETS = [
    { name: 'Object.prototype',   obj: Object.prototype   },
    { name: 'Array.prototype',    obj: Array.prototype     },
    { name: 'Function.prototype', obj: Function.prototype  },
    { name: 'String.prototype',   obj: String.prototype    },
    { name: 'Number.prototype',   obj: Number.prototype    },
  ];

  function _captureProtoBaseline() {
    PROTO_TARGETS.forEach(function (t) {
      try {
        _protoBaselines[t.name] = new Set(Object.getOwnPropertyNames(t.obj));
      } catch (_) {}
    });
  }

  function _checkProtoPollution() {
    var found = [];
    PROTO_TARGETS.forEach(function (t) {
      var baseline = _protoBaselines[t.name];
      if (!baseline) return;
      try {
        var current = Object.getOwnPropertyNames(t.obj);
        current.forEach(function (prop) {
          if (!baseline.has(prop)) {
            found.push(t.name + '.' + prop);
          }
        });
      } catch (_) {}
    });
    if (found.length > 0) {
      console.warn(LOG, 'PROTOTYPE POLLUTION detected:', found);
      _s(function () {
        if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:proto-pollution', { props: found });
      });
      _flagSession('proto-pollution:' + found[0]);
    }
    return found;
  }

  // ── B. Runtime Integrity Sweep ────────────────────────────────────────────
  // Validates that critical global references haven't been replaced.
  // Delegates to RuntimeProtection's registry if available.

  function _integritysweep() {
    // 1. Prototype pollution
    _checkProtoPollution();

    // 2. Check RuntimeProtection's registry integrity
    _s(function () {
      var rp = G.RuntimeProtection || G.RuntimeHealth;
      if (rp && rp.audit) {
        var report = rp.audit();
        if (report && report.mutationCount > 0) {
          _flagSession('mutation-detected:' + report.mutationCount);
        }
      }
    });

    // 3. Verify security sentinels are still intact (not replaced with stubs)
    var SENTINELS = ['RuntimeSecurity', 'RuntimeSandbox'];
    SENTINELS.forEach(function (name) {
      var obj = G[name];
      if (!obj) return;
      // If validateWorkerMessage was replaced with a stub, flag it
      if (obj.validateWorkerMessage && typeof obj.validateWorkerMessage !== 'function') {
        _flagSession('sentinel-corrupted:' + name + '.validateWorkerMessage');
      }
    });
  }

  // ── C. Honeypot Trap Objects ──────────────────────────────────────────────
  // Fake globals that trigger session flagging when accessed.
  // Real secrets are NEVER stored here — these are decoys.

  var _decoys = {
    __debug: {
      version: '1.0.0-dev',
      env: 'production',
      keys: [],                          // empty — no real keys
      inspect: function () { return null; },
    },
    __admin: {
      token: null,
      users: [],
      revoke: function () { return false; },
    },
    __config: {
      endpoint: '/api',
      mode: 'production',
    },
    __rt_internal: {
      workers: [],
      registry: null,
    },
  };

  function _installHoneypots() {
    if (_lite) return; // skip on very weak devices

    Object.keys(_decoys).forEach(function (trapName) {
      // Don't clobber real properties
      if (trapName in G && G[trapName] !== undefined) return;

      var decoyValue = _decoys[trapName];

      try {
        Object.defineProperty(G, trapName, {
          get: function () {
            _flagSession('honeypot:' + trapName + ':read');
            return decoyValue;
          },
          set: function (v) {
            _flagSession('honeypot:' + trapName + ':write');
            // silently accept — don't error, just flag
          },
          enumerable: false,    // hidden from normal enumeration
          configurable: false,  // cannot be overwritten
        });
      } catch (_) {}
    });

    console.debug(LOG, 'honeypots installed:', Object.keys(_decoys).join(', '));
  }

  // ── D. Tamper Response ─────────────────────────────────────────────────────
  // Graceful degradation — never kills processing, never freezes the browser.
  // Only clears diagnostic/inspection tooling for the suspicious session.

  function _triggerTamperResponse(reason) {
    if (_tamperResponse) return;
    _tamperResponse = true;

    console.info(LOG, 'tamper response activated:', reason);
    _s(function () {
      if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:tamper-response', { reason: reason });
    });

    // 1. Clear DebugTrace — no processing data accessible
    _s(function () {
      var dt = G.DebugTrace;
      if (dt && dt.clear) dt.clear();
    });

    // 2. Suspend RuntimeDiagnosticsCenter timeline (hide internals)
    _s(function () {
      var dc = G.RuntimeDiagnosticsCenter;
      if (dc && dc.clearTimeline) dc.clearTimeline();
      if (dc && dc.suspend)       dc.suspend();
    });

    // 3. Revoke any exposed ObjectURLs from diagnostics
    _s(function () {
      var reg = G.ObjectURLRegistry;
      if (reg && reg.revokeOwner) {
        reg.revokeOwner('diagnostics');
        reg.revokeOwner('debug');
        reg.revokeOwner('dashboard');
      }
    });

    // 4. Suspend RuntimeAnalytics inspection mode
    _s(function () {
      var ra = G.RuntimeAnalytics;
      if (ra && ra.suspendInspection) ra.suspendInspection();
    });

    // 5. Nullify RuntimeDevtoolsDashboard overlay
    _s(function () {
      var dd = G.RuntimeDevtoolsDashboard;
      if (dd && dd.destroy) dd.destroy();
    });

    // 6. Gracefully terminate any sensitive diagnostic workers
    _s(function () {
      var rw = G.RuntimeWorkers;
      if (rw && rw.terminateType) rw.terminateType('diagnostics');
    });

    console.debug(LOG, 'tamper response: diagnostic data cleared for this session');
  }

  // ── E. DevTools Degradation ───────────────────────────────────────────────
  // Detection strategy: window size heuristic (docked DevTools opens a panel,
  // shrinking the document viewport relative to the OS window).
  // NOT using debugger; traps or fake-disable tricks — those harm users.
  // When DevTools detected for 3+ consecutive checks → degrade diagnostics.

  var _dtDetectedConsec = 0;
  var DT_CONSEC_THRESHOLD = 3; // 3 consecutive detections → degrade
  var _dtDegraded = false;

  function _detectDevTools() {
    // Heuristic: DevTools takes space, shrinking viewport significantly
    var wDiff = G.outerWidth  - G.innerWidth;
    var hDiff = G.outerHeight - G.innerHeight;
    // Threshold: 200px gap suggests a docked DevTools panel
    return (wDiff > 200 || hDiff > 200);
  }

  function _devToolsCheck() {
    if (_dtDegraded) return; // already degraded, stop checking
    if (_detectDevTools()) {
      _dtDetectedConsec++;
      if (_dtDetectedConsec >= DT_CONSEC_THRESHOLD) {
        _degradeDevTools();
      }
    } else {
      _dtDetectedConsec = Math.max(0, _dtDetectedConsec - 1); // decay
    }
  }

  function _degradeDevTools() {
    if (_dtDegraded) return;
    _dtDegraded = true;

    console.debug(LOG, 'sustained DevTools open — degrading diagnostic metadata');
    _s(function () {
      if (G.RuntimeTelemetry) G.RuntimeTelemetry.record('shield:devtools-degraded');
    });

    // Unload runtime metadata — leave processing fully intact
    _s(function () {
      var dt = G.DebugTrace;
      if (dt && dt.clear) dt.clear();
    });

    // Clear telemetry enterprise flamegraph/waterfall data
    _s(function () {
      var te = G.RuntimeTelemetryEnterprise;
      if (te && te.clearFlamegraph)  te.clearFlamegraph();
      if (te && te.clearWaterfall)   te.clearWaterfall();
    });

    // Revoke diagnostic object URLs
    _s(function () {
      var reg = G.ObjectURLRegistry;
      if (reg && reg.revokeOwner) reg.revokeOwner('diagnostics');
    });

    // Replace window.RuntimeDashboard with an opaque stub
    // (dashboard is for admins only — unauthorized viewers get nothing useful)
    _s(function () {
      if (G.RuntimeDashboard && !G.RuntimeDashboard.__degraded) {
        G.RuntimeDashboard = { __degraded: true, status: function () { return {}; } };
      }
    });
  }

  // ── Boot & scheduling ─────────────────────────────────────────────────────
  function _boot() {
    _captureProtoBaseline();

    if (!_lite) {
      _installHoneypots();
      _checkProtoPollution(); // immediate check

      if (SWEEP_INTERVAL_MS > 0) {
        setInterval(_integritysweep, SWEEP_INTERVAL_MS);
      }

      // DevTools check every 5s (cheap, non-blocking)
      setInterval(_devToolsCheck, 5000);
    }

    console.info(LOG, 'v' + VERSION + ' ready',
      '| lite:', _lite,
      '| sweep interval:', SWEEP_INTERVAL_MS + 'ms',
      '| honeypots:', !_lite);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 400);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 400); }, { once: true });
  }

  G.RuntimeShieldIntegrity = {
    VERSION:  VERSION,
    getStats: function () {
      return {
        flags:         _flags,
        devtoolsCount: _dtDetectedConsec,
        degraded:      _dtDegraded,
        tamperResponse:_tamperResponse,
        liteMode:      _lite,
      };
    },
    // Manual sweep (callable by admins)
    sweep: function () { return _integritysweep(); },
    flag:  function (reason) { _flagSession(String(reason).slice(0, 60)); },
  };

}(window));
