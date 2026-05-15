// SharedClusterWorker v1.0 — Phase 9C
// =====================================================================
// SharedWorker script for RuntimeSharedCluster.
// Runs as a single persistent instance shared by all tabs from the same
// origin. Acts as the cluster brain: owns the shared task queue, routes
// work to tabs, tracks per-tab health, and broadcasts cluster state.
//
// Protocol (MessagePort messages):
//   TAB_CONNECT    → tab registers; worker tracks its port + load
//   TAB_HEARTBEAT  → tab updates its load/health/visible status
//   TAB_DISCONNECT → tab is going away; worker cleans up
//   TASK_SUBMIT    → tab submits a task to the cluster queue
//   TASK_RESULT    → tab reports result of a task it was asked to run
//   TASK_DECLINE   → tab cannot run the task assigned to it
//   CLUSTER_STATS  → worker broadcasts cluster stats to all tabs
//   TASK_ASSIGN    → worker assigns a queued task to the best-fit tab
//   TASK_COMPLETE  → worker notifies the submitter that its task is done
//
// Tasks that can't be forwarded (no serialisable fn) are bounced back
// to the submitter tab with TASK_SELF flag so it runs locally.
// =====================================================================
'use strict';

var LOG = '[SCW9C]';

// ── Tab registry ─────────────────────────────────────────────────────────────
// Map<tabId, { port, load, health, visible, ts }>
var _tabs = new Map();
var _tabIdCounter = 0;

// ── Task queue ────────────────────────────────────────────────────────────────
// [{ taskId, type, priority, payload, submitterTabId, assignedTabId, ts }]
var _queue = [];
var _taskIdCounter = 0;
var _inflight = new Map(); // taskId → { task, submitterPort }

// ── Priority ordering ─────────────────────────────────────────────────────────
var PRI = { critical: 0, high: 1, normal: 2, background: 3 };

function _insertByPri(queue, item) {
  var p = PRI[item.priority] != null ? PRI[item.priority] : 2;
  var i = 0;
  while (i < queue.length && (PRI[queue[i].priority] || 2) <= p) i++;
  queue.splice(i, 0, item);
}

// ── Broadcast to all connected tabs ──────────────────────────────────────────
function _broadcast(type, payload) {
  _tabs.forEach(function (tab) {
    try { tab.port.postMessage({ type: type, payload: payload }); } catch (_) {}
  });
}

// ── Best-fit tab selector ─────────────────────────────────────────────────────
// Scores tabs: prefer visible, low load, high health. Excludes submitter tab.
function _bestTab(excludeTabId) {
  var best = null, bestScore = Infinity;
  _tabs.forEach(function (tab, id) {
    if (id === excludeTabId) return;
    var age = Date.now() - tab.ts;
    if (age > 15000) return; // stale tab — skip
    var score = (tab.load || 0) * 1000
              + (tab.visible ? 0 : 3000)
              + (100 - Math.min(100, tab.health || 100)) * 20
              + age * 0.01;
    if (score < bestScore) { bestScore = score; best = id; }
  });
  return best;
}

// ── Cluster stats ─────────────────────────────────────────────────────────────
function _clusterStats() {
  var tabs = [];
  _tabs.forEach(function (tab, id) {
    tabs.push({ tabId: id, load: tab.load, health: tab.health, visible: tab.visible, ageMs: Date.now() - tab.ts });
  });
  return {
    tabs:      tabs,
    tabCount:  _tabs.size,
    queued:    _queue.length,
    inflight:  _inflight.size,
    tasksSeen: _taskIdCounter,
  };
}

// ── Drain queue: try to assign pending tasks ───────────────────────────────────
function _drainQueue() {
  if (_queue.length === 0) return;

  var assigned = [];
  _queue.forEach(function (task) {
    if (_inflight.has(task.taskId)) return; // already assigned

    // Try to find a tab to run this task
    // Tasks with a type that maps to a real SharedWorker operation (no fn):
    // These are descriptive tasks the worker can route. Tasks with fn are
    // bounced back (fn is not serialisable).
    var targetId = _bestTab(task.submitterTabId);

    if (targetId == null) {
      // No other tab available — bounce back to submitter (TASK_SELF)
      var submitterTab = _tabs.get(task.submitterTabId);
      if (submitterTab) {
        try {
          submitterTab.port.postMessage({ type: 'TASK_SELF', payload: { taskId: task.taskId } });
        } catch (_) {}
      }
      assigned.push(task.taskId);
      return;
    }

    var targetTab = _tabs.get(targetId);
    if (!targetTab) { assigned.push(task.taskId); return; }

    try {
      targetTab.port.postMessage({ type: 'TASK_ASSIGN', payload: {
        taskId:    task.taskId,
        type:      task.type,
        priority:  task.priority,
        payload:   task.payload,
      }});
      task.assignedTabId = targetId;
      targetTab.load = (targetTab.load || 0) + 1;
      _inflight.set(task.taskId, { task: task, submitterTabId: task.submitterTabId });
      assigned.push(task.taskId);
    } catch (_) {
      // Tab gone — remove it
      _tabs.delete(targetId);
    }
  });

  // Remove assigned tasks from queue
  _queue = _queue.filter(function (t) { return assigned.indexOf(t.taskId) === -1; });
}

