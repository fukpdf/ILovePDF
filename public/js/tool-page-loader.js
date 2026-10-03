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

  // Critical scripts only. They are inserted together so the browser can
  // download them in parallel; async=false preserves their execution order.
  // Do not turn this into a sequential waterfall: the tool shell must become
  // interactive as soon as the dependency graph is available.
  var BASE = [
    '/js/config.js',
    '/js/timer-registry.js',
    '/js/phase1-stabilization.js',
    '/js/runtime-device-lite.js',
    '/js/tools-config.js?v=20261003-second-section-v2',
    '/js/tool-registry-runtime.js',
    '/js/tool-module-registry.js',
    '/js/tool-content.js',
    '/js/tool-state.js',
    '/js/session-persist.js',
    '/js/i18n.js?v=__BUILD_ID__',
    '/js/i18n-ext.js?v=__BUILD_ID__',
    '/js/chrome.js',
    '/js/tool-page.js?v=20261003-cloud-layout-v4',
    '/js/shared.js?v=__BUILD_ID__',
    '/js/browser-tool-runtime.js'
  ];

  // Non-critical UI assets are deliberately delayed until after first paint.
  var LAZY_CSS = [
    '/css/economy.css',
    '/css/community-economy.css',
    '/css/home.css',
    '/css/blog.css',
    '/css/seo-extended.css',
    '/css/ads.css',
    '/css/responsive-ads.css',
    '/css/home-footer-v2.css?v=20260924',
    '/css/rtl.css',
    '/css/editor-workspace.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
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

  function loadStylesheet(href) {
    if (document.querySelector('link[data-ilpdf-lazy-css="' + href + '"]')) {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-ilpdf-lazy-css', href);
      link.onload = resolve;
      link.onerror = function () {
        console.warn('[ToolPageLoader] failed CSS:', href);
        resolve();
      };
      document.head.appendChild(link);
    });
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
      '/js/runtime-tool-code-loader.js'
    ];

    if (isIn(pdfPreviewTools, toolId)) scripts.push('/js/pdf-preview.js');
    if (isIn(pageOrganizerTools, toolId)) scripts.push('/js/page-organizer.js');
    if (isIn(livePreviewTools, toolId)) scripts.push('/js/live-preview.js');

    if (toolId === 'background-remover') scripts.push('/js/bg-remover-pro.js');
    if (toolId === 'edit') scripts.push('/js/edit-pdf-pro.js');

    // Canonical tool adapters/apps are lazy too: only the active tool pays for
    // its processor boundary after the upload shell has painted.
    var canonicalToolDeps = {
      'crop': ['/js/crop-pdf-app.js'],
      'page-numbers': ['/js/page-numbers-worker-adapter.js'],
      'redact': ['/js/redact-worker-adapter.js'],
      'sign': ['/js/sign-worker-adapter.js'],
      'watermark': ['/js/watermark-worker-adapter.js'],
      'compare': ['/js/compare-worker-adapter.js'],
      'ocr': ['/js/ocr-tool-app.js', '/js/ocr-runtime.js', '/js/ocr-worker-adapter.js']
    };
    (canonicalToolDeps[toolId] || []).forEach(function (src) {
      scripts.push(src);
    });

    return unique(scripts);
  }

  // Keep authentication/language/PWA helpers out of the upload critical path.
  var POST_LOAD_SHARED = [
    '/js/browser-tools.js',
    'https://unpkg.com/lucide@0.474.0/dist/umd/lucide.min.js',
    '/js/tool-i18n-bridge.js?v=__BUILD_ID__',
    '/js/auth-ui.js?v=__BUILD_ID__',
    '/js/footer-lang.js',
    '/js/pwa-register.js'
  ];

  async function bootCritical() {
    // Start the whole critical graph together. Dynamic classic scripts with
    // async=false execute in insertion order while their downloads overlap.
    // This removes the old N-request waterfall without changing dependency
    // execution order.
    await Promise.all(BASE.map(loadScript));

    // tool-page.js registers its DOMContentLoaded handler. The loader is
    // deferred in <head>, so the critical chain can finish before DOMContentLoaded
    // while HTML parsing continues uninterrupted.
    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-critical-ready', {
        detail: { toolId: getToolId() }
      }));
    } catch (_) {}
  }

  async function bootAfterPaint() {
    var toolId = getToolId();
    var deps = relatedScripts(toolId);

    // After first paint, fetch only this tool's processor graph and optional
    // shared assets. Dependencies in the selected graph are still ordered.
    await Promise.all(deps.map(loadScript));
    await Promise.all(LAZY_CSS.map(loadStylesheet));

    // The existing per-tool graph loads only workers/extras belonging to the
    // active tool. No other tool's processor bundle is fetched.
    try {
      if (G.RuntimeToolCodeLoader && typeof G.RuntimeToolCodeLoader.load === 'function') {
        await G.RuntimeToolCodeLoader.load(toolId);
      }
    } catch (_) {}

    // Small shared helpers are non-critical; fetch them together after the
    // active tool runtime so they cannot delay the upload screen.
    await Promise.all(POST_LOAD_SHARED.map(loadScript));

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
