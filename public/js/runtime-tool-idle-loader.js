/**
 * runtime-tool-idle-loader.js — Phase 2B Idle Group Separator
 *
 * Loads IDLE and BACKGROUND runtime systems on tool pages after the browser
 * signals idle time — never during the critical render path.
 *
 * STRATEGY:
 *   • Crawler detected → skip all idle scripts (no parse cost for bots)
 *   • Normal user → load on the first requestIdleCallback opportunity,
 *                   with a 4 s requestIdleCallback timeout
 *   • Browsers without requestIdleCallback → 5 s fallback timer
 *   • File/drop input interaction → accelerate immediately
 *   • Upload UI / chrome.js / tool-page.js remain completely unaffected
 *
 * TARGET SYSTEMS (all purely additive, use _s() / window.X guards):
 *   1.  runtime-diagnostics-center.js  — enterprise diagnostics (Phase 27)
 *   2.  runtime-prefetch.js            — predictive route prefetch (Phase 28)
 *   3.  runtime-processing-concurrency.js — browser-side processing semaphore
 *   4.  runtime-compression-presets.js — adaptive compression preset selector
 *   5.  runtime-session-intel.js       — session funnel + rage-click + heatmap
 *   6.  runtime-tool-engagement.js     — per-tool engagement counters
 *   7.  runtime-pinned-tools.js        — pinned recent tools UI
 *   8.  runtime-ai-graph.js            — AI pipeline DAG visualiser (Phase 29)
 *   9.  runtime-cross-tab.js           — BroadcastChannel tab coordination
 *   10. runtime-ai-orchestrator.js     — AI provider chain wiring (Phase 6E)
 *
 * GUARANTEES:
 *   • Upload / preview / processing / download — completely unaffected
 *   • BrowserTools.process() — untouched
 *   • Arc systems — untouched
 *   • Workers — untouched
 *   • Security chain — untouched
 *   • Order preserved: loadScript(async=false) loads sequentially
 *   • Idempotent: skips any script tag already in the document
 *   • Fault-tolerant: one failed file never blocks the rest of the chain
 *
 * REUSES: homepage-lazy-loader.js pattern exactly (Phase 13B reference).
 */
(function (G) {
  'use strict';

  /* ── Crawler detection ──────────────────────────────────────────────────── */
  var CRAWLER_RE = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|exabot|ia_archiver|facebot|facebookexternalhit|twitterbot|linkedinbot|semrush|ahrefs|bot|crawler|spider|scraper/i;

  function isCrawler() {
    try { return CRAWLER_RE.test(navigator.userAgent || ''); }
    catch (_) { return false; }
  }

  /* ── Script loader ──────────────────────────────────────────────────────── */
  /**
   * loadScript(src) → Promise<void>
   * Injects a <script async=false> and preserves relative ordering within
   * the idle batch. Always resolves so one failed file cannot stall the chain.
   */
  function loadScript(src) {
    return new Promise(function (resolve) {
      if (document.querySelector('script[src="' + src + '"]')) {
        resolve(); return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function (e) {
        console.warn('[ToolIdleLoader] failed to load:', src, e);
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  /* ── Idle stack ─────────────────────────────────────────────────────────── */
  // Root modules have no dependency on another idle-stack module and can be
  // fetched concurrently. The second wave contains only modules whose direct
  // idle-stack dependency was verified: AI graph → diagnostics, responsive ads
  // → AdManager, analytics sync → AnalyticsEngine.
  var IDLE_ROOT_STACK = [
    '/js/runtime-diagnostics-center.js',
    '/js/runtime-prefetch.js',
    '/js/runtime-processing-concurrency.js',
    '/js/runtime-compression-presets.js',
    '/js/runtime-session-intel.js',
    '/js/runtime-tool-engagement.js',
    '/js/runtime-pinned-tools.js',
    '/js/runtime-cross-tab.js',
    '/js/runtime-ai-orchestrator.js',
    '/js/ad-manager.js',
    '/js/analytics-engine.js',
  ];

  var IDLE_DEPENDENT_STACK = [
    '/js/runtime-ai-graph.js',
    '/js/ad-responsive-engine.js',
    '/js/analytics-sync.js',
  ];

  var IDLE_STACK_COUNT = IDLE_ROOT_STACK.length + IDLE_DEPENDENT_STACK.length;

  /* ── Dependency boundary ──────────────────────────────────────────────── */
  /* ── Crawler guard ──────────────────────────────────────────────────────── */
  if (isCrawler()) {
    console.debug('[ToolIdleLoader] crawler detected — idle stack skipped');
    return;
  }

  /* ── Trigger scheduling ─────────────────────────────────────────────────── */
  var _fallbackTimer = null;
  var _triggered = false;

  function triggerLoad() {
    if (_triggered || _loaded) return;
    _triggered = true;
    if (_fallbackTimer !== null) {
      clearTimeout(_fallbackTimer);
      _fallbackTimer = null;
    }
    loadAll();
  }

  if (typeof G.requestIdleCallback === 'function') {
    G.requestIdleCallback(function () {
      triggerLoad();
    }, { timeout: 4000 });

    _fallbackTimer = setTimeout(triggerLoad, 5000);
  } else {
    _fallbackTimer = setTimeout(triggerLoad, 5000);
  }

  /* ── Accelerate on first file drop / input interaction ──────────────────── */
  function _onFirstInteraction() {
    document.removeEventListener('dragenter', _onFirstInteraction, true);
    document.removeEventListener('change', _onFirstInteraction, true);
    triggerLoad();
  }

  document.addEventListener('dragenter', _onFirstInteraction, true);
  document.addEventListener('change', _onFirstInteraction, true);

}(window));
