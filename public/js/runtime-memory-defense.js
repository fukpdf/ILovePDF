// RuntimeMemoryDefense v1.0 — Phase 8D
// =====================================================================
// Predictive OOM defense system. Acts BEFORE a crash, not after.
//
// Strategy:
//   1. Predictive OOM  — tracks heap growth rate over time;
//                        estimates time-to-OOM and acts before it.
//   2. Auto chunk shrink — on WARNING+, halves RuntimeAdaptivePipeline
//                          chunk size proactively.
//   3. Emergency drain  — terminates non-essential workers immediately
//                         on CRITICAL/EMERGENCY tier.
//   4. Stream pausing   — sends 'stream-pause' to active stream workers.
//   5. Worker shedding  — evicts oldest idle workers to free memory.
//   6. Compression mode — drops canvas scale, disables previews.
//   7. Preemptive GC    — triggers CleanupContracts + URL revocation.
//
// Integrates: RuntimeMemory, RuntimeAdaptivePipeline, RuntimeWorkers,
//             RuntimeStreamBridge, RuntimeEventBus, RuntimeTelemetry,
//             CleanupContracts, ObjectURLRegistry
//
// Expose: window.RuntimeMemoryDefense
//   .getStatus()    → current defense state
//   .forceCheck()   → run defense analysis immediately
//   .getHistory()   → last N defense events
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeMemoryDefense) return;

  var LOG = '[MDF8D]';

  // ── Heap sample ring ──────────────────────────────────────────────────────
  // Stores { ts, heapBytes } every SAMPLE_INTERVAL_MS for rate estimation.
  var SAMPLE_INTERVAL_MS  = 5000;
  var MAX_SAMPLES         = 24;   // 2 minutes of history at 5s intervals
  var OOM_WARN_SECS       = 60;   // warn if OOM predicted within 60 s
  var OOM_CRITICAL_SECS   = 20;   // act if OOM predicted within 20 s

  var _samples    = [];   // [{ ts, heapBytes }]
  var _sampleTimer = null;
  var _history    = [];   // [{ ts, action, reason, tier }]
  var MAX_HISTORY = 50;

  // ── State ─────────────────────────────────────────────────────────────────
  var _lastTier   = 'NORMAL';
  var _streamsPaused = false;
  var _compressionMode = false;
  var _defenseCooldown = new Map(); // action → lastFiredTs

  function _logAction(action, reason, tier) {
    var ev = { ts: Date.now(), action: action, reason: reason, tier: tier };
    _history.push(ev);
    if (_history.length > MAX_HISTORY) _history.shift();
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('memdefense:' + action, { reason: reason, tier: tier }); } catch (_) {}
    }
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('memdefense:' + action, ev); } catch (_) {}
    }
    console.warn(LOG, action, '—', reason, '(tier:', tier + ')');
  }

  // ── Cooldown guard ────────────────────────────────────────────────────────
  function _cooldown(action, minIntervalMs) {
    var last = _defenseCooldown.get(action) || 0;
    if (Date.now() - last < minIntervalMs) return true; // still cooling
    _defenseCooldown.set(action, Date.now());
    return false;
  }

  // ── 1. Heap sampling + OOM prediction ────────────────────────────────────
  function _sampleHeap() {
    var m = global.performance && global.performance.memory;
    if (!m) return;
    _samples.push({ ts: Date.now(), heapBytes: m.usedJSHeapSize, limit: m.jsHeapSizeLimit });
    if (_samples.length > MAX_SAMPLES) _samples.shift();
  }

  // Returns estimated seconds until OOM, or Infinity if stable / not enough data.
  function _predictOomSecs() {
    if (_samples.length < 3) return Infinity;

    var m = global.performance && global.performance.memory;
    if (!m) return Infinity;

    var recent  = _samples.slice(-6); // last 30 s (6 × 5s)
    var oldest  = recent[0];
    var newest  = recent[recent.length - 1];
    var dtMs    = newest.ts - oldest.ts;
    if (dtMs < 4000) return Infinity;

    var growthBytesPerMs = (newest.heapBytes - oldest.heapBytes) / dtMs;
    if (growthBytesPerMs <= 0) return Infinity;

    var headroom   = newest.limit - newest.heapBytes;
    var secsToOom  = (headroom / growthBytesPerMs) / 1000;
    return Math.max(0, secsToOom);
  }

  // ── 2. Auto chunk shrink ──────────────────────────────────────────────────
  function _shrinkChunks(reason) {
    if (_cooldown('chunk-shrink', 15000)) return;
    var rap = global.RuntimeAdaptivePipeline;
    if (!rap) return;
    // Force re-tune at next call (set profile.ts = 0 trick via EventBus)
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('memory:tier-changed', { tier: _lastTier, source: 'memdefense', forced: true }); } catch (_) {}
    }
    _logAction('chunk-shrink', reason, _lastTier);
  }

  // ── 3. Emergency worker drain ─────────────────────────────────────────────
  function _drainWorkers(reason) {
    if (_cooldown('worker-drain', 20000)) return;
    // Ask RuntimeWorkers to shed non-essential idle workers
    if (global.RuntimeWorkers && global.RuntimeWorkers.drainIdle) {
      try { global.RuntimeWorkers.drainIdle(reason); } catch (_) {}
    }
    // Also cancel all background-priority tasks
    if (global.RuntimeCancellation) {
      try { global.RuntimeCancellation.cancelScope('background', reason); } catch (_) {}
    }
    _logAction('worker-drain', reason, _lastTier);
  }

  // ── 4. Adaptive stream pausing ────────────────────────────────────────────
  function _pauseStreams(reason) {
    if (_streamsPaused) return;
    if (_cooldown('stream-pause', 10000)) return;
    _streamsPaused = true;
    // Emit event — RuntimeStreamBridge and pdf-worker-runtime-factory listen
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('memdefense:stream-pause', { reason: reason }); } catch (_) {}
    }
    _logAction('stream-pause', reason, _lastTier);
  }

  function _resumeStreams(reason) {
    if (!_streamsPaused) return;
    _streamsPaused = false;
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('memdefense:stream-resume', { reason: reason }); } catch (_) {}
    }
    _logAction('stream-resume', reason, _lastTier);
  }

  // ── 5. Worker shedding (evict oldest idle workers) ────────────────────────
  function _shedWorkers(reason) {
    if (_cooldown('worker-shed', 30000)) return;
    if (global.RuntimeWorkers && global.RuntimeWorkers.shedOldest) {
      try { global.RuntimeWorkers.shedOldest(1, reason); } catch (_) {}
    }
    _logAction('worker-shed', reason, _lastTier);
  }

  // ── 6. Low-memory compression mode ────────────────────────────────────────
  function _enterCompressionMode(reason) {
    if (_compressionMode) return;
    _compressionMode = true;
    // Reduce canvas scale via AdaptiveDegradation
    if (global.AdaptiveDegradation && global.AdaptiveDegradation.forceTier) {
      try { global.AdaptiveDegradation.forceTier('critical'); } catch (_) {}
    }
    // Disable previews via RuntimeMemory applyConfig
    if (global.RuntimeMemory && global.RuntimeMemory.applyConfig) {
      try { global.RuntimeMemory.applyConfig({ enablePreview: false, canvasScale: 0.4 }); } catch (_) {}
    }
    _logAction('compression-mode-enter', reason, _lastTier);
  }

  function _exitCompressionMode(reason) {
    if (!_compressionMode) return;
    _compressionMode = false;
    _logAction('compression-mode-exit', reason, _lastTier);
  }

  // ── 7. Preemptive cleanup ─────────────────────────────────────────────────
  function _preemptiveCleanup(reason) {
    if (_cooldown('preemptive-cleanup', 20000)) return;
    if (global.CleanupContracts) {
      try { global.CleanupContracts.cleanup(reason); } catch (_) {}
    }
    if (global.ObjectURLRegistry && global.ObjectURLRegistry.revokeAll) {
      try { global.ObjectURLRegistry.revokeAll('memdefense:preemptive'); } catch (_) {}
    }
    if (global.MemPressure && global.MemPressure.emergencyCleanup) {
      try { global.MemPressure.emergencyCleanup(); } catch (_) {}
    }
    _logAction('preemptive-cleanup', reason, _lastTier);
  }

  // ── Main defense analysis ─────────────────────────────────────────────────
  function _analyze() {
    var tier = (global.RuntimeMemory && global.RuntimeMemory.getTier)
      ? global.RuntimeMemory.getTier()
      : 'NORMAL';

    _lastTier = tier;

    var oomSecs = _predictOomSecs();

    // === EMERGENCY tier ===
    if (tier === 'EMERGENCY') {
      _preemptiveCleanup('emergency-tier');
      _drainWorkers('emergency-tier');
      _pauseStreams('emergency-tier');
      _shedWorkers('emergency-tier');
      _enterCompressionMode('emergency-tier');
      return;
    }

    // === CRITICAL tier ===
    if (tier === 'CRITICAL') {
      _shrinkChunks('critical-tier');
      _drainWorkers('critical-tier');
      _pauseStreams('critical-tier');
      _preemptiveCleanup('critical-tier');
      _enterCompressionMode('critical-tier');
      return;
    }

    // === WARNING tier ===
    if (tier === 'WARNING') {
      _shrinkChunks('warning-tier');
      if (oomSecs < OOM_WARN_SECS) {
        _preemptiveCleanup('predictive-oom-warn');
      }
      return;
    }

    // === NORMAL tier + predictive checks ===
    if (oomSecs < OOM_CRITICAL_SECS) {
      _logAction('predictive-oom-critical', 'OOM in ~' + Math.round(oomSecs) + 's', 'NORMAL');
      _preemptiveCleanup('predictive-oom');
      _drainWorkers('predictive-oom');
    } else if (oomSecs < OOM_WARN_SECS) {
      _logAction('predictive-oom-warn', 'OOM in ~' + Math.round(oomSecs) + 's', 'NORMAL');
      _shrinkChunks('predictive-oom');
    }

    // Recovery from CRITICAL/EMERGENCY: re-enable if now NORMAL
    if (_compressionMode) _exitCompressionMode('tier-recovered');
    if (_streamsPaused)   _resumeStreams('tier-recovered');
  }

  // ── Periodic defense sweep ────────────────────────────────────────────────
  var _sweepTimer = null;
  var SWEEP_INTERVAL_MS = 10000; // every 10 s

  function _startSweep() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(function () {
      _sampleHeap();
      _analyze();
    }, SWEEP_INTERVAL_MS);
    if (global.TimerRegistry) {
      try { global.TimerRegistry.registerInterval('memdefense-sweep', _sweepTimer); } catch (_) {}
    }
  }

  // ── Subscribe to RuntimeMemory tier changes ────────────────────────────────
  function _subscribeTierChanges() {
    if (global.RuntimeMemory && global.RuntimeMemory.onChange) {
      global.RuntimeMemory.onChange(function (newTier) {
        _lastTier = newTier;
        _analyze();
      });
    }
    if (global.RuntimeEventBus) {
      global.RuntimeEventBus.on('memory:tier-changed', function () {
        _sampleHeap();
        _analyze();
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _sampleHeap();
    _subscribeTierChanges();
    _startSweep();

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('memoryDefense', global.RuntimeMemoryDefense); } catch (_) {}
    }

    console.info(LOG, 'RuntimeMemoryDefense v1.0 ready — predictive OOM defense active');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 300); }, { once: true });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  global.RuntimeMemoryDefense = {
    getStatus: function () {
      return {
        tier:            _lastTier,
        oomPredictedSecs: _predictOomSecs(),
        streamsPaused:   _streamsPaused,
        compressionMode: _compressionMode,
        samples:         _samples.length,
        heapMB:          (function () {
          try { return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024); } catch (_) { return 0; }
        }()),
      };
    },
    forceCheck: function () {
      _sampleHeap();
      _analyze();
      return global.RuntimeMemoryDefense.getStatus();
    },
    getHistory: function () { return _history.slice(); },
  };
}(window));
