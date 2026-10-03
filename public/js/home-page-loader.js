/**
 * Lightweight homepage bootstrap.
 * Critical shell only first; non-essential runtime, ads and AI stack load
 * after the page has fully loaded and painted.
 */
(function (G) {
  'use strict';
  if (G.__ILOVE_HOME_LOADER__) return;
  G.__ILOVE_HOME_LOADER__ = true;

  var POST_LOAD = [
  "/js/browser-tools.js",
  "/js/runtime-protection.js",
  "/js/runtime-shield-core.js",
  "/js/runtime-shield-integrity.js",
  "/js/runtime-shield-workers.js",
  "/js/runtime-shield-dependency.js",
  "/js/runtime-manifest.js",
  "/js/runtime-worker-factory.js",
  "/core/runtime-chunk-manifest.js",
  "/js/runtime-compat-validator.js",
  "/js/runtime-rollback.js",
  "/js/runtime-deployment-bind.js",
  "/js/runtime-security-tiers.js",
  "/js/runtime-security-telemetry.js",
  "/js/runtime-sri-engine.js",
  "/js/runtime-worker-bootstrap.js",
  "/js/runtime-wasm-registry.js",
  "/js/runtime-perf-safety.js",
  "/js/runtime-foreign-deploy.js",
  "/js/app-router.js",
  "https://unpkg.com/lucide@latest",
  "/js/firebase-init.js",
  "/js/dropdown-fix.js",
  "/js/auth-ui.js",
  "/laba/laba-widget.js",
  "/core/core-manifest.js",
  "/core/shared-constants.js",
  "/core/runtime-contracts.js",
  "/js/runtime-identity.js",
  "/js/runtime-savings.js",
  "/js/runtime-ads.js",
  "/js/ad-manager.js",
  "/js/ad-responsive-engine.js",
  "/js/runtime-credits.js",
  "/js/runtime-donation.js",
  "/js/runtime-failed-log.js",
  "/js/runtime-device-lite.js",
  "/js/runtime-analytics.js",
  "/js/runtime-compression-presets.js",
  "/js/runtime-session-intel.js",
  "/js/runtime-tool-engagement.js",
  "/js/analytics-engine.js",
  "/js/analytics-sync.js",
  "/js/runtime-pinned-tools.js",
  "/js/runtime-offline.js",
  "/js/runtime-updater.js",
  "/js/runtime-changelog.js",
  "/js/runtime-recovery.js",
  "/js/runtime-ai-scheduler.js",
  "/js/runtime-perf.js",
  "/js/homepage-lazy-loader.js",
  "/js/savings-animation.js",
  "/js/live-stats-sim.js",
  "/js/community-economy.js",
  "/core/production-mode.js",
  "/js/pwa-register.js",
  "/js/footer-lang.js"
];
  var AD_SCRIPT = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3242156405919556';

  var loaded = Object.create(null);
  var pending = Object.create(null);

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
    if (!src || loaded[src] || hasScript(src)) {
      loaded[src] = true;
      return Promise.resolve();
    }
    if (pending[src]) return pending[src];
    pending[src] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { loaded[src] = true; delete pending[src]; resolve(); };
      s.onerror = function () {
        console.warn('[HomepageLoader] failed:', src);
        delete pending[src];
        resolve();
      };
      document.head.appendChild(s);
    });
    return pending[src];
  }

  function loadOrderedBatch(list) {
    return Promise.all(list.map(loadScript));
  }

  function loadStyle(href) {
    if (document.querySelector('link[data-ilpdf-home-lazy="' + href + '"]')) return Promise.resolve();
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.ilpdfHomeLazy = href;
      link.onload = resolve;
      link.onerror = function () { console.warn('[HomepageLoader] failed CSS:', href); resolve(); };
      document.head.appendChild(link);
    });
  }

  var LAZY_CSS = [
    '/css/economy.css',
    '/css/community-economy.css',
    '/css/rtl.css',
    '/css/seo-extended.css',
    '/css/home-footer-v2.css',
    '/css/ads.css',
    '/css/responsive-ads.css',
    '/laba/laba-widget.css',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
  ];

  async function boot() {
    await loadOrderedBatch(CRITICAL);
    try { G.dispatchEvent(new CustomEvent('ilovepdf:home-critical-ready')); } catch (_) {}

    var startPostLoad = function () {
      var run = function () {
        Promise.all([
          loadOrderedBatch(POST_LOAD),
          loadScript(AD_SCRIPT),
          Promise.all(LAZY_CSS.map(loadStyle))
        ]).then(function () {
          try { G.dispatchEvent(new CustomEvent('ilovepdf:home-lazy-ready')); } catch (_) {}
        });
      };
      if (G.requestAnimationFrame) {
        G.requestAnimationFrame(function () {
          G.requestAnimationFrame(run);
        });
      } else {
        setTimeout(run, 50);
      }
    };

    if (document.readyState === 'complete') {
      startPostLoad();
    } else {
      G.addEventListener('load', startPostLoad, { once: true });
    }
  }

  boot().catch(function (e) {
    console.warn('[HomepageLoader] bootstrap failed:', e);
  });
}(window));
