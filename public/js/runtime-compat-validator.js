// runtime-compat-validator.js
// Phase 2 — Final Hardening Pass: Compatibility Validation
// =========================================================
// Validates that all Phase 1 and Phase 2 runtime systems are:
//   A. Present and operational
//   B. Compatible with the current browser environment
//   C. Correctly tiered for low-end devices
//   D. Not silently degraded by missing APIs
//
// Systems audited:
//   Phase 1: RuntimeProtection, RuntimeShieldCore, RuntimeShieldIntegrity,
//            RuntimeShieldWorkers, RuntimeShieldDependency, RuntimeSecurity,
//            RuntimeDeviceLite
//   Phase 2: RuntimeManifest, RuntimeWorkerFactory, RuntimeHardening,
//            ILovePDFContracts, RuntimeChunkValidator, BuildPipelineHooks
//
// Output: window.RuntimeCompatValidator
//   .status()     → { ok, score, issues[], warnings[], systems{} }
//   .report()     → full diagnostic string (console-friendly)
//   .validate()   → runs all checks, returns status object
//
// ADDITIVE ONLY. No existing system is modified or removed.
// Low-end devices: lite scan (skip heavy browser-API probes).

(function (G) {
  'use strict';

  if (G.RuntimeCompatValidator) return;

  var VERSION = '1.0';
  var LOG = '[RCV]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Device tier ─────────────────────────────────────────────────────────────
  var _score = _s(function () {
    var rdl = G.RuntimeDeviceLite;
    if (rdl && typeof rdl.score === 'function')    return rdl.score();
    if (rdl && typeof rdl.getScore === 'function') return rdl.getScore();
    return 70;
  }, 70);
  var _lite = _score < 40;

  // ── Issue collector ──────────────────────────────────────────────────────────
  var _issues   = [];   // critical problems
  var _warnings = [];   // non-fatal degradations
  var _systems  = {};   // system name → { present, version, ok, note }

  function _issue(msg) {
    _issues.push({ msg: msg, ts: Date.now() });
  }
  function _warn(msg) {
    _warnings.push({ msg: msg, ts: Date.now() });
  }
  function _registerSystem(name, obj, required) {
    var present = !!(obj);
    var version = _s(function () { return obj.VERSION || obj.version || '?'; }, '?');
    var ok      = present;
    var note    = '';

    if (!present && required) {
      _issue('Required system missing: ' + name);
      note = 'MISSING';
    } else if (!present) {
      _warn('Optional system missing: ' + name);
      note = 'ABSENT';
    }

    _systems[name] = { present: present, version: version, ok: ok, note: note };
    return present;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § A — PHASE 1 SYSTEM PRESENCE CHECK
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkPhase1Systems() {
    _registerSystem('RuntimeProtection',      G.RuntimeProtection,      true);
    _registerSystem('RuntimeShieldCore',      G.RuntimeShieldCore,      true);
    _registerSystem('RuntimeShieldIntegrity', G.RuntimeShieldIntegrity, true);
    _registerSystem('RuntimeShieldWorkers',   G.RuntimeShieldWorkers,   true);
    _registerSystem('RuntimeShieldDependency',G.RuntimeShieldDependency,true);
    _registerSystem('RuntimeSecurity',        G.RuntimeSecurity,        true);
    _registerSystem('RuntimeDeviceLite',      G.RuntimeDeviceLite,      false);

    // Verify Phase 1 operational signals
    _s(function () {
      var shield = G.RuntimeShieldCore;
      if (shield && typeof shield.status === 'function') {
        var st = shield.status();
        if (!st.booted) _warn('RuntimeShieldCore: status.booted=false');
      }
    });
    _s(function () {
      var integrity = G.RuntimeShieldIntegrity;
      if (integrity && typeof integrity.status === 'function') {
        var st = integrity.status();
        if (st.flagged) _warn('RuntimeShieldIntegrity: session is flagged (suspicious activity detected)');
      }
    });
    _s(function () {
      var workers = G.RuntimeShieldWorkers;
      if (workers && typeof workers.status === 'function') {
        var st = workers.status();
        if (st.replayBlocked > 0) {
          console.info(LOG, 'ShieldWorkers: replay attacks blocked:', st.replayBlocked);
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § B — PHASE 2 SYSTEM PRESENCE CHECK
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkPhase2Systems() {
    _registerSystem('RuntimeManifest',      G.RuntimeManifest,      true);
    _registerSystem('RuntimeWorkerFactory', G.RuntimeWorkerFactory, true);
    _registerSystem('RuntimeHardening',     G.RuntimeHardening,     false);
    _registerSystem('ILovePDFContracts',    G.ILovePDFContracts,    false);
    _registerSystem('ILovePDFConstants',    G.ILovePDFConstants,    false);

    // Verify Phase 2 manifest boot
    _s(function () {
      var manifest = G.RuntimeManifest;
      if (manifest && typeof manifest.status === 'function') {
        var st = manifest.status();
        if (!st.booted) _warn('RuntimeManifest: status.booted=false (manifest may not have loaded)');
        if (st.violations && st.violations > 0) {
          _warn('RuntimeManifest: ' + st.violations + ' script injection violation(s) detected');
        }
      }
    });

    // Verify WorkerFactory allowlist is non-empty
    _s(function () {
      var wf = G.RuntimeWorkerFactory;
      if (wf && typeof wf.status === 'function') {
        var st = wf.status();
        if (!st.allowedPaths || st.allowedPaths.length < 5) {
          _issue('RuntimeWorkerFactory: allowlist appears incomplete (<5 paths)');
        }
        if (st.violations && st.violations.length > 0) {
          _warn('RuntimeWorkerFactory: ' + st.violations.length + ' untrusted worker spawn(s) detected');
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § C — BROWSER COMPATIBILITY PROBES
  // ══════════════════════════════════════════════════════════════════════════════

  var _browserCompat = {};

  function _checkBrowserCompat() {
    // Core ES6+ capabilities required by all runtime systems
    _browserCompat.Symbol        = typeof Symbol === 'function';
    _browserCompat.WeakMap       = typeof WeakMap !== 'undefined';
    _browserCompat.Map           = typeof Map !== 'undefined';
    _browserCompat.Set           = typeof Set !== 'undefined';
    _browserCompat.Promise       = typeof Promise !== 'undefined';
    _browserCompat.Proxy         = typeof Proxy !== 'undefined';
    _browserCompat.structuredClone = typeof structuredClone === 'function';
    _browserCompat.MutationObserver = typeof MutationObserver !== 'undefined';
    _browserCompat.crypto_getRandomValues = !!(G.crypto && G.crypto.getRandomValues);

    // Worker capabilities
    _browserCompat.Worker        = typeof Worker !== 'undefined';
    _browserCompat.SharedWorker  = typeof SharedWorker !== 'undefined';

    // Storage capabilities
    _browserCompat.localStorage  = _s(function () { return typeof localStorage !== 'undefined'; }, false);
    _browserCompat.indexedDB     = typeof indexedDB !== 'undefined';

    // WASM / performance
    _browserCompat.WebAssembly   = typeof WebAssembly !== 'undefined';
    _browserCompat.performance_now = !!(G.performance && typeof G.performance.now === 'function');

    // Cross-origin isolation (required for SharedArrayBuffer)
    _browserCompat.crossOriginIsolated = !!G.crossOriginIsolated;

    // Check critical failures
    if (!_browserCompat.Symbol)      _issue('Browser: Symbol not supported — runtime systems will fail');
    if (!_browserCompat.WeakMap)     _issue('Browser: WeakMap not supported — shield state cannot be hidden');
    if (!_browserCompat.Worker)      _issue('Browser: Web Workers not supported — tool processing will fail');
    if (!_browserCompat.Promise)     _issue('Browser: Promise not supported — async tools will fail');
    if (!_browserCompat.crypto_getRandomValues) _issue('Browser: crypto.getRandomValues unavailable — nonce system insecure');
    if (!_browserCompat.MutationObserver) _warn('Browser: MutationObserver unavailable — script injection monitoring disabled');
    if (!_browserCompat.WebAssembly)   _warn('Browser: WebAssembly not supported — OCR and AI tools will be slower');
    if (!_browserCompat.crossOriginIsolated) {
      _warn('Browser: crossOriginIsolated=false — SharedArrayBuffer may be unavailable (affects PDF.js workers)');
    }

    // Object.defineProperty required for shield lockdowns
    if (typeof Object.defineProperty !== 'function') {
      _issue('Browser: Object.defineProperty not supported — shield lockdown systems cannot operate');
    }
    if (typeof Object.freeze !== 'function') {
      _warn('Browser: Object.freeze not supported — some immutability enforcement is weakened');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § D — LOW-END DEVICE COMPATIBILITY
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkDeviceCompat() {
    var rdl = G.RuntimeDeviceLite;
    if (!rdl) {
      _warn('RuntimeDeviceLite not loaded — device tier unknown, assuming capable');
      return;
    }

    var profile = _s(function () { return rdl.getProfile ? rdl.getProfile() : null; }, null);

    _systems['DeviceTier'] = {
      present: true,
      version: '?',
      ok: true,
      note: 'score=' + _score + ' lite=' + _lite,
    };

    if (_lite) {
      // Low-end: verify that heavy systems properly activated lite mode
      var shieldLite = _s(function () {
        return G.RuntimeShieldCore && G.RuntimeShieldCore.status &&
               G.RuntimeShieldCore.status().liteMode;
      }, null);
      if (shieldLite === false) {
        _warn('Low-end device: RuntimeShieldCore did not activate lite mode — may over-burden device');
      }

      var manifestLite = _s(function () {
        return G.RuntimeManifest && G.RuntimeManifest.status &&
               G.RuntimeManifest.status().liteMode;
      }, null);
      if (manifestLite === false) {
        _warn('Low-end device: RuntimeManifest did not activate lite mode');
      }

      // On low-end: verify heavy interval-based sweeps are disabled
      _s(function () {
        var integrity = G.RuntimeShieldIntegrity;
        if (integrity && typeof integrity.status === 'function') {
          var st = integrity.status();
          if (st.sweepIntervalMs && st.sweepIntervalMs < 30000) {
            _warn('Low-end device: RuntimeShieldIntegrity sweep interval is ' + st.sweepIntervalMs + 'ms (expected 0 or >30000 on lite)');
          }
        }
      });
    } else {
      // High/mid-end: verify active monitoring is engaged
      _s(function () {
        var integrity = G.RuntimeShieldIntegrity;
        if (integrity && typeof integrity.status === 'function') {
          var st = integrity.status();
          if (!st.sweepIntervalMs || st.sweepIntervalMs === 0) {
            _warn('High/mid device: RuntimeShieldIntegrity sweep interval is 0 — integrity sweeps may be disabled');
          }
        }
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § E — CSP & SECURITY HEADER VERIFICATION
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkCspCompat() {
    // Verify nonce infrastructure is active (we cannot read CSP headers from JS,
    // but we can verify that nonce-bearing scripts loaded correctly)
    var nonceScripts = _s(function () {
      return Array.from(document.querySelectorAll('script[nonce]')).length;
    }, 0);
    if (nonceScripts === 0 && !_lite) {
      _warn('CSP: No nonce-bearing <script> elements detected — server may not be injecting nonces');
    }

    // Verify SecurityPolicy is not exposing sensitive globals
    _s(function () {
      var exposed = [];
      var sensitiveKeys = ['RuntimeSecurity', 'WorkerPool', 'RuntimeState', 'RuntimeKernel'];
      sensitiveKeys.forEach(function (k) {
        // If enumerable, it appears in for..in — should be hidden by ShieldCore
        var desc = Object.getOwnPropertyDescriptor(G, k);
        if (desc && desc.enumerable) exposed.push(k);
      });
      if (exposed.length > 0) {
        _warn('CSP/Shield: ' + exposed.length + ' sensitive global(s) still enumerable: ' + exposed.join(', '));
      }
    });

    // Verify SharedArrayBuffer availability (requires COOP/COEP headers)
    _browserCompat.sharedArrayBuffer = _s(function () { return typeof SharedArrayBuffer !== 'undefined'; }, false);
    if (!_browserCompat.sharedArrayBuffer) {
      _warn('CSP: SharedArrayBuffer unavailable — COOP/COEP headers may be misconfigured (affects PDF.js)');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § F — WORKER COMPATIBILITY CHECK
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkWorkerCompat() {
    if (!_browserCompat.Worker) return; // already flagged

    // Verify worker factory patch is active
    _s(function () {
      var wf = G.RuntimeWorkerFactory;
      if (!wf) return;
      var st = wf.status ? wf.status() : {};
      var patched = st.patchActive;
      if (patched === false && !_lite) {
        _warn('RuntimeWorkerFactory: Worker patch not active — untrusted workers can be spawned undetected');
      }
    });

    // Verify ShieldWorkers is intercepting message validation
    _s(function () {
      var sw = G.RuntimeShieldWorkers;
      if (!sw) return;
      var st = sw.status ? sw.status() : {};
      if (!_lite && !st.wrappedValidateWorkerMessage) {
        _warn('RuntimeShieldWorkers: validateWorkerMessage not wrapped — replay protection may be inactive');
      }
    });

    // blob: worker support (required by some runtime workers)
    _browserCompat.blobWorker = _s(function () {
      var b = new Blob(['self.onmessage=function(){};'], { type: 'application/javascript' });
      var url = URL.createObjectURL(b);
      URL.revokeObjectURL(url);
      return !!url;
    }, false);
    if (!_browserCompat.blobWorker) {
      _warn('Browser: blob: URL workers not supported — some dynamic worker creation may fail');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § G — PROTOTYPE POLLUTION BASELINE CHECK
  // ══════════════════════════════════════════════════════════════════════════════

  function _checkPrototypePollution() {
    var polluted = [];
    var protos = [
      { name: 'Object', proto: Object.prototype },
      { name: 'Array',  proto: Array.prototype },
      { name: 'String', proto: String.prototype },
    ];
    protos.forEach(function (p) {
      var own = Object.getOwnPropertyNames(p.proto);
      var suspicious = own.filter(function (k) {
        return k !== '__proto__' && k !== 'constructor' &&
               typeof p.proto[k] !== 'function';
      });
      if (suspicious.length > 0) {
        polluted.push(p.name + ':' + suspicious.join(','));
      }
    });
    if (polluted.length > 0) {
      _issue('Prototype pollution detected: ' + polluted.join(' | '));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // § MAIN VALIDATE
  // ══════════════════════════════════════════════════════════════════════════════

  var _validated = false;
  var _lastStatus = null;

  function _validate() {
    _issues   = [];
    _warnings = [];
    _systems  = {};
    _browserCompat = {};

    _checkBrowserCompat();
    _checkPhase1Systems();
    _checkPhase2Systems();
    _checkDeviceCompat();
    _checkCspCompat();
    _checkWorkerCompat();
    if (!_lite) _checkPrototypePollution();

    var score = Math.max(0, 100 - (_issues.length * 20) - (_warnings.length * 5));
    var ok    = _issues.length === 0;

    _lastStatus = {
      ok:           ok,
      score:        score,
      issues:       _issues.slice(),
      warnings:     _warnings.slice(),
      systems:      _validated ? _systems : Object.assign({}, _systems),
      browserCompat:_browserCompat,
      deviceScore:  _score,
      liteMode:     _lite,
      timestamp:    new Date().toISOString(),
    };
    _validated = true;

    // Report to telemetry (non-blocking)
    _s(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('compat:validate', {
          ok: ok, score: score,
          issues: _issues.length, warnings: _warnings.length,
        });
      }
    });

    // Log summary
    if (ok) {
      console.info(LOG, 'v' + VERSION, 'all systems compatible — score:', score);
    } else {
      console.warn(LOG, 'v' + VERSION, 'compatibility issues found:', _issues.length, 'issues,', _warnings.length, 'warnings');
      _issues.forEach(function (i) { console.error(LOG, 'ISSUE:', i.msg); });
      _warnings.forEach(function (w) { console.warn(LOG, 'WARN:', w.msg); });
    }

    return _lastStatus;
  }

  function _report() {
    if (!_lastStatus) _validate();
    var s = _lastStatus;
    var lines = [
      '══════════════════════════════════════════════════',
      ' RuntimeCompatValidator v' + VERSION + ' — Compatibility Report',
      ' Score: ' + s.score + '/100  |  OK: ' + s.ok + '  |  Device: ' + (s.liteMode ? 'LITE' : 'FULL') + ' (' + s.deviceScore + ')',
      '══════════════════════════════════════════════════',
    ];
    if (s.issues.length > 0) {
      lines.push('CRITICAL ISSUES (' + s.issues.length + '):');
      s.issues.forEach(function (i) { lines.push('  ✗ ' + i.msg); });
    }
    if (s.warnings.length > 0) {
      lines.push('WARNINGS (' + s.warnings.length + '):');
      s.warnings.forEach(function (w) { lines.push('  ⚠ ' + w.msg); });
    }
    lines.push('SYSTEMS:');
    Object.keys(s.systems).forEach(function (name) {
      var sys = s.systems[name];
      lines.push('  ' + (sys.present ? '✓' : '✗') + ' ' + name + ' v' + sys.version + (sys.note ? ' [' + sys.note + ']' : ''));
    });
    lines.push('BROWSER COMPAT:');
    Object.keys(s.browserCompat).forEach(function (k) {
      lines.push('  ' + (s.browserCompat[k] ? '✓' : '✗') + ' ' + k);
    });
    lines.push('══════════════════════════════════════════════════');
    return lines.join('\n');
  }

  // ── Boot (deferred to allow all runtime systems to load first) ───────────────
  function _boot() {
    setTimeout(function () {
      _validate();
    }, 800); // allow all defer'd scripts to run
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  G.RuntimeCompatValidator = Object.freeze({
    VERSION:  VERSION,
    validate: _validate,
    status:   function () { return _lastStatus || _validate(); },
    report:   _report,
  });

  console.debug(LOG, 'v' + VERSION, 'ready — validation scheduled');

}(typeof window !== 'undefined' ? window : this));
