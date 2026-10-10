/**
 * home-fast-boot.js — Homepage tool-card paint accelerator
 *
 * PROBLEM: home.js waits up to 50ms × N for TOOL_GROUPS, then blocks on Lucide
 * before cards feel "done". Header/footer paint first; cards lag.
 *
 * FIX (non-breaking):
 *  1. Poll TOOL_GROUPS every ~16ms once chrome.js has defined it
 *  2. Dispatch a custom event so any listener can react immediately
 *  3. If home.js has already exposed paint helpers on window, call them early
 *  4. Never touch tool engines / workers / tool pages
 *
 * SAFE: Does not replace home.js logic. Only speeds discovery + optional hooks.
 */
(function (G) {
  'use strict';
  if (G.__HOME_FAST_BOOT__) return;
  G.__HOME_FAST_BOOT__ = true;

  var LOG = '[HomeFastBoot]';
  var MAX = 150;
  var attempts = 0;

  function ready() {
    return Array.isArray(G.TOOL_GROUPS) && G.TOOL_GROUPS.length > 0;
  }

  function tryPaint() {
    // Optional hooks if future home.js exposes them
    try {
      if (typeof G.renderCategorySections === 'function') G.renderCategorySections();
      if (typeof G.renderRecentUse === 'function') G.renderRecentUse();
    } catch (_) {}

    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-groups-ready', {
        detail: { count: G.TOOL_GROUPS.length, ts: Date.now() }
      }));
    } catch (_) {}

    // Defer Lucide-only refresh so first paint is not blocked
    var refresh = function () {
      try {
        if (G.lucide && typeof G.lucide.createIcons === 'function') {
          G.lucide.createIcons();
        }
      } catch (_) {}
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(refresh);
    } else {
      setTimeout(refresh, 0);
    }
  }

  function tick() {
    if (ready()) {
      tryPaint();
      console.debug(LOG, 'TOOL_GROUPS ready in', attempts, 'polls');
      return;
    }
    if (++attempts < MAX) {
      setTimeout(tick, 16);
    }
  }

  // Start as early as possible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tick, { once: true });
  } else {
    tick();
  }

  // Also start immediately in case chrome.js already ran (defer order)
  if (ready()) tryPaint();
  else setTimeout(tick, 0);

}(window));
