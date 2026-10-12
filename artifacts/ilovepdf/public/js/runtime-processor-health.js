// RuntimeProcessorHealth v1.0 — Arc 6 / Phase G
// =====================================================================
// Independent processor health scores, startup metrics, crash counters,
// worker health, memory telemetry.
//
// Provides a unified health view per processor family, aggregating from:
//   - RuntimeProcessorLoader  (activation state + startup timing)
//   - RuntimeProcessorMemory  (memory tier + panic count)
//   - RuntimeProcessorWorkers (crash count + isolation state)
//   - RuntimeProcessorHydration (hydration coverage)
//   - RuntimeProcessorBundles  (bundle GC state)
//
// Health score: 0–100 per processor (100 = fully healthy)
//   -10 per critical memory tier
//   -20 per panic
//   -15 per isolated worker pool
//   -5  per dormant bundle (processor not active)
//    +5 when all hydration tiers activated
//    clamp to [0, 100]
//
// window.getProcessorHealth() → summary API for dashboards.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorHealth) return;

  var LOG     = '[ProcHealth]';
  var VERSION = '1.0';
  var SAMPLE_MS = 30 * 1000; // sample every 30 s

  // ── Per-processor health state ────────────────────────────────────
  // family → { score, tier, events[], startupMs, crashCount, lastSampleAt }
  var _health = {};

  var FAMILIES = [
    'organize', 'split', 'compress', 'convert',
    'edit', 'repair', 'ocr', 'ai-nlp', 'image', 'utility',
  ];

  FAMILIES.forEach(function (f) {
    _health[f] = {
      family:       f,
      score:        100,
      tier:         'healthy', // healthy | degraded | critical | isolated
      events:       [],
      startupMs:    null,
      crashCount:   0,
      lastSampleAt: null,
    };
  });

  function _addEvent(family, type, data) {
    var h = _health[family];
    if (!h) return;
    h.events.push({ ts: Date.now(), type: type, data: data || null });
    if (h.events.length > 50) h.events.shift();
  }

  // ── Score computation ─────────────────────────────────────────────
  function _computeScore(family) {
    var score = 100;

    // Memory tier penalty
    try {
      var pm = G.RuntimeProcessorMemory;
      if (pm) {
        var memTier = pm.getTier(family);
        var stats   = pm.getStats && pm.getStats();
        var ps      = stats && stats[family];
        if (memTier === 'panic')    { score -= 20; if (ps) score -= (ps.panicCount || 0) * 5; }
        if (memTier === 'critical') { score -= 10; }
        if (memTier === 'warn')     { score -= 3;  }
      }
    } catch (_) {}

    // Worker isolation penalty
    try {
      var pw = G.RuntimeProcessorWorkers;
      if (pw) {
        var wstats = pw.getStats && pw.getStats();
        var ws     = wstats && wstats[family];
        if (ws && ws.isolated) score -= 25;
        if (ws) score -= Math.min(ws.crashCount || 0, 4) * 5;
      }
    } catch (_) {}

    // Loader crash penalty
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr) {
        var lstats = ldr.getStats && ldr.getStats();
        var ls     = lstats && lstats[family];
        if (ls) {
          score -= (ls.crashCount || 0) * 8;
          // Dormant penalty (processor evicted — not available)
          if (!ls.activated && ls.dormantAt) score -= 5;
        }
      }
    } catch (_) {}

    // Hydration bonus
    try {
      var ph = G.RuntimeProcessorHydration;
      if (ph) {
        var p2 = ph.isActivated && ph.isActivated(family, 'P2');
        if (p2) score += 3;
      }
    } catch (_) {}

    return Math.min(100, Math.max(0, score));
  }

  function _tierFromScore(score) {
    if (score >= 85) return 'healthy';
    if (score >= 60) return 'degraded';
    if (score >= 30) return 'critical';
    return 'isolated';
  }

  // ── Sample all processors ─────────────────────────────────────────
  function _sample() {
    var now = Date.now();
    FAMILIES.forEach(function (family) {
      var h     = _health[family];
      if (!h) return;
      var score = _computeScore(family);
      var tier  = _tierFromScore(score);
      var prev  = h.tier;
      h.score        = score;
      h.tier         = tier;
      h.lastSampleAt = now;

      if (tier !== prev) {
        _addEvent(family, 'tier-change', { from: prev, to: tier, score: score });
        console.debug(LOG, family, 'health:', tier, '(' + score + ')');
        try {
          G.dispatchEvent(new CustomEvent('processor-health:change', {
            detail: { family: family, tier: tier, score: score, prev: prev },
          }));
        } catch (_) {}
      }
    });
  }
  setInterval(_sample, SAMPLE_MS);

  // ── Event hooks ───────────────────────────────────────────────────
  G.addEventListener('processor-loader:crash', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (!family || !_health[family]) return;
      _health[family].crashCount++;
      _addEvent(family, 'loader-crash', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor-memory:panic', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) _addEvent(family, 'memory-panic', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor-workers:isolated', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) _addEvent(family, 'worker-isolated', evt.detail);
      _sample();
    } catch (_) {}
  });

  G.addEventListener('processor:init', function (evt) {
    try {
      var d = evt && evt.detail;
      if (!d || !d.processor) return;
      var h = _health[d.processor];
      if (h) {
        h.startupMs = d.startupMs;
        _addEvent(d.processor, 'init', { startupMs: d.startupMs });
      }
    } catch (_) {}
  });

  // ── Stats API ─────────────────────────────────────────────────────
  function getAll() {
    var out = {};
    FAMILIES.forEach(function (f) {
      var h = _health[f];
      out[f] = { score: h.score, tier: h.tier, crashCount: h.crashCount,
                 startupMs: h.startupMs, lastSampleAt: h.lastSampleAt };
    });
    return out;
  }

  function getHealthScore(family) {
    return (_health[family] || {}).score || 0;
  }

  // Expose as window.getProcessorHealth() for console inspection
  G.getProcessorHealth = function () { return getAll(); };

  G.RuntimeProcessorHealth = Object.freeze({
    VERSION:         VERSION,
    getAll:          getAll,
    getScore:        getHealthScore,
    getTier:         function (f) { return (_health[f] || {}).tier || 'unknown'; },
    getEvents:       function (f) { return ((_health[f] || {}).events || []).slice(); },
    sample:          _sample,
  });

  // Initial sample
  setTimeout(_sample, 2000);

  console.debug(LOG, 'v' + VERSION + ' ready — processor health domains active | window.getProcessorHealth() available');

}(window));
