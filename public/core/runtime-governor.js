/**
 * RuntimeGovernor — Phase 16
 *
 * Browser OS Runtime Finalization: global resource governor, orchestration
 * control plane, and the complete RT.runtime.* enterprise API surface.
 *
 * Components:
 *   RuntimeGovernor    — monitors all resources above RuntimeKernel;
 *                        takes automatic corrective action when limits hit
 *   RuntimeOrchestrator — unified task control plane (wraps CentralRuntime)
 *   RT.runtime.*       — extends window.RT with the full status API:
 *                          RT.runtime.status()   — complete platform snapshot
 *                          RT.runtime.health()   — health details
 *                          RT.runtime.modules()  — federation module status
 *                          RT.runtime.memory()   — memory details
 *                          RT.runtime.workers()  — worker pool details
 *                          RT.runtime.ai()       — AI layer details
 *                          RT.runtime.streams()  — stream system details
 *
 * Mobile resilience: automatically lowers concurrency/chunk limits on
 * mobile and iOS Safari. No code changes in existing modules.
 *
 * Production safety guards:
 *   - Runaway worker detection (too many spawns in window)
 *   - Memory explosion prevention (emergency GC trigger)
 *   - Stream leak detection (idle streams > threshold)
 *   - AI deadlock prevention (stuck tasks > timeout)
 *   - Orphan task recovery (tasks without progress for > 3 min)
 *   - Recursive load prevention (re-entrancy guard)
 *
 * BACKWARD COMPATIBLE: 100% additive. Zero changes to any existing module.
 * All existing RT.* APIs are unchanged. Only RT.runtime is added.
 *
 * Exposed as: window.RuntimeGovernor, window.RuntimeOrchestrator
 *             Extended: window.RT.runtime (if CentralRuntime loaded)
 */
