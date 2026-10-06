// RuntimeSessionStability v1.0 — Arc 9 / Phase C
// =====================================================================
// Long-session degradation detector and stability engine.
// Targets 6hr+ session stability with automated entropy mitigation.
//
// Session age tiers:
//   fresh    (0–30 min)   — no action
//   warm     (30–60 min)  — baseline sweep
//   long     (1–2 hr)     — moderate compaction
//   extended (2–4 hr)     — aggressive cleanup
//   critical (4+ hr)      — emergency stabilization
//
// Degradation signals:
//   - Heap growth rate (MB/min over 5-min window)
//   - Event timeline growth rate (events/min)
//   - Worker stall rate
//   - Hydration failure rate
//   - Incident rate (incidents/min)
//
// Interventions (by degradation level 0–4):
//   0  nominal   — log only
//   1  warning   — GC hint + dormant worker cleanup
//   2  degraded  — cache clear + hydration flush + snapshot
//   3  critical  — extreme-mode ULTRA_LOW_MEMORY + subsystem compaction
//   4  emergency — safe-mode request + mandatory snapshot
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeSessionStability) return;

  var LOG     = '[SessionStability]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var SWEEP_MS     = 5 * 60 * 1000;  // 5-min compaction sweep
  var SAMPLE_MS    = 60 * 1000;      // 1-min entropy sample
  var HEAP_WARN_RATE  = 50;   // MB/min heap growth → warn
  var HEAP_CRIT_RATE  = 150;  // MB/min heap growth → critical
  var INCIDENT_WARN   = 5;    // incidents/min → warn
  var EVENT_WARN_RATE = 200;  // events/min → warn

  // ── Session state ─────────────────────────────────────────────────
  var _startTs   = Date.now();
  var _level     = 0;  // 0=nominal, 1=warn, 2=degraded, 3=critical, 4=emergency
  var _levelNames = ['nominal', 'warning', 'degraded', 'critical', 'emergency'];

  // ── Entropy samples ───────────────────────────────────────────────
  var _heapSamples   = [];  // { ts, mb }
  var _eventSamples  = [];  // { ts, count }
  var _incidentSamples = [];

  function _sessionAge()  { return Date.now() - _startTs; }
  function _ageMinutes()  { return Math.round(_sessionAge() / 60000); }
  function _ageTier() {
    var m = _ageMinutes();
    if (m < 30) return 'fresh';
    if (m < 60) return 'warm';
    if (m < 120) return 'long';
    if (m < 240) return 'extended';
    return 'critical';
  }

  // ── Entropy sampling ──────────────────────────────────────────────
  function _sample() {
    var now = Date.now();
    // Heap
    try {
      var pm = performance.memory;
      if (pm) _heapSamples.push({ ts: now, mb: pm.usedJSHeapSize / 1024 / 1024 });
      if (_heapSamples.length > 30) _heapSamples.shift();
    } catch (_) {}

    // Event count
    try {
      var et = G.RuntimeEventTimeline;
      if (et) _eventSamples.push({ ts: now, count: et.getCount() });
      if (_eventSamples.length > 30) _eventSamples.shift();
    } catch (_) {}

    // Incident count
    try {
      var ic = G.getRuntimeIncidents && G.getRuntimeIncidents();
      if (ic) _incidentSamples.push({ ts: now, count: ic.length });
      if (_incidentSamples.length > 30) _incidentSamples.shift();
    } catch (_) {}
  }

  // ── Rate calculation (per minute over last N samples) ─────────────
  function _rate(samples, field) {
    if (samples.length < 2) return 0;
    var first = samples[0];
    var last  = samples[samples.length - 1];
    var dtMin = (last.ts - first.ts) / 60000;
    if (dtMin < 0.01) return 0;
    return (last[field] - first[field]) / dtMin;
  }

  // ── Degradation assessment ────────────────────────────────────────
  function _assess() {
    var heapRate     = _rate(_heapSamples, 'mb');
    var eventRate    = _rate(_eventSamples, 'count');
    var incidentRate = _rate(_incidentSamples, 'count');
    var tier         = _ageTier();

    var score = 0;
    if (heapRate     > HEAP_WARN_RATE)   score++;
    if (heapRate     > HEAP_CRIT_RATE)   score++;
    if (eventRate    > EVENT_WARN_RATE)  score++;
    if (incidentRate > INCIDENT_WARN)    score++;
    if (tier === 'extended')             score++;
    if (tier === 'critical')             score += 2;

    var newLevel = Math.min(4, score);
    if (newLevel !== _level) {
      var prev = _level;
      _level   = newLevel;
      console.debug(LOG, 'degradation level:', _levelNames[prev], '→', _levelNames[_level],
        '| age:', _ageMinutes() + 'min | heap-rate:', heapRate.toFixed(1) + 'MB/min');
      try {
        G.dispatchEvent(new CustomEvent('arc9:stability-level', {
          detail: { level: _level, levelName: _levelNames[_level], ageMin: _ageMinutes() },
        }));
      } catch (_) {}
    }

    return { heapRate: heapRate, eventRate: eventRate, incidentRate: incidentRate, level: _level };
  }

  // ── Interventions by level ────────────────────────────────────────
  function _intervene(assessment) {
    if (assessment.level === 0) return;

    var steps = [];

    if (assessment.level >= 1) {
      // GC hint
      try { if (G.gc) { G.gc(); steps.push('gc-hint'); } } catch (_) {}
      // Dormant worker cleanup advisory
      try {
        G.dispatchEvent(new CustomEvent('arc9:cleanup-dormant', { detail: { level: assessment.level } }));
        steps.push('cleanup-advisory');
      } catch (_) {}
    }

    if (assessment.level >= 2) {
      // Cache clear
      try {
        var sc = G.RuntimeSmartCache;
        if (sc && sc.clear) { sc.clear(); steps.push('cache-clear'); }
      } catch (_) {}
      // Hydration flush
      try {
        var sh = G.RuntimeStreamingHydration;
        if (sh && sh.flush) { sh.flush(); steps.push('hydration-flush'); }
      } catch (_) {}
      // Stability snapshot
      try {
        var ss = G.RuntimeStateSnapshots;
        if (ss) { ss.take('stability:level-' + assessment.level, false); steps.push('snapshot'); }
      } catch (_) {}
    }

    if (assessment.level >= 3) {
      // Extreme mode for memory pressure
      try {
        if (G.triggerExtremeMode) { G.triggerExtremeMode('ULTRA_LOW_MEMORY', 'session-stability'); steps.push('extreme-ulm'); }
      } catch (_) {}
      // Compact event timeline
      try {
        var et = G.RuntimeEventTimeline;
        if (et && et.clear) { et.clear(); steps.push('timeline-compact'); }
      } catch (_) {}
    }

    if (assessment.level >= 4) {
      // Emergency: request safe-mode via RecoveryOrchestrator
      try {
        G.dispatchEvent(new CustomEvent('arc9:safe-mode-request', {
          detail: { reason: 'session-entropy', ageMin: _ageMinutes(), level: assessment.level },
        }));
        steps.push('safe-mode-request');
      } catch (_) {}
      // Mandatory snapshot checkpoint
      try {
        var ss2 = G.RuntimeStateSnapshots;
        if (ss2) { ss2.take('emergency:session-critical', true); steps.push('emergency-checkpoint'); }
      } catch (_) {}
    }

    if (steps.length) {
      console.warn(LOG, 'intervention L' + assessment.level + ':', steps.join(','));
      try {
        G.dispatchEvent(new CustomEvent('arc9:stability-intervention', {
          detail: { level: assessment.level, steps: steps },
        }));
      } catch (_) {}
    }
  }

  // ── Sweep ─────────────────────────────────────────────────────────
  var _sweepCount = 0;
  function _sweep() {
    _sweepCount++;
    _sample();
    var assessment = _assess();
    _intervene(assessment);
  }

  // ── Timers ────────────────────────────────────────────────────────
  var _sampleTimer = setInterval(_sample, SAMPLE_MS);
  var _sweepTimer  = setInterval(_sweep, SWEEP_MS);

  // Initial sample
  setTimeout(_sample, 5000);

  G.RuntimeSessionStability = Object.freeze({
    VERSION:     VERSION,
    getLevel:    function () { return { level: _level, name: _levelNames[_level] }; },
    getAgeTier:  _ageTier,
    getAgeMin:   _ageMinutes,
    assess:      _assess,
    forceIntervene: function () { _intervene(_assess()); },
    getState: function () {
      return {
        ageMin:       _ageMinutes(),
        ageTier:      _ageTier(),
        level:        _level,
        levelName:    _levelNames[_level],
        sweeps:       _sweepCount,
        heapRate:     _rate(_heapSamples, 'mb'),
        eventRate:    _rate(_eventSamples, 'count'),
        incidentRate: _rate(_incidentSamples, 'count'),
      };
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — session stability monitoring | target: 6hr+ | sweep:', SWEEP_MS / 60000 + 'min');

}(window));
