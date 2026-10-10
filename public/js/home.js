/**
 * Temporary bootstrap: load last known-good home.js from public CDN mirror
 * of commit e8e860a. Unblocks homepage tool cards, calculators, recent use.
 * Replace with full in-repo file + perf patch when large-file push is available.
 */
(function () {
  'use strict';
  var SRC = 'https://cdn.jsdelivr.net/gh/fukpdf/ILovePDF@e8e860a0ffeeb997597c6cd1caa6f3b4eab03ed6/public/js/home.js';
  var s = document.createElement('script');
  s.src = SRC;
  s.defer = true;
  s.onerror = function () {
    console.error('[ILovePDF] Failed to load home.js from CDN. Restore public/js/home.js from commit e8e860a.');
  };
  var cur = document.currentScript;
  if (cur && cur.parentNode) cur.parentNode.insertBefore(s, cur.nextSibling);
  else document.head.appendChild(s);
})();
