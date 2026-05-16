// RuntimeAIScheduler v1.0 — Phase 25A-D
// Advanced AI task scheduler with priority queues, device profiling,
// adaptive quality adjustments, IDB task persistence, and telemetry.
// Builds ON TOP of RuntimeScheduler — does NOT replace it.
//
// Priority tiers (highest → lowest):
//   gpu-critical: tasks that must run on GPU immediately
//   high:         user-initiated AI (OCR, bg-remove, summarize)
//   normal:       batch AI (translate, enhance, detect)
//   background:   pre-warm, prefetch, warm-up
//
// Device adaptation:
//   gpuTier:   'webgpu' | 'webgl' | 'cpu'
//   ramTier:   'high' (>4GB) | 'medium' (2-4GB) | 'low' (<2GB)
//   thermal:   'nominal' | 'warm' | 'hot'  (estimated)
//   network:   '4g' | '3g' | 'slow'
//   battery:   { charging, level }
//
// IDB persistence:
//   DB: iplv-ai-q | store: tasks
//   On schedule: write task → on complete/cancel: delete
//   On init: restore pending → replay with lowered priority
//
// Exposed as: window.RuntimeAIScheduler

(function (G) {
  'use strict';

  if (G.RuntimeAIScheduler) return;

  var VERSION = '1.0';
  var LOG     = '[AIS25]';

  var IDB_DB      = 'iplv-ai-q';
  var IDB_VERSION = 1;
  var IDB_STORE   = 'tasks';

  function _log(msg, d) { console.debug(LOG, msg, d !== undefined ? d : ''); }
  function _s(fn) { try { return fn(); } catch (_) { return null; } }

  // ── Task queue ─────────────────────────────────────────────────────────────
  var PRIORITIES = ['gpu-critical', 'high', 'normal', 'background'];
  var _queues = {
    'gpu-critical': [],
    'high':         [],
    'normal':       [],
    'background':   [],
  };
  var _tasks   = new Map();   // taskId → task meta
  var _taskSeq = 0;
  var _running = 0;
  var _paused  = false;

  // Concurrency caps per device tier
  var CONCURRENCY = { 'webgpu': 3, 'webgl': 2, 'cpu': 1 };

  function _maxConcurrent() {
    return CONCURRENCY[_profile.gpuTier] || 1;
  }

  // ── Device profile ─────────────────────────────────────────────────────────
  var _profile = {
    gpuTier:  'cpu',    // detected below
    ramTier:  'medium',
    thermal:  'nominal',
    network:  '4g',
    battery:  { charging: true, level: 1.0 },
    score:    50,       // 0-100 capability score
  };

  function _detectGPUTier() {
    if (navigator.gpu) { _profile.gpuTier = 'webgpu'; return; }
    try {
      var cvs = document.createElement('canvas');
      var gl  = cvs.getContext('webgl2') || cvs.getContext('webgl');
      if (gl) { _profile.gpuTier = 'webgl'; return; }
    } catch (_) {}
    _profile.gpuTier = 'cpu';
  }

  function _detectRAMTier() {
    var mem = navigator.deviceMemory || 4;
    _profile.ramTier = mem >= 6 ? 'high' : mem >= 3 ? 'medium' : 'low';
  }

  function _detectNetwork() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return;
    var eff = conn.effectiveType || '4g';
    _profile.network = eff;
  }

  function _detectBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(function (b) {
      _profile.battery = { charging: b.charging, level: b.level };
      b.addEventListener('chargingchange', function () {
        _profile.battery.charging = b.charging;
        _adjustQuality();
      });
      b.addEventListener('levelchange', function () {
        _profile.battery.level = b.level;
        _adjustQuality();
      });
    }).catch(function () {});
  }

  function _computeScore() {
    var s = 50;
    if (_profile.gpuTier === 'webgpu') s += 30;
    else if (_profile.gpuTier === 'webgl') s += 15;
    if (_profile.ramTier === 'high')    s += 15;
    else if (_profile.ramTier === 'low') s -= 15;
    if (_profile.thermal === 'hot')     s -= 20;
    else if (_profile.thermal === 'warm') s -= 10;
    if (!_profile.battery.charging && _profile.battery.level < 0.2) s -= 10;
    if (_profile.network === 'slow')    s -= 5;
    _profile.score = Math.max(0, Math.min(100, s));
  }

  // ── Adaptive quality adjustments ─────────────────────────────────────────
  // Exposed so tools can read recommended settings.
  var _quality = {
    ocrMode:     'balanced', // 'fast' | 'balanced' | 'accurate'
    resolution:  1.0,        // image scale factor
    batchSize:   4,
    workerCount: 1,
  };

  function _adjustQuality() {
    _computeScore();
    var sc = _profile.score;
    // OCR mode
    _quality.ocrMode = sc >= 70 ? 'accurate' : sc >= 40 ? 'balanced' : 'fast';
    // Resolution
    _quality.resolution = sc >= 70 ? 1.0 : sc >= 40 ? 0.75 : 0.5;
    // Batch size
    _quality.batchSize = sc >= 70 ? 8 : sc >= 40 ? 4 : 2;
    // Worker count
    _quality.workerCount = _maxConcurrent();
    // Integrate with RuntimeMemory if available
    _s(function () {
      var rm = G.RuntimeMemory;
      if (!rm) return;
      var tier = rm.getTier ? rm.getTier() : 'NORMAL';
      if (tier === 'CRITICAL' || tier === 'EMERGENCY') {
        _quality.ocrMode    = 'fast';
        _quality.resolution = 0.5;
        _quality.batchSize  = 2;
      }
    });
    _log('quality adjusted', _quality);
  }

  function _profileDevices() {
    _detectGPUTier();
    _detectRAMTier();
    _detectNetwork();
    _detectBattery();
    _computeScore();
    _adjustQuality();
    _log('device profile', _profile);
  }

  // Thermal: estimate from benchmark timing (rough heuristic)
  function _benchmarkThermal() {
    var t0 = performance.now();
    var sum = 0;
    for (var i = 0; i < 2000000; i++) sum += Math.sqrt(i);
    var elapsed = performance.now() - t0;
    // On hot device, this takes longer due to throttling
    if (elapsed > 150)      _profile.thermal = 'hot';
    else if (elapsed > 80)  _profile.thermal = 'warm';
    else                    _profile.thermal = 'nominal';
    _adjustQuality();
    return sum; // prevent dead-code elimination
  }

  // ── Telemetry ──────────────────────────────────────────────────────────────
  var _tel = {
    total:       0,
    completed:   0,
    failed:      0,
    gpuCount:    0,  // tasks that ran on GPU
    cpuCount:    0,  // tasks that ran on CPU (fallback)
    infTimes:    [], // rolling 50 inference times (ms)
  };

  function _telRecord(taskMeta, outcome, durationMs) {
    _tel.total++;
    if (outcome === 'ok')     _tel.completed++;
    else if (outcome === 'fail') _tel.failed++;
    if (taskMeta.gpuUsed) _tel.gpuCount++;
    else                  _tel.cpuCount++;
    if (durationMs > 0) {
      _tel.infTimes.push(durationMs);
      if (_tel.infTimes.length > 50) _tel.infTimes.shift();
    }
    _s(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('ai-scheduler.' + outcome, {
          type: taskMeta.type,
          priority: taskMeta.priority,
          durationMs: durationMs,
          gpuUsed: !!taskMeta.gpuUsed,
        });
      }
    });
  }

  function _getTelStats() {
    var times = _tel.infTimes;
    var avgMs = times.length ? Math.round(times.reduce(function (a, b) { return a + b; }, 0) / times.length) : 0;
    return {
      total:        _tel.total,
      completed:    _tel.completed,
      failed:       _tel.failed,
      failureRate:  _tel.total ? (_tel.failed / _tel.total) : 0,
      gpuRatio:     _tel.total ? (_tel.gpuCount / _tel.total) : 0,
      fallbackRatio:_tel.total ? (_tel.cpuCount / _tel.total) : 0,
      avgInferenceMs: avgMs,
    };
  }

  // ── IDB persistence ────────────────────────────────────────────────────────
  var _db = null;

  function _openIDB() {
    return new Promise(function (resolve) {
      if (!('indexedDB' in window)) { resolve(null); return; }
      var req = indexedDB.open(IDB_DB, IDB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'taskId' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function () { resolve(null); };
    });
  }

  function _idbPut(task) {
    if (!_db) return;
    try {
      var tx = _db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({
        taskId:   task.taskId,
        type:     task.type,
        priority: task.priority,
        ts:       task.ts,
        meta:     task.meta || null,
      });
    } catch (_) {}
  }

  function _idbDelete(taskId) {
    if (!_db) return;
    try {
      var tx = _db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(taskId);
    } catch (_) {}
  }

  function _idbGetAll() {
    return new Promise(function (resolve) {
      if (!_db) { resolve([]); return; }
      try {
        var tx  = _db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror   = function () { resolve([]); };
      } catch (_) { resolve([]); }
    });
  }

  // ── Task scheduling ────────────────────────────────────────────────────────
  function _genId() { return 'ait_' + (++_taskSeq) + '_' + Date.now().toString(36); }

  function schedule(type, fn, opts) {
    opts = opts || {};
    var priority = PRIORITIES.indexOf(opts.priority) !== -1 ? opts.priority : 'normal';
    var taskId   = opts.taskId || _genId();
    var task = {
      taskId:   taskId,
      type:     type,
      priority: priority,
      fn:       fn,
      ts:       Date.now(),
      meta:     opts.meta || null,
      gpuUsed:  false,
      _resolve: null,
      _reject:  null,
    };

    var promise = new Promise(function (resolve, reject) {
      task._resolve = resolve;
      task._reject  = reject;
    });

    _queues[priority].push(task);
    _tasks.set(taskId, task);
    _idbPut(task);

    _log('scheduled', { taskId: taskId, type: type, priority: priority });
    setTimeout(_tick, 0);
    return { taskId: taskId, promise: promise };
  }

  function cancel(taskId) {
    var task = _tasks.get(taskId);
    if (!task) return false;
    // Remove from queue
    var q = _queues[task.priority];
    var idx = q.indexOf(task);
    if (idx !== -1) q.splice(idx, 1);
    _tasks.delete(taskId);
    _idbDelete(taskId);
    if (task._reject) task._reject(new Error('cancelled'));
    _log('cancelled', { taskId: taskId });
    return true;
  }

  // ── Dispatch loop ──────────────────────────────────────────────────────────
  function _tick() {
    if (_paused) return;
    var maxC = _maxConcurrent();
    while (_running < maxC) {
      var task = _dequeue();
      if (!task) break;
      _dispatch(task);
    }
  }

  function _dequeue() {
    for (var i = 0; i < PRIORITIES.length; i++) {
      var q = _queues[PRIORITIES[i]];
      if (q.length) return q.shift();
    }
    return null;
  }

  function _dispatch(task) {
    _running++;
    var t0 = performance.now();
    // Check GPU availability for this task
    task.gpuUsed = (_profile.gpuTier === 'webgpu') && (task.type !== 'background');

    // Delegate to RuntimeScheduler if available for concurrency control
    var runFn = function () {
      return new Promise(function (resolve, reject) {
        try {
          var result = task.fn({ quality: _quality, profile: _profile, gpuUsed: task.gpuUsed });
          if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
          } else {
            resolve(result);
          }
        } catch (err) {
          reject(err);
        }
      });
    };

    var sched = G.RuntimeScheduler;
    var runner = (sched && sched.run)
      ? function () { return sched.run(task.type, runFn, { priority: task.priority, type: 'ai' }); }
      : runFn;

    runner().then(function (result) {
      var durationMs = performance.now() - t0;
      _telRecord(task, 'ok', durationMs);
      _tasks.delete(task.taskId);
      _idbDelete(task.taskId);
      _running = Math.max(0, _running - 1);
      if (task._resolve) task._resolve(result);
      setTimeout(_tick, 0);
    }).catch(function (err) {
      var durationMs = performance.now() - t0;
      _telRecord(task, 'fail', durationMs);
      _tasks.delete(task.taskId);
      _idbDelete(task.taskId);
      _running = Math.max(0, _running - 1);
      if (task._reject) task._reject(err);
      setTimeout(_tick, 0);
    });
  }

  // ── Restore persisted tasks on init ────────────────────────────────────────
  function _restorePersisted() {
    _idbGetAll().then(function (rows) {
      if (!rows.length) return;
      _log('restoring ' + rows.length + ' persisted AI tasks');
      rows.forEach(function (row) {
        // Re-queue as background priority (we don't have the original fn)
        // Store metadata so caller can detect and replay
        _restoredTasks.push(row);
      });
    });
  }
  var _restoredTasks = [];

  // ── Init ────────────────────────────────────────────────────────────────────
  _openIDB().then(function (db) {
    _db = db;
    _restorePersisted();
  });

  // Profile immediately, re-benchmark thermal in the background
  _profileDevices();
  setTimeout(function () { try { _benchmarkThermal(); } catch (_) {} }, 3000);

  // Re-adjust quality whenever memory pressure changes
  _s(function () {
    var eb = G.RuntimeEventBus;
    if (eb && eb.on) {
      eb.on('memory:tier-change', function () { _adjustQuality(); });
    }
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  var RuntimeAIScheduler = {
    VERSION: VERSION,

    /** Schedule an AI task. Returns { taskId, promise }. */
    schedule: schedule,

    /** Cancel a queued (not yet running) task by ID. */
    cancel: cancel,

    /** Pause all AI dispatching (e.g. during page unload) */
    pause: function () { _paused = true; },

    /** Resume dispatching */
    resume: function () { _paused = false; setTimeout(_tick, 0); },

    /** Reset all queues (emergency) */
    reset: function () {
      PRIORITIES.forEach(function (p) {
        _queues[p].forEach(function (t) {
          if (t._reject) t._reject(new Error('reset'));
        });
        _queues[p] = [];
      });
      _tasks.clear();
      _running = 0;
      _log('queues reset');
    },

    /** Current device profile */
    getDeviceProfile: function () { return Object.assign({}, _profile); },

    /** Recommended quality settings for the current device */
    getQuality: function () { return Object.assign({}, _quality); },

    /** Queue depths */
    getQueueStats: function () {
      var depths = {};
      PRIORITIES.forEach(function (p) { depths[p] = _queues[p].length; });
      return { depths: depths, running: _running, paused: _paused, maxConcurrent: _maxConcurrent() };
    },

    /** Telemetry stats */
    getTelemetry: function () { return _getTelStats(); },

    /** Tasks restored from IDB (call to detect pending from previous session) */
    getPersisted: function () { return _restoredTasks.slice(); },

    /** Force re-profile device (call after GPU context change etc.) */
    reprofile: function () { _profileDevices(); },

    audit: function () {
      var r = {
        version:  VERSION,
        device:   this.getDeviceProfile(),
        quality:  this.getQuality(),
        queues:   this.getQueueStats(),
        tel:      this.getTelemetry(),
        persisted:this.getPersisted().length,
      };
      console.group(LOG + ' RuntimeAIScheduler audit');
      console.log('Device:', r.device);
      console.log('Quality:', r.quality);
      console.log('Queues:', r.queues);
      console.log('Telemetry:', r.tel);
      console.groupEnd();
      return r;
    },
  };

  G.RuntimeAIScheduler = RuntimeAIScheduler;
  _log('RuntimeAIScheduler v' + VERSION + ' ready — gpuTier=' + _profile.gpuTier + ' score=' + _profile.score);

}(window));
