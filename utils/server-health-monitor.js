// utils/server-health-monitor.js — Phase 9 server-side health metrics
// Tracks memory, uptime, request counts, error rates, and service latency
// for the /api/server-health endpoint without any external dependencies.

const _bootTime   = Date.now();
const _windows    = [60, 300, 900];   // 1-min, 5-min, 15-min rolling windows (seconds)
const _reqBuckets = new Map();         // ts_second → { count, errors }
const _latencies  = [];               // ring buffer of last 200 latency samples (ms)
const _LAT_MAX    = 200;

function _bucket(ts) {
  const k = Math.floor(ts / 1000);
  if (!_reqBuckets.has(k)) _reqBuckets.set(k, { count: 0, errors: 0 });
  return _reqBuckets.get(k);
}

function _pruneOld() {
  const cutoff = Math.floor(Date.now() / 1000) - 1000;
  for (const k of _reqBuckets.keys()) {
    if (k < cutoff) _reqBuckets.delete(k);
  }
}

function _rollup(windowSec) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - windowSec;
  let count = 0, errors = 0;
  for (const [k, v] of _reqBuckets) {
    if (k >= from && k <= now) { count += v.count; errors += v.errors; }
  }
  return { count, errors, rps: +(count / windowSec).toFixed(2) };
}

function recordRequest(durationMs, isError) {
  const b = _bucket(Date.now());
  b.count++;
  if (isError) b.errors++;
  _latencies.push(durationMs);
  if (_latencies.length > _LAT_MAX) _latencies.shift();
  if (_reqBuckets.size > 2000) _pruneOld();
}

function _memStats() {
  const m = process.memoryUsage();
  return {
    rss_mb:       +(m.rss        / 1048576).toFixed(1),
    heap_used_mb: +(m.heapUsed   / 1048576).toFixed(1),
    heap_total_mb:+(m.heapTotal  / 1048576).toFixed(1),
    external_mb:  +(m.external   / 1048576).toFixed(1),
  };
}

function _latencyPercentiles() {
  if (!_latencies.length) return { p50: 0, p95: 0, p99: 0, avg: 0 };
  const sorted = [..._latencies].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct / 100))];
  const avg = +(sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(1);
  return { p50: p(50), p95: p(95), p99: p(99), avg };
}

export function getHealthSnapshot(buildId, services) {
  const uptimeSec = Math.floor((Date.now() - _bootTime) / 1000);
  return {
    ok:        true,
    buildId:   buildId || 'unknown',
    bootTime:  new Date(_bootTime).toISOString(),
    uptimeSec,
    uptimeHuman: _humanUptime(uptimeSec),
    memory:    _memStats(),
    latency:   _latencyPercentiles(),
    traffic: {
      '1m':  _rollup(60),
      '5m':  _rollup(300),
      '15m': _rollup(900),
    },
    node: process.version,
    pid:  process.pid,
    services: services || {},
  };
}

export function requestTimingMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      recordRequest(Date.now() - start, res.statusCode >= 500);
    });
    next();
  };
}

function _humanUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
