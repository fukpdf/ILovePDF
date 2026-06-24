/**
 * runtime-tool-idle-loader.js — Phase 2B Idle Group Separator
 *
 * Loads IDLE and BACKGROUND runtime systems on tool pages after the browser
 * signals idle time — never during the critical render path.
 *
 * STRATEGY:
 *   • Crawler detected  → skip all idle scripts (no parse cost for bots)
 *   • Normal user       → load after requestIdleCallback fires (≤4 s timeout)
 *                         with a 5 s hard fallback timer
 *   • Upload UI / chrome.js / tool-page.js remain completely unaffected
 *
 * TARGET SYSTEMS (all purely additive, use _s() / window.X guards):
 *   1.  runtime-diagnostics-center.js  — enterprise diagnostics (Phase 27)
 *   2.  runtime-prefetch.js            — predictive route prefetch (Phase 28)
 *   3.  runtime-worker-warmup.js       — idle worker pool warmup
 *   4.  runtime-processing-concurrency.js — browser-side processing semaphore
 *   5.  runtime-compression-presets.js — adaptive compression preset selector
 *   6.  runtime-session-intel.js       — session funnel + rage-click + heatmap
 *   7.  runtime-tool-engagement.js     — per-tool engagement counters
 *   8.  runtime-pinned-tools.js        — pinned recent tools UI
 *   9.  runtime-ai-graph.js            — AI pipeline DAG visualiser (Phase 29)
 *   10. runtime-cross-tab.js           — BroadcastChannel tab coordination
 *   11. runtime-ai-orchestrator.js     — AI provider chain wiring (Phase 6E)
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
   * Injects a <script async=false> so the browser downloads it without
   * blocking but preserves relative ordering within the idle batch.
   * Always resolves — errors are logged and swallowed so one 404 or
   * syntax error cannot stall the rest of the idle stack.
   */
  function loadScript(src) {
    return new Promise(function (resolve) {
      if (document.querySelector('script[src="' + src + '"]')) {
        resolve(); return;
      }
      var s = document.createElement('script');
      s.src   = src;
      s.async = false;
      s.onload  = function () { resolve(); };
      s.onerror = function (e) {
        console.warn('[ToolIdleLoader] failed to load:', src, e);
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  /* ── Idle stack ─────────────────────────────────────────────────────────── */
  var IDLE_STACK = [
    '/js/runtime-diagnostics-center.js',
    '/js/runtime-prefetch.js',
    '/js/runtime-worker-warmup.js',
    '/js/runtime-processing-concurrency.js',
    '/js/runtime-compression-presets.js',
    '/js/runtime-session-intel.js',
    '/js/runtime-tool-engagement.js',
    '/js/runtime-pinned-tools.js',
    '/js/runtime-ai-graph.js',
    '/js/runtime-cross-tab.js',
    '/js/runtime-ai-orchestrator.js',
    '/js/ad-manager.js',
    '/js/ad-responsive-engine.js',
    '/js/analytics-engine.js',
  ];

  /* ── Sequential loader ──────────────────────────────────────────────────── */
  var _loaded = false;

  async function loadAll() {
    if (_loaded) return;
    _loaded = true;
    console.debug('[ToolIdleLoader] loading idle runtime stack (' + IDLE_STACK.length + ' modules)…');
    for (var i = 0; i < IDLE_STACK.length; i++) {
      await loadScript(IDLE_STACK[i]);
    }
    console.debug('[ToolIdleLoader] idle runtime stack ready');
    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-idle-stack-ready'));
    } catch (_) {}
  }

  /* ── Crawler guard ──────────────────────────────────────────────────────── */
  if (isCrawler()) {
    console.debug('[ToolIdleLoader] crawler detected — idle stack skipped');
    return;
  }

  /* ── Trigger: requestIdleCallback → 2 s inner delay (4 s hard timeout) ─── */
  var _idleTimer;

  if (typeof G.requestIdleCallback === 'function') {
    G.requestIdleCallback(function () {
      _idleTimer = setTimeout(loadAll, 2000);
    }, { timeout: 4000 });
  } else {
    _idleTimer = setTimeout(loadAll, 5000);
  }

  /* ── Accelerate on first file drop / input interaction ──────────────────── */
  function _onFirstInteraction() {
    document.removeEventListener('dragenter', _onFirstInteraction, true);
    document.removeEventListener('change',    _onFirstInteraction, true);
    clearTimeout(_idleTimer);
    loadAll();
  }
  document.addEventListener('dragenter', _onFirstInteraction, true);
  document.addEventListener('change',    _onFirstInteraction, true);

}(window));
