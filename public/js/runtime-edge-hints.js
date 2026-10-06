// RuntimeEdgeHints v1.0 — Arc 2 / Target 8
// =====================================================================
// Geo-aware resource hints + BUILD_ID-aware edge cache validation.
//
// Responsibilities:
//   1. Inject <link rel=preconnect> for CDN origins
//   2. Inject <link rel=prefetch/preload> for predicted next-navigation assets
//   3. Detect stale edge cache via X-Build-Id header mismatch
//   4. Partition cache hints by BUILD_ID (immutable asset channels)
//   5. Detect geo-region from navigator.language + timezone offset
//      for selecting optimal CDN PoP hint
//
// Purely declarative/informational — zero side-effects beyond resource hints.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeEdgeHints) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[EdgeHints]';
  var VERSION = '1.0';

  // ── CDN origins to preconnect ─────────────────────────────────────────────
  var CDN_ORIGINS = [
    'https://unpkg.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ];

  // ── Inject a <link> hint ──────────────────────────────────────────────────
  function _link(rel, url, as, type) {
    try {
      if (document.querySelector('link[href="' + url + '"]')) return;
      var el  = document.createElement('link');
      el.rel  = rel;
      el.href = url;
      if (as)   el.setAttribute('as', as);
      if (type) el.type = type;
      el.crossOrigin = 'anonymous';
      document.head.appendChild(el);
    } catch (_) {}
  }

  // ── Preconnect to CDN origins ─────────────────────────────────────────────
  function _addPreconnects() {
    CDN_ORIGINS.forEach(function (origin) {
      _link('preconnect', origin);
      _link('dns-prefetch', origin);
    });
  }

  // ── Geo-region detection (coarse — no external API) ───────────────────────
  function _detectRegion() {
    try {
      var tz     = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      var lang   = navigator.language || '';
      var offset = new Date().getTimezoneOffset(); // minutes west of UTC

      // Coarse region: Americas (<= -240 offset), Asia (>= -540), Europe (middle)
      var region;
      if (offset >=  60)  region = 'america';
      else if (offset <= -240) region = 'asia';
      else                     region = 'europe';

      return { tz: tz, lang: lang, offset: offset, region: region };
    } catch (_) {
      return { region: 'unknown' };
    }
  }

  // ── BUILD_ID edge validation ───────────────────────────────────────────────
  // Checks if the X-Build-Id served by the edge matches our tab's BUILD_ID.
  // Stale edge = CDN is serving an old build. We surface this via event only.
  var _edgeStale    = false;
  var _edgeBuildId  = '';

  function _validateEdge() {
    try {
      var tabBuildId = G.RuntimeDeploySync && G.RuntimeDeploySync.getBuildId
        ? G.RuntimeDeploySync.getBuildId()
        : '';
      if (!tabBuildId) return;

      fetch('/api/health', { method: 'HEAD', cache: 'no-store', credentials: 'omit' })
        .then(function (r) {
          var edgeBuild = r.headers.get('X-Build-Id') || r.headers.get('x-build-id') || '';
          _edgeBuildId  = edgeBuild;
          if (edgeBuild && edgeBuild !== tabBuildId) {
            _edgeStale = true;
            console.debug(LOG, 'edge stale — tab:', tabBuildId, 'edge:', edgeBuild);
            try {
              G.dispatchEvent(new CustomEvent('edge:stale', {
                detail: { tabBuildId: tabBuildId, edgeBuildId: edgeBuild },
              }));
            } catch (_) {}
          }
        })
        .catch(function () {});
    } catch (_) {}
  }

  // ── Immutable asset channels: preload BUILD_ID-versioned assets ────────────
  // Key assets that benefit from early preload (non-blocking via <link>)
  var PRELOAD_ASSETS = [
    { url: '/js/tool-page.js?v=__BUILD_ID__', as: 'script' },
    { url: '/js/shared.js?v=__BUILD_ID__',    as: 'script' },
  ];

  function _addPreloads() {
    try {
      var buildId = (G.RuntimeDeploySync && G.RuntimeDeploySync.getBuildId
        ? G.RuntimeDeploySync.getBuildId()
        : '') || '';
      if (!buildId) return;

      PRELOAD_ASSETS.forEach(function (asset) {
        var url = asset.url.replace('__BUILD_ID__', buildId);
        _link('prefetch', url, asset.as);
      });
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _addPreconnects();

    // Edge validation after a short delay (let DeploySync init first)
    setTimeout(function () {
      _validateEdge();
      _addPreloads();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    _boot();
  }

  G.RuntimeEdgeHints = Object.freeze({
    VERSION:         VERSION,
    isEdgeStale:     function () { return _edgeStale; },
    getEdgeBuildId:  function () { return _edgeBuildId; },
    getRegion:       _detectRegion,
    addPreconnect:   function (origin) { _link('preconnect', origin); },
    addPrefetch:     function (url, as) { _link('prefetch', url, as); },
    validate:        _validateEdge,
  });

}(window));
