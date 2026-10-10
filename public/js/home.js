/**
 * Homepage boot (perf-optimized path)
 * 1) Load known-good home.js body from public CDN (commit e8e860a)
 * 2) Load home-fast-boot.js accelerator from this repo
 * 3) After CDN script loads, re-poll TOOL_GROUPS at 16ms and re-paint if hooks exist
 *
 * Theme/design/tool engines unchanged. No heavy PDF engines on homepage.
 */
(function (G) {
  'use strict';

  var CDN_HOME = 'https://cdn.jsdelivr.net/gh/fukpdf/ILovePDF@e8e860a0ffeeb997597c6cd1caa6f3b4eab03ed6/public/js/home.js';
  var FAST = '/js/home-fast-boot.js';

  function loadScript(src, onload) {
    var s = document.createElement('script');
    s.src = src;
    s.defer = true;
    if (onload) s.onload = onload;
    s.onerror = function () {
      console.error('[ILovePDF] failed to load', src);
    };
    var cur = document.currentScript;
    if (cur && cur.parentNode) cur.parentNode.insertBefore(s, cur.nextSibling);
    else document.head.appendChild(s);
  }

  function acceleratePaint() {
    var attempts = 0;
    function tick() {
      var ready = Array.isArray(G.TOOL_GROUPS) && G.TOOL_GROUPS.length > 0;
      if (ready) {
        try {
          if (typeof G.renderCategorySections === 'function') G.renderCategorySections();
          if (typeof G.renderRecentUse === 'function') G.renderRecentUse();
        } catch (_) {}
        try {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
              try { G.lucide && G.lucide.createIcons && G.lucide.createIcons(); } catch (_) {}
            });
          }
        } catch (_) {}
        return;
      }
      if (++attempts < 150) setTimeout(tick, 16);
    }
    tick();
  }

  loadScript(CDN_HOME, function () {
    // CDN home.js does not expose render* on window; still help Lucide + event
    acceleratePaint();
    loadScript(FAST);
  });
})(window);
