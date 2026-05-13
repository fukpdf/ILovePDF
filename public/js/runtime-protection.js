/**
 * runtime-protection.js — Core Runtime Hardening System v1.0.0
 *
 * PHASES IMPLEMENTED:
 *   B — CORE_RUNTIME registry (immutable references + metadata)
 *   C — Method immutability (writable:false on critical entry points)
 *   D — RuntimeMutationAudit (NOOP detection, replacement tracking)
 *   E — SafeRuntimePatch  (explicit allowlist, ownership, rollback)
 *   G — RuntimeHealth.audit() (full system health dashboard)
 *   H — FFmpeg + OCR lifecycle tracking
 *   I — runProductionStress() (mutation resistance + pool stress)
 *
 * LOAD ORDER: must appear after core runtime modules assign their
 * window.X globals (pdf-preview, task-scheduler, canvas-pool, etc.)
 * Runs _boot() immediately (sync), then re-locks on DOMContentLoaded
 * and load to catch deferred scripts.
 */
(function (G) {
  'use strict';

  var VERSION = '1.0.0';
  var _now    = Date.now;

  // ─────────────────────────────────────────────────────────────────────────
  // § HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  function _ts()  { return new Date().toISOString(); }

  /** Detect NOOP/stub functions (short body, returns falsy/resolved promise). */
  function _isNoop(fn) {
    if (typeof fn !== 'function') return false;
    var s = fn.toString().replace(/[\s\n\r]+/g, '');
    if (s.length > 120) return false;
    return (
      s.includes('returnPromise.resolve') ||
      s.includes('returnPromise.resolve(null)') ||
      s.includes('return false') ||
      s === 'function(){}' ||
      s === '()=>{}' ||
      s === 'function(){return false;}' ||
      /^(async\s*)?function[^{]*\{\s*\}$/.test(s) ||
      /^(async\s*)?\(\)\s*=>\s*\{?\s*\}?$/.test(s)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE D — MUTATION LOG
  // ─────────────────────────────────────────────────────────────────────────

  var _mutations = [];

  function _recordMutation(type, target, method, oldVal, newVal) {
    var entry = {
      type      : type,
      target    : target,
      method    : method || null,
      oldType   : typeof oldVal,
      oldIsNoop : _isNoop(oldVal),
      newType   : typeof newVal,
      newIsNoop : _isNoop(newVal),
      timestamp : _ts(),
      stack     : (new Error()).stack
    };
    _mutations.push(entry);
    var label = target + (method ? '.' + method : '');
    console.error(
      '[RuntimeMutationAudit] ' + type + ' on ' + label,
      '\n  old:', entry.oldType, entry.oldIsNoop ? '(NOOP)' : '',
      '\n  new:', entry.newType, entry.newIsNoop ? '(NOOP)' : '',
      '\n  time:', entry.timestamp,
      '\n  stack:', entry.stack
    );
    var reg = _registry[target];
    if (reg) reg.mutationCount++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE B — CORE RUNTIME REGISTRY
  // ─────────────────────────────────────────────────────────────────────────

  var _registry = Object.create(null);

  /** Canonical list of core production engines. */
  var CORE_GLOBALS = [
    'PdfPreview', 'TaskScheduler', 'CanvasPool', 'WorkerPool',
    'BgAiEngine',  'ObjectURLRegistry', 'MemoryTelemetry',
    'AdaptiveRuntime', 'OcrRuntimeManager', 'BrowserTools',
    'LivePreview', 'StabilityMetrics', 'AdvancedEngine'
  ];

  function _register(name) {
    var obj = G[name];
    if (!obj) return;
    if (_registry[name]) {
      // Re-registration: check for global replacement
      if (_registry[name].ref !== obj) {
        _recordMutation('global-replacement', name, null, _registry[name].ref, obj);
        _registry[name].ref = obj;
      }
      return;
    }
    _registry[name] = {
      name          : name,
      ref           : obj,
      registeredAt  : _now(),
      version       : obj.VERSION || obj.version || null,
      locked        : false,
      mutationCount : 0
    };
  }

  function _registerAll() { CORE_GLOBALS.forEach(_register); }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE C — METHOD IMMUTABILITY
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Critical execution entry points.
   * ONLY functions listed here are locked writable:false.
   * Mutable state objects (stats, counters, queues) are NOT frozen.
   */
  var PROTECTED_METHODS = {
    PdfPreview       : ['renderPage', 'loadDocument', 'cancelRender'],
    TaskScheduler    : ['acquireSlot', 'releaseSlot', 'schedule'],
    CanvasPool       : ['acquireCanvas', 'releaseCanvas'],
    WorkerPool       : ['run', 'acquire', 'release'],
    BgAiEngine       : ['infer', 'process'],
    OcrRuntimeManager: ['recognize', 'cancel'],
    BrowserTools     : ['supports'],
    ObjectURLRegistry: ['create', 'revoke'],
    MemoryTelemetry  : ['getSnapshot'],
    AdaptiveRuntime  : ['getProfile']
  };

  function _lockMethod(obj, globalName, methodName) {
    var current = obj[methodName];
    if (typeof current !== 'function') return;

    // Guard: refuse to lock a NOOP (means it was already patched before us)
    if (_isNoop(current)) {
      console.error(
        '[RuntimeProtection] PRE-LOCK CONTAMINATION: ' + globalName + '.' + methodName +
        ' is already a NOOP at lock time. Locking aborted for this method — investigate load order.'
      );
      _recordMutation('pre-lock-contamination', globalName, methodName, null, current);
      return;
    }

    try {
      Object.defineProperty(obj, methodName, {
        configurable : false,
        writable     : false,
        enumerable   : true,
        value        : current
      });
    } catch (e) {
      // Already non-configurable — this is fine
    }
  }

  function _lockGlobal(name) {
    var obj = G[name];
    if (!obj) return;
    var methods = PROTECTED_METHODS[name];
    if (!methods) return;
    methods.forEach(function (m) { _lockMethod(obj, name, m); });
    if (_registry[name]) _registry[name].locked = true;
  }

  function _lockAll() {
    Object.keys(PROTECTED_METHODS).forEach(_lockGlobal);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE E — SAFE PATCH SYSTEM
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Explicit allowlist: only these method slots may be wrapped
   * via SafeRuntimePatch. Everything else is rejected.
   */
  var PATCH_ALLOWLIST = {
    BrowserTools : ['process']   // phase26-36 enhancers legitimately wrap this
  };

  var _patches = [];

  function SafeRuntimePatch(owner, targetName, methodName, wrapperFn) {
    if (!owner || !targetName || !methodName || typeof wrapperFn !== 'function') {
      console.error('[SafeRuntimePatch] Invalid arguments — owner, targetName, methodName, wrapperFn all required.');
      return null;
    }
    var allowed = PATCH_ALLOWLIST[targetName];
    if (!allowed || allowed.indexOf(methodName) === -1) {
      console.error('[SafeRuntimePatch] REJECTED: ' + targetName + '.' + methodName +
                    ' is not in the patch allowlist. Use events or safe APIs instead of direct patching.');
      return null;
    }
    var dup = _patches.filter(function (p) {
      return p.owner === owner && p.target === targetName && p.method === methodName;
    })[0];
    if (dup) {
      console.warn('[SafeRuntimePatch] Duplicate patch rejected: ' + owner +
                   ' already owns a patch on ' + targetName + '.' + methodName);
      return null;
    }
    var obj = G[targetName];
    if (!obj)                         { console.error('[SafeRuntimePatch] window.' + targetName + ' not found'); return null; }
    if (typeof obj[methodName] !== 'function') { console.error('[SafeRuntimePatch] ' + targetName + '.' + methodName + ' is not a function'); return null; }

    var orig    = obj[methodName];
    var patched = wrapperFn(orig);
    if (typeof patched !== 'function') { console.error('[SafeRuntimePatch] wrapperFn must return a function'); return null; }

    obj[methodName] = patched;
    var entry = { owner: owner, target: targetName, method: methodName, orig: orig, patched: patched, at: _now() };
    _patches.push(entry);
    console.log('[SafeRuntimePatch] ' + owner + ' patched ' + targetName + '.' + methodName + ' — owner chain length: ' + _patches.filter(function(p){return p.target===targetName&&p.method===methodName;}).length);

    return {
      rollback: function () {
        obj[methodName] = orig;
        _patches = _patches.filter(function (p) { return p !== entry; });
        console.log('[SafeRuntimePatch] Rolled back: ' + owner + ' → ' + targetName + '.' + methodName);
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE H — FFMPEG + OCR LIFECYCLE TRACKING
  // ─────────────────────────────────────────────────────────────────────────

  var _ffmpegInstances = [];

  function _trackFFmpeg() {
    ['FFmpeg', 'createFFmpeg'].forEach(function (name) {
      var orig = G[name];
      if (typeof orig !== 'function') return;
      G[name] = function () {
        var inst = orig.apply(this, arguments);
        _ffmpegInstances.push({ created: _now(), ref: inst, terminated: false });
        console.log('[RuntimeProtection] FFmpeg instance tracked. Total: ' + _ffmpegInstances.length);
        var origTerm = inst && inst.terminate;
        if (typeof origTerm === 'function') {
          inst.terminate = function () {
            var r = origTerm.apply(this, arguments);
            var entry = _ffmpegInstances.filter(function(f){ return f.ref === inst; })[0];
            if (entry) entry.terminated = true;
            return r;
          };
        }
        return inst;
      };
    });
  }

  function _ffmpegAudit() {
    var alive    = _ffmpegInstances.filter(function (f) { return !f.terminated; }).length;
    var dead     = _ffmpegInstances.filter(function (f) { return  f.terminated; }).length;
    var zombies  = _ffmpegInstances.filter(function (f) {
      return !f.terminated && (_now() - f.created) > 120000;
    });
    if (zombies.length) {
      console.warn('[RuntimeProtection] ' + zombies.length + ' potentially zombie FFmpeg instance(s) (alive >120s, not terminated)');
    }
    return { total: _ffmpegInstances.length, alive: alive, terminated: dead, potentialZombies: zombies.length };
  }

  function _ocrAudit() {
    try {
      if (G.OcrRuntimeManager && G.OcrRuntimeManager.getStats) {
        return G.OcrRuntimeManager.getStats();
      }
    } catch (_) {}
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE G — RUNTIME HEALTH DASHBOARD
  // ─────────────────────────────────────────────────────────────────────────

  function _audit() {
    var report = {
      timestamp      : _ts(),
      version        : VERSION,
      protectedGlobals: {},
      mutations      : _mutations.slice(),
      mutationCount  : _mutations.length,
      activePatches  : _patches.map(function (p) {
        return { owner: p.owner, target: p.target, method: p.method, at: p.at };
      }),
      scheduler      : null,
      canvasPool     : null,
      objectURLs     : null,
      memory         : null,
      adaptiveRuntime: null,
      ocr            : null,
      ffmpeg         : _ffmpegAudit(),
      workers        : _workerAudit()
    };

    // Protected global integrity check
    CORE_GLOBALS.forEach(function (name) {
      var entry = _registry[name];
      if (!entry) { report.protectedGlobals[name] = { registered: false }; return; }
      var current  = G[name];
      var intact   = (current === entry.ref);
      report.protectedGlobals[name] = {
        registered    : true,
        locked        : entry.locked,
        mutationCount : entry.mutationCount,
        globalIntact  : intact,
        version       : entry.version
      };
      if (!intact) {
        console.error('[RuntimeHealth] GLOBAL REPLACEMENT: window.' + name + ' was swapped after registration!');
        _recordMutation('global-replacement', name, null, entry.ref, current);
      }
    });

    // Method NOOP scan
    var noopMethods = [];
    Object.keys(PROTECTED_METHODS).forEach(function (gname) {
      var obj = G[gname];
      if (!obj) return;
      PROTECTED_METHODS[gname].forEach(function (m) {
        if (obj[m] && _isNoop(obj[m])) {
          noopMethods.push(gname + '.' + m);
          console.error('[RuntimeHealth] NOOP DETECTED: ' + gname + '.' + m + ' is a no-op at audit time!');
        }
      });
    });
    report.noopMethods = noopMethods;

    // System stats
    try { if (G.TaskScheduler)     report.scheduler       = G.TaskScheduler.stats();       } catch (_) {}
    try { if (G.CanvasPool)        report.canvasPool      = G.CanvasPool.stats();           } catch (_) {}
    try { if (G.ObjectURLRegistry) report.objectURLs      = G.ObjectURLRegistry.stats();   } catch (_) {}
    try { if (G.MemoryTelemetry)   report.memory          = G.MemoryTelemetry.getSnapshot();} catch (_) {}
    try { if (G.AdaptiveRuntime)   report.adaptiveRuntime = G.AdaptiveRuntime.stats();     } catch (_) {}
    report.ocr = _ocrAudit();

    return report;
  }

  function _workerAudit() {
    var out = { poolStats: null, leaked: [] };
    try { if (G.WorkerPool && G.WorkerPool.stats)             out.poolStats = G.WorkerPool.stats();           } catch (_) {}
    try { if (G.WorkerLeakDetector && G.WorkerLeakDetector.getLeaks) out.leaked = G.WorkerLeakDetector.getLeaks(); } catch (_) {}
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § PHASE I — PRODUCTION STRESS TEST
  // ─────────────────────────────────────────────────────────────────────────

  async function runProductionStress() {
    console.group('[StressTest] Production stress starting — v' + VERSION);
    var results = {
      started          : _ts(),
      rounds           : [],
      runtimeCorruption: 0,
      mutationLeaks    : 0,
      mutationBlocked  : 0,
      registryIntact   : true
    };

    /* ── Round 1: Scheduler slot acquire/release ── */
    try {
      if (G.TaskScheduler && G.TaskScheduler.acquireSlot) {
        var slots = [];
        for (var i = 0; i < 8; i++) {
          try {
            var s = await G.TaskScheduler.acquireSlot('stress-test', 'medium');
            if (s) slots.push(s);
          } catch (_) {}
        }
        slots.forEach(function (s) { try { G.TaskScheduler.releaseSlot(s); } catch (_) {} });
        results.rounds.push({ name: 'scheduler-slots', acquired: slots.length, released: slots.length, ok: true });
      } else {
        results.rounds.push({ name: 'scheduler-slots', ok: false, reason: 'TaskScheduler not available' });
      }
    } catch (e) {
      results.rounds.push({ name: 'scheduler-slots', ok: false, error: e.message });
    }

    /* ── Round 2: Canvas pool acquire/release ── */
    try {
      if (G.CanvasPool && G.CanvasPool.acquireCanvas) {
        var canvases = [];
        for (var j = 0; j < 6; j++) {
          try { var c = G.CanvasPool.acquireCanvas(128, 128); if (c) canvases.push(c); } catch (_) {}
        }
        canvases.forEach(function (c) { try { G.CanvasPool.releaseCanvas(c); } catch (_) {} });
        results.rounds.push({ name: 'canvas-pool', acquired: canvases.length, released: canvases.length, ok: true });
      } else {
        results.rounds.push({ name: 'canvas-pool', ok: false, reason: 'CanvasPool not available' });
      }
    } catch (e) {
      results.rounds.push({ name: 'canvas-pool', ok: false, error: e.message });
    }

    /* ── Round 3: ObjectURL create/revoke ── */
    try {
      if (G.ObjectURLRegistry && G.ObjectURLRegistry.create) {
        var blob = new Blob(['stress-test'], { type: 'text/plain' });
        var urls = [];
        for (var k = 0; k < 5; k++) {
          try { var u = G.ObjectURLRegistry.create(blob, 'stress-test'); if (u) urls.push(u); } catch (_) {}
        }
        try { G.ObjectURLRegistry.revokeOwner('stress-test'); } catch (_) {}
        results.rounds.push({ name: 'object-urls', created: urls.length, revoked: 'batch', ok: true });
      } else {
        results.rounds.push({ name: 'object-urls', ok: false, reason: 'ObjectURLRegistry not available' });
      }
    } catch (e) {
      results.rounds.push({ name: 'object-urls', ok: false, error: e.message });
    }

    /* ── Round 4: NOOP contamination scan ── */
    Object.keys(PROTECTED_METHODS).forEach(function (gname) {
      var obj = G[gname];
      if (!obj) return;
      PROTECTED_METHODS[gname].forEach(function (m) {
        if (typeof obj[m] === 'function' && _isNoop(obj[m])) {
          results.runtimeCorruption++;
          console.error('[StressTest] CORRUPTION: ' + gname + '.' + m + ' is a NOOP!');
        }
      });
    });
    results.rounds.push({ name: 'noop-scan', corrupted: results.runtimeCorruption, ok: results.runtimeCorruption === 0 });

    /* ── Round 5: Monkey-patch resistance (attempt to overwrite locked methods) ── */
    var attempts = 0;
    Object.keys(PROTECTED_METHODS).forEach(function (gname) {
      var obj = G[gname];
      if (!obj) return;
      PROTECTED_METHODS[gname].forEach(function (m) {
        if (typeof obj[m] !== 'function') return;
        var before = obj[m];
        attempts++;
        try {
          obj[m] = function STRESS_NOOP_INJECTED() { return Promise.resolve('CORRUPTED'); };
          if (obj[m] !== before) {
            results.mutationLeaks++;
            console.error('[StressTest] MUTATION LEAK: ' + gname + '.' + m + ' was writable — not locked!');
            obj[m] = before; // restore
          } else {
            results.mutationBlocked++;
          }
        } catch (_) {
          results.mutationBlocked++; // TypeError: Cannot assign to read-only — correct behaviour
        }
      });
    });
    results.rounds.push({
      name          : 'mutation-resistance',
      attempts      : attempts,
      blocked       : results.mutationBlocked,
      leaked        : results.mutationLeaks,
      ok            : results.mutationLeaks === 0
    });

    /* ── Round 6: Global registry integrity ── */
    var replacements = 0;
    CORE_GLOBALS.forEach(function (name) {
      var entry = _registry[name];
      if (entry && G[name] !== entry.ref) {
        replacements++;
        console.error('[StressTest] GLOBAL REPLACED: window.' + name);
      }
    });
    results.registryIntact = (replacements === 0);
    results.rounds.push({ name: 'registry-integrity', replacements: replacements, ok: results.registryIntact });

    /* ── Round 7: Memory telemetry ── */
    try {
      if (G.MemoryTelemetry) {
        var snap = G.MemoryTelemetry.getSnapshot();
        results.rounds.push({ name: 'memory-telemetry', ok: !!snap, usedMB: snap && snap.usedMB });
      }
    } catch (e) {
      results.rounds.push({ name: 'memory-telemetry', ok: false, error: e.message });
    }

    results.finished = _ts();

    console.log('[StressTest] SUMMARY');
    console.table(results.rounds);
    console.log('Runtime corruption :', results.runtimeCorruption);
    console.log('Mutations blocked  :', results.mutationBlocked, '/', attempts);
    console.log('Mutations leaked   :', results.mutationLeaks);
    console.log('Registry intact    :', results.registryIntact);
    console.groupEnd();

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // § BOOT
  // ─────────────────────────────────────────────────────────────────────────

  function _boot() {
    _registerAll();
    _lockAll();
    _trackFFmpeg();
    var locked = Object.keys(PROTECTED_METHODS).reduce(function (n, k) {
      return n + PROTECTED_METHODS[k].length;
    }, 0);
    console.log(
      '[RuntimeProtection] v' + VERSION + ' active' +
      ' | globals registered: ' + Object.keys(_registry).length +
      ' | methods locked: ' + locked
    );
  }

  _boot();
  document.addEventListener('DOMContentLoaded', function () {
    _registerAll();
    _lockAll();
    console.log('[RuntimeProtection] Post-DOMContentLoaded re-lock complete');
  });
  window.addEventListener('load', function () {
    _registerAll();
    _lockAll();
    console.log('[RuntimeProtection] Post-load re-lock complete — running initial health check');
    var h = _audit();
    if (h.noopMethods.length) {
      console.error('[RuntimeProtection] POST-LOAD NOOP METHODS DETECTED:', h.noopMethods);
    }
    if (h.mutationCount) {
      console.warn('[RuntimeProtection] ' + h.mutationCount + ' mutation(s) recorded during page load');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // § PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  /** Immutable registry of core production engines. */
  G.CORE_RUNTIME = _registry;

  /** Mutation event log + report. */
  G.RuntimeMutationAudit = {
    getReport : function () { return { mutations: _mutations.slice(), count: _mutations.length }; },
    clear     : function () { _mutations = []; },
    isNoop    : _isNoop
  };

  /** Safe, audited patching of allowlisted method slots. */
  G.SafeRuntimePatch = SafeRuntimePatch;

  /** Full system health dashboard. */
  G.RuntimeHealth = {
    audit   : _audit,
    lockAll : function () { _registerAll(); _lockAll(); },
    VERSION : VERSION
  };

  /** Production stress test. */
  G.runProductionStress = runProductionStress;

}(window));
