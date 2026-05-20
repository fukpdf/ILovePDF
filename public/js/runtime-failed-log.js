// RuntimeFailedLog v1.0 — Categorized Failed Processing Logger
// =====================================================================
// Captures, categorises, and stores processing failures in localStorage.
// Integrates with RuntimeTelemetry + RuntimeAnalytics without dependency.
//
// Categories:
//   worker_crash    — Web Worker threw or terminated unexpectedly
//   oom             — Memory / heap exhaustion
//   timeout         — Processing exceeded time limit
//   unsupported_file — File type / version / encoding not supported
//   browser_compat  — Missing API (SharedArrayBuffer, WebGL, WASM, etc.)
//   unknown         — Anything else
//
// Privacy: zero PII. Only tool slug, error category, and anonymous context.
//
// Exposes: window.FailedProcessingLog
//   .record(slug, category, detail?)  — log a failure
//   .getAll()                         — all stored entries (newest first)
//   .getSummary()                     — aggregate counts per category + tool
//   .getForTool(slug)                 — entries for one tool
//   .clear()                          — wipe all logs
// =====================================================================
(function (G) {
  'use strict';

  if (G.FailedProcessingLog) return;

  var LOG         = '[FPL]';
  var LS_KEY      = 'iplv_failed_log_v1';
  var MAX_ENTRIES = 200;
  var MAX_AGE_MS  = 7 * 24 * 3600 * 1000; // 7 days
  var THROTTLE_MS = 30000; // max 1 log per tool per 30 s
  var _throttleMap = {};  // slug → last log ts
  var _isProd      = (typeof G.location !== 'undefined' && !/localhost|127\.0\.0\.1/.test(G.location.hostname));

  var CATEGORIES = ['worker_crash', 'oom', 'timeout', 'unsupported_file', 'browser_compat', 'unknown'];

  function _safe(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Storage helpers ───────────────────────────────────────────────────────
  function _load() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      var cutoff = Date.now() - MAX_AGE_MS;
      return raw.filter(function (e) { return e && e.ts && e.ts > cutoff; });
    } catch (_) { return []; }
  }

  function _save(entries) {
    try {
      var trimmed = entries.slice(-MAX_ENTRIES);
      localStorage.setItem(LS_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }

  // ── Category auto-detection from error message ────────────────────────────
  function _detectCategory(err) {
    if (!err) return 'unknown';
    var msg = String(err.message || err || '').toLowerCase();
    if (/out of memory|heap|oom|allocation|quota exceeded|memory/i.test(msg)) return 'oom';
    if (/timeout|timed out|deadline|too long/i.test(msg)) return 'timeout';
    if (/worker.*terminat|worker.*crash|worker.*stop|worker.*died|worker.*exit/i.test(msg)) return 'worker_crash';
    if (/unsupported|invalid.*format|corrupt|not.*pdf|not.*valid|unrecognized|cannot.*parse/i.test(msg)) return 'unsupported_file';
    if (/sharedarraybuffer|webgl|webgpu|wasm|webassembly|canvas|offscreencanvas|coop|coep/i.test(msg)) return 'browser_compat';
    if (/network|fetch|connection|offline/i.test(msg)) return 'unknown';
    return 'unknown';
  }

  // ── Throttle check ────────────────────────────────────────────────────────
  function _isThrottled(slug) {
    var last = _throttleMap[slug] || 0;
    var now  = Date.now();
    if (now - last < THROTTLE_MS) return true;
    _throttleMap[slug] = now;
    return false;
  }

  // ── Core record function ──────────────────────────────────────────────────
  function record(slug, categoryOrErr, detail) {
    if (!slug) return;

    // Determine category
    var category;
    if (typeof categoryOrErr === 'string' && CATEGORIES.indexOf(categoryOrErr) !== -1) {
      category = categoryOrErr;
    } else {
      category = _detectCategory(categoryOrErr);
    }

    // Throttle per-tool
    if (_isThrottled(slug)) return;

    var entry = {
      ts:       Date.now(),
      slug:     String(slug).slice(0, 64),
      category: category,
      detail:   detail ? String(detail).slice(0, 200) : null,
      ua_type:  /mobile|android|iphone|ipad/i.test(navigator.userAgent || '') ? 'mobile' : 'desktop',
    };

    // Store
    var entries = _load();
    entries.push(entry);
    _save(entries);

    // Emit to analytics (throttled, aggregated — not raw errors)
    _safe(function () {
      if (G.RuntimeAnalytics) {
        G.RuntimeAnalytics.track('processing:failed', {
          tool_id: slug,
          extra: { category: category },
        });
      }
    });

    // Emit to telemetry
    _safe(function () {
      if (G.RuntimeTelemetry) {
        G.RuntimeTelemetry.record('fail:' + category, { slug: slug });
      }
    });

    // Emit custom event (for UI-level recovery prompts)
    _safe(function () {
      G.dispatchEvent(new CustomEvent('iplv:processing-failed', {
        detail: { slug: slug, category: category },
      }));
    });

    if (!_isProd) {
      console.debug(LOG, 'recorded', category, 'for', slug, detail || '');
    }
  }

  // ── Query functions ───────────────────────────────────────────────────────
  function getAll() {
    return _load().reverse();
  }

  function getForTool(slug) {
    return _load().filter(function (e) { return e.slug === slug; }).reverse();
  }

  function getSummary() {
    var entries = _load();
    var byCategory = {};
    var byTool     = {};
    var total      = entries.length;

    CATEGORIES.forEach(function (c) { byCategory[c] = 0; });

    entries.forEach(function (e) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      byTool[e.slug]         = (byTool[e.slug] || 0) + 1;
    });

    // Top failing tools
    var topTools = Object.keys(byTool)
      .map(function (s) { return { slug: s, count: byTool[s] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 10);

    return { total: total, byCategory: byCategory, topTools: topTools };
  }

  function clear() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    _throttleMap = {};
  }

  // ── Auto-hook RuntimeTelemetry task:failed events ─────────────────────────
  function _hookTelemetry() {
    if (!G.RuntimeTelemetry || !G.RuntimeTelemetry.onEvent) return;
    G.RuntimeTelemetry.onEvent(function (ev) {
      if (ev.name !== 'task:failed') return;
      var d    = ev.data || {};
      var slug = d.toolId || d.slug || d.tool || null;
      var err  = d.error  || d.reason || d.message || null;
      if (slug) record(slug, err || 'unknown');
    });
  }

  // ── Auto-hook uncaught worker errors ─────────────────────────────────────
  function _hookWorkerErrors() {
    var orig = G.WorkerPool;
    if (orig && orig.onError) {
      try {
        orig.onError(function (err, meta) {
          var slug = meta && (meta.toolId || meta.slug) || null;
          record(slug || 'unknown', 'worker_crash', err && err.message);
        });
      } catch (_) {}
    }
  }

  // ── Periodic cleanup (auto-remove entries older than MAX_AGE_MS) ──────────
  function _scheduleCleanup() {
    setInterval(function () {
      var entries = _load();
      _save(entries); // _load() already filters by MAX_AGE_MS
    }, 30 * 60 * 1000); // every 30 min
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function _init() {
    _hookTelemetry();
    _hookWorkerErrors();
    _scheduleCleanup();
    if (!_isProd) console.debug(LOG, 'ready — entries:', _load().length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.FailedProcessingLog = {
    record:     record,
    getAll:     getAll,
    getForTool: getForTool,
    getSummary: getSummary,
    clear:      clear,
    CATEGORIES: CATEGORIES,
  };

}(window));
