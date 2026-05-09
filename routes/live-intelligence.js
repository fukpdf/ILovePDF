/**
 * LIVE INTELLIGENCE ROUTER  v3.0
 * Mounted at /live-intel/*
 *
 * Real-time knowledge layer: news, weather, live search,
 * market/public data, trend detection.
 *
 * Features: caching, rate limiting, sanitization, timeout protection.
 */

import express   from 'express';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// ── Rate Limits ────────────────────────────────────────────────────────────
const _limiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please wait a minute.' },
});
router.use(_limiter);

// ── In-Memory Cache ────────────────────────────────────────────────────────
const _cache  = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.v;
  _cache.delete(key);
  return null;
}
function cacheSet(key, v) {
  _cache.set(key, { v, ts: Date.now() });
  // Limit cache size
  if (_cache.size > 200) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

// ── Timeout Wrapper ────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

// ── Sanitize ───────────────────────────────────────────────────────────────
function sanitize(str) {
  return String(str || '').replace(/[<>"'&]/g, '').slice(0, 200).trim();
}

// ── GET /live-intel/weather?city=Lahore ────────────────────────────────────
router.get('/weather', async (req, res) => {
  const city = sanitize(req.query.city || 'London');
  const key  = 'wx:' + city.toLowerCase();
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, cached: true, ...cached });

  try {
    const url  = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const resp = await withTimeout(fetch(url), 7000);
    if (!resp.ok) throw new Error('wttr.in error ' + resp.status);
    const data = await resp.json();
    const cur  = data.current_condition?.[0];
    if (!cur) throw new Error('no current data');
    const area    = data.nearest_area?.[0];
    const cityName = area?.areaName?.[0]?.value || city;
    const country  = area?.country?.[0]?.value  || '';
    const result = {
      location:  cityName + (country ? ', ' + country : ''),
      temp_c:    cur.temp_C,
      feels_c:   cur.FeelsLikeC,
      humidity:  cur.humidity,
      desc:      cur.weatherDesc?.[0]?.value || '',
      wind:      cur.windspeedKmph,
      uv:        cur.uvIndex,
    };
    cacheSet(key, result);
    res.json({ ok: true, cached: false, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Weather service unavailable: ' + err.message });
  }
});

// ── GET /live-intel/search?q=elon+musk&type=news ─────────────────────────
router.get('/search', async (req, res) => {
  const q    = sanitize(req.query.q || '');
  const type = sanitize(req.query.type || '');
  if (!q) return res.status(400).json({ ok: false, error: 'q parameter required' });

  const key = 'srch:' + type + ':' + q.toLowerCase().slice(0, 80);
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, cached: true, ...cached });

  try {
    // DuckDuckGo instant answers (free, no auth)
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const resp   = await withTimeout(fetch(ddgUrl, { headers: { 'User-Agent': 'LabaAI/3.0' } }), 8000);
    if (!resp.ok) throw new Error('DDG error ' + resp.status);
    const data = await resp.json();

    const result = {
      abstract: data.Abstract || '',
      source:   data.AbstractSource || data.Entity || '',
      url:      data.AbstractURL || '',
      image:    data.Image || '',
      type:     data.Type || '',
      results:  (data.RelatedTopics || []).slice(0, 6).map(function(t) {
        return {
          title:   t.Text?.split(' - ')[0] || t.Text || '',
          snippet: t.Text || '',
          url:     t.FirstURL || '',
        };
      }).filter(r => r.title),
    };
    cacheSet(key, result);
    res.json({ ok: true, cached: false, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Search service unavailable: ' + err.message });
  }
});

// ── GET /live-intel/trends ─────────────────────────────────────────────────
router.get('/trends', async (req, res) => {
  const key = 'trends:global';
  const cached = cacheGet(key);
  if (cached) return res.json({ ok: true, cached: true, trends: cached });

  try {
    // GitHub trending (public API proxy)
    const url  = 'https://api.github.com/search/repositories?q=created:>2024-01-01&sort=stars&order=desc&per_page=5';
    const resp = await withTimeout(fetch(url, { headers: { 'User-Agent': 'LabaAI/3.0', 'Accept': 'application/vnd.github.v3+json' } }), 7000);
    if (!resp.ok) throw new Error('GitHub API error ' + resp.status);
    const data = await resp.json();
    const trends = (data.items || []).map(r => ({ name: r.full_name, desc: r.description, stars: r.stargazers_count, url: r.html_url }));
    cacheSet(key, trends);
    res.json({ ok: true, cached: false, trends });
  } catch (err) {
    // Fallback: return mock trending topics
    res.json({ ok: true, cached: false, trends: [], note: 'Trends unavailable: ' + err.message });
  }
});

// ── GET /live-intel/time?tz=Asia/Karachi ──────────────────────────────────
router.get('/time', (req, res) => {
  const tz  = sanitize(req.query.tz || 'UTC');
  try {
    const now  = new Date();
    const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit',
                   year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    const str  = now.toLocaleString('en-US', opts);
    res.json({ ok: true, tz, time: str, unix: now.getTime() });
  } catch (err) {
    res.json({ ok: true, tz: 'UTC', time: new Date().toUTCString(), unix: Date.now() });
  }
});

// ── GET /live-intel/health ─────────────────────────────────────────────────
router.get('/health', (_req, res) => {
  res.json({ ok: true, cacheSize: _cache.size, version: '3.0', ts: Date.now() });
});

export default router;