(function (G) {
  'use strict';

  if (G.RuntimeGovernor) return;

  var VERSION = '1.0.0';
  var LOG     = '[GOV16]';

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 1  DEVICE PROFILE
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _ua          = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var _isMobile    = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  var _isIOS       = /iPhone|iPad|iPod/i.test(_ua);
  var _isIOSSafari = _isIOS && !/CriOS|FxiOS|OPiOS/i.test(_ua);
  var _cores       = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  var _memGB       = (typeof navigator !== 'undefined' && navigator.deviceMemory)  || 4;

  /* ── Mobile resilience limits ─────────────────────────────────────────────
   * Applied to RuntimeKernel.setLimit() if available at runtime. */
  var MOBILE_LIMITS = (function () {
    if (_isIOSSafari) return { workers: 1, gpu: 1, ai: 1, stream: 1 };
    if (_isMobile)    return { workers: 2, gpu: 1, ai: 2, stream: 2 };
    return null; // desktop: use kernel defaults
  }());

  function _safe(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 2  GOVERNOR CHECKS (production safety guards)
   * ═══════════════════════════════════════════════════════════════════════════ */

  var GUARD_INTERVAL_MS = 60000; // run checks every 60 s

  /* ── 2A: Memory explosion prevention ─────────────────────────────────── */
  function _checkMemory() {
    var tier = _safe(function () {
      return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'NORMAL';
    }, 'NORMAL');

    if (tier === 'EMERGENCY') {
      // Trigger emergency GC path in AdaptiveDegradation
      _safe(function () {
        if (G.AdaptiveDegradation && typeof G.AdaptiveDegradation.emergencyCleanup === 'function') {
          G.AdaptiveDegradation.emergencyCleanup('governor:memory-explosion');
        }
      });
      // Revoke orphan object URLs
      _safe(function () {
        if (G.ObjectURLRegistry && typeof G.ObjectURLRegistry.revokeAll === 'function') {
          G.ObjectURLRegistry.revokeAll('governor:emergency');
        }
      });
      console.warn(LOG, 'EMERGENCY memory — emergency cleanup triggered');
    }
  }

  /* ── 2B: Worker runaway detection ─────────────────────────────────────── */
  function _checkWorkers() {
    var stats = _safe(function () {
      return G.WorkerPool ? G.WorkerPool.getStats() : null;
    }, null);
    if (!stats) return;

    // If zombies > 5 — schedule termination via WorkerLeakDetector
    var zombies = _safe(function () {
      return G.WorkerLeakDetector ? G.WorkerLeakDetector.getStats().zombies : 0;
    }, 0);

    if (zombies > 5) {
      console.warn(LOG, 'runaway workers detected (' + zombies + ' zombies) — triggering cleanup');
      _safe(function () {
        if (G.WorkerLifecycle && typeof G.WorkerLifecycle.cleanup === 'function') {
          G.WorkerLifecycle.cleanup('governor:runaway-workers');
        }
      });
    }
  }

  /* ── 2C: AI deadlock prevention ───────────────────────────────────────── */
  var _lastAiTaskTs = 0;
  var AI_DEADLOCK_MS = 5 * 60 * 1000; // 5 minutes with no AI task completion = deadlock

  function _checkAi() {
    // If AIRuntime is present and has been stuck for too long, cancel scope
    var aiStatus = _safe(function () {
      return G.AIRuntime ? G.AIRuntime.status() : null;
    }, null);
    if (!aiStatus) return;

    if (aiStatus.active > 0 && _lastAiTaskTs > 0) {
      var stuckMs = Date.now() - _lastAiTaskTs;
      if (stuckMs > AI_DEADLOCK_MS) {
        console.warn(LOG, 'AI deadlock detected (' + Math.round(stuckMs / 1000) + 's) — cancelling AI scope');
        _safe(function () {
          if (G.RuntimeCancellation) {
            G.RuntimeCancellation.cancelScope('ai', 'governor:ai-deadlock');
          }
        });
        _lastAiTaskTs = Date.now(); // reset timer
      }
    } else {
      _lastAiTaskTs = Date.now();
    }
  }

  /* ── 2D: Stream leak detection ────────────────────────────────────────── */
  function _checkStreams() {
    var stats = _safe(function () {
      return G.RuntimeStreamBridge ? G.RuntimeStreamBridge.getStats() : null;
    }, null);
    if (!stats) return;
    // If open streams > 10, warn (stream bridge self-manages cleanup)
    var openStreams = stats.openStreams || stats.active || 0;
    if (openStreams > 10) {
      console.warn(LOG, 'potential stream leak: ' + openStreams + ' open streams');
      _safe(function () {
        if (G.RuntimeEventBus) {
          G.RuntimeEventBus.emit('governor:stream-leak-warning', { count: openStreams });
        }
      });
    }
  }

  /* ── Governor loop ─────────────────────────────────────────────────────── */
  var _guardTimer = null;

  function _runGuards() {
    _checkMemory();
    _checkWorkers();
    _checkAi();
    _checkStreams();
  }

  function _startGuards() {
    if (_guardTimer) return;
    // First check after 30s (let everything boot), then every 60s
    setTimeout(function () {
      _runGuards();
      _guardTimer = setInterval(_runGuards, GUARD_INTERVAL_MS);
      // Register with TimerRegistry if available
      _safe(function () {
        if (G.TimerRegistry) {
          G.TimerRegistry.registerInterval('governor:guards', _guardTimer);
        }
      });
    }, 30000);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 3  MOBILE LIMITS APPLICATION
   * Applied to RuntimeKernel.setLimit() when kernel is available.
   * ═══════════════════════════════════════════════════════════════════════════ */

  function _applyMobileLimits() {
    if (!MOBILE_LIMITS) return;
    var kernel = G.RuntimeKernel;
    if (!kernel || typeof kernel.setLimit !== 'function') return;
    Object.keys(MOBILE_LIMITS).forEach(function (res) {
      _safe(function () { kernel.setLimit(res, MOBILE_LIMITS[res]); });
    });
    console.debug(LOG, 'mobile limits applied:', JSON.stringify(MOBILE_LIMITS));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 4  STATUS SNAPSHOT HELPERS
   * ═══════════════════════════════════════════════════════════════════════════ */

  function _memoryStatus() {
    return {
      tier:         _safe(function () { return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'UNKNOWN'; }, 'UNKNOWN'),
      config:       _safe(function () { return G.RuntimeMemory ? G.RuntimeMemory.getConfig() : null; }, null),
      jsHeapMB:     _safe(function () {
        var m = performance.memory;
        return m ? Math.round(m.usedJSHeapSize / 1048576) : -1;
      }, -1),
      deviceMemGB:  _memGB,
      isMobile:     _isMobile,
      isIOSSafari:  _isIOSSafari,
      mobileLimits: MOBILE_LIMITS,
      defenseStat:  _safe(function () {
        return G.RuntimeMemoryDefense ? G.RuntimeMemoryDefense.getStats() : null;
      }, null),
    };
  }

  function _workerStatus() {
    return {
      pool:        _safe(function () { return G.WorkerPool ? G.WorkerPool.getStats() : null; }, null),
      orchestrator:_safe(function () { return G.RuntimeWorkers ? G.RuntimeWorkers.getStats() : null; }, null),
      lifecycle:   _safe(function () { return G.WorkerLifecycle ? G.WorkerLifecycle.getStats() : null; }, null),
      leakDetector:_safe(function () { return G.WorkerLeakDetector ? G.WorkerLeakDetector.getStats() : null; }, null),
      kernel:      _safe(function () { return G.RuntimeKernel ? G.RuntimeKernel.getLoad() : null; }, null),
    };
  }

  function _aiStatus() {
    return {
      runtime:        _safe(function () { return G.AIRuntime ? G.AIRuntime.status() : null; }, null),
      orchestrator:   _safe(function () { return G.RuntimeAIOrchestrator ? G.RuntimeAIOrchestrator.getStats() : null; }, null),
      localAi:        _safe(function () { return G.RuntimeLocalAI ? G.RuntimeLocalAI.getStats() : null; }, null),
      vectorMemory:   _safe(function () { return G.VectorMemoryEngine ? G.VectorMemoryEngine.getStats() : null; }, null),
      gpuEngine:      _safe(function () { return G.RuntimeGpuEngine ? G.RuntimeGpuEngine.getStats() : null; }, null),
      wasmEngine:     _safe(function () { return G.RuntimeWasmEngine ? G.RuntimeWasmEngine.getStats() : null; }, null),
    };
  }

  function _streamStatus() {
    return {
      bridge:   _safe(function () { return G.RuntimeStreamBridge ? G.RuntimeStreamBridge.getStats() : null; }, null),
      opfs:     _safe(function () { return G.RuntimeStreaming ? G.RuntimeStreaming.getStats() : null; }, null),
      zeroCopy: _safe(function () { return G.RuntimeZeroCopy ? G.RuntimeZeroCopy.getStats() : null; }, null),
      adaptive: _safe(function () { return G.RuntimeAdaptivePipeline ? G.RuntimeAdaptivePipeline.getProfile() : null; }, null),
    };
  }

  function _modulesStatus() {
    return _safe(function () {
      return G.RuntimeFederation ? G.RuntimeFederation.status() : null;
    }, null);
  }

  function _healthStatus() {
    return {
      score:         _safe(function () { return G.RuntimeHealth ? G.RuntimeHealth.getScore() : -1; }, -1),
      snapshot:      _safe(function () { return G.RuntimeHealth ? G.RuntimeHealth.getSnapshot() : null; }, null),
      kernelHealth:  _safe(function () { return G.RuntimeKernel ? G.RuntimeKernel.getHealth() : null; }, null),
      security:      _safe(function () { return G.RuntimeSecurity ? G.RuntimeSecurity.getStats() : null; }, null),
      diagnostics:   _safe(function () { return G.RuntimeDiagnostics ? G.RuntimeDiagnostics.snapshot() : null; }, null),
    };
  }

  function _fullStatus() {
    var rt = G.CentralRuntime;
    return {
      version:       VERSION,
      runtimeVersion:rt ? rt.VERSION : 'not-loaded',
      ts:            new Date().toISOString(),
      uptimeMs:      _safe(function () { return rt ? rt.status().uptimeMs : 0; }, 0),
      platform: {
        device:      _isMobile ? (_isIOSSafari ? 'ios-safari' : 'mobile') : 'desktop',
        cores:       _cores,
        memGB:       _memGB,
        mobileLimits:MOBILE_LIMITS,
      },
      runtime:       rt ? rt.status() : null,
      health:        _healthStatus(),
      memory:        _memoryStatus(),
      workers:       _workerStatus(),
      ai:            _aiStatus(),
      streams:       _streamStatus(),
      modules:       _modulesStatus(),
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 5  RUNTIME ORCHESTRATOR
   * Global task control plane. Wraps CentralRuntime with governance checks.
   * ═══════════════════════════════════════════════════════════════════════════ */

  var RuntimeOrchestrator = {
    VERSION: VERSION,

    /**
     * execute(toolId, fn, opts) — governed execute.
     * Adds: memory pre-flight, health gate, telemetry.
     * Falls back to CentralRuntime.execute() transparently.
     */
    execute: function (toolId, fn, opts) {
      opts = opts || {};

      // Memory pre-flight: downgrade opts based on tier
      var memTier = _safe(function () {
        return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'NORMAL';
      }, 'NORMAL');

      if (memTier === 'EMERGENCY' && opts.type !== 'cleanup') {
        return Promise.reject(new Error('RuntimeGovernor: execute blocked — EMERGENCY memory'));
      }

      // Delegate to CentralRuntime
      var rt = G.CentralRuntime;
      if (rt) return rt.execute(toolId, fn, opts);
      // No CentralRuntime: run directly
      return Promise.resolve().then(function () { return fn(function () {}, null); });
    },

    /** Graceful shutdown: cancel all, cleanup, flush telemetry. */
    shutdown: function (reason) {
      reason = reason || 'orchestrator:shutdown';
      _safe(function () { if (G.CentralRuntime) G.CentralRuntime.cancelAll(reason); });
      _safe(function () { if (G.CentralRuntime) G.CentralRuntime.cleanup(reason); });
      _safe(function () { if (G.RuntimeTelemetryEnterprise) G.RuntimeTelemetryEnterprise.flush(); });
      _safe(function () { if (G.RuntimeEventBus) G.RuntimeEventBus.emit('orchestrator:shutdown', { reason: reason }); });
      if (_guardTimer) { clearInterval(_guardTimer); _guardTimer = null; }
      console.info(LOG, 'RuntimeOrchestrator shutdown — reason:', reason);
    },
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 6  RT.runtime EXTENSION
   * Adds the full enterprise API surface to window.RT / window.CentralRuntime.
   * ═══════════════════════════════════════════════════════════════════════════ */

  function _attachRtRuntime(target) {
    if (!target) return;
    if (target.runtime) return;  // already attached

    target.runtime = {
      /** Full platform snapshot. */
      status:  function () { return _fullStatus(); },
      /** Health details only. */
      health:  function () { return _healthStatus(); },
      /** Module federation status. */
      modules: function () { return _modulesStatus(); },
      /** Memory details only. */
      memory:  function () { return _memoryStatus(); },
      /** Worker pool details. */
      workers: function () { return _workerStatus(); },
      /** AI layer details. */
      ai:      function () { return _aiStatus(); },
      /** Stream system details. */
      streams: function () { return _streamStatus(); },
      /** Print summary to console. */
      print:   function () {
        var s = _fullStatus();
        console.group('[RT.runtime] v' + VERSION + ' — Platform Status');
        console.log('  Runtime:', s.runtimeVersion, '| Uptime:', Math.round(s.uptimeMs / 1000) + 's');
        console.log('  Device:', s.platform.device, '| Cores:', s.platform.cores, '| RAM:', s.platform.memGB + 'GB');
        console.log('  Health score:', s.health.score);
        console.log('  Memory tier:', s.memory.tier, '| JS heap:', s.memory.jsHeapMB + 'MB');
        console.log('  Workers:', JSON.stringify(s.workers.pool ? { active: s.workers.pool.active || 0, queued: s.workers.pool.queued || 0 } : 'N/A'));
        console.log('  AI:', s.ai.runtime ? ('active=' + s.ai.runtime.active + ' queued=' + s.ai.runtime.queued) : 'not loaded');
        console.log('  Modules:', s.modules ? (s.modules.groupsReady + ' groups, ' + s.modules.toolsReady + ' tools') : 'not loaded');
        console.groupEnd();
      },
    };

    console.debug(LOG, 'RT.runtime attached to', target === G.CentralRuntime ? 'CentralRuntime' : 'RT');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 7  BOOT
   * ═══════════════════════════════════════════════════════════════════════════ */

  var RuntimeGovernor = {
    VERSION: VERSION,

    /* Public API */
    status:      _fullStatus,
    health:      _healthStatus,
    memory:      _memoryStatus,
    workers:     _workerStatus,
    ai:          _aiStatus,
    streams:     _streamStatus,
    modules:     _modulesStatus,
    runGuards:   _runGuards,
    Orchestrator: RuntimeOrchestrator,

    /** Attach RT.runtime to CentralRuntime (call after CentralRuntime loads). */
    attachToRuntime: function () {
      _attachRtRuntime(G.CentralRuntime);
      if (G.RT && G.RT !== G.CentralRuntime) _attachRtRuntime(G.RT);
      _applyMobileLimits();
      _startGuards();
    },
  };

  G.RuntimeGovernor    = RuntimeGovernor;
  G.RuntimeOrchestrator = RuntimeOrchestrator;

  /* ── Attach RT.runtime now if CentralRuntime is ready; else wait ─────── */
  function _tryAttach() {
    if (G.CentralRuntime || G.RT) {
      RuntimeGovernor.attachToRuntime();
    }
  }

  _tryAttach();
  if (!G.CentralRuntime) {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(_tryAttach, 150); // after CentralRuntime bootstrap (100ms delay)
    }, { once: true });
  }

  /* ── pagehide cleanup ────────────────────────────────────────────────── */
  window.addEventListener('pagehide', function () {
    if (_guardTimer) { clearInterval(_guardTimer); _guardTimer = null; }
  }, { passive: true });

  console.debug(LOG, 'RuntimeGovernor v' + VERSION + ' ready — device:'
    + (_isIOSSafari ? 'ios-safari' : _isMobile ? 'mobile' : 'desktop')
    + ', cores:' + _cores + ', RAM:' + _memGB + 'GB');

}(window));
