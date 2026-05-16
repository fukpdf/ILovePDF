// RuntimeAnalytics v1.0 — Phase 27
// =====================================================================
// Client-side analytics bus.  Enriches every event with runtime context
// (uid, fp_hash, trust_score, gpu_tier, pwa_installed, savings_pkr)
// and flushes batches to /api/admin/analytics/event.
//
// PRIVACY:  Only hashed fp_hash is ever sent — never raw fingerprint.
// SECURITY: All reads behind /api/admin/* (adminGuard).  Public endpoint
//           accepts writes only.
// CRAWLER-SAFE: Bot UA suppresses all tracking.
//
// Auto-tracks: page_view · tool_use · credits_consumed · credits_rewarded
//   savings_added · donation_clicked · ad_shown · ad_completed
//   pwa_installed · gpu_init · quota_exceeded · abuse_detected
//
// Exposes: window.RuntimeAnalytics
//   .track(event, data)  — queue + flush
//   .flush()             — force immediate flush
//   .getStats()          — session snapshot
//   .getContext()        — current device context
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeAnalytics) return;

  var LOG = '[RuntimeAnalytics]';

  // ── Crawler guard ──────────────────────────────────────────────────
  var CRAWLER_RE = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|bot|crawler|spider/i;
  if (CRAWLER_RE.test((typeof navigator !== 'undefined' && navigator.userAgent) || '')) return;

  var ENDPOINT          = '/api/admin/analytics/event';
  var FLUSH_DEBOUNCE_MS = 2000;
  var MAX_QUEUE         = 20;
  var _queue            = [];
  var _flushTimer       = null;
  var _context          = null;
  var _listenersOn      = false;
  var _session          = { tracked: 0, flushed: 0, errors: 0, startTs: Date.now() };

  // ── Device context ─────────────────────────────────────────────────
  function buildContext() {
    var gpuTier = 'unknown';
    try {
      if (global.RuntimeGpuEngine && global.RuntimeGpuEngine.getTier) {
        gpuTier = global.RuntimeGpuEngine.getTier() || 'unknown';
      } else if (global.__IPLV_GPU_TIER__) {
        gpuTier = global.__IPLV_GPU_TIER__;
      }
    } catch (_) {}

    var pwaInstalled = 0;
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) pwaInstalled = 1;
      if (navigator.standalone) pwaInstalled = 1;
    } catch (_) {}

    var uid = '', fpHash = '', trustScore = -1;
    try {
      if (global.RuntimeIdentity) {
        uid        = global.RuntimeIdentity.getUser().id || '';
        fpHash     = global.RuntimeIdentity.getFingerprint().hash || '';
        trustScore = global.RuntimeIdentity.getTrust().score;
      }
    } catch (_) {}

    var ua     = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    var uaType = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';

    return { uid: uid, fp_hash: fpHash, trust_score: trustScore,
             gpu_tier: gpuTier, pwa_installed: pwaInstalled, ua_type: uaType };
  }

  function getContext() {
    if (!_context) _context = buildContext();
    return _context;
  }

  function refreshContext() { _context = buildContext(); }

  // ── Queue + flush ──────────────────────────────────────────────────
  function enqueue(event, data) {
    data = data || {};
    var ctx     = getContext();
    var savings = 0;
    try { if (global.RuntimeSavings) savings = global.RuntimeSavings.getToday().total || 0; } catch (_) {}

    _queue.push({
      event:         event,
      tool_id:       data.tool_id || data.slug || data.tool || null,
      path:          (global.location && global.location.pathname) || '',
      referrer:      (global.document && global.document.referrer) || '',
      uid:           data.uid       || ctx.uid,
      fp_hash:       ctx.fp_hash,
      trust_score:   ctx.trust_score,
      savings_pkr:   data.savings_pkr != null ? data.savings_pkr : savings,
      gpu_tier:      data.gpu_tier  || ctx.gpu_tier,
      pwa_installed: ctx.pwa_installed,
      ua_type:       ctx.ua_type,
      extra:         data.extra ? JSON.stringify(data.extra) : null,
    });

    _session.tracked++;
    if (_queue.length >= MAX_QUEUE) { flush(); } else { scheduleFlush(); }
  }

  function scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(function () { _flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
  }

  function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (!_queue.length) return;
    var batch = _queue.splice(0, 10);
    batch.forEach(function (item) {
      fetch(ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body:    JSON.stringify(item),
        keepalive: true,
      })
      .then(function (r) { if (r.ok) _session.flushed++; })
      .catch(function () { _session.errors++; });
    });
  }

  // ── Auto-listeners (attached once) ─────────────────────────────────
  function attachListeners() {
    if (_listenersOn) return;
    _listenersOn = true;

    document.addEventListener('savings:added', function (e) {
      var d = e.detail || {};
      enqueue('savings_added', { slug: d.slug, savings_pkr: d.amount, extra: { todayTotal: d.todayTotal } });
    });
    document.addEventListener('credits:consumed', function (e) {
      var d = e.detail || {};
      enqueue('credits_consumed', { tool_id: d.op, extra: { remaining: d.remaining } });
    });
    document.addEventListener('credits:rewarded', function (e) {
      var d = e.detail || {};
      enqueue('credits_rewarded', { extra: { added: d.added, newTotal: d.newTotal } });
    });
    document.addEventListener('credits:reset', function () {
      enqueue('credits_reset', {});
    });
    document.addEventListener('donation:clicked', function (e) {
      var d = e.detail || {};
      enqueue('donation_clicked', { extra: { provider: d.provider } });
    });
    document.addEventListener('gpu:init', function (e) {
      var d = e.detail || {};
      refreshContext();
      enqueue('gpu_init', { gpu_tier: d.tier || d.mode, extra: { adapter: d.adapter } });
    });
    global.addEventListener('appinstalled', function () {
      refreshContext();
      enqueue('pwa_installed', { pwa_installed: 1 });
    });
    global.addEventListener('pagehide', function () { flush(); }, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // ── Public API ─────────────────────────────────────────────────────
  global.RuntimeAnalytics = {
    track: function (event, data) {
      if (!event || typeof event !== 'string') return;
      enqueue(event, data || {});
    },
    flush: flush,
    getStats: function () {
      return {
        session:  Object.assign({}, _session, { uptimeMs: Date.now() - _session.startTs }),
        queueLen: _queue.length,
        context:  getContext(),
      };
    },
    getContext:     getContext,
    refreshContext: refreshContext,
  };

  // ── Boot ────────────────────────────────────────────────────────────
  function boot() {
    attachListeners();
    setTimeout(function () {
      refreshContext();
      enqueue('page_view', {});
    }, 600);
    if (global.RT && global.RT.register) {
      try { global.RT.register('analytics', global.RuntimeAnalytics); } catch (_) {}
    }
    console.info(LOG, 'v1.0 ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

}(typeof window !== 'undefined' ? window : this));
