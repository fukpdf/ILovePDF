/**
 * Web Search + News proxy route
 * GET /api/web-search?q=...&type=news|search
 *
 * Uses DuckDuckGo Instant Answer API (no auth required).
 * Server-side to avoid browser CORS restrictions.
 */
import express from 'express';
const router = express.Router();

// Simple in-process cache (per worker, resets on restart — acceptable for search)
const _cache = new Map();
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function cacheGet(k) {
  const e = _cache.get(k);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.v;
  _cache.delete(k); return null;
}
function cacheSet(k, v) {
  // Cap cache at 200 entries
  if (_cache.size > 200) { const first = _cache.keys().next().value; _cache.delete(first); }
  _cache.set(k, { v, ts: Date.now() });
}

// Sanitise a string — remove HTML tags and trim
function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

router.get('/web-search', async (req, res) => {
  const q    = (req.query.q || '').slice(0, 200).trim();
  const type = (req.query.type || 'search').toLowerCase();

  if (!q) return res.json({ results: [], abstract: '', source: '' });

  const cacheKey = type + ':' + q;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // DuckDuckGo Instant Answer API — free, no key, returns JSON
    const ddgUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(q) +
      '&format=json&no_html=1&skip_disambig=1&no_redirect=1&t=ilovepdf';

    const ctrl   = new AbortController();
    const timer  = setTimeout(() => ctrl.abort(), 6000);

    const resp = await fetch(ddgUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ILovePDFBot/1.0)' },
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error('DDG HTTP ' + resp.status);
    const raw = await resp.json();

    // Build normalised result
    const out = {
      abstract: clean(raw.AbstractText || raw.Answer || ''),
      source:   clean(raw.AbstractSource || ''),
      type:     raw.Type || '',
      results:  [],
    };

    // RelatedTopics → result cards
    const topics = raw.RelatedTopics || [];
    for (const t of topics) {
      if (out.results.length >= 6) break;
      if (t.Text && t.FirstURL) {
        out.results.push({
          title:   clean(t.Text.split(' - ')[0]).slice(0, 120),
          snippet: clean(t.Text).slice(0, 280),
          url:     t.FirstURL,
        });
      } else if (t.Topics) {
        // Nested group
        for (const sub of t.Topics) {
          if (out.results.length >= 6) break;
          if (sub.Text && sub.FirstURL) {
            out.results.push({
              title:   clean(sub.Text.split(' - ')[0]).slice(0, 120),
              snippet: clean(sub.Text).slice(0, 280),
              url:     sub.FirstURL,
            });
          }
        }
      }
    }

    // If we got nothing useful, try a Google News RSS fallback for news queries
    if (out.results.length === 0 && (type === 'news' || /news|headline|khabar/i.test(q))) {
      try {
        const rssUrl = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) +
          '&hl=en-US&gl=US&ceid=US:en';
        const rssCtrl  = new AbortController();
        const rssTimer = setTimeout(() => rssCtrl.abort(), 5000);
        const rssResp  = await fetch(rssUrl, { signal: rssCtrl.signal });
        clearTimeout(rssTimer);
        if (rssResp.ok) {
          const xml = await rssResp.text();
          const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
          for (const [, block] of items.slice(0, 5)) {
            const title   = clean((block.match(/<title>(.*?)<\/title>/)   || [])[1] || '');
            const link    = clean((block.match(/<link[^>]*>(.*?)<\/link>|<link\s+href="([^"]+)"/)  || [])[1] || '');
            const snippet = clean((block.match(/<description>(.*?)<\/description>/) || [])[1] || '');
            if (title) out.results.push({ title: title.slice(0, 120), snippet: snippet.slice(0, 280), url: link });
          }
        }
      } catch (_) { /* RSS fallback failed — ignore */ }
    }

    cacheSet(cacheKey, out);
    res.json(out);

  } catch (err) {
    // Return empty rather than an error so client shows a graceful message
    res.json({ results: [], abstract: '', source: '', error: err.message });
  }
});

export default router;
