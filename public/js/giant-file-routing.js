// Giant File Routing v1.0 — Phase 25I
// WorkerPool extensions for giant-file isolation, dedicated lanes,
// memory budgeting, task estimation, and emergency worker termination.
// Exposes: window.GiantFileRouting
// Depends on: WorkerPool (Phase 24), MemPressure (Phase 23A)
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Task memory estimation ─────────────────────────────────────────────────
  // Estimates how many MB a task will consume based on tool + file size.
  // Used to gate dispatches when memory is tight.
  var TASK_MB_FACTORS = {
    'ocr':               12,  // render + preprocessor + Tesseract WASM + output
    'compare':           6,
    'repair':            8,
    'compress':          5,
    'pdf-to-word':       8,
    'pdf-to-excel':      8,
    'pdf-to-powerpoint': 8,
    'pdf-to-jpg':        4,
    'jpg-to-pdf':        4,
    'background-remover':6,
    'image-filters':     4,
    'translate':         3,
    'ai-summarize':      3,
  };

  function estimateTaskMemoryMB(toolId, fileSizeBytes, pageCount) {
    var factor  = TASK_MB_FACTORS[toolId] || 5;
    var fileMB  = (fileSizeBytes || 0) / MB;
    var pageMB  = (pageCount    || 1) * 0.5;  // ~0.5 MB per page overhead
    return Math.ceil(fileMB * factor + pageMB);
  }

  // ── Lane identifiers ───────────────────────────────────────────────────────
  var LANES = {
    OCR:    '/workers/ocr-preprocessor-worker.js',
    PDF:    '/workers/pdf-worker.js',
    ADVANC: '/workers/advanced-worker.js',
  };

  // ── Dynamic worker cap per memory tier ────────────────────────────────────
  function maxWorkersForTier() {
    if (!window.MemPressure) return 4;
    return window.MemPressure.maxWorkers();
  }

  // ── Giant-task isolation pool ──────────────────────────────────────────────
  // A separate micro-pool (1 slot) for tasks that exceed the GIANT threshold.
  // Giant tasks run isolated so they don't starve normal jobs.
  var GIANT_THRESHOLD_MB = 200; // files > 200 MB get isolated dispatch

  var _giantQueue    = [];  // { message, transferables, opts, resolve, reject, estimatedMB }
  var _giantRunning  = false;
  var _giantStats    = { dispatched: 0, completed: 0, failed: 0, queued: 0 };

  function _runNextGiantTask() {
    if (_giantRunning || _giantQueue.length === 0) return;

    // Gate: check available memory before dispatching
    var next = _giantQueue[0];
    if (window.MemPressure) {
      var availMB = window.MemPressure.memAvail() / MB;
      if (availMB < next.estimatedMB * 1.5) {
        // Not enough memory yet — wait and retry
        setTimeout(_runNextGiantTask, 2000);
        return;
      }
    }

    _giantQueue.shift();
    _giantRunning = true;
    _giantStats.dispatched++;
    _giantStats.queued = _giantQueue.length;

    var pool = window.WorkerPool;
    if (!pool) {
      next.reject(new Error('WorkerPool unavailable'));
      _giantRunning = false;
      _runNextGiantTask();
      return;
    }

    _recordTelemetry('giantTask.dispatched', { estimatedMB: next.estimatedMB, tool: next.opts.toolId });

    pool.run(next.workerUrl, next.message, next.transferables, {
      priority: 'high',   // isolated giant tasks always get high priority
      token:    next.opts.token || null,
    }).then(function (result) {
      _giantStats.completed++;
      next.resolve(result);
    }).catch(function (err) {
      _giantStats.failed++;
      next.reject(err);
    }).finally(function () {
      _giantRunning = false;
      _recordTelemetry('giantTask.completed', { failed: false });
      setTimeout(_runNextGiantTask, 100); // small delay to let memory release
    });
  }

  // Run a giant task through the isolation lane
  function runGiantTask(workerUrl, message, transferables, opts) {
    opts = opts || {};
    var estimatedMB = estimateTaskMemoryMB(opts.toolId, opts.fileSize, opts.pageCount);

    return new Promise(function (resolve, reject) {
      _giantQueue.push({
        workerUrl:    workerUrl,
        message:      message,
        transferables: transferables || [],
        opts:         opts,
        resolve:      resolve,
        reject:       reject,
        estimatedMB:  estimatedMB,
        queuedAt:     Date.now(),
      });
      _giantStats.queued = _giantQueue.length;
      _runNextGiantTask();
    });
  }

  // ── Adaptive dispatch router ───────────────────────────────────────────────
  // Routes tasks to either the giant isolation lane or the normal WorkerPool
  // based on file size, estimated memory, and current pressure tier.
  function routeTask(workerUrl, message, transferables, opts) {
    opts = opts || {};
    var fileSizeMB  = (opts.fileSize || 0) / MB;
    var estimatedMB = estimateTaskMemoryMB(opts.toolId, opts.fileSize, opts.pageCount);
    var pool        = window.WorkerPool;

    var forceGiant = fileSizeMB >= GIANT_THRESHOLD_MB ||
                     estimatedMB > 400 ||
                     opts.forceGiant;

    // Under critical memory: force giant lane for any heavy task
    if (window.MemPressure && window.MemPressure.isCritical()) {
      if (estimatedMB > 50) forceGiant = true;
    }

    if (forceGiant) {
      return runGiantTask(workerUrl, message, transferables, opts);
    }

    // Normal dispatch via WorkerPool
    if (!pool) return Promise.reject(new Error('WorkerPool unavailable'));
    return pool.run(workerUrl, message, transferables || [], {
      priority: opts.priority || 'normal',
      token:    opts.token    || null,
    });
  }

  // ── Low-memory worker routing ──────────────────────────────────────────────
  // When memory is critical, serialize all worker tasks (only 1 at a time).
  var _serialQueue   = [];
  var _serialRunning = false;

  function _runSerialNext() {
    if (_serialRunning || _serialQueue.length === 0) return;
    var task = _serialQueue.shift();
    _serialRunning = true;

    var pool = window.WorkerPool;
    if (!pool) {
      task.reject(new Error('WorkerPool unavailable'));
      _serialRunning = false;
      _runSerialNext();
      return;
    }

    pool.run(task.workerUrl, task.message, task.transferables, { priority: 'high' })
      .then(task.resolve)
      .catch(task.reject)
      .finally(function () {
        _serialRunning = false;
        setTimeout(_runSerialNext, 50);
      });
  }

  function runSerialTask(workerUrl, message, transferables) {
    return new Promise(function (resolve, reject) {
      _serialQueue.push({ workerUrl: workerUrl, message: message, transferables: transferables || [], resolve: resolve, reject: reject });
      _runSerialNext();
    });
  }

  // ── Memory-aware dispatch helper ───────────────────────────────────────────
  // Decides whether to use serial, giant, or normal dispatch.
  function dispatchMemoryAware(workerUrl, message, transferables, opts) {
    if (!window.MemPressure) return routeTask(workerUrl, message, transferables, opts);
    var tier = window.MemPressure.tier();
    if (tier === 'abort') {
      // Under abort pressure: serialize everything
      return runSerialTask(workerUrl, message, transferables);
    }
    return routeTask(workerUrl, message, transferables, opts);
  }

  // ── Emergency worker termination ──────────────────────────────────────────
  // Terminates all WorkerPool slots for a given URL to free memory.
  function emergencyTerminatePool(workerUrl) {
    var pool = window.WorkerPool;
    if (!pool || !pool.terminatePool) return;
    try {
      pool.terminatePool(workerUrl);
      _recordTelemetry('emergencyTerminate', { workerUrl: workerUrl });
    } catch (_) {}
  }

  // Terminate all known lanes
  function emergencyTerminateAll() {
    Object.values(LANES).forEach(function (url) {
      emergencyTerminatePool(url);
    });
    // Cancel all giant queue tasks
    var pending = _giantQueue.splice(0);
    pending.forEach(function (t) {
      try { t.reject(new Error('emergency_terminate')); } catch (_) {}
    });
    _giantRunning = false;
    _recordTelemetry('emergencyTerminateAll', { pendingGiant: pending.length });
  }

  // ── Worker RAM budgeting ───────────────────────────────────────────────────
  // Returns true if it is safe to spawn another worker for this tool.
  function canAffordWorker(toolId, fileSizeBytes, pageCount) {
    if (!window.MemPressure) return true;
    var needed  = estimateTaskMemoryMB(toolId, fileSizeBytes, pageCount) * MB;
    var avail   = window.MemPressure.memAvail();
    var safetyF = 1.8;
    return (needed * safetyF) < avail;
  }

  // ── Pre-warm OCR lane ──────────────────────────────────────────────────────
  function prewarmOcrLane() {
    var pool = window.WorkerPool;
    if (!pool || !pool.prewarm) return;
    try { pool.prewarm(LANES.OCR); } catch (_) {}
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  function getStats() {
    var poolStats = {};
    try {
      poolStats = window.WorkerPool ? window.WorkerPool.getStats() : {};
    } catch (_) {}
    return {
      giant:      Object.assign({}, _giantStats, { queueLength: _giantQueue.length }),
      serial:     { queued: _serialQueue.length, running: _serialRunning },
      workerPool: poolStats,
      maxWorkers: maxWorkersForTier(),
    };
  }

  // ── Telemetry helper ──────────────────────────────────────────────────────
  function _recordTelemetry(event, data) {
    if (window.GiantFileTelemetry) {
      window.GiantFileTelemetry.record('routing.' + event, data);
    }
  }

  // ── Hook MemPressure for auto-termination ──────────────────────────────────
  if (window.MemPressure) {
    window.MemPressure.onTierChange(function (newTier) {
      if (newTier === 'abort') {
        emergencyTerminateAll();
      }
    });
  } else {
    // Defer hook until MemPressure is ready
    var _hookRetries = 0;
    var _hookIv = setInterval(function () {
      if (window.MemPressure || _hookRetries++ > 20) {
        clearInterval(_hookIv);
        if (window.MemPressure) {
          window.MemPressure.onTierChange(function (newTier) {
            if (newTier === 'abort') emergencyTerminateAll();
          });
        }
      }
    }, 500);
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.GiantFileRouting = {
    version: '1.0',
    LANES:   LANES,
    GIANT_THRESHOLD_MB: GIANT_THRESHOLD_MB,
    // Memory estimation
    estimateTaskMemoryMB:  estimateTaskMemoryMB,
    canAffordWorker:       canAffordWorker,
    // Dispatch
    routeTask:             routeTask,
    runGiantTask:          runGiantTask,
    runSerialTask:         runSerialTask,
    dispatchMemoryAware:   dispatchMemoryAware,
    // Emergency
    emergencyTerminatePool: emergencyTerminatePool,
    emergencyTerminateAll:  emergencyTerminateAll,
    // Utilities
    prewarmOcrLane:        prewarmOcrLane,
    maxWorkersForTier:     maxWorkersForTier,
    getStats:              getStats,
  };

}());
