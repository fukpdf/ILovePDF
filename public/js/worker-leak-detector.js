// Worker Leak Detector v1.0 — Final Stabilization
// Tracks all Web Worker instances created in this tab.
// Warns when workers appear to be orphaned (alive > TTL_MS without activity).
//
// API: window.WorkerLeakDetector
//   .track(worker, name)    → worker (pass-through for easy chaining)
//   .untrack(worker)
//   .pulse(worker)          → update last-seen timestamp for heartbeat
//   .getReport()            → { total, alive, suspects, list }
//   .terminateZombies()     → terminates workers suspected to be leaking
(function () {
  'use strict';

  if (window.WorkerLeakDetector) return;

  var TTL_MS          = 5 * 60 * 1000;  // 5 minutes without pulse → suspect
  var CHECK_INTERVAL  = 30 * 1000;       // check every 30 s
  var MAX_TRACKED     = 100;             // safety cap

  // Map<worker, { name, created, lastPulse, terminated }>
  var _tracked = new Map();
  var _suspects = [];   // names of zombie workers detected in last scan

  var _uid = 0;

  function track(worker, name) {
    if (!worker || typeof worker.terminate !== 'function') return worker;
    if (_tracked.size >= MAX_TRACKED) {
      // Evict first terminated entry
      var evicted = false;
      _tracked.forEach(function (meta, w) {
        if (!evicted && meta.terminated) { _tracked.delete(w); evicted = true; }
      });
      if (_tracked.size >= MAX_TRACKED) {
        console.warn('[WorkerLeakDetector] cap reached (' + MAX_TRACKED + '), skipping track for: ' + (name || 'unknown'));
        return worker;
      }
    }
    var now = Date.now();
    _tracked.set(worker, {
      name:       name || ('worker-' + (++_uid)),
      created:    now,
      lastPulse:  now,
      terminated: false,
    });
    return worker;
  }

  function untrack(worker) {
    if (!worker) return;
    var meta = _tracked.get(worker);
    if (meta) meta.terminated = true;
    _tracked.delete(worker);
  }

  function pulse(worker) {
    var meta = _tracked.get(worker);
    if (meta) meta.lastPulse = Date.now();
  }

  function getReport() {
    var now   = Date.now();
    var list  = [];
    var alive = 0;
    _tracked.forEach(function (meta, _) {
      if (!meta.terminated) alive++;
      var age = Math.round((now - meta.created) / 1000);
      var idle = Math.round((now - meta.lastPulse) / 1000);
      list.push({
        name:       meta.name,
        ageS:       age,
        idleS:      idle,
        terminated: meta.terminated,
        suspect:    !meta.terminated && (now - meta.lastPulse) > TTL_MS,
      });
    });
    return {
      total:    _tracked.size,
      alive:    alive,
      suspects: _suspects.slice(),
      list:     list,
    };
  }

  function terminateZombies() {
    var now       = Date.now();
    var terminated = 0;
    _tracked.forEach(function (meta, worker) {
      if (!meta.terminated && (now - meta.lastPulse) > TTL_MS) {
        console.warn('[WorkerLeakDetector] terminating zombie worker: ' + meta.name +
          ' (idle ' + Math.round((now - meta.lastPulse) / 1000) + 's)');
        try { worker.terminate(); } catch (_) {}
        meta.terminated = true;
        terminated++;
        if (window.StabilityMetrics) {
          try { window.StabilityMetrics.recordEvent('zombie-worker-terminated:' + meta.name); } catch (_) {}
        }
      }
    });
    return terminated;
  }

  function _scan() {
    var now = Date.now();
    _suspects = [];
    _tracked.forEach(function (meta) {
      if (!meta.terminated && (now - meta.lastPulse) > TTL_MS) {
        _suspects.push(meta.name);
      }
    });
    if (_suspects.length > 0) {
      console.warn('[WorkerLeakDetector] suspect zombie workers: ' + _suspects.join(', '));
      if (window.StabilityMetrics) {
        try { window.StabilityMetrics.recordEvent('zombie-workers-suspected:' + _suspects.length); } catch (_) {}
      }
    }
  }

  var _scanTimer = setInterval(_scan, CHECK_INTERVAL);
  if (window.TimerRegistry) {
    window.TimerRegistry.registerInterval('WorkerLeakDetector', _scanTimer);
  }

  window.addEventListener('pagehide', function () {
    clearInterval(_scanTimer);
  }, { passive: true });

  window.WorkerLeakDetector = { track, untrack, pulse, getReport, terminateZombies };
  console.debug('[WorkerLeakDetector] ready — tracks Web Worker instances');
}());