// ── SharedWorker onconnect ─────────────────────────────────────────────────────
self.onconnect = function (ev) {
  var port = ev.ports[0];
  var tabId = null;

  port.onmessage = function (e) {
    var msg     = e.data;
    var type    = msg && msg.type;
    var payload = msg && msg.payload;

    switch (type) {

      case 'TAB_CONNECT': {
        tabId = 'T' + (++_tabIdCounter);
        _tabs.set(tabId, {
          port:    port,
          load:    0,
          health:  100,
          visible: payload && payload.visible !== false,
          ts:      Date.now(),
        });
        port.postMessage({ type: 'TAB_CONNECTED', payload: { tabId: tabId, clusterStats: _clusterStats() } });
        _broadcast('CLUSTER_UPDATE', _clusterStats());
        console.log(LOG, 'tab connected:', tabId, '| total:', _tabs.size);
        _drainQueue();
        break;
      }

      case 'TAB_HEARTBEAT': {
        if (!tabId || !_tabs.has(tabId)) break;
        var tab = _tabs.get(tabId);
        tab.load    = payload && payload.load    != null ? payload.load    : tab.load;
        tab.health  = payload && payload.health  != null ? payload.health  : tab.health;
        tab.visible = payload && payload.visible != null ? payload.visible : tab.visible;
        tab.ts      = Date.now();
        break;
      }

      case 'TAB_DISCONNECT': {
        if (tabId) {
          _tabs.delete(tabId);
          // Re-queue any inflight tasks that were assigned to this tab
          _inflight.forEach(function (entry, taskId) {
            if (entry.task.assignedTabId === tabId) {
              _inflight.delete(taskId);
              _insertByPri(_queue, entry.task); // back into queue
            }
          });
          _broadcast('CLUSTER_UPDATE', _clusterStats());
          console.log(LOG, 'tab disconnected:', tabId, '| remaining:', _tabs.size);
          _drainQueue();
        }
        break;
      }

      case 'TASK_SUBMIT': {
        if (!tabId) break;
        var taskId = 'TASK-' + (++_taskIdCounter);
        var task = {
          taskId:       taskId,
          type:         payload && payload.type     || 'custom',
          priority:     payload && payload.priority || 'normal',
          payload:      payload && payload.data,
          submitterTabId: tabId,
          assignedTabId:  null,
          ts:           Date.now(),
        };
        _insertByPri(_queue, task);
        port.postMessage({ type: 'TASK_QUEUED', payload: { taskId: taskId } });
        _drainQueue();
        break;
      }

      case 'TASK_RESULT': {
        var resultTaskId = payload && payload.taskId;
        var entry = _inflight.get(resultTaskId);
        if (!entry) break;

        _inflight.delete(resultTaskId);
        // Decrement assignee load
        var assignee = _tabs.get(tabId);
        if (assignee) assignee.load = Math.max(0, (assignee.load || 1) - 1);

        // Notify submitter
        var submitterTab = _tabs.get(entry.submitterTabId);
        if (submitterTab) {
          try {
            submitterTab.port.postMessage({ type: 'TASK_COMPLETE', payload: {
              taskId:  resultTaskId,
              result:  payload && payload.result,
              error:   payload && payload.error,
              runByTabId: tabId,
            }});
          } catch (_) {}
        }
        _drainQueue();
        break;
      }

      case 'TASK_DECLINE': {
        var declineId = payload && payload.taskId;
        var declineEntry = _inflight.get(declineId);
        if (!declineEntry) break;
        _inflight.delete(declineId);
        declineEntry.task.assignedTabId = null;
        _insertByPri(_queue, declineEntry.task); // back to queue
        // Demote declining tab load
        var decliner = _tabs.get(tabId);
        if (decliner) decliner.load = Math.max(0, (decliner.load || 1) - 1);
        _drainQueue();
        break;
      }

      case 'CLUSTER_STATS': {
        port.postMessage({ type: 'CLUSTER_STATS', payload: _clusterStats() });
        break;
      }
    }
  };

  port.onmessageerror = function () {
    if (tabId) _tabs.delete(tabId);
  };

  port.start();
};

// ── Periodic stale-tab sweep ───────────────────────────────────────────────────
setInterval(function () {
  var cutoff = Date.now() - 30000; // 30 s without heartbeat = stale
  var removed = [];
  _tabs.forEach(function (tab, id) {
    if (tab.ts < cutoff) {
      removed.push(id);
      _tabs.delete(id);
    }
  });
  if (removed.length > 0) {
    console.log(LOG, 'swept stale tabs:', removed);
    _inflight.forEach(function (entry, taskId) {
      if (removed.indexOf(entry.task.assignedTabId) !== -1) {
        _inflight.delete(taskId);
        entry.task.assignedTabId = null;
        _insertByPri(_queue, entry.task);
      }
    });
    _drainQueue();
  }
}, 15000);
