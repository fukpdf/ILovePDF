/**
 * PHASE 53 — ENTERPRISE MEMORY FABRIC
 * window.EnterpriseMemoryFabric
 *
 * Intelligent cache eviction, vector cache balancing, adaptive memory pressure
 * routing, ONNX memory balancing, GPU balancing, streaming-only mode,
 * giant-job isolation, adaptive concurrency, emergency memory evacuation.
 * Purely additive. Integrates with existing MemPressure, OnnxRuntimeManager,
 * WebGpuAiExpansion, VectorMemoryEngine. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[EMF]';
  var MB      = 1024 * 1024;

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  MEMORY TIER DETECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var MemoryTierDetector = (function () {
    var _tier  = 'normal';
    var _heapMB = 0;

    function detect() {
      // Use existing MemPressure if available
      var mp = sys('MemPressure') || sys('MemoryPressureMonitor');
      if (mp && typeof mp.tier === 'function') { _tier = mp.tier(); return _tier; }

      // Fallback: estimate from performance.memory
      try {
        var mem = performance.memory;
        if (mem) {
          var usedMB = mem.usedJSHeapSize / MB;
          var limitMB = mem.jsHeapSizeLimit / MB;
          _heapMB = usedMB;
          var ratio = usedMB / limitMB;
          if      (ratio > 0.9) _tier = 'critical';
          else if (ratio > 0.75) _tier = 'danger';
          else if (ratio > 0.6)  _tier = 'warning';
          else                   _tier = 'normal';
        }
      } catch (_) {}
      return _tier;
    }

    function tier()   { return _tier; }
    function heapMB() { return _heapMB; }
    function isSafe() { return _tier === 'normal' || _tier === 'low'; }

    setInterval(detect, 5000);
    detect();
    return { detect: detect, tier: tier, heapMB: heapMB, isSafe: isSafe };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  INTELLIGENT CACHE EVICTION
  // ═══════════════════════════════════════════════════════════════════════════
  var CacheEvictionManager = (function () {
    var _registries = []; // { name, evict(), sizeEstimate() }

    function register(name, evict, sizeEstimate) {
      _registries.push({ name: name, evict: evict, sizeEstimate: sizeEstimate || function () { return 0; } });
    }

    function evictAll() {
      var total = 0;
      _registries.forEach(function (r) {
        try {
          var before = r.sizeEstimate();
          r.evict();
          var after  = r.sizeEstimate();
          var freed  = before - after;
          if (freed > 0) { total += freed; log('evicted', r.name, freed + 'B'); }
        } catch (e) { warn('evict failed:', r.name, e.message); }
      });
      return total;
    }

    function evictSingle(name) {
      var r = _registries.find(function (r) { return r.name === name; });
      if (r) try { r.evict(); } catch (_) {}
    }

    function totalSize() {
      return _registries.reduce(function (s, r) { try { return s + r.sizeEstimate(); } catch (_) { return s; } }, 0);
    }

    // Register known caches
    function _registerKnown() {
      // VectorMemoryEngine shard cache
      var VME = sys('VectorMemoryEngine');
      if (VME && VME.ShardManager) {
        register('vector-shard-cache',
          function () { VME.ShardManager.evictLRU(2); },
          function () { return VME.ShardManager.cacheSize() * 512 * 384 * 4; } // rough estimate
        );
      }
      // GenerativeAiEngine cache
      var GAE = sys('GenerativeAiEngine');
      if (GAE && GAE.cleanup) {
        register('gen-ai-cache', function () { GAE.cleanup(); }, function () { return 0; });
      }
      // GPU tensor pool
      var WGAE = sys('WebGpuAiExpansion');
      if (WGAE && WGAE.TensorPool) {
        register('gpu-tensor-pool',
          function () { WGAE.TensorPool._evict && WGAE.TensorPool._evict(); },
          function () { var s = WGAE.TensorPool.stats(); return parseFloat(s.allocatedMB || 0) * MB; }
        );
      }
    }

    // Register known caches after short delay (let modules initialize)
    setTimeout(_registerKnown, 2000);

    return { register: register, evictAll: evictAll, evictSingle: evictSingle, totalSize: totalSize };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  ADAPTIVE MEMORY PRESSURE ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  var AdaptiveMemoryRouter = (function () {
    var _streamingMode = false;
    var _lastEviction  = 0;

    function shouldStream(fileSizeBytes) {
      if (_streamingMode) return true;
      var tier = MemoryTierDetector.tier();
      if (tier === 'danger' || tier === 'critical') return true;
      return fileSizeBytes > 50 * MB;
    }

    function routeTask(taskType, sizeBytes) {
      var tier = MemoryTierDetector.tier();
      switch (tier) {
        case 'critical':
          if (Date.now() - _lastEviction > 10000) { CacheEvictionManager.evictAll(); _lastEviction = Date.now(); }
          return { mode: 'streaming', workers: 1, chunkMB: 1, gpu: false };
        case 'danger':
          return { mode: 'streaming', workers: 1, chunkMB: 2, gpu: false };
        case 'warning':
          return { mode: 'buffered',  workers: 2, chunkMB: 4, gpu: true };
        default:
          return { mode: 'buffered',  workers: 4, chunkMB: 8, gpu: true };
      }
    }

    function enableStreamingOnly()  { _streamingMode = true;  log('streaming-only mode enabled'); }
    function disableStreamingOnly() { _streamingMode = false; log('streaming-only mode disabled'); }
    function isStreamingMode()      { return _streamingMode; }

    return { shouldStream: shouldStream, routeTask: routeTask, enableStreamingOnly: enableStreamingOnly, disableStreamingOnly: disableStreamingOnly, isStreamingMode: isStreamingMode };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  ONNX MEMORY BALANCER
  // ═══════════════════════════════════════════════════════════════════════════
  var OnnxMemoryBalancer = (function () {
    function balance() {
      var ORM = sys('OnnxRuntimeManager');
      if (!ORM) return;
      var tier = MemoryTierDetector.tier();
      if (tier === 'danger' || tier === 'critical') {
        // Release ONNX sessions if under pressure
        if (ORM.releaseAll) { ORM.releaseAll(); log('ONNX sessions released due to memory pressure'); }
        else if (ORM.evict) { ORM.evict(); }
      }
    }
    setInterval(balance, 8000);
    return { balance: balance };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  GIANT JOB ISOLATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var GiantJobIsolator = (function () {
    var _isolated = new Map(); // jobId → { startTime, reserved }
    var GIANT_THRESHOLD = 100 * MB;

    function isGiant(sizeBytes) { return sizeBytes >= GIANT_THRESHOLD; }

    function isolate(jobId, sizeBytes) {
      if (!isGiant(sizeBytes)) return false;
      // Evict caches before giant job
      var freed = CacheEvictionManager.evictAll();
      log('giant job isolation:', jobId, 'freed', (freed / MB).toFixed(1), 'MB');
      _isolated.set(jobId, { startTime: Date.now(), reserved: sizeBytes, freed: freed });
      AdaptiveMemoryRouter.enableStreamingOnly();
      // Pause vector indexing
      var VME = sys('VectorMemoryEngine');
      if (VME && VME.BackgroundIndex) {
        // VectorMemoryEngine BackgroundIndexer doesn't expose pause; skip
      }
      return true;
    }

    function release(jobId) {
      _isolated.delete(jobId);
      if (!_isolated.size) {
        AdaptiveMemoryRouter.disableStreamingOnly();
        log('giant job isolation released');
      }
    }

    function active() { return Array.from(_isolated.entries()).map(function (e) { return { jobId: e[0], duration: Date.now() - e[1].startTime }; }); }

    return { isGiant: isGiant, isolate: isolate, release: release, active: active };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  ADAPTIVE CONCURRENCY MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var AdaptiveConcurrencyManager = (function () {
    var _limit = 4;
    var _active = 0;

    function _recompute() {
      var tier  = MemoryTierDetector.tier();
      var cores = Math.min(navigator.hardwareConcurrency || 2, 8);
      switch (tier) {
        case 'critical': _limit = 1; break;
        case 'danger':   _limit = 1; break;
        case 'warning':  _limit = Math.max(1, Math.floor(cores / 2)); break;
        default:         _limit = Math.max(2, cores - 1); break;
      }
    }

    async function acquire() {
      while (_active >= _limit) await new Promise(function (r) { setTimeout(r, 100); });
      _active++;
    }

    function release() { _active = Math.max(0, _active - 1); }
    function limit()   { return _limit; }
    function active()  { return _active; }

    setInterval(_recompute, 5000);
    _recompute();
    return { acquire: acquire, release: release, limit: limit, active: active };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  EMERGENCY MEMORY EVACUATION
  // ═══════════════════════════════════════════════════════════════════════════
  var EmergencyEvacuator = (function () {
    var _lastEmergency = 0;
    var COOLDOWN = 15000;

    async function evacuate() {
      if (Date.now() - _lastEmergency < COOLDOWN) { warn('emergency cooldown active'); return; }
      _lastEmergency = Date.now();
      warn('EMERGENCY MEMORY EVACUATION STARTED');

      // 1. Evict all caches
      var freed = CacheEvictionManager.evictAll();

      // 2. Release ONNX
      OnnxMemoryBalancer.balance();

      // 3. GPU cleanup
      var WGAE = sys('WebGpuAiExpansion');
      if (WGAE && WGAE.cleanup) WGAE.cleanup();

      // 4. Enable streaming mode
      AdaptiveMemoryRouter.enableStreamingOnly();

      // 5. GC hint
      if (window.gc) try { window.gc(); } catch (_) {}

      log('emergency evacuation complete, freed ~' + (freed / MB).toFixed(1) + 'MB');
      return { freed: freed };
    }

    // Auto-trigger on critical pressure
    function _watch() {
      var tier = MemoryTierDetector.tier();
      if (tier === 'critical') evacuate().catch(function () {});
    }
    setInterval(_watch, 10000);

    return { evacuate: evacuate };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  VECTOR CACHE BALANCER
  // ═══════════════════════════════════════════════════════════════════════════
  var VectorCacheBalancer = (function () {
    function balance() {
      var VME  = sys('VectorMemoryEngine');
      if (!VME || !VME.ShardManager) return;
      var tier = MemoryTierDetector.tier();
      var keep = tier === 'normal' ? 8 : tier === 'warning' ? 4 : tier === 'danger' ? 2 : 1;
      VME.ShardManager.evictLRU(keep);
    }
    setInterval(balance, 12000);
    return { balance: balance };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  DISTRIBUTED MEMORY BALANCER
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedMemoryBalancer = (function () {
    function balance() {
      var P2P = sys('P2PDistributedMeshV2');
      if (!P2P || !P2P.enabled()) return;
      var tier = MemoryTierDetector.tier();
      if (tier === 'danger' || tier === 'critical') {
        // Broadcast memory pressure to peers
        if (P2P.Coordinator && P2P.Coordinator.broadcast) {
          P2P.Coordinator.broadcast({ type: 'memory-pressure', tier: tier, ts: Date.now() });
        }
      }
    }
    setInterval(balance, 15000);
    return { balance: balance };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  PERFORMANCE METRICS
  // ═══════════════════════════════════════════════════════════════════════════
  var PerformanceMetrics = (function () {
    var _samples = [];
    var MAX      = 120;

    function record(label, durationMs, sizeBytes) {
      _samples.push({ label: label, duration: durationMs, size: sizeBytes || 0, tier: MemoryTierDetector.tier(), ts: Date.now() });
      if (_samples.length > MAX) _samples.shift();
    }

    function summary() {
      if (!_samples.length) return { count: 0 };
      var durations = _samples.map(function (s) { return s.duration; });
      var avg = durations.reduce(function (a,b){return a+b;},0) / durations.length;
      var max = Math.max.apply(null, durations);
      return { count: _samples.length, avgMs: avg.toFixed(1), maxMs: max, tier: MemoryTierDetector.tier() };
    }

    function recent(n) { return _samples.slice(-n || -20); }
    return { record: record, summary: summary, recent: recent };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.EnterpriseMemoryFabric = {
    version: VERSION,

    // Route a task based on current memory tier
    route: function (taskType, sizeBytes) { return AdaptiveMemoryRouter.routeTask(taskType, sizeBytes); },

    // Should this task stream?
    shouldStream: function (sizeBytes) { return AdaptiveMemoryRouter.shouldStream(sizeBytes); },

    // Giant job management
    isolateGiantJob: function (jobId, size) { return GiantJobIsolator.isolate(jobId, size); },
    releaseGiantJob: function (jobId)        { return GiantJobIsolator.release(jobId); },
    isGiantJob:      function (size)          { return GiantJobIsolator.isGiant(size); },

    // Concurrency
    acquireSlot: function () { return AdaptiveConcurrencyManager.acquire(); },
    releaseSlot: function () { return AdaptiveConcurrencyManager.release(); },
    concurrencyLimit: function () { return AdaptiveConcurrencyManager.limit(); },

    // Emergency
    emergencyEvacuate: function () { return EmergencyEvacuator.evacuate(); },

    // Evict caches
    evictAll: function () { return CacheEvictionManager.evictAll(); },
    registerCache: function (name, evict, sizeEstimate) { CacheEvictionManager.register(name, evict, sizeEstimate); },

    // Metrics
    record: function (label, ms, bytes) { PerformanceMetrics.record(label, ms, bytes); },

    // Stats
    stats: function () {
      return {
        memTier:          MemoryTierDetector.tier(),
        heapMB:           MemoryTierDetector.heapMB().toFixed(1),
        cacheEntries:     CacheEvictionManager.totalSize(),
        streamingMode:    AdaptiveMemoryRouter.isStreamingMode(),
        concurrencyLimit: AdaptiveConcurrencyManager.limit(),
        concurrencyActive: AdaptiveConcurrencyManager.active(),
        giantJobs:        GiantJobIsolator.active().length,
        perf:             PerformanceMetrics.summary(),
      };
    },

    audit: function () {
      return { version: VERSION, ...window.EnterpriseMemoryFabric.stats() };
    },

    cleanup: function () {
      CacheEvictionManager.evictAll();
      AdaptiveMemoryRouter.disableStreamingOnly();
      log('EnterpriseMemoryFabric cleaned up');
    },

    // Sub-systems
    TierDetector:       MemoryTierDetector,
    CacheEviction:      CacheEvictionManager,
    MemoryRouter:       AdaptiveMemoryRouter,
    OnnxBalancer:       OnnxMemoryBalancer,
    GiantJobIsolator:   GiantJobIsolator,
    ConcurrencyMgr:     AdaptiveConcurrencyManager,
    EmergencyEvacuator: EmergencyEvacuator,
    VectorBalancer:     VectorCacheBalancer,
    DistributedBalancer: DistributedMemoryBalancer,
    Metrics:            PerformanceMetrics,
  };

  log('EnterpriseMemoryFabric v' + VERSION + ' ready — tier:', MemoryTierDetector.tier());
}());
