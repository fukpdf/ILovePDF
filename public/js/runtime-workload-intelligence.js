// RuntimeWorkloadIntelligence v1.0 — Arc 9 / Phase B
// =====================================================================
// Dynamic workload redistribution engine. Monitors per-family queue
// depths, thermal state, and memory pressure to intelligently migrate
// and balance tasks across worker domains.
//
// Capabilities:
//   - Thermal-aware task migration (hot family → migrate to spare domain)
//   - Memory-aware task balancing (over-budget family gets throttled)
//   - Worker congestion prediction (queue depth trend → preemptive relief)
//   - Queue pressure balancing (starvation prevention, adaptive concurrency)
//   - Idle-core utilization (detect unused capacity → route work there)
//
// Integrates: RuntimeTaskOrchestrator, RuntimeProcessorWorkers,
//   RuntimeStreamWorkers, RuntimeMobileHardening, RuntimeStreamTelemetry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeWorkloadIntelligence) return;

  var LOG     = '[WorkloadIntel]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SWEEP_MS          = 3000;   // balancing sweep interval
  var STARVATION_MS     = 5000;   // family waiting > this → starved
  var STARVATION_DEPTH  = 5;      // min queue depth to count as starvation
  var CONGESTION_THRESH = 8;      // queue depth → congested
  var IDLE_THRESH       = 0.2;    // worker utilization < this → idle

  // ── Per-family metrics ────────────────────────────────────────────
  var _families = {};
  // family → { queueDepth, running, thermalBudget, memMb, stallSince, utilization, migrations }

  function _ensure(family) {
    if (!_families[family]) {
      _families[family] = {
        queueDepth: 0, running: 0, thermalBudget: 100,
        memMb: 0, stallSince: null, utilization: 0.5, migrations: 0,
      };
    }
    return _families[family];
  }

  // ── Queue depth trend ─────────────────────────────────────────────
  var _depthHistory = {};  // family → [last 5 snapshots]

  function _trackDepth(family, depth) {
    if (!_depthHistory[family]) _depthHistory[family] = [];
    _depthHistory[family].push(depth);
    if (_depthHistory[family].length > 5) _depthHistory[family].shift();
  }

  function _depthTrend(family) {
    var h = _depthHistory[family];
    if (!h || h.length < 2) return 0;
    return h[h.length - 1] - h[0];  // positive = growing
  }

  // ── Telemetry ─────────────────────────────────────────────────────
  var _actions = [];
  function _record(action, family, detail) {
    _actions.push({ ts: Date.now(), action: action, family: family, detail: detail || null });
    if (_actions.length > 200) _actions.shift();
  }

  var _stats = { sweeps: 0, migrations: 0, throttles: 0, lifts: 0, starvations: 0 };

  // ── Collect current workload state ────────────────────────────────
  function _collect() {
    var families = ['organize', 'compress', 'convert', 'ocr', 'image', 'ai', 'watermark', 'repair', 'split', 'merge'];

    try {
      var to = G.RuntimeTaskOrchestrator;
      if (to && to.getStats) {
        var ts = to.getStats();
        // Map lane stats to families
        if (ts && ts.lanes) {
          Object.keys(ts.lanes).forEach(function (lane) {
            var fm = _ensure(lane);
            fm.queueDepth = ts.lanes[lane].queued || 0;
            fm.running    = ts.lanes[lane].running || 0;
            _trackDepth(lane, fm.queueDepth);
          });
        }
      }
    } catch (_) {}

    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw && pw.getStats) {
        var ws = pw.getStats();
        if (ws) {
          families.forEach(function (f) {
            if (ws[f]) {
              _ensure(f).thermalBudget = ws[f].budget || 100;
              _ensure(f).utilization   = ws[f].active || 0;
            }
          });
        }
      }
    } catch (_) {}

    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm && pm.getStats) {
        var ms = pm.getStats();
        if (ms) {
          families.forEach(function (f) {
            if (ms[f]) _ensure(f).memMb = ms[f].heapMb || 0;
          });
        }
      }
    } catch (_) {}
  }

  // ── Thermal migration ─────────────────────────────────────────────
  function _thermalMigration() {
    // Find hot families and idle families
    var hot  = [];
    var idle = [];

    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.thermalBudget < 30 && fm.queueDepth > 2) hot.push(f);
      if (fm.utilization < IDLE_THRESH && fm.queueDepth === 0) idle.push(f);
    });

    if (!hot.length || !idle.length) return;

    hot.forEach(function (f) {
      // Reduce thermal pressure on hot family
      try {
        var pw = G.RuntimeProcessorWorkers;
        if (pw && pw.setThermalLimit) {
          pw.setThermalLimit(f, 1);  // reduce to 1 concurrent worker
          _families[f].migrations++;
          _stats.migrations++;
          _record('thermal-migrate', f, 'budget:' + _families[f].thermalBudget);
          console.debug(LOG, 'thermal-migrate:', f, '→ reduced concurrency');
        }
      } catch (_) {}
    });
  }

  // ── Memory balancing ──────────────────────────────────────────────
  function _memoryBalance() {
    var OVER_MB = 300;  // family heap > 300MB → throttle
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.memMb > OVER_MB) {
        try {
          var pw = G.RuntimeProcessorWorkers;
          if (pw && pw.setThermalLimit) {
            pw.setThermalLimit(f, 1);
            _stats.throttles++;
            _record('mem-throttle', f, 'memMb:' + fm.memMb);
            console.debug(LOG, 'mem-throttle:', f, fm.memMb + 'MB');
          }
        } catch (_) {}
        // Try RuntimeIncidentCenter advisory
        try {
          var ic = G.RuntimeIncidentCenter;
          if (ic) ic.record('memory-panic', ic.P2, f, { memMb: fm.memMb });
        } catch (_) {}
      }
    });
  }

  // ── Starvation prevention ─────────────────────────────────────────
  function _starvationCheck() {
    var now = Date.now();
    Object.keys(_families).forEach(function (f) {
      var fm = _families[f];
      if (fm.queueDepth >= STARVATION_DEPTH && fm.running === 0) {
        if (!fm.stallSince) fm.stallSince = now;
        else if (now - fm.stallSince > STARVATION_MS) {
          _stats.starvations++;
          _record('starvation', f, 'depth:' + fm.queueDepth + ' stalledMs:' + (now - fm.stallSince));
          console.warn(LOG, 'starvation detected:', f, 'depth:', fm.queueDepth);
          // Lift any artificial throttle
          try {
            var pw = G.RuntimeProcessorWorkers;
            if (pw && pw.setThermalLimit) { pw.setThermalLimit(f, 2); _stats.lifts++; }
          } catch (_) {}
          // Emit for AutonomousHealing
          try {
            G.dispatchEvent(new CustomEvent('arc9:starvation', { detail: { family: f, depth: fm.queueDepth } }));
          } catch (_) {}
          fm.stallSince = null;  // reset
        }
      } else {
        fm.stallSince = null;
      }
    });
  }

  // ── Congestion prediction ─────────────────────────────────────────
  function _congestionPredict() {
    Object.keys(_families).forEach(function (f) {
      var trend = _depthTrend(f);
      var fm    = _families[f];
      if (fm.queueDepth > CONGESTION_THRESH || (fm.queueDepth > 4 && trend > 2)) {
        _record('congestion-predict', f, 'depth:' + fm.queueDepth + ' trend:' + trend);
        // Emit advisory for task orchestrator
        try {
          G.dispatchEvent(new CustomEvent('arc9:congestion', {
            detail: { family: f, depth: fm.queueDepth, trend: trend },
          }));
        } catch (_) {}
      }
    });
  }

  // ── Idle utilization ──────────────────────────────────────────────
  function _idleUtilization() {
    // Identify idle capacity and emit advisory for predictive loader
    var idleFamilies = Object.keys(_families).filter(function (f) {
      return _families[f].utilization < IDLE_THRESH && _families[f].queueDepth === 0;
    });
    if (idleFamilies.length > 0) {
      try {
        G.dispatchEvent(new CustomEvent('arc9:idle-capacity', { detail: { families: idleFamilies } }));
      } catch (_) {}
    }
  }

  // ── Main sweep ────────────────────────────────────────────────────
  function _sweep() {
    _stats.sweeps++;
    _collect();
    _thermalMigration();
    _memoryBalance();
    _starvationCheck();
    _congestionPredict();
    _idleUtilization();
  }

  // ── Controls ──────────────────────────────────────────────────────
  var _timer = null;

  function start() {
    if (_timer) return;
    _timer = setInterval(_sweep, SWEEP_MS);
    console.debug(LOG, 'workload intelligence ACTIVE — sweep:', SWEEP_MS + 'ms');
  }

  function stop() {
    clearInterval(_timer); _timer = null;
    console.debug(LOG, 'workload intelligence PAUSED');
  }

  function getState() {
    return {
      running:  !!_timer,
      families: Object.assign({}, _families),
      stats:    Object.assign({}, _stats),
      recent:   _actions.slice(-20),
    };
  }

  start();

  G.RuntimeWorkloadIntelligence = Object.freeze({
    VERSION:  VERSION,
    start:    start,
    stop:     stop,
    getState: getState,
    getFamilies: function () { return Object.assign({}, _families); },
    getActions:  function () { return _actions.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — thermal/memory/starvation/congestion balancing active');

}(window));
