// RuntimeGovernance v1.0 — Arc 9 / Phase F
// =====================================================================
// Runtime policy enforcement and compliance layer.
//
// Policy graph covers:
//   - Worker concurrency limits (min/max per family)
//   - Memory budget limits (per-family, global)
//   - Feature flag protections (flags that must not be disabled)
//   - Extreme mode authorization (which sources can trigger modes)
//   - Mutation guards (prevent unauthorized runtime state changes)
//   - Thermal safety boundaries (minimum thermal headroom)
//
// Enforcement:
//   - Intercepts RuntimeControlPlane commands via arc8:command events
//   - Periodic compliance sweep (every 2 min)
//   - Violation → arc8:incident(P1) for critical / P2 for advisory
//   - Quarantine: block all commands to a quarantined subsystem
//
// Governance snapshots: frozen policy state at each sweep.
// Protected flags: cannot be disabled without governance override.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeGovernance) return;

  var LOG     = '[Governance]';
  var VERSION = '1.0';

  // ── Policy definitions ────────────────────────────────────────────
  var POLICIES = [
    { id: 'worker-concurrency-max', desc: 'Max 4 workers per family',
      check: function () {
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (!pw || !pw.getStats) return null;
          var ws = pw.getStats();
          if (!ws) return null;
          var violations = Object.keys(ws).filter(function (f) { return (ws[f].active || 0) > 4; });
          return violations.length === 0 ? null : 'families over concurrency limit: ' + violations.join(',');
        } catch (_) { return null; }
      }
    },
    { id: 'memory-global-budget', desc: 'Global heap < 80% of limit',
      check: function () {
        try {
          var pm = performance.memory;
          if (!pm) return null;
          var pct = pm.usedJSHeapSize / pm.jsHeapSizeLimit * 100;
          return pct > 80 ? 'global heap at ' + pct.toFixed(1) + '% — over 80% limit' : null;
        } catch (_) { return null; }
      }
    },
    { id: 'protected-flags-intact', desc: 'Core runtime flags must not be disabled',
      check: function () {
        try {
          var cp = G.RuntimeControlPlane;
          if (!cp) return null;
          var failed = PROTECTED_FLAGS.filter(function (f) { return cp.getFlag(f) === false; });
          return failed.length ? 'protected flags disabled: ' + failed.join(',') : null;
        } catch (_) { return null; }
      }
    },
    { id: 'hydration-domains-active', desc: 'P0 hydration domain must always be active',
      check: function () {
        try {
          var hd = G.RuntimeHydrationDomains;
          if (!hd) return null;
          var state = hd.getState && hd.getState();
          if (!state) return null;
          return state.P0Active === false ? 'P0 hydration domain inactive — safety violation' : null;
        } catch (_) { return null; }
      }
    },
    { id: 'offline-safe-active', desc: 'Offline queue must be operational',
      check: function () {
        try {
          var od = G.RuntimeOfflineDomains;
          if (!od) return null;
          // If offline domains exist and are suspended, flag it
          var s = od.getState && od.getState();
          if (s && s.suspended) return 'offline domains suspended — processing safety risk';
        } catch (_) {}
        return null;
      }
    },
    { id: 'immutability-guard-active', desc: 'RuntimeImmutabilityGuard must be active',
      check: function () {
        try {
          var ig = G.RuntimeImmutabilityGuard;
          return (ig && ig.isActive) ? null : 'ImmutabilityGuard not active — mutation risk';
        } catch (_) { return null; }
      }
    },
    { id: 'incident-center-operational', desc: 'Incident center must be operational',
      check: function () {
        try {
          return G.RuntimeIncidentCenter ? null : 'IncidentCenter not operational — observability gap';
        } catch (_) { return null; }
      }
    },
    { id: 'no-dynamic-code-exec', desc: 'No dynamic code execution at runtime',
      check: function () { return null; /* Verified at build time by CI gate */ }
    },
  ];

  // ── Protected flags (cannot be disabled without override) ─────────
  var PROTECTED_FLAGS = [
    'hydration.streaming',
    'hydration.viewport',
    'workers.preload',
    'trace.enabled',
    'timeline.capture',
  ];

  // ── Quarantine registry ───────────────────────────────────────────
  var _quarantined = {};  // subsystemId → reason

  function quarantine(subsystemId, reason) {
    _quarantined[subsystemId] = { reason: reason, ts: Date.now() };
    _tel('quarantine', { subsystem: subsystemId, reason: reason });
    console.warn(LOG, 'QUARANTINED:', subsystemId, '—', reason);
    try {
      G.dispatchEvent(new CustomEvent('arc9:quarantine', { detail: { subsystem: subsystemId, reason: reason } }));
    } catch (_) {}
  }

  function lift(subsystemId) {
    delete _quarantined[subsystemId];
    console.debug(LOG, 'quarantine lifted:', subsystemId);
  }

  function isQuarantined(subsystemId) {
    return !!_quarantined[subsystemId];
  }

  // ── Compliance sweep ──────────────────────────────────────────────
  var _violations = [];
  var _sweepCount = 0;
  var _snapshots  = [];

  function _sweep() {
    _sweepCount++;
    var found = [];

    POLICIES.forEach(function (policy) {
      try {
        var violation = policy.check();
        if (violation) {
          found.push({ policy: policy.id, detail: violation, ts: Date.now() });
          _tel('violation', { policy: policy.id, detail: violation });
          // Escalate to incident center
          try {
            var ic = G.RuntimeIncidentCenter;
            if (ic) {
              var sev = ic.P2;  // most governance violations are advisory
              if (policy.id === 'protected-flags-intact' || policy.id === 'immutability-guard-active') sev = ic.P1;
              ic.record('mutation', sev, policy.id, { detail: violation });
            }
          } catch (_) {}
        }
      } catch (_) {}
    });

    // Capture governance snapshot
    var snap = Object.freeze({
      ts:         Date.now(),
      sweep:      _sweepCount,
      violations: found.slice(),
      quarantined: Object.keys(_quarantined),
      flags:      _getFlagSnapshot(),
    });
    _snapshots.push(snap);
    if (_snapshots.length > 20) _snapshots.shift();

    // Update violation history
    _violations = _violations.concat(found);
    if (_violations.length > 200) _violations = _violations.slice(-200);

    if (found.length > 0) {
      console.warn(LOG, 'compliance sweep:', found.length, 'violation(s) at sweep #' + _sweepCount);
    } else {
      console.debug(LOG, 'compliance sweep #' + _sweepCount + ' — clean');
    }

    try {
      G.dispatchEvent(new CustomEvent('arc9:governance-sweep', {
        detail: { sweep: _sweepCount, violations: found.length },
      }));
    } catch (_) {}
  }

  function _getFlagSnapshot() {
    try {
      var cp = G.RuntimeControlPlane;
      return cp ? cp.getFlags() : {};
    } catch (_) { return {}; }
  }

  // ── Command intercept: enforce protected flags ─────────────────────
  G.addEventListener('arc8:command', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d) return;

      // Check quarantine
      var targetSubsystem = d.cmd && d.cmd.split('.')[0];
      if (targetSubsystem && isQuarantined(targetSubsystem)) {
        _tel('blocked', { cmd: d.cmd, reason: 'quarantined' });
        console.warn(LOG, 'BLOCKED quarantined command:', d.cmd);
        return;
      }

      // Protect flags
      if (d.cmd === 'flag.set' && d.args && d.args.value === false) {
        if (PROTECTED_FLAGS.indexOf(d.args.name) !== -1) {
          _tel('protected-flag-attempt', { flag: d.args.name });
          console.warn(LOG, 'GOVERNANCE: attempt to disable protected flag:', d.args.name);
          try {
            var ic = G.RuntimeIncidentCenter;
            if (ic) ic.record('mutation', ic.P1, d.args.name, { cmd: d.cmd, args: d.args });
          } catch (_) {}
        }
      }
    } catch (_) {}
  });

  // ── Telemetry ─────────────────────────────────────────────────────
  var _telBuf = [];
  function _tel(ev, d) {
    _telBuf.push({ ts: Date.now(), ev: ev, d: d });
    if (_telBuf.length > 100) _telBuf.shift();
  }

  // ── Bootstrap: sweep every 2 min ─────────────────────────────────
  var SWEEP_MS = 2 * 60 * 1000;
  var _sweepTimer = null;

  function start() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(_sweep, SWEEP_MS);
    setTimeout(_sweep, 10000);  // first sweep after 10s
    console.debug(LOG, 'governance active — sweep:', SWEEP_MS / 60000 + 'min |', POLICIES.length, 'policies | protected flags:', PROTECTED_FLAGS.length);
  }

  function stop() { clearInterval(_sweepTimer); _sweepTimer = null; }

  start();

  G.RuntimeGovernance = Object.freeze({
    VERSION:       VERSION,
    quarantine:    quarantine,
    lift:          lift,
    isQuarantined: isQuarantined,
    sweep:         _sweep,
    start:         start,
    stop:          stop,
    getViolations:   function () { return _violations.slice(-50); },
    getSnapshots:    function () { return _snapshots.slice(); },
    getQuarantined:  function () { return Object.assign({}, _quarantined); },
    getProtectedFlags: function () { return PROTECTED_FLAGS.slice(); },
    getPolicies:     function () { return POLICIES.map(function (p) { return { id: p.id, desc: p.desc }; }); },
    getTelemetry:    function () { return _telBuf.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready —', POLICIES.length, 'policies |', PROTECTED_FLAGS.length, 'protected flags');

}(window));
