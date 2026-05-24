// RuntimeTaskOrchestrator v1.0 — Arc 7 / Phase D
// =====================================================================
// Enterprise task orchestration. Distinct from RuntimeTaskScheduler
// (Phase 2 priority queue) — this provides the EXECUTION GRAPH layer:
//
//   - Task priority lanes: CRITICAL / HIGH / NORMAL / LOW / BACKGROUND
//   - Cooperative scheduling: yields to UI between task batches
//   - Runtime execution graph: tasks declare dependencies; graph resolves order
//   - Worker affinity: task types routed to preferred worker families
//   - Congestion prediction: queue depth + thermal tier → throttle
//   - Thermal-aware execution: reduce concurrency under heat pressure
//
// AI jobs never block simple tool operations (CRITICAL lane reserved for UI).
// Large OCR/translate jobs auto-throttled to BACKGROUND under pressure.
//
// Integrates with RuntimeProcessorWorkers (Arc 6) for pool coordination.
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeTaskOrchestrator) return;

  var LOG     = '[TaskOrchestrator]';
  var VERSION = '1.0';

  // ── Priority lanes ────────────────────────────────────────────────
  var CRITICAL   = 0;  // UI-blocking — run immediately
  var HIGH       = 1;  // Interactive user operation
  var NORMAL     = 2;  // Standard tool processing
  var LOW        = 3;  // Background processing
  var BACKGROUND = 4;  // Deferred / deprioritized

  var LANE_NAMES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW', 'BACKGROUND'];

  // ── Config ────────────────────────────────────────────────────────
  var _cores        = navigator.hardwareConcurrency || 2;
  var MAX_CONCUR    = { 0: 4, 1: 3, 2: 2, 3: 1, 4: 1 };  // per lane
  var TICK_MS       = 16;   // cooperative scheduling interval
  var THERMAL_CHECK = 30 * 1000;

  // ── Worker affinity per task type ─────────────────────────────────
  var TYPE_AFFINITY = {
    'compress':    'compress',
    'merge':       'organize',
    'split':       'split',
    'ocr':         'ocr',
    'translate':   'ai-nlp',
    'ai-summarize':'ai-nlp',
    'convert':     'convert',
    'watermark':   'edit',
    'repair':      'repair',
    'image':       'image',
  };

  // ── State ─────────────────────────────────────────────────────────
  var _lanes       = [[], [], [], [], []];  // per-priority queue
  var _graph       = {};  // taskId → { deps: [], state, fn, priority, meta }
  var _running     = {};  // taskId → { startedAt, lane }
  var _runningCount = 0;
  var _thermalTier = 'nominal';
  var _ticking     = false;
  var _metrics     = { submitted: 0, completed: 0, dropped: 0, throttled: 0, graphResolved: 0 };
  var _telemetry   = [];
  var _idSeq       = 0;

  function _tel(ev, data) {
    _telemetry.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_telemetry.length > 120) _telemetry.shift();
  }

  function _genId() { return 'orch_' + (++_idSeq) + '_' + Date.now().toString(36); }

  // ── Thermal tier ──────────────────────────────────────────────────
  function _refreshThermal() {
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) { _thermalTier = pw.getThermalTier() || 'nominal'; return; }
      var ai = G.RuntimeAIScheduler;
      if (ai && ai.getProfile) { _thermalTier = (ai.getProfile().thermal) || 'nominal'; }
    } catch (_) {}
  }
  setInterval(_refreshThermal, THERMAL_CHECK);
  _refreshThermal();

  function _maxConcurrency() {
    // Reduce under thermal pressure
    var base = Math.max(1, _cores - 1);
    if (_thermalTier === 'critical') return 1;
    if (_thermalTier === 'hot')      return Math.min(2, base);
    return base;
  }

  function _laneLimit(lane) {
    var max = MAX_CONCUR[lane] || 1;
    var thermal = _maxConcurrency();
    return lane === CRITICAL ? Math.min(max, thermal + 2) : Math.min(max, thermal);
  }

  // ── Submit a task ─────────────────────────────────────────────────
  // spec: { fn, priority?, type?, deps?, onComplete?, onError?, meta? }
  function submit(spec) {
    if (typeof spec.fn !== 'function') return null;
    var id       = _genId();
    var priority = Math.max(0, Math.min(4, spec.priority || NORMAL));
    var task     = {
      id:         id,
      fn:         spec.fn,
      priority:   priority,
      type:       spec.type    || 'generic',
      deps:       spec.deps    || [],
      onComplete: spec.onComplete || null,
      onError:    spec.onError    || null,
      meta:       spec.meta       || {},
      state:      'queued',
      submittedAt: Date.now(),
    };

    _graph[id] = task;
    _metrics.submitted++;
    _tel('submit', { id: id, lane: LANE_NAMES[priority], type: task.type, deps: task.deps.length });

    // Resolve graph immediately if no deps
    if (task.deps.length === 0) {
      _enqueue(task);
    } else {
      task.state = 'waiting';
    }

    if (!_ticking) _tick();
    return id;
  }

  function _enqueue(task) {
    _lanes[task.priority].push(task);
    task.state = 'ready';
  }

  // ── Check if a task's deps are all done ──────────────────────────
  function _depsResolved(task) {
    return task.deps.every(function (depId) {
      var dep = _graph[depId];
      return dep && dep.state === 'done';
    });
  }

  // ── Tick: cooperative scheduler ───────────────────────────────────
  function _tick() {
    _ticking = true;
    var ran  = 0;

    // Promote waiting tasks whose deps are now resolved
    Object.keys(_graph).forEach(function (id) {
      var task = _graph[id];
      if (task.state === 'waiting' && _depsResolved(task)) {
        _enqueue(task);
        _metrics.graphResolved++;
        _tel('graph-resolved', { id: id });
      }
    });

    // Congestion check
    var maxConc = _maxConcurrency();
    if (_runningCount >= maxConc) {
      _metrics.throttled++;
      setTimeout(_tick, TICK_MS * 4);
      return;
    }

    // Run tasks from highest to lowest priority
    for (var lane = CRITICAL; lane <= BACKGROUND; lane++) {
      var queue   = _lanes[lane];
      var laneMax = _laneLimit(lane);
      var laneRun = 0;

      while (queue.length && _runningCount < maxConc && laneRun < laneMax) {
        var task = queue.shift();
        if (!task || task.state === 'cancelled') continue;

        // Affinity: check if worker pool can accept
        var affFamily = TYPE_AFFINITY[task.type];
        if (affFamily) {
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && !pw.canAccept(affFamily)) {
              // Re-queue at lower priority if pool congested
              if (task.priority < BACKGROUND) {
                task.priority++;
                _lanes[task.priority].push(task);
                _metrics.throttled++;
                _tel('affinity-throttle', { id: task.id, family: affFamily });
              } else {
                _metrics.dropped++;
                task.state = 'dropped';
              }
              continue;
            }
            pw.taskStart && pw.taskStart(affFamily);
          } catch (_) {}
        }

        _runTask(task, affFamily);
        laneRun++;
        ran++;

        // Cooperative: yield to UI after CRITICAL + HIGH
        if (lane >= NORMAL && ran >= 2) break;
      }
    }

    var hasMore = _lanes.some(function (q) { return q.length > 0; });
    var hasWaiting = Object.keys(_graph).some(function (id) { return _graph[id].state === 'waiting'; });
    if (hasMore || hasWaiting || _runningCount > 0) {
      setTimeout(_tick, TICK_MS);
    } else {
      _ticking = false;
    }
  }

  function _runTask(task, affFamily) {
    task.state = 'running';
    _running[task.id] = { startedAt: Date.now(), lane: task.priority };
    _runningCount++;

    setTimeout(function () {
      try {
        task.fn();
        task.state = 'done';
        _metrics.completed++;
        try { task.onComplete && task.onComplete(); } catch (_) {}
        _tel('done', { id: task.id, ms: Date.now() - _running[task.id].startedAt });
      } catch (e) {
        task.state = 'error';
        try { task.onError && task.onError(e); } catch (_) {}
        _tel('error', { id: task.id, err: e && e.message });
      } finally {
        _runningCount = Math.max(0, _runningCount - 1);
        delete _running[task.id];
        if (affFamily) {
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && pw.taskEnd) pw.taskEnd(affFamily);
          } catch (_) {}
        }
        // Cleanup completed tasks
        if (task.state === 'done' || task.state === 'error') {
          setTimeout(function () { delete _graph[task.id]; }, 5000);
        }
      }
    }, 0);
  }

  // ── Cancel a task ─────────────────────────────────────────────────
  function cancel(id) {
    var task = _graph[id];
    if (task) { task.state = 'cancelled'; delete _graph[id]; }
    // Also cancel dependents
    Object.keys(_graph).forEach(function (tid) {
      var t = _graph[tid];
      if (t && t.deps.indexOf(id) !== -1) cancel(tid);
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    return {
      running:      _runningCount,
      queued:       _lanes.reduce(function (s, q) { return s + q.length; }, 0),
      waiting:      Object.keys(_graph).filter(function (id) { return _graph[id].state === 'waiting'; }).length,
      thermalTier:  _thermalTier,
      maxConcurrency: _maxConcurrency(),
      metrics:      Object.assign({}, _metrics),
      laneDepths:   _lanes.map(function (q) { return q.length; }),
    };
  }

  G.RuntimeTaskOrchestrator = Object.freeze({
    VERSION:    VERSION,
    CRITICAL:   CRITICAL,
    HIGH:       HIGH,
    NORMAL:     NORMAL,
    LOW:        LOW,
    BACKGROUND: BACKGROUND,
    submit:     submit,
    cancel:     cancel,
    getStats:   getStats,
    getTelemetry: function () { return _telemetry.slice(); },
    getThermalTier: function () { return _thermalTier; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — 5-lane cooperative orchestrator | maxConc:', _maxConcurrency());

}(window));
