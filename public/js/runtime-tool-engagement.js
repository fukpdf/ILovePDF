// RuntimeToolEngagement v1.0 — Per-Tool Processed / Downloaded / Failed / Retry Counters
// =====================================================================
// Extends the session intelligence layer with granular per-tool engagement
// metrics beyond simple visit counts. Tracks what happened AFTER the user
// opened a tool — did they process? Download? Fail? Retry?
//
// Storage: localStorage 'iplv_engagement_v2' — 7-day rolling window.
// Structure per slug: { p: processed, d: downloaded, f: failed, r: retries, ts: lastSeen }
//
// Integrates with:
//   RuntimeTelemetry  — listens for task lifecycle events
//   RuntimeAnalytics  — sends periodic engagement snapshots
//   RuntimeEventBus   — listens for download:triggered
//
// Exposes: window.RuntimeToolEngagement
//   .getStats(slug?)          — stats for one or all tools
//   .getTopProcessed(n?)      — [{slug, processed}] sorted by processed count
//   .getTopDownloaded(n?)     — [{slug, downloaded}] sorted
//   .getTopFailed(n?)         — [{slug, failed}] sorted
//   .getMostRetried(n?)       — [{slug, retries}] sorted
//   .getConversionRate(slug)  — downloads/processed ratio (0-1)
//   .record(slug, action)     — manually record an action
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolEngagement) return;

  var LOG         = '[RTE]';
  var LS_KEY      = 'iplv_engagement_v2';
  var MAX_SLUGS   = 60;
  var MAX_AGE_MS  = 7 * 24 * 3600 * 1000;
  var ACTIONS     = ['processed', 'downloaded', 'failed', 'retry'];

  var CRAWLER_RE  = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|bot|crawler|spider/i;
  if (CRAWLER_RE.test((navigator.userAgent) || '')) return;

  // ── Storage ───────────────────────────────────────────────────────────────
  function _load() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (typeof raw !== 'object' || Array.isArray(raw)) return {};
      // Prune expired slugs
      var cutoff = Date.now() - MAX_AGE_MS;
      var cleaned = {};
      Object.keys(raw).forEach(function (s) {
        if (raw[s] && raw[s].ts && raw[s].ts > cutoff) cleaned[s] = raw[s];
      });
      return cleaned;
    } catch (_) { return {}; }
  }

  function _save(data) {
    try {
      var keys = Object.keys(data);
      // If over cap, remove least recently seen
      if (keys.length > MAX_SLUGS) {
        keys.sort(function (a, b) { return (data[a].ts || 0) - (data[b].ts || 0); });
        keys.slice(0, keys.length - MAX_SLUGS).forEach(function (k) { delete data[k]; });
      }
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function _entry(slug) {
    return { p: 0, d: 0, f: 0, r: 0, ts: Date.now(), slug: slug };
  }

  // ── Core record ───────────────────────────────────────────────────────────
  function record(slug, action) {
    if (!slug || ACTIONS.indexOf(action) === -1) return;
    var data = _load();
    var e    = data[slug] || _entry(slug);
    if (action === 'processed')  e.p = (e.p || 0) + 1;
    if (action === 'downloaded') e.d = (e.d || 0) + 1;
    if (action === 'failed')     e.f = (e.f || 0) + 1;
    if (action === 'retry')      e.r = (e.r || 0) + 1;
    e.ts   = Date.now();
    data[slug] = e;
    _save(data);
  }

  // ── Periodic analytics snapshot ───────────────────────────────────────────
  var _snapCount = 0;
  function _maybeSnapshot(data) {
    _snapCount++;
    if (_snapCount % 20 !== 0) return; // every 20 events
    try {
      if (!G.RuntimeAnalytics) return;
      var top = _sortedBy(data, 'p').slice(0, 3);
      G.RuntimeAnalytics.track('tool:engagement_snapshot', {
        extra: {
          top3p: top.map(function (t) { return t.slug + ':' + t.processed; }).join(','),
        },
      });
    } catch (_) {}
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────
  function _hookTelemetry() {
    if (!G.RuntimeTelemetry || !G.RuntimeTelemetry.onEvent) return;
    G.RuntimeTelemetry.onEvent(function (ev) {
      var n    = ev.name || '';
      var d    = ev.data || {};
      var slug = d.toolId || d.slug || d.tool || _currentSlug();
      if (!slug) return;
      if (n === 'task:completed' || n === 'queue:task-done') {
        record(slug, 'processed');
        _maybeSnapshot(_load());
      }
      if (n === 'task:failed')   { record(slug, 'failed'); }
      if (n === 'task:retry' || n === 'worker:retry') { record(slug, 'retry'); }
    });
  }

  function _hookDownload() {
    document.addEventListener('download:triggered', function (e) {
      var slug = (e.detail && e.detail.slug) || _currentSlug();
      if (slug) record(slug, 'downloaded');
    }, { passive: true });
    if (G.DownloadManager && G.DownloadManager.onDownload) {
      try {
        G.DownloadManager.onDownload(function (d) {
          var slug = (d && d.toolId) || _currentSlug();
          if (slug) record(slug, 'downloaded');
        });
      } catch (_) {}
    }
  }

  function _hookRetry() {
    // Listen for retry events dispatched by advanced-engine or tool-page
    document.addEventListener('processing:retry', function (e) {
      var slug = (e.detail && e.detail.slug) || _currentSlug();
      if (slug) record(slug, 'retry');
    }, { passive: true });
  }

  function _currentSlug() {
    try {
      var p = (G.location && G.location.pathname || '/').replace(/^\//, '').split('/')[0];
      return p && p !== 'index.html' ? p : null;
    } catch (_) { return null; }
  }

  // ── Query helpers ─────────────────────────────────────────────────────────
  function _sortedBy(data, field) {
    var FIELD_MAP = { p: 'processed', d: 'downloaded', f: 'failed', r: 'retries' };
    var shortKey  = Object.keys(FIELD_MAP).find(function (k) { return FIELD_MAP[k] === field || k === field; }) || 'p';
    return Object.keys(data)
      .map(function (s) {
        return {
          slug:       s,
          processed:  data[s].p || 0,
          downloaded: data[s].d || 0,
          failed:     data[s].f || 0,
          retries:    data[s].r || 0,
        };
      })
      .sort(function (a, b) { return b[FIELD_MAP[shortKey] || 'processed'] - a[FIELD_MAP[shortKey] || 'processed']; });
  }

  function getStats(slug) {
    var data = _load();
    if (slug) {
      var e = data[slug];
      return e ? { slug: slug, processed: e.p||0, downloaded: e.d||0, failed: e.f||0, retries: e.r||0, lastSeen: e.ts } : null;
    }
    return _sortedBy(data, 'p');
  }

  function getTopProcessed(n)  { return _sortedBy(_load(), 'p').slice(0, n || 10); }
  function getTopDownloaded(n) { return _sortedBy(_load(), 'd').slice(0, n || 10); }
  function getTopFailed(n)     { return _sortedBy(_load(), 'f').slice(0, n || 10); }
  function getMostRetried(n)   { return _sortedBy(_load(), 'r').slice(0, n || 10); }

  function getConversionRate(slug) {
    var s = getStats(slug);
    if (!s || !s.processed) return 0;
    return Math.min(1, s.downloaded / s.processed);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function _init() {
    _hookTelemetry();
    _hookDownload();
    _hookRetry();
    console.debug(LOG, 'ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  G.RuntimeToolEngagement = {
    record:              record,
    getStats:            getStats,
    getTopProcessed:     getTopProcessed,
    getTopDownloaded:    getTopDownloaded,
    getTopFailed:        getTopFailed,
    getMostRetried:      getMostRetried,
    getConversionRate:   getConversionRate,
  };

}(window));
