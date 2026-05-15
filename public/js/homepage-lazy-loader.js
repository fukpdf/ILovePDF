/**
 * Homepage Lazy Loader — Phase 13B
 *
 * Replaces 50+ eagerly-deferred AI/Laba script tags on the homepage with a
 * smart, SEO-safe, performance-first lazy loading strategy.
 *
 * STRATEGY:
 *   • Crawler detected  → skip all heavy AI scripts (saves 2-4 MB parse work)
 *   • Normal user       → load after 4 s idle OR on first Laba interaction
 *   • Laba widget CSS + laba-widget.js remain in the HTML (loaded eagerly)
 *     so the chat button appears immediately; only the intelligence stack
 *     (laba-ai-chat.js and onwards) is deferred.
 *
 * GUARANTEES:
 *   • Translations (i18n.js)      — always loaded eagerly → unaffected
 *   • SEO tags / structured data  — server-rendered / static → unaffected
 *   • Homepage hero / tools grid  — rendered synchronously by home.js
 *   • Ads (AdSense)               — script tag in <head>, unaffected
 *   • Analytics                   — not in this file; unaffected
 *   • Runtime chain (Phases 1-9)  — only on tool.html, never on homepage
 *   • All tool links / navigation — chrome.js loaded eagerly → unaffected
 *
 * ORDER PRESERVED:
 *   loadScript() uses async=false + sequential await so the exact init
 *   order from the original script tags is maintained. Each file's
 *   window.* global is available before the next file executes.
 *
 * BACKWARD COMPATIBLE:
 *   If any script fails (network error), the chain continues — each
 *   individual failure is swallowed so one broken CDN asset can't block
 *   the rest of the stack. Errors are logged to console.warn.
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
   * Injects a <script> tag with async=false so the browser downloads it
   * but does not execute it before preceding scripts in the same batch.
   * Resolves when loaded; resolves (not rejects) on error so the chain
   * continues even if one file 404s or throws.
   */
  function loadScript(src) {
    return new Promise(function (resolve) {
      // Check if already loaded (idempotent)
      if (document.querySelector('script[src="' + src + '"]')) {
        resolve(); return;
      }
      var s = document.createElement('script');
      s.src   = src;
      s.async = false;   // preserve relative ordering within the batch
      s.onload  = function () { resolve(); };
      s.onerror = function (e) {
        console.warn('[HomepageLazyLoader] failed to load:', src, e);
        resolve();       // swallow — don't block the chain
      };
      document.head.appendChild(s);
    });
  }

  /* ── The heavy stack ────────────────────────────────────────────────────── */
  // Exact order from the original index.html defer script list.
  // ILovePDFCore.LAZY_GROUPS.HOMEPAGE_AI mirrors this list (Phase 12A).
  var HEAVY_STACK = (
    G.ILovePDFCore && G.ILovePDFCore.getLazyGroup('HOMEPAGE_AI')
  ) || [
    '/js/vector-memory-engine.js',
    '/js/generative-ai-engine.js',
    '/js/ai-agent-system.js',
    '/js/p2p-distributed-mesh-v2.js',
    '/js/webgpu-ai-expansion.js',
    '/js/enterprise-memory-fabric.js',
    '/js/ai-document-os-ui.js',
    '/js/laba-ai-chat.js',
    '/js/laba-tool-orchestrator.js',
    '/js/laba-conversational-intelligence.js',
    '/js/laba-memory-system.js',
    '/js/laba-semantic-memory.js',
    '/js/laba-agent-system.js',
    '/js/laba-workflow-engine.js',
    '/js/laba-session-recovery.js',
    '/js/laba-smart-suggestions.js',
    '/js/laba-cognitive-brain.js',
    '/js/laba-personality-engine.js',
    '/js/laba-admin-core.js',
    '/js/laba-dev-copilot.js',
    '/js/laba-safe-executor.js',
    '/js/laba-autonomous-agents.js',
    '/js/laba-context-engine.js',
    '/js/laba-task-queue.js',
    '/js/laba-tool-healing.js',
    '/js/laba-humanizer.js',
    '/js/laba-deep-memory-ext.js',
    '/js/laba-workflow-planner.js',
    '/js/laba-predictive-engine.js',
    '/js/laba-tool-learning.js',
    '/js/final-ai-os-audit.js',
    '/js/real-llm-routing.js',
    '/js/persistent-vector-database.js',
    '/js/autonomous-agent-system.js',
    '/js/stable-p2p-network.js',
    '/js/ai-os-integration.js',
    '/js/real-generative-intelligence.js',
    '/js/autonomous-ai-workers.js',
    '/js/local-ai-runtime.js',
    '/js/browser-compute-cloud.js',
    '/js/hyperscale-vector-memory.js',
    '/js/laba-ai-operating-system.js',
    '/js/final-super-ai-audit.js',
    '/js/real-local-llm-engine.js',
    '/js/advanced-agent-intelligence.js',
    '/js/hyperscale-vector-fabric.js',
    '/js/production-compute-mesh.js',
    '/js/laba-ai-evolution-os.js',
    '/js/final-ai-evolution-audit.js',
    '/js/runtime-global-certification.js',
  ];

  /* ── Load all in sequence ───────────────────────────────────────────────── */
  var _loaded = false;

  async function loadAll() {
    if (_loaded) return;
    _loaded = true;
    console.debug('[HomepageLazyLoader] loading AI/Laba stack (' + HEAVY_STACK.length + ' modules)…');
    for (var i = 0; i < HEAVY_STACK.length; i++) {
      await loadScript(HEAVY_STACK[i]);
    }
    console.debug('[HomepageLazyLoader] AI/Laba stack ready');
    // Emit event so any listener can react (e.g. laba-widget activating chat)
    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:ai-stack-ready'));
    } catch (_) {}
  }

  /* ── Crawler guard ──────────────────────────────────────────────────────── */
  if (isCrawler()) {
    console.debug('[HomepageLazyLoader] crawler detected — heavy AI stack skipped');
    return;
  }

  /* ── Trigger 1: first interaction with the Laba widget ─────────────────── */
  // The laba-widget.js creates the chat bubble. Clicking it before the AI
  // stack is loaded triggers an instant load so the chat responds quickly.
  var _labaSelectors = [
    '.laba-toggle', '.laba-btn', '.laba-trigger', '.laba-chat-toggle',
    '#laba-toggle', '#laba-open', '[data-laba]', '.laba-fab',
    '.laba-chat-btn', '#laba-widget-toggle', '.laba-widget-toggle',
  ];

  function _isLabaTarget(el) {
    if (!el) return false;
    for (var i = 0; i < _labaSelectors.length; i++) {
      try { if (el.closest(_labaSelectors[i])) return true; } catch (_) {}
    }
    return false;
  }

  var _interactionHandler = function (e) {
    if (_isLabaTarget(e.target)) {
      document.removeEventListener('click', _interactionHandler, true);
      clearTimeout(_idleTimer);
      loadAll();
    }
  };
  document.addEventListener('click', _interactionHandler, true);

  /* ── Trigger 2: idle timer ──────────────────────────────────────────────── */
  // Load the heavy stack 4 seconds after the page becomes interactive.
  // This ensures AI systems are ready before most users scroll down and
  // consider using the Laba chat, without blocking the critical render path.
  var _idleTimer = setTimeout(function () {
    document.removeEventListener('click', _interactionHandler, true);
    loadAll();
  }, 4000);

  // If the browser supports requestIdleCallback, use it for the 4s trigger
  // so it doesn't interrupt paint or interaction in flight.
  if (typeof G.requestIdleCallback === 'function') {
    clearTimeout(_idleTimer);
    G.requestIdleCallback(function () {
      _idleTimer = setTimeout(function () {
        document.removeEventListener('click', _interactionHandler, true);
        loadAll();
      }, 2000);   // shorter delay once browser signals idle
    }, { timeout: 4000 });
  }

}(window));
