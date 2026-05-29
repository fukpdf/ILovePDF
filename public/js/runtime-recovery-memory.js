// RuntimeRecoveryMemory v1.0 — Arc 11 / Phase G
// =============================================================================
// Adaptive recovery strategy memory. Learns from past recovery outcomes to
// recommend the most effective strategy for each failure class.
//
// Storage:
//   - Recovery records: { strategy, category, outcome, durationMs, ts }
//   - Strategy success rates per failure category
//   - Failed strategy blocklist (avoid repeating known-bad approaches)
//   - Incident patterns with associated effective strategies
//   - Healing effectiveness scores (0–100) per strategy
//
// Capabilities:
//   - recommend(category)     → best strategy for this failure class
//   - recordOutcome(...)      → store a recovery attempt result
//   - avoid(strategy, reason) → add to failure blocklist
//   - getEffectiveness(strat) → 0–100 score
//   - getHistory(n)           → recent recovery attempts
//
// Persists to RuntimeBlackboxStorage (recovery_history store) across reloads.
//
// window.RuntimeRecoveryMemory
//   .recommend(category)         → { strategy, confidence, reason }
//   .recordOutcome(opts)         → void
//   .getEffectiveness(strategy)  → number 0-100
//   .getHistory(n)               → RecoveryRecord[]
//   .getBlocklist()              → BlockEntry[]
//   .reset()                     → void
//   .getMetrics()                → MetricsObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeRecoveryMemory) return;

  var VERSION = '1.0';
  var LOG     = '[RecoveryMemory]';

  var MAX_HISTORY      = 500;
  var BLOCKLIST_TTL_MS = 10 * 60 * 1000;  // 10 min — re-try blocked strategies after this
  var MIN_SAMPLES      = 3;               // minimum samples to trust a rate

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── State ──────────────────────────────────────────────────────────────────
  var _history   = [];    // RecoveryRecord[]
  var _rates     = {};    // strategy → { success, total, categories: { cat → {s,t} } }
  var _blocklist = [];    // { strategy, reason, ts }
  var _patterns  = {};    // category → { bestStrategy, confidence, lastTs }
  var _metrics   = { recorded: 0, recommended: 0, blocked: 0, loaded: 0 };

  // ── Record an outcome ─────────────────────────────────────────────────────
  function recordOutcome(opts) {
    opts = opts || {};
    var rec = {
      strategy:   opts.strategy   || 'unknown',
      category:   opts.category   || 'general',
      outcome:    opts.outcome     || 'unknown',   // 'success' | 'failed' | 'partial'
      durationMs: opts.durationMs  || 0,
      ts:         Date.now(),
      attempts:   opts.attempts    || 1,
    };
    _history.push(rec);
    if (_history.length > MAX_HISTORY) _history.shift();
    _metrics.recorded++;

    // Update rates
    var strat = rec.strategy;
    _rates[strat] = _rates[strat] || { success: 0, total: 0, categories: {} };
    _rates[strat].total++;
    if (rec.outcome === 'success') _rates[strat].success++;

    var cat = rec.category;
    _rates[strat].categories[cat] = _rates[strat].categories[cat] || { s: 0, t: 0 };
    _rates[strat].categories[cat].t++;
    if (rec.outcome === 'success') _rates[strat].categories[cat].s++;

    // Update category pattern
    _updatePattern(cat);

    // Persist to storage
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (bbs && bbs.isAvailable()) bbs.store('recovery_history', rec);
    });
  }

  // ── Update best strategy for a category ───────────────────────────────────
  function _updatePattern(category) {
    var best = null;
    var bestRate = -1;
    Object.keys(_rates).forEach(function (strat) {
      var catStats = _rates[strat].categories[category];
      if (!catStats || catStats.t < MIN_SAMPLES) return;
      if (_isBlocked(strat)) return;
      var rate = catStats.s / catStats.t;
      if (rate > bestRate) { bestRate = rate; best = strat; }
    });
    if (best) {
      _patterns[category] = {
        bestStrategy: best,
        confidence:   Math.round(bestRate * 100),
        lastTs:       Date.now(),
      };
    }
  }

  // ── Blocklist management ──────────────────────────────────────────────────
  function avoid(strategy, reason) {
    _blocklist = _blocklist.filter(function (b) { return b.strategy !== strategy; });
    _blocklist.push({ strategy: strategy, reason: reason || 'manual', ts: Date.now() });
    _metrics.blocked++;
    console.debug(LOG, 'strategy blocked:', strategy, '|', reason);
  }

  function _isBlocked(strategy) {
    var cutoff = Date.now() - BLOCKLIST_TTL_MS;
    return _blocklist.some(function (b) { return b.strategy === strategy && b.ts > cutoff; });
  }

  // ── Recommend ─────────────────────────────────────────────────────────────
  function recommend(category) {
    _metrics.recommended++;
    // Check learned pattern first
    var pattern = _patterns[category];
    if (pattern && !_isBlocked(pattern.bestStrategy)) {
      return { strategy: pattern.bestStrategy, confidence: pattern.confidence, reason: 'learned' };
    }
    // Fall back to global best non-blocked strategy
    var best = null; var bestRate = -1;
    Object.keys(_rates).forEach(function (strat) {
      if (_isBlocked(strat)) return;
      var r = _rates[strat];
      if (r.total < MIN_SAMPLES) return;
      var rate = r.success / r.total;
      if (rate > bestRate) { bestRate = rate; best = strat; }
    });
    if (best) return { strategy: best, confidence: Math.round(bestRate * 100), reason: 'global-best' };
    // No data
    return { strategy: null, confidence: 0, reason: 'insufficient-data' };
  }

  // ── Effectiveness score ────────────────────────────────────────────────────
  function getEffectiveness(strategy) {
    var r = _rates[strategy];
    if (!r || r.total < 1) return 50;  // neutral default
    return Math.round((r.success / r.total) * 100);
  }

  // ── Load history from persistence ─────────────────────────────────────────
  function _loadFromStorage() {
    _s(function () {
      var bbs = G.RuntimeBlackboxStorage;
      if (!bbs || !bbs.isAvailable()) return;
      bbs.load('recovery_history', { limit: 200 }).then(function (rows) {
        if (!Array.isArray(rows)) return;
        rows.forEach(function (row) {
          if (row && row.strategy && row.category && row.outcome) {
            _history.push(row);
            _metrics.loaded++;
          }
        });
        // Rebuild rates from loaded history
        _history.forEach(function (rec) {
          var strat = rec.strategy;
          _rates[strat] = _rates[strat] || { success: 0, total: 0, categories: {} };
          _rates[strat].total++;
          if (rec.outcome === 'success') _rates[strat].success++;
          var cat = rec.category;
          _rates[strat].categories[cat] = _rates[strat].categories[cat] || { s: 0, t: 0 };
          _rates[strat].categories[cat].t++;
          if (rec.outcome === 'success') _rates[strat].categories[cat].s++;
        });
        Object.keys(_rates).forEach(function (strat) {
          Object.keys(_rates[strat].categories).forEach(function (cat) { _updatePattern(cat); });
        });
        console.debug(LOG, 'loaded', _metrics.loaded, 'recovery records from storage');
      }).catch(function () {});
    });
  }

  function reset() {
    _history = []; _rates = {}; _blocklist = []; _patterns = {};
    _metrics = { recorded: 0, recommended: 0, blocked: 0, loaded: 0 };
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  setTimeout(_loadFromStorage, 4000);

  G.RuntimeRecoveryMemory = Object.freeze({
    VERSION:          VERSION,
    recommend:        recommend,
    recordOutcome:    recordOutcome,
    avoid:            avoid,
    getEffectiveness: getEffectiveness,
    getHistory:       function (n) { return _history.slice(-(n || 50)); },
    getBlocklist:     function () { return _blocklist.slice(); },
    getPatterns:      function () { return Object.assign({}, _patterns); },
    reset:            reset,
    getMetrics:       function () { return Object.assign({}, _metrics); },
  });

  console.debug(LOG, 'v' + VERSION + ' loaded');
}(window));
