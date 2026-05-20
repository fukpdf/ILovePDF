// pwa-register.js
// Phase 2 — Inline Script Migration (Task 2)
//
// Extracted from tool.html line 625 and index.html line 686.
// Registers the PWA service worker on load. Shared between both shells.
// Task 9 — PWA + CSP Compatibility: worker-src 'self' blob: already present
// in CSP so SW registration is unaffected by nonce hardening.
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function (reg) {
        console.info('[SW] registered, scope:', reg.scope);
      })
      .catch(function (err) {
        console.warn('[SW] registration failed:', err);
      });
  });
}());
