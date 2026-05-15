// RuntimeSharedCluster v1.0 — Phase 9C
// =====================================================================
// SharedWorker compute cluster manager.
// Coordinates compute tasks across all open tabs via a SharedWorker.
//
// Architecture:
//   SharedWorker (shared-cluster-worker.js) = cluster brain
//     - Runs once, shared by all tabs from same origin
//     - Owns global task queue, tracks per-tab load + health
//     - Routes tasks to best-fit tab
//
//   RuntimeSharedCluster (this file) = per-tab client
//     - Manages the MessagePort to the SharedWorker
//     - Provides enqueue() API for scheduling cross-tab tasks
//     - Handles TASK_ASSIGN (runs tasks assigned by the cluster)
//     - Falls back to local execution if SharedWorker unavailable
//
// Capabilities:
//   • Multi-tab unified compute queue
//   • Priority-based fair routing
//   • Idle-tab utilisation
//   • Persistent context (SharedWorker survives individual tab navigations)
//   • Automatic leader election via SharedWorker singleton
//   • Memory-aware load reporting
//
// Expose: window.RuntimeSharedCluster
//   .enqueue(task)           → Promise<result>
//   .getClusterStats()       → Promise<ClusterStats>
//   .getLeader()             → Promise<{ tabId, clusterSize }>
//   .getLocalStats()         → LocalStats
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeSharedCluster) return;

  var LOG = '[SC9C]';
  var WORKER_URL = '/workers/shared-cluster-worker.js';
  var HB_INTERVAL_MS  = 5000;  // heartbeat to SharedWorker
  var TASK_TIMEOUT_MS = 60000; // task completion timeout

  // ── Capability check ──────────────────────────────────────────────────────
  var _supported = typeof SharedWorker !== 'undefined';
  var _worker    = null;   // SharedWorker instance
  var _port      = null;   // MessagePort to SharedWorker
  var _tabId     = null;   // assigned by SharedWorker on connect
  var _connected = false;
  var _available = false;  // true when fully connected + tabId assigned

  // ── Pending task promises ─────────────────────────────────────────────────
  // taskId → { resolve, reject, timer }
  var _pending = new Map();

  // ── Per-tab stats ─────────────────────────────────────────────────────────
  var _localStats = {
    submitted:    0,
    local:        0,     // ran locally (fallback or self)
    routed:       0,     // handed to another tab
    received:     0,     // ran because cluster assigned to us
    errors:       0,
    connected:    false,
    tabId:        null,
  };

  // ── Registered handlers for assigned tasks (by type) ─────────────────────
  // Other modules can register: RuntimeSharedCluster.registerHandler(type, fn)
  var _handlers = new Map();

  function registerHandler(type, fn) {
    if (typeof fn === 'function') _handlers.set(type, fn);
  }

  // ── Connect to SharedWorker ───────────────────────────────────────────────
  function _connect() {
    if (!_supported) return;
    try {
      _worker = new SharedWorker(WORKER_URL, { name: 'ilovepdf-cluster-v1' });
      _port   = _worker.port;
    } catch (e) {
      console.warn(LOG, 'SharedWorker spawn failed:', e.message);
      _supported = false;
      return;
    }

    _port.onmessage = _handleWorkerMessage;
    _port.onmessageerror = function () {
      console.warn(LOG, 'port messageerror — reconnecting');
      _connected = false; _available = false;
      setTimeout(_connect, 2000);
    };

    _port.start();

    // Register this tab with the cluster
    _port.postMessage({ type: 'TAB_CONNECT', payload: {
      visible: !!(document.visibilityState === 'visible'),
      load:    0,
      health:  _tabHealth(),
    }});
  }

  function _handleWorkerMessage(e) {
    var msg     = e.data;
    var type    = msg && msg.type;
    var payload = msg && msg.payload;

    switch (type) {

      case 'TAB_CONNECTED': {
        _tabId     = payload && payload.tabId;
        _connected = true;
        _available = true;
        _localStats.connected = true;
        _localStats.tabId     = _tabId;
        console.info(LOG, 'connected as tab:', _tabId, '| cluster size:', payload.clusterStats && payload.clusterStats.tabCount);
        if (global.RuntimeEventBus) {
          try { global.RuntimeEventBus.emit('cluster:connected', payload.clusterStats); } catch (_) {}
        }
        break;
      }

      case 'TASK_QUEUED': {
        // Acknowledged — wait for TASK_COMPLETE or TASK_SELF
        break;
      }

      case 'TASK_SELF': {
        // Cluster has no other tab available — run locally
        var selfTaskId = payload && payload.taskId;
        var pendingSelf = _pending.get(selfTaskId);
        if (pendingSelf) {
          if (pendingSelf.task && pendingSelf.task.fn) {
            _localStats.local++;
            _runLocally(pendingSelf.task, pendingSelf.resolve, pendingSelf.reject);
            _pending.delete(selfTaskId);
          } else {
            pendingSelf.reject(new Error('cluster:no-other-tab-and-no-fn'));
            _pending.delete(selfTaskId);
          }
        }
        break;
      }

      case 'TASK_ASSIGN': {
        // Cluster asked us to run a task
        var assignedId = payload && payload.taskId;
        _localStats.received++;
        var handler = _handlers.get(payload.type);
        var resultPromise;

        if (handler) {
          try { resultPromise = Promise.resolve(handler(payload.payload, payload)); }
          catch (e) { resultPromise = Promise.reject(e); }
        } else {
          // No handler — decline
          _port.postMessage({ type: 'TASK_DECLINE', payload: { taskId: assignedId, reason: 'no-handler' } });
          break;
        }

        resultPromise.then(function (result) {
          _port.postMessage({ type: 'TASK_RESULT', payload: { taskId: assignedId, result: result } });
        }).catch(function (err) {
          _port.postMessage({ type: 'TASK_RESULT', payload: { taskId: assignedId, error: err.message } });
        });
        break;
      }

      case 'TASK_COMPLETE': {
        var completeId = payload && payload.taskId;
        var entry = _pending.get(completeId);
        if (!entry) break;
        clearTimeout(entry.timer);
        _pending.delete(completeId);
        if (payload.error) {
          _localStats.errors++;
          entry.reject(new Error(payload.error));
        } else {
          _localStats.routed++;
          entry.resolve(payload.result);
        }
        break;
      }

      case 'CLUSTER_UPDATE':
      case 'CLUSTER_STATS': {
        if (global.RuntimeEventBus) {
          try { global.RuntimeEventBus.emit('cluster:stats', payload); } catch (_) {}
        }
        break;
      }
    }
  }

  // ── Heartbeat to SharedWorker ─────────────────────────────────────────────
  var _hbTimer = null;
  function _startHeartbeat() {
    if (_hbTimer) return;
    _hbTimer = setInterval(function () {
      if (!_connected || !_port) return;
      try {
        _port.postMessage({ type: 'TAB_HEARTBEAT', payload: {
          load:    _localActiveCount(),
          health:  _tabHealth(),
          visible: !!(document.visibilityState === 'visible'),
        }});
      } catch (_) {}
    }, HB_INTERVAL_MS);
    if (global.TimerRegistry) {
      try { global.TimerRegistry.registerInterval('sc-heartbeat', _hbTimer); } catch (_) {}
    }
  }

  function _tabHealth() {
    if (global.RuntimeHealth && global.RuntimeHealth.getScore) {
      try { return global.RuntimeHealth.getScore(); } catch (_) {}
    }
    return 100;
  }

  function _localActiveCount() {
    return _pending.size;
  }

  // ── Enqueue ───────────────────────────────────────────────────────────────
  function enqueue(task) {
    task = task || {};
    _localStats.submitted++;

    // If SharedWorker unavailable, run locally
    if (!_supported || !_available || !_port) {
      _localStats.local++;
      if (task.fn) {
        return Promise.resolve().then(task.fn).catch(function (e) {
          _localStats.errors++;
          throw e;
        });
      }
      return Promise.reject(new Error('cluster:unavailable-and-no-fn'));
    }

    var taskId = _tabId + '-' + Date.now() + '-' + (Math.random() * 1e6 | 0);

    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        _pending.delete(taskId);
        _localStats.errors++;
        // Timeout — fall back to local execution if possible
        if (task.fn) {
          _localStats.local++;
          Promise.resolve().then(task.fn).then(resolve).catch(reject);
        } else {
          reject(new Error('cluster:task-timeout'));
        }
      }, TASK_TIMEOUT_MS);

      _pending.set(taskId, { task: task, resolve: resolve, reject: reject, timer: timer });

      try {
        _port.postMessage({ type: 'TASK_SUBMIT', payload: {
          taskId:   taskId,
          type:     task.type     || 'custom',
          priority: task.priority || 'normal',
          data:     task.data,
        }});
      } catch (e) {
        clearTimeout(timer);
        _pending.delete(taskId);
        _localStats.errors++;
        // Fallback
        if (task.fn) {
          _localStats.local++;
          return Promise.resolve().then(task.fn).then(resolve).catch(reject);
        }
        reject(e);
      }
    });
  }

  function _runLocally(task, resolve, reject) {
    if (task.fn) {
      Promise.resolve().then(task.fn).then(resolve).catch(function (e) {
        _localStats.errors++;
        reject(e);
      });
    } else {
      reject(new Error('no-fn-for-local-execution'));
    }
  }

  // ── Cluster stats (async — asks SharedWorker) ─────────────────────────────
  function getClusterStats() {
    if (!_connected || !_port) {
      return Promise.resolve({ available: false, tabs: [], tabCount: 0, queued: 0 });
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve({ available: false, timeout: true }); }, 2000);
      var unsub = global.RuntimeEventBus
        ? global.RuntimeEventBus.once('cluster:stats', function (stats) {
            clearTimeout(timer);
            resolve(Object.assign({ available: true }, stats));
          })
        : function () {};
      try {
        _port.postMessage({ type: 'CLUSTER_STATS' });
      } catch (_) {
        clearTimeout(timer);
        if (unsub) unsub();
        resolve({ available: false });
      }
    });
  }

  function getLeader() {
    // The SharedWorker itself is the leader (singleton).
    return getClusterStats().then(function (stats) {
      return {
        tabId:       _tabId,
        clusterSize: stats.tabCount || 1,
        isLeader:    true,  // in SharedWorker model, worker = leader
        sharedWorker: !!_supported,
      };
    });
  }

  function getLocalStats() {
    return Object.assign({}, _localStats, {
      pending: _pending.size,
      supported: _supported,
      connected: _connected,
    });
  }

  // ── Pagehide cleanup ──────────────────────────────────────────────────────
  global.addEventListener('pagehide', function () {
    if (_connected && _port) {
      try { _port.postMessage({ type: 'TAB_DISCONNECT', payload: {} }); } catch (_) {}
    }
    if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
  }, { passive: true });

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    if (_supported) {
      _connect();
      _startHeartbeat();
    } else {
      console.info(LOG, 'SharedWorker not supported — cluster disabled, local-only mode');
    }

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('sharedCluster', global.RuntimeSharedCluster); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('cluster:boot', { supported: _supported }); } catch (_) {}
    }
    console.info(LOG, 'RuntimeSharedCluster v1.0 ready — SharedWorker:', _supported);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 400);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 400); }, { once: true });
  }

  global.RuntimeSharedCluster = {
    enqueue:         enqueue,
    getClusterStats: getClusterStats,
    getLeader:       getLeader,
    getLocalStats:   getLocalStats,
    registerHandler: registerHandler,
    isAvailable:     function () { return _available; },
  };
}(window));
