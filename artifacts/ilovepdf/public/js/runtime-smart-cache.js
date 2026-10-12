// RuntimeSmartCache v1.0 — Arc 7 / Phase E
// =====================================================================
// Adaptive runtime cache orchestration. Distinct from RuntimeResultCache
// (which caches processed file OUTPUTS) — this caches RUNTIME STATE:
// hydration modules, processor init state, worker configs, tool metadata.
//
//   - Adaptive eviction: LRU + frequency scoring (LFU-LRU hybrid)
//   - Hot-runtime preservation: active processor families never evicted
//   - Predictive cache warming: pre-cache likely-next processor configs
//   - Stale-runtime purge: TTL-based eviction for old runtime states
//   - Memory-aware sizing: recalculates max entries based on heap pressure
//   - Tier tracking: warm / hot / cold per cache entry
// =====================================================================
(function (G) {
  'use strict';
  if (G.RuntimeSmartCache) return;

  var LOG     = '[SmartCache]';
  var VERSION = '1.0';

  // ── Config ────────────────────────────────────────────────────────
  var DEFAULT_MAX   = 200;   // entries
  var DEFAULT_TTL   = 20 * 60 * 1000;  // 20 min stale TTL
  var HOT_TTL       = 60 * 60 * 1000;  // 1 hr for hot entries
  var SWEEP_MS      = 2  * 60 * 1000;  // sweep interval
  var MEM_HIGH_PCT  = 0.75; // shrink cache above 75% heap
  var MEM_CRIT_PCT  = 0.90; // aggressive eviction above 90%

  // ── Cache storage: key → entry ────────────────────────────────────
  // entry: { value, ts, lastHit, hits, tier, ttl, pinned }
  var _cache   = {};
  var _count   = 0;
  var _maxSize = DEFAULT_MAX;
  var _metrics = { sets: 0, gets: 0, hits: 0, misses: 0, evictions: 0, purges: 0, warms: 0 };
  var _tel     = [];

  function _addTel(ev, data) {
    _tel.push({ ts: Date.now(), ev: ev, d: data || null });
    if (_tel.length > 100) _tel.shift();
  }

  // ── Memory pressure ───────────────────────────────────────────────
  function _memPct() {
    try {
      var pm = performance.memory;
      return pm ? pm.usedJSHeapSize / pm.jsHeapSizeLimit : 0;
    } catch (_) { return 0; }
  }

  function _recalcMax() {
    var pct = _memPct();
    if (pct >= MEM_CRIT_PCT) { _maxSize = Math.max(20, Math.floor(DEFAULT_MAX * 0.25)); }
    else if (pct >= MEM_HIGH_PCT) { _maxSize = Math.max(50, Math.floor(DEFAULT_MAX * 0.50)); }
    else { _maxSize = DEFAULT_MAX; }
  }

  // ── Tier logic ────────────────────────────────────────────────────
  function _tier(entry) {
    var age   = Date.now() - entry.ts;
    var hits  = entry.hits || 0;
    if (entry.pinned)        return 'hot';
    if (hits >= 10)          return 'hot';
    if (hits >= 3 && age < HOT_TTL)  return 'warm';
    return 'cold';
  }

  // ── LFU-LRU eviction score: lower = evict first ──────────────────
  function _score(entry) {
    var recency = Date.now() - (entry.lastHit || entry.ts);
    var freq    = entry.hits || 1;
    // cold + old = low score = evict first
    if (entry.pinned) return 1e9;
    return (freq * 1000) - recency;
  }

  // ── set ───────────────────────────────────────────────────────────
  function set(key, value, opts) {
    opts = opts || {};
    _recalcMax();
    var now = Date.now();
    var existing = _cache[key];
    if (!existing) { _count++; }
    _cache[key] = {
      value:   value,
      ts:      now,
      lastHit: now,
      hits:    existing ? (existing.hits + 1) : 0,
      tier:    'cold',
      ttl:     opts.ttl  || DEFAULT_TTL,
      pinned:  opts.pin  || false,
    };
    _cache[key].tier = _tier(_cache[key]);
    _metrics.sets++;

    // Evict if over max
    if (_count > _maxSize) _evict(1);
    return key;
  }

  // ── get ───────────────────────────────────────────────────────────
  function get(key) {
    _metrics.gets++;
    var entry = _cache[key];
    if (!entry) { _metrics.misses++; return undefined; }
    if (_isExpired(entry)) { _drop(key); _metrics.misses++; return undefined; }
    entry.hits++;
    entry.lastHit = Date.now();
    entry.tier = _tier(entry);
    _metrics.hits++;
    return entry.value;
  }

  function has(key) {
    var entry = _cache[key];
    return !!(entry && !_isExpired(entry));
  }

  function del(key) {
    if (_cache[key]) { _drop(key); }
  }

  // ── Pin / unpin (prevent eviction) ───────────────────────────────
  function pin(key)   { if (_cache[key]) { _cache[key].pinned = true;  _cache[key].tier = 'hot'; } }
  function unpin(key) { if (_cache[key]) { _cache[key].pinned = false; _cache[key].tier = _tier(_cache[key]); } }

  // ── Warm: preload a value ─────────────────────────────────────────
  function warm(key, valueFn, opts) {
    if (has(key)) return;
    _metrics.warms++;
    try {
      var val = typeof valueFn === 'function' ? valueFn() : valueFn;
      set(key, val, opts);
    } catch (_) {}
  }

  // ── Internal helpers ──────────────────────────────────────────────
  function _isExpired(entry) {
    return (Date.now() - entry.ts) > (entry.ttl || DEFAULT_TTL);
  }

  function _drop(key) {
    if (_cache[key]) { delete _cache[key]; _count = Math.max(0, _count - 1); }
  }

  // Evict N worst-scored entries
  function _evict(n) {
    var keys = Object.keys(_cache).filter(function (k) { return !_cache[k].pinned; });
    keys.sort(function (a, b) { return _score(_cache[a]) - _score(_cache[b]); });
    var removed = 0;
    for (var i = 0; i < keys.length && removed < n; i++) {
      _drop(keys[i]);
      _metrics.evictions++;
      removed++;
    }
    _addTel('evict', { n: removed });
  }

  // ── Periodic sweep: purge stale + resize ──────────────────────────
  function _sweep() {
    _recalcMax();
    var purged = 0;
    Object.keys(_cache).forEach(function (key) {
      var entry = _cache[key];
      if (!entry.pinned && _isExpired(entry)) { _drop(key); purged++; _metrics.purges++; }
    });

    // Hot-runtime preservation: pin active processor families
    try {
      var ldr = G.RuntimeProcessorLoader;
      if (ldr) {
        var stats = ldr.getStats && ldr.getStats();
        Object.keys(stats || {}).forEach(function (family) {
          if (stats[family].activated) {
            pin('processor:' + family);
          }
        });
      }
    } catch (_) {}

    // Evict if still over limit
    if (_count > _maxSize) _evict(_count - _maxSize);

    if (purged > 0) _addTel('sweep', { purged: purged, remaining: _count, maxSize: _maxSize });
  }
  setInterval(_sweep, SWEEP_MS);

  // ── Predictive warming from PredictiveLoader ──────────────────────
  G.addEventListener('predictive-loader:preload', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (!family) return;
      // Pre-warm common cache entries for this family
      warm('family:config:' + family, function () { return { family: family, warmedAt: Date.now() }; },
           { ttl: HOT_TTL });
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────
  function getStats() {
    var tiers = { hot: 0, warm: 0, cold: 0 };
    Object.keys(_cache).forEach(function (k) {
      var t = (_cache[k] || {}).tier || 'cold';
      tiers[t] = (tiers[t] || 0) + 1;
    });
    return {
      count: _count, maxSize: _maxSize, memPct: Math.round(_memPct() * 100),
      tiers: tiers, hitRate: _metrics.gets > 0
        ? Math.round((_metrics.hits / _metrics.gets) * 100) : 0,
      metrics: Object.assign({}, _metrics),
    };
  }

  G.RuntimeSmartCache = Object.freeze({
    VERSION:  VERSION,
    set:      set,
    get:      get,
    has:      has,
    del:      del,
    pin:      pin,
    unpin:    unpin,
    warm:     warm,
    getStats: getStats,
    getTelemetry: function () { return _tel.slice(); },
    clear:    function () { _cache = {}; _count = 0; _addTel('clear', {}); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — LFU-LRU hybrid cache | max:', DEFAULT_MAX, 'entries');

}(window));
