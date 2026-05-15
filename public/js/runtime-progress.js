// Runtime Progress System v1.0 — Phase 2 (T026)
// Centralized progress tracking with: normalized events, aggregation,
// smoothing, retry-aware progress, multi-stage support, worker-aware progress.
// Prevents stuck bars, progress jumps, and infinite loading states.
//
// All tools emit progress through RuntimeProgress.report() instead of
// directly calling showProcessing(). Adapters bridge the gap so existing
// tool code continues to work unchanged.
//
// Integrates: RuntimeEventBus, RuntimeState, RuntimeTelemetry, RuntimeCancellation
//
// [FUTURE: UIRuntime] RuntimeProgress events will drive a unified progress
// HUD that overlays all tools, replacing per-tool showProcessing() calls.
//
// Exposed as: window.RuntimeProgress
(function () {
  'use strict';

  if (window.RuntimeProgress) return;

  var LOG = '[RP]';

  // ── Stage descriptor ──────────────────────────────────────────────────────
  // Multi-stage progress: each operation can declare N stages.
  // Overall progress = weighted average of all stage progress values.

  // Map<taskId, TaskProgress>
  var _tasks = new Map();

  var _taskIdCounter = 0;

  function _makeTask(opts) {
    opts = opts || {};
    var id = ++_taskIdCounter;
    var stages = Array.isArray(opts.stages) ? opts.stages : [{ name: opts.label || 'processing', weight: 1 }];
    var totalWeight = stages.reduce(function (s, st) { return s + (st.weight || 1); }, 0);

    var task = {
      id:          id,
      label:       opts.label || 'task-' + id,
      stages:      stages.map(function (st) {
        return { name: st.name, weight: st.weight || 1, progress: 0, done: false };
      }),
      totalWeight: totalWeight,
      startTs:     Date.now(),
      lastUpdate:  Date.now(),
      overall:     0,         // 0–100
      completed:   false,
      stalled:     false,
      token:       opts.token || null,  // RuntimeCancellation token
      stallTimer:  null,
    };

    _startStallWatcher(task, opts.stallTimeoutMs || 30000);
    return task;
  }

  // ── Stall detection ───────────────────────────────────────────────────────
  // If a task makes no progress in stallTimeoutMs, emit 'progress:stalled'
  var STALL_CHECK_MS = 5000;

  function _startStallWatcher(task, stallTimeoutMs) {
    var tid = setInterval(function () {
      if (task.completed || !_tasks.has(task.id)) { clearInterval(tid); return; }
      var sinceUpdate = Date.now() - task.lastUpdate;
      if (!task.stalled && sinceUpdate > stallTimeoutMs) {
        task.stalled = true;
        console.warn(LOG, 'task stalled:', task.label, '(' + Math.round(sinceUpdate / 1000) + 's)');
        if (window.RuntimeTelemetry) {
          try { window.RuntimeTelemetry.record('progress:stalled', { label: task.label, sinceMs: sinceUpdate }); } catch (_) {}
        }
        if (window.RuntimeEventBus) {
          try { window.RuntimeEventBus.emit('progress:stalled', { taskId: task.id, label: task.label }); } catch (_) {}
        }
      }
    }, STALL_CHECK_MS);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('rp-stall-' + task.id, tid);
    task.stallTimer = tid;
  }

  function _stopStallWatcher(task) {
    if (task.stallTimer) { clearInterval(task.stallTimer); task.stallTimer = null; }
  }

  // ── Overall progress calculation ──────────────────────────────────────────
  function _calcOverall(task) {
    var weighted = 0;
    task.stages.forEach(function (st) {
      weighted += (st.done ? 100 : st.progress) * st.weight;
    });
    return Math.round(weighted / task.totalWeight);
  }

  // ── Smoothing ─────────────────────────────────────────────────────────────
  // Prevent backwards progress jumps and large instantaneous jumps > 30%.
  function _smooth(task, newOverall) {
    var old = task.overall;
    if (newOverall < old) return old; // no backwards movement
    // Cap forward jump at 30 per update (smoothing)
    if (newOverall - old > 30) return old + 30;
    return newOverall;
  }

  // ── Core report ───────────────────────────────────────────────────────────
  // report(taskId, stageIndex, pct, message?)
  // pct: 0–100
  function report(taskId, stageIndex, pct, message) {
    var task = _tasks.get(taskId);
    if (!task || task.completed) return;

    // Check cancellation
    if (task.token && task.token.cancelled) return;

    stageIndex = stageIndex || 0;
    var stage = task.stages[stageIndex];
    if (!stage) return;

    pct = Math.max(0, Math.min(100, pct || 0));
    stage.progress = pct;
    if (pct >= 100) stage.done = true;

    task.lastUpdate = Date.now();
    task.stalled = false;

    var rawOverall = _calcOverall(task);
    var smoothed   = _smooth(task, rawOverall);
    task.overall   = smoothed;

    var ev = {
      taskId:     taskId,
      label:      task.label,
      stage:      stage.name,
      stagePct:   pct,
      overall:    smoothed,
      message:    message || null,
    };

    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('progress:update', ev); } catch (_) {}
    }
    if (window.RuntimeTelemetry && smoothed % 25 === 0) {
      try { window.RuntimeTelemetry.record('progress:milestone', { label: task.label, pct: smoothed }); } catch (_) {}
    }

    // Notify per-task subscribers
    var subs = _taskSubs.get(taskId);
    if (subs) subs.forEach(function (fn) { try { fn(ev); } catch (_) {} });

    // Forward to legacy showProcessing if available and task is the current one
    if (window.showProcessing && task.id === _primaryTaskId) {
      try {
        var msg = message || (task.label + '… ' + smoothed + '%');
        var sub = stage.name !== task.label ? stage.name : null;
        window.showProcessing(msg, sub);
      } catch (_) {}
    }
  }

  // ── Task creation / completion ────────────────────────────────────────────
  var _taskSubs = new Map(); // Map<taskId, Set<fn>>
  var _primaryTaskId = null; // the "foreground" task that drives showProcessing

  function startTask(opts) {
    var task = _makeTask(opts);
    _tasks.set(task.id, task);
    if (_tasks.size === 1 || opts.primary) _primaryTaskId = task.id;

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('task:started', { label: task.label, stages: task.stages.length }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('task:started', { taskId: task.id, label: task.label }); } catch (_) {}
    }
    return task.id;
  }

  function completeTask(taskId, outcome) {
    var task = _tasks.get(taskId);
    if (!task) return;
    _stopStallWatcher(task);
    task.completed = true;
    task.overall   = 100;
    task.stages.forEach(function (s) { s.progress = 100; s.done = true; });

    _tasks.delete(taskId);
    _taskSubs.delete(taskId);
    if (_primaryTaskId === taskId) _primaryTaskId = null;

    var durationMs = Date.now() - task.startTs;
    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('task:completed', { label: task.label, durationMs: durationMs, outcome: outcome || 'ok' }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('task:completed', { taskId: taskId, label: task.label, durationMs: durationMs }); } catch (_) {}
    }
    return durationMs;
  }

  function failTask(taskId, errorMessage) {
    var task = _tasks.get(taskId);
    if (!task) return;
    _stopStallWatcher(task);
    task.completed = true;
    _tasks.delete(taskId);
    _taskSubs.delete(taskId);
    if (_primaryTaskId === taskId) _primaryTaskId = null;

    if (window.RuntimeTelemetry) {
      try { window.RuntimeTelemetry.record('task:failed', { label: task.label, error: errorMessage }); } catch (_) {}
    }
    if (window.RuntimeEventBus) {
      try { window.RuntimeEventBus.emit('task:failed', { taskId: taskId, label: task.label, error: errorMessage }); } catch (_) {}
    }
  }

  // ── Per-task subscription ─────────────────────────────────────────────────
  function onProgress(taskId, fn) {
    if (!_taskSubs.has(taskId)) _taskSubs.set(taskId, new Set());
    _taskSubs.get(taskId).add(fn);
    return function () {
      var s = _taskSubs.get(taskId);
      if (s) s.delete(fn);
    };
  }

  // ── Convenience: single-stage simple task ─────────────────────────────────
  // Returns { taskId, report(pct, msg), complete(), fail(msg) }
  function createSimpleTask(label, token) {
    var taskId = startTask({ label: label, token: token || null, primary: true });
    return {
      taskId:   taskId,
      report:   function (pct, msg) { report(taskId, 0, pct, msg); },
      complete: function () { return completeTask(taskId, 'ok'); },
      fail:     function (msg) { failTask(taskId, msg); },
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var active = [];
    _tasks.forEach(function (t) {
      active.push({ id: t.id, label: t.label, overall: t.overall, stalled: t.stalled,
                    ageMs: Date.now() - t.startTs });
    });
    return { activeTasks: active.length, tasks: active, primaryTaskId: _primaryTaskId };
  }

  // ── Pagehide ──────────────────────────────────────────────────────────────
  window.addEventListener('pagehide', function () {
    _tasks.forEach(function (t) { _stopStallWatcher(t); });
    _tasks.clear();
    _taskSubs.clear();
  }, { passive: true });

  window.RuntimeProgress = {
    startTask:        startTask,
    completeTask:     completeTask,
    failTask:         failTask,
    report:           report,
    onProgress:       onProgress,
    createSimpleTask: createSimpleTask,
    getStats:         getStats,
  };

  // ── Overlay progress bridge ────────────────────────────────────────────────
  // Listens on RuntimeEventBus for progress:update events and drives the DOM
  // progress bar fill width, percentage text, and cancel button visibility.
  // Wires the cancel button to RuntimeCancellation.cancelAll().
  (function _wireOverlayBridge() {
    var _barFill = document.getElementById('processing-bar-fill');
    var _pctText = document.getElementById('processing-pct');
    var _cancelBtn = document.getElementById('processing-cancel-btn');

    if (!_barFill && !_pctText && !_cancelBtn) return; // not on a tool page

    function _updateBar(overall) {
      if (_barFill) _barFill.style.width = overall + '%';
      if (_pctText)  _pctText.textContent = overall > 0 && overall < 100 ? overall + '%' : '';
    }

    function _resetBar() {
      if (_barFill)  { _barFill.style.width = '0'; }
      if (_pctText)  { _pctText.textContent = ''; }
      if (_cancelBtn) { _cancelBtn.classList.add('hidden'); }
    }

    if (window.RuntimeEventBus) {
      window.RuntimeEventBus.on('progress:update', function (ev) {
        if (!ev || typeof ev.overall !== 'number') return;
        _updateBar(ev.overall);
        if (_cancelBtn && ev.overall > 0 && ev.overall < 100) {
          _cancelBtn.classList.remove('hidden');
        }
      });
      window.RuntimeEventBus.on('task:completed', _resetBar);
      window.RuntimeEventBus.on('task:failed',    _resetBar);
    }

    if (_cancelBtn) {
      _cancelBtn.addEventListener('click', function () {
        if (window.RuntimeCancellation) {
          try { window.RuntimeCancellation.cancelAll('user-cancel'); } catch (_) {}
        }
        _resetBar();
      });
    }
  }());

  console.debug('[RuntimeProgress] ready — T026 progress system active');
}());
