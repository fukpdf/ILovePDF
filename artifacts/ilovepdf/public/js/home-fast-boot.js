/**
 * home-fast-boot.js — one-shot homepage registry readiness signal.
 *
 * The production homepage already ships all tool cards in its HTML. home.js
 * owns rendering and icon repair. This helper must not re-render the catalogue
 * or rebuild cards: doing so duplicates work and can make widgets move after
 * the first paint, especially when the Recent Tools section has saved items.
 */
(function (G) {
  'use strict';

  if (G.__HOME_FAST_BOOT__) return;
  G.__HOME_FAST_BOOT__ = true;

  var signalled = false;
  var attempts = 0;
  var MAX_ATTEMPTS = 150;

  function ready() {
    return Array.isArray(G.TOOL_GROUPS) && G.TOOL_GROUPS.length > 0;
  }

  function signalReady() {
    if (signalled || !ready()) return false;
    signalled = true;

    try {
      G.dispatchEvent(new CustomEvent('ilovepdf:tool-groups-ready', {
        detail: { count: G.TOOL_GROUPS.reduce(function (total, group) {
          return total + (Array.isArray(group.items) ? group.items.length : 0);
        }, 0) }
      }));
    } catch (_) {
      // The event is an optional integration hook; the homepage remains usable
      // if a legacy browser does not support CustomEvent.
    }
    return true;
  }

  function waitForRegistry() {
    if (signalReady()) return;
    attempts += 1;
    if (attempts < MAX_ATTEMPTS) setTimeout(waitForRegistry, 16);
  }

  // One start path only. Do not also poll from DOMContentLoaded and a separate
  // zero-delay timeout: those paths used to race and invoke render hooks twice.
  if (!signalReady()) setTimeout(waitForRegistry, 0);
}(window));
