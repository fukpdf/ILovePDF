// chrome-shim.js
// Phase 2 — Inline Script Migration (Task 2)
//
// Extracted from tool.html inline script (was line 552).
// tool-page.js (legacy) calls window.buildSidebar / window.setupMegaMenu
// but chrome.js now handles header and sidebar rendering.
// These stubs prevent "not a function" errors on older cached page loads.
(function (G) {
  if (G.buildSidebar && G.buildSidebar._shim) return; // already installed
  G.buildSidebar  = function () {};
  G.buildSidebar._shim = true;
  G.setupMegaMenu = function () {};
  G.setupMegaMenu._shim = true;
}(window));
