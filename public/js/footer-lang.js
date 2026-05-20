// footer-lang.js
// Phase 2 — Inline Script Migration (Task 2)
//
// Extracted from index.html inline script (was lines 701-712).
// Handles footer language link clicks — delegates to RuntimeI18n.setLanguage.
(function () {
  document.addEventListener('click', function (e) {
    var link = e.target.closest('.footer-lang-link[data-lang]');
    if (!link) return;
    e.preventDefault();
    var lang = link.getAttribute('data-lang');
    if (window.RuntimeI18n && typeof window.RuntimeI18n.setLanguage === 'function') {
      window.RuntimeI18n.setLanguage(lang).then(function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  });
}());
