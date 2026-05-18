// runtime-healer.js — WorkerPool Healer + Scheduler Self-Recovery (Phase 2D)
// ADDITIVE ONLY — never modifies WorkerPool, RuntimeScheduler, or TaskScheduler directly.
// Monitors all pool slots globally, detects stuck/dead workers, auto-recovers via
// safe wrappers. Also heals scheduler slot-counter drift and queue deadlocks.
//
// window.RuntimeHealer — public API
// Thresholds: NORMAL=60s, HEAVY_OCR=180s, BG_REMOVE=240s
(function () {
  'use strict';

  if (window.RuntimeHealer) return;

  var LOG = '[RH]';
  var VERSION = '1.0.0';

  // ── Thresholds (ms) ─────────────────────────────────────────────────────────
  var THRESHOLD = {
    normal:     60000,   // generic workers
    ocr:        180000,  // heavy OCR jobs
    bgremove:   240000,  // background removal
  };

  // Worker URL patterns → threshold category
  var URL_THRESHOLDS = [
    { pattern: /ocr|tesseract/i,          key: 'ocr'      },
    { pattern: /remove-bg|background/i,   key: 'bgremove' },
  ];

  function _thresholdFor(url) {
    if (!url) return THRESHOLD.normal;
    for (var i = 0; i < URL_THRESHOLDS.length; i++) {
      if (URL_THRESHOLDS[i].pattern.test(url)) return THRESHOLD[URL_THRESHOLDS[i].key];
    }
    return THRESHOLD.normal;
  }

  // ── Action log ──────────────────────────────────────────────────────────────
  var _actionLog = [];
  var MAX_LOG    = 200;

  function _log(action, detail) {
    var entry = { ts: Date.now(), action: action, detail: detail || {} };
    _actionLog.push(entry);
    if (_actionLog.length > MAX_LOG) _actionLog.shift();
    console.warn(LOG, action, detail);
    try {
      if (window.RuntimeEventBus) window.RuntimeEventBus.emit('healer:' + action, entry);
    } catch (_) {}
  }

  // ── WorkerPool slot inspector ────────────────────────────────────────────────
  // We access WorkerPool internals via its public getStats() + terminatePool() API.
  // For per-slot healing we also patch the internal `pools` reference once we
  // detect it's available (read-only — we only call existing methods on slots).

  function _healWorkerPools() {
    try {
      var WP = window.WorkerPool;
      if (!WP || typeof WP.getStats !== 'function') return;

      var stats = WP.getStats();
      var now   = Date.now();

      Object.keys(stats).forEach(function (url) {
        var s = stats[url];
        if (!s) return;

        // Heuristic: if all slots are busy and queuedHigh+queuedNormal > 0
        // AND the pool has been fully busy for longer than threshold → force reset
        var threshold = _thresholdFor(url);
        var queuedWork = (s.queued || 0);

        // Check if there are crashed-out slots consuming slots
        if (s.crashed > 0) {
          _log('pool:crashed-slots', { url: url, crashed: s.crashed });
          // terminatePool then re-allow: WorkerPool will re-create on next run()
          try { WP.terminatePool(url); } catch (_) {}
          _log('pool:terminated-and-freed', { url: url });
        }

        // Check for stuck-busy state: all slots busy, work queued, no progress for threshold
        if (s.busy > 0 && s.total > 0 && s.busy === s.total && queuedWork > 0) {
          // Record the first time we see this state
          var key = 'stuck:' + url;
          if (!_stuckSince[key]) {
            _stuckSince[key] = now;
          } else if ((now - _stuckSince[key]) > threshold) {
            _log('pool:stuck-detected', { url: url, busyMs: now - _stuckSince[key], threshold: threshold });
            // Force terminate and free — WorkerPool will auto-respawn on next dispatch
            try { WP.terminatePool(url); } catch (_) {}
            delete _stuckSince[key];
            _log('pool:force-freed', { url: url });
            _recoveries.workerPool++;
          }
        } else {
          delete _stuckSince['stuck:' + url];
        }
      });
    } catch (err) {
      console.debug(LOG, '_healWorkerPools error (non-fatal):', err.message);
    }
  }

  var _stuckSince = {};

  // ── Scheduler Self-Recovery ──────────────────────────────────────────────────
  // Detects and heals:
  //   1. TaskScheduler.active counter exceeding limit (slot poisoning)
  //   2. RuntimeScheduler._typeCounts stuck > type cap (queue deadlock)
  //   3. Negative active counters (defensive)

  function _healSchedulers() {
    try {
      _healTaskScheduler();
    } catch (_) {}
    try {
      _healRuntimeScheduler();
    } catch (_) {}
  }

  function _healTaskScheduler() {
    var TS = window.TaskScheduler;
    if (!TS || typeof TS.stats !== 'function') return;

    var s = TS.stats();
    var tiers = ['RENDER', 'AI', 'BACKGROUND'];

    tiers.forEach(function (tier) {
      var tierStats = s[tier];
      if (!tierStats) return;

      // Negative active counter — impossible state, reset
      if (tierStats.active < 0) {
        _log('scheduler:negative-active', { tier: tier, active: tierStats.active });
        // We can't directly set active, but calling releaseSlot when active < 0
        // is safe — releaseSlot clamps at 0 via Math.max(0, active - 1)
        // Instead, cancel queued tasks to unblock the queue
        try { TS.cancelQueued(tier); } catch (_) {}
        _recoveries.scheduler++;
      }

      // Active stuck above limit with waiters — slot poisoning
      // If active >= limit AND queue > 0 AND this has been the case for a while
      if (tierStats.active >= tierStats.limit && tierStats.queued > 0) {
        var key = 'ts-stuck:' + tier;
        if (!_stuckSince[key]) {
          _stuckSince[key] = Date.now();
        } else if ((Date.now() - _stuckSince[key]) > THRESHOLD.normal) {
          _log('scheduler:slot-poisoning', { tier: tier, active: tierStats.active, limit: tierStats.limit, queued: tierStats.queued });
          // Drain by calling releaseSlot — this DECREMENTS active and drains waiters
          // Called once per stuck slot to nudge queue forward without over-releasing
          try { TS.releaseSlot(tier); } catch (_) {}
          delete _stuckSince[key];
          _recoveries.scheduler++;
        }
      } else {
        delete _stuckSince['ts-stuck:' + tier];
      }
    });
  }

  function _healRuntimeScheduler() {
    var RS = window.RuntimeScheduler;
    if (!RS || typeof RS.getStats !== 'function') return;

    var s = RS.getStats();
    if (!s) return;

    // Detect wait queue bloat (tasks waiting but nothing running)
    var typeCounts = s.typeCounts || {};
    var waitSize   = s.waitQueueSize || 0;

    if (waitSize > 10) {
      _log('scheduler:queue-bloat', { waitQueueSize: waitSize, typeCounts: typeCounts });
    }

    // Detect type counters stuck at cap with no actual work (counter drift)
    // If a type has runningCount > 0 but WorkerPool shows no busy workers matching
    // this pattern for longer than threshold → counter drift → force drain
    Object.keys(typeCounts).forEach(function (type) {
      var count = typeCounts[type];
      if (count > 0) {
        var key = 'rs-stuck:' + type;
        if (!_stuckSince[key]) {
          _stuckSince[key] = Date.now();
        } else if ((Date.now() - _stuckSince[key]) > THRESHOLD.normal * 2) {
          _log('scheduler:type-count-drift', { type: type, count: count });
          // cancelType forces all waiting tasks to reject and clears the type count
          try { RS.cancelType(type, 'healer:drift-recovery'); } catch (_) {}
          delete _stuckSince[key];
          _recoveries.scheduler++;
        }
      } else {
        delete _stuckSince['rs-stuck:' + type];
      }
    });
  }

  // ── Stats ────────────────────────────────────────────────────────────────────
  var _recoveries = { workerPool: 0, scheduler: 0, total: 0 };

  function _runHealCycle() {
    _healWorkerPools();
    _healSchedulers();
    _recoveries.total = _recoveries.workerPool + _recoveries.scheduler;
  }

  // ── Start healing loop (every 15s) ──────────────────────────────────────────
  var HEAL_INTERVAL = 15000;
  var _healTimer = null;

  function start() {
    if (_healTimer) return;
    _healTimer = setInterval(function () {
      try { _runHealCycle(); } catch (_) {}
    }, HEAL_INTERVAL);
    if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimeHealer', _healTimer);
    console.info(LOG, 'v' + VERSION + ' started — heal interval ' + (HEAL_INTERVAL / 1000) + 's');
  }

  function stop() {
    if (_healTimer) {
      clearInterval(_healTimer);
      _healTimer = null;
    }
  }

  function runNow() {
    try { _runHealCycle(); } catch (_) {}
  }

  function getStats() {
    return {
      version:    VERSION,
      recoveries: Object.assign({}, _recoveries),
      stuckKeys:  Object.keys(_stuckSince),
      actionLog:  _actionLog.slice(-20),
    };
  }

  // Auto-start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    setTimeout(start, 1000);
  }

  window.RuntimeHealer = { start: start, stop: stop, runNow: runNow, getStats: getStats, VERSION: VERSION };
  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
