/**
 * Lightweight Tool Upload Loader
 * --------------------------------
 * Critical path: only the shell/runtime required to render the upload page.
 * Everything processor-specific is loaded after the page has painted, and
 * only for the active tool.
 */
(function (G) {
  'use strict';

  if (G.__ILOVE_TOOL_PAGE_LOADER__) return;
  G.__ILOVE_TOOL_PAGE_LOADER__ = true;

  var BASE = [
    '/js/config.js',
    '/js/timer-registry.js',
    '/js/phase1-stabilization.js',
    '/js/runtime-device-lite.js',
    '/js/tools-config.js?v=20261003-second-section-v2',
    '/js/tool-registry-runtime.js',
    '/js/browser-tools.js',
    '/js/tool-module-registry.js',
    '/js/tool-content.js',
    '/js/tool-state.js',
    '/js/session-persist.js',
    'https://unpkg.com/lucide@0.474.0/dist/umd/lucide.min.js',
    '/js/i18n.js?v=__BUILD_ID__',
    '/js/i18n-ext.js?v=__BUILD_ID__',
    '/js/chrome.js',
    '/js/tool-page.js?v=20261003-cloud-layout-v4',
    '/js/shared.js?v=__BUILD_ID__',
    '/js/tool-i18n-bridge.js?v=__BUILD_ID__'
  ];

  var loaded = Object.create(null);
  var loading = Object.create(null);

  function hasScript(src) {
    var clean = String(src).replace(/^https?:\/\/[^/]+/, '');
    var nodes = document.querySelectorAll('script[src]');
    for (var i = 0; i < nodes.length; i++) {
      var current = nodes[i].src.replace(/^https?:\/\/[^/]+/, '');
      if (current === clean) return true;
    }
    return false;
  }

  function loadScript(src) {
    if (loaded[src] || hasScript(src)) {
      loaded[src] = true;
      return Promise.resolve();
    }
    if (loading[src]) return loading[src];

    loading[src] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () {
        loaded[src] = true;
        delete loading[src];
        resolve();
      };
      s.onerror = function () {
        delete loading[src];
        console.warn('[ToolPageLoader] failed:', src);
        resolve();
      };
      document.head.appendChild(s);
    });
    return loading[src];
  }

  function getToolId() {
    try {
      if (typeof G.resolveToolIdFromUrl === 'function') return G.resolveToolIdFromUrl();
      if (G.__TOOL_ID) return G.__TOOL_ID;
      var q = new URLSearchParams(location.search).get('id');
      if (q) return q;
      var slug = (location.pathname || '/').replace(/^\/+|\/+$/g, '').toLowerCase();
      return (G.SLUG_MAP && G.SLUG_MAP[slug] && G.SLUG_MAP[slug].id) || slug || null;
    } catch (_) {
      return G.__TOOL_ID || null;
    }
  }

  function isIn(list, id) {
    return list.indexOf(id) !== -1;
  }

  function unique(list) {
    var out = [];
    list.forEach(function (src) {
      if (src && out.indexOf(src) === -1) out.push(src);
    });
    return out;
  }

  // Only the active tool's processor/preview/editor dependencies are eligible.
  function relatedScripts(toolId) {
    var pdfPreviewTools = [
      'merge','split','rotate','crop','organize','page-numbers','watermark',
      'sign','redact','protect','unlock','repair','compare','pdf-to-word',
      'pdf-to-powerpoint','pdf-to-excel','pdf-to-jpg','word-to-pdf',
      'powerpoint-to-pdf','excel-to-pdf','html-to-pdf','scan-to-pdf','ocr',
      'ai-summarize','translate','edit','jpg-to-pdf'
    ];

    var pageOrganizerTools = [
      'split','rotate','organize','crop','page-numbers','watermark','sign',
      'redact','ocr','ai-summarize','translate','repair','edit'
    ];

    var livePreviewTools = [
      'word-to-pdf','excel-to-pdf','pdf-to-word','pdf-to-excel',
      'background-remover','translate','ai-summarize','edit',
      'pdf-to-powerpoint','powerpoint-to-pdf','html-to-pdf','ocr',
      'scan-to-pdf','repair','word-to-excel'
    ];

    var scripts = [
      '/js/browser-tool-runtime.js',
      '/js/runtime-tool-code-loader.js'
    ];

    if (isIn(pdfPreviewTools, toolId)) scripts.push('/js/pdf-preview.js');
    if (isIn(pageOrganizerTools, toolId)) scripts.push('/js/page-organizer.js');
    if (isIn(livePreviewTools, toolId)) scripts.push('/js/live-preview.js');

    if (toolId === 'background-remover') scripts.push('/js/bg-remover-pro.js');
    if (toolId === 'edit') scripts.push('/js/edit-pdf-pro.js');

    return unique(scripts);
  }

  // Keep authentication/language/PWA helpers out of the upload critical path.
  var POST_LOAD_SHARED = [
    '/js/auth-ui.js?v=__BUILD_ID__',
    '/js/footer-lang.js',
    '/js/pwa-register.js'
  ];

  async function bootCritical() {
    for (var i = 0; i < BASE.length; i++) await loadScript(BASE[i]);

    // tool-page.js registers its DOMContentLoaded handler. Because this loader
    // is itself placed at the end of <body>, the critical chain completes
    // before DOMContentLoaded fires, preserving the existing initialization.
    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-critical-ready', {
        detail: { toolId: getToolId() }
      }));
    } catch (_) {}
  }

  async function bootAfterPaint() {
    var toolId = getToolId();
    var deps = relatedScripts(toolId);

    // Wait until the browser has painted the upload page. This is deliberately
    // later than DOMContentLoaded so the first screen is interactive first.
    for (var i = 0; i < deps.length; i++) await loadScript(deps[i]);

    // The existing per-tool graph loads only workers/extras belonging to the
    // active tool. No other tool's processor bundle is fetched.
    try {
      if (G.RuntimeToolCodeLoader && typeof G.RuntimeToolCodeLoader.load === 'function') {
        await G.RuntimeToolCodeLoader.load(toolId);
      }
    } catch (_) {}

    // Small shared helpers are non-critical; load them after the tool runtime.
    for (var j = 0; j < POST_LOAD_SHARED.length; j++) {
      await loadScript(POST_LOAD_SHARED[j]);
    }

    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-lazy-ready', {
        detail: { toolId: toolId, scripts: deps.slice() }
      }));
    } catch (_) {}
  }

  bootCritical().then(function () {
    var start = function () {
      var schedule = function () {
        bootAfterPaint().catch(function (e) {
          console.warn('[ToolPageLoader] lazy phase failed:', e);
        });
      };
      if (typeof G.requestAnimationFrame === 'function') {
        G.requestAnimationFrame(function () {
          G.requestAnimationFrame(schedule);
        });
      } else {
        setTimeout(schedule, 50);
      }
    };

    if (document.readyState === 'complete') {
      start();
    } else {
      G.addEventListener('load', start, { once: true });
    }
  });
}(window));
