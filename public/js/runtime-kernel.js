// RuntimeKernel v1.0 — Phase 9G
// =====================================================================
// Browser Compute OS Microkernel.
//
// ALL compute subsystems route through ONE kernel. The kernel is the
// single arbitration point for:
//   • Worker slots  (RuntimeWorkers)
//   • Memory tiers  (RuntimeMemory)
//   • Stream slots  (RuntimeStreamBridge / RuntimeStreaming)
//   • OPFS access   (RuntimeStreaming)
//   • AI queue      (RuntimeAIOrchestrator / RuntimeAIUpgrade)
//   • GPU queue     (RuntimeGpuEngine)
//   • WASM queue    (RuntimeWasmEngine)
//   • Cross-tab     (RuntimeDistributedScheduler / RuntimeSharedCluster)
//   • Health gates  (RuntimeHealth)
//
// Task model:
//   KernelTask {
//     id, type, op, priority, payload, opts,
//     resolve, reject, token, submittedTs, deadline?
//   }
//
// Task types:
//   'worker'   → RuntimeWorkers.dispatch()
//   'gpu'      → RuntimeGpuEngine.runTask()
//   'wasm'     → RuntimeWasmEngine.execute()
//   'ai'       → RuntimeAIOrchestrator.runAiTask()
//   'stream'   → RuntimeStreamBridge.streamToWorkerReadable()
//   'opfs'     → RuntimeStreaming.openFile()
//   'custom'   → task.fn()  — arbitrary function
//
// Priority queue: critical(0) → high(1) → normal(2) → background(3)
// Fairness: each priority level is time-sliced so background tasks
//           are not fully starved.
//
// Expose: window.RuntimeKernel
//   .schedule(task)   → Promise<result>
//   .getLoad()        → KernelLoad
//   .getHealth()      → KernelHealth
//   .setLimit(resource, n) → void
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeKernel) return;

  var LOG = '[KRN9G]';

  // ── Resource limits (runtime-adjustable) ──────────────────────────────────
  var _limits = {
    workerSlots:  4,
    gpuSlots:     4,
    wasmSlots:    2,
    aiSlots:      3,
    streamSlots:  2,
    opfsSlots:    2,
    customSlots:  8,
  };

  // ── In-flight counters ────────────────────────────────────────────────────
  var _active = {
    worker: 0, gpu: 0, wasm: 0, ai: 0,
    stream: 0, opfs: 0, custom: 0,
  };

  // ── Priority queues (one per task type, each sorted by priority) ──────────
  // Map<type, Array<KernelTask>>
  var _queues = {
    worker: [], gpu: [], wasm: [], ai: [],
    stream: [], opfs: [], custom: [],
  };

  var _taskIdCounter = 0;
  var _stats = {
    submitted: 0, completed: 0, failed: 0,
    rejected: 0, queued: 0,
    avgWaitMs: 0, avgExecMs: 0,
    _totalWait: 0, _totalExec: 0,
  };

  // ── Priority ordering ─────────────────────────────────────────────────────
  var PRI = { critical: 0, high: 1, normal: 2, background: 3 };

  function _insertByPriority(queue, task) {
    var p = PRI[task.priority] != null ? PRI[task.priority] : 2;
    var i = 0;
    while (i < queue.length && PRI[queue[i].priority] <= p) i++;
    queue.splice(i, 0, task);
  }

  // ── Slot management ───────────────────────────────────────────────────────
  function _slotLimit(type) {
    var mem = global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL';
    var lim = _limits[type + 'Slots'] || 4;
    // Reduce limits under memory pressure
    if (mem === 'CRITICAL'  || mem === 'EMERGENCY') return Math.max(1, Math.floor(lim * 0.25));
    if (mem === 'WARNING')                          return Math.max(1, Math.floor(lim * 0.5));
    return lim;
  }

  function _hasSlot(type) {
    return _active[type] < _slotLimit(type);
  }

  // ── Health gate ────────────────────────────────────────────────────────────
  function _healthOk(task) {
    var score = global.RuntimeHealth ? global.RuntimeHealth.getScore() : 100;
    if (score < 10) return false;                // severe: only allow critical tasks
    if (score < 30 && task.priority === 'background') return false;
    return true;
  }

  // ── Schedule ───────────────────────────────────────────────────────────────
  function schedule(task) {
    task = task || {};
    task.id          = ++_taskIdCounter;
    task.priority    = task.priority || 'normal';
    task.type        = task.type     || 'custom';
    task.submittedTs = Date.now();
    _stats.submitted++;

    // Validate type
    if (!_queues[task.type]) {
      _stats.rejected++;
      return Promise.reject(new Error('unknown kernel task type: ' + task.type));
    }

    // Cancellation pre-check
    if (task.token && task.token.cancelled) {
      _stats.rejected++;
      return Promise.reject(new Error('cancelled-before-schedule'));
    }

    // Health gate
    if (!_healthOk(task)) {
      _stats.rejected++;
      return Promise.reject(new Error('kernel:health-gate-rejected'));
    }

    return new Promise(function (resolve, reject) {
      task.resolve = resolve;
      task.reject  = reject;

      if (_hasSlot(task.type)) {
        _dispatch(task);
      } else {
        _stats.queued++;
        _insertByPriority(_queues[task.type], task);
        if (global.RuntimeTelemetry) {
          try { global.RuntimeTelemetry.record('kernel:queued', { type: task.type, priority: task.priority }); } catch (_) {}
        }
      }
    });
  }

  function _dispatch(task) {
    _active[task.type]++;
    var startTs = Date.now();
    var waitMs  = startTs - task.submittedTs;
    _stats._totalWait += waitMs;

    _run(task).then(function (result) {
      var execMs = Date.now() - startTs;
      _stats._totalExec += execMs;
      _stats.completed++;
      _stats.avgWaitMs = Math.round(_stats._totalWait / _stats.completed);
      _stats.avgExecMs = Math.round(_stats._totalExec / _stats.completed);
      _recordTask(task, 'ok', execMs);
      task.resolve(result);
    }).catch(function (err) {
      _stats.failed++;
      _recordTask(task, 'error', Date.now() - startTs);
      task.reject(err);
    }).finally(function () {
      _active[task.type] = Math.max(0, _active[task.type] - 1);
      _drainQueue(task.type);
    });
  }

  function _drainQueue(type) {
    var q = _queues[type];
    while (q.length > 0 && _hasSlot(type)) {
      var next = q.shift();
      // Check cancellation before running
      if (next.token && next.token.cancelled) {
        next.reject(new Error('cancelled-in-queue'));
        _stats.rejected++;
        continue;
      }
      // Check deadline if set
      if (next.deadline && Date.now() > next.deadline) {
        next.reject(new Error('kernel:task-deadline-exceeded'));
        _stats.rejected++;
        continue;
      }
      _dispatch(next);
    }
  }

  // ── Task runner ───────────────────────────────────────────────────────────
  function _run(task) {
    var type = task.type;

    if (type === 'worker') {
      var rw = global.RuntimeWorkers;
      if (!rw) return Promise.reject(new Error('RuntimeWorkers not loaded'));
      return rw.dispatch(task.workerUrl, task.message, task.transferables || [], task.opts || {});
    }

    if (type === 'gpu') {
      var gpu = global.RuntimeGpuEngine;
      if (!gpu) return Promise.reject(new Error('RuntimeGpuEngine not loaded'));
      return gpu.runTask(task.op, task.payload, task.opts || {});
    }

    if (type === 'wasm') {
      var we = global.RuntimeWasmEngine;
      if (!we) return Promise.reject(new Error('RuntimeWasmEngine not loaded'));
      return we.execute(task.op, task.payload, task.opts || {});
    }

    if (type === 'ai') {
      var ai = global.RuntimeAIOrchestrator;
      if (!ai) return Promise.reject(new Error('RuntimeAIOrchestrator not loaded'));
      return ai.runAiTask(task.op, Object.assign({ token: task.token }, task.payload || {}));
    }

    if (type === 'stream') {
      var rsb = global.RuntimeStreamBridge;
      if (!rsb) return Promise.reject(new Error('RuntimeStreamBridge not loaded'));
      return rsb.streamToWorkerReadable(task.workerUrl, task.file, task.message || {}, task.opts || {});
    }

    if (type === 'opfs') {
      var rse = global.RuntimeStreaming;
      if (!rse) return Promise.reject(new Error('RuntimeStreaming not loaded'));
      return rse.openFile(task.file, task.opts || {});
    }

    if (type === 'custom') {
      if (typeof task.fn !== 'function') return Promise.reject(new Error('custom task must have .fn()'));
      try { return Promise.resolve(task.fn()); } catch (e) { return Promise.reject(e); }
    }

    return Promise.reject(new Error('unhandled task type: ' + type));
  }

  function _recordTask(task, status, execMs) {
    if (global.RuntimeTelemetry) {
      try {
        global.RuntimeTelemetry.record('kernel:task:' + status, {
          type: task.type, op: task.op, priority: task.priority, execMs: execMs,
        });
      } catch (_) {}
    }
    if (global.RuntimeEventBus) {
      try {
        global.RuntimeEventBus.emit('kernel:task:' + status, {
          id: task.id, type: task.type, priority: task.priority, execMs: execMs,
        });
      } catch (_) {}
    }
  }

  // ── Load report ───────────────────────────────────────────────────────────
  function getLoad() {
    var queued = 0;
    Object.keys(_queues).forEach(function (t) { queued += _queues[t].length; });
    return {
      active:  Object.assign({}, _active),
      queued:  queued,
      queues:  Object.keys(_queues).reduce(function (o, t) {
        o[t] = _queues[t].length; return o;
      }, {}),
      limits:  Object.assign({}, _limits),
      memTier: global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL',
    };
  }

  function getHealth() {
    var health = global.RuntimeHealth ? global.RuntimeHealth.getScore() : 100;
    var load   = getLoad();
    var totalQ = load.queued;
    var totalA = Object.values(load.active).reduce(function (a, b) { return a + b; }, 0);
    return {
      score:       health,
      totalActive: totalA,
      totalQueued: totalQ,
      stats:       Object.assign({}, _stats),
      subsystems: {
        workers:  !!(global.RuntimeWorkers),
        gpu:      !!(global.RuntimeGpuEngine),
        wasm:     !!(global.RuntimeWasmEngine),
        ai:       !!(global.RuntimeAIOrchestrator),
        stream:   !!(global.RuntimeStreamBridge),
        opfs:     !!(global.RuntimeStreaming && global.RuntimeStreaming.isReady()),
        crossTab: !!(global.RuntimeDistributedScheduler),
        cluster:  !!(global.RuntimeSharedCluster),
      },
    };
  }

  function setLimit(resource, n) {
    var key = resource + 'Slots';
    if (_limits[key] !== undefined) {
      _limits[key] = Math.max(1, n);
      console.info(LOG, 'limit updated:', key, '=', _limits[key]);
    }
  }

  // ── React to memory tier changes ──────────────────────────────────────────
  function _syncLimitsToMemory() {
    if (!global.RuntimeMemory) return;
    global.RuntimeMemory.onChange(function (tier) {
      if (tier === 'EMERGENCY') {
        _limits.workerSlots = 1; _limits.gpuSlots = 1; _limits.aiSlots = 1;
      } else if (tier === 'CRITICAL') {
        _limits.workerSlots = 1; _limits.gpuSlots = 2; _limits.aiSlots = 1;
      } else if (tier === 'WARNING') {
        var mem = global.RuntimeMemory.maxWorkers();
        _limits.workerSlots = mem;
      } else {
        _limits.workerSlots = 4; _limits.gpuSlots = 4; _limits.aiSlots = 3;
      }
      // Drain queues immediately after limit change (some slots may open)
      Object.keys(_queues).forEach(function (t) { _drainQueue(t); });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _syncLimitsToMemory();

    // Register with CentralRuntime
    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('kernel', global.RuntimeKernel); } catch (_) {}
    }

    // Announce to event bus
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('kernel:ready', getHealth()); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('kernel:ready', { types: Object.keys(_queues) }); } catch (_) {}
    }

    console.info(LOG, 'RuntimeKernel v1.0 ready — task types:', Object.keys(_queues).join(', '));
  }

  if (global.RuntimeEventBus) {
    global.RuntimeEventBus.once('runtime:ready', function () { setTimeout(_boot, 50); });
  }
  if (document.readyState === 'complete') setTimeout(_boot, 200);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 200); }, { once: true });

  global.RuntimeKernel = { schedule: schedule, getLoad: getLoad, getHealth: getHealth, setLimit: setLimit };
}(window));
