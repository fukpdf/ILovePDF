/* Homepage footer language controller.
   RuntimeI18n owns detection, translation and persistence.
   This file only connects the homepage footer selector to that engine. */
(function () {
  'use strict';

  function initFooterLanguage() {
    var root = document.getElementById('footer-lang-sel');
    var btn = document.getElementById('footer-lang-btn');
    var label = document.getElementById('footer-lang-label');
    var panel = document.getElementById('footer-lang-panel');
    if (!root || !btn || !label || !panel || !window.RuntimeI18n) return false;

    var languages = window.RuntimeI18n.availableLanguages();

    function setLabel(lang) {
      var item = languages.find(function (x) { return x.code === lang; }) || languages[0];
      label.textContent = item.flag + ' ' + item.nativeName;
      btn.setAttribute('aria-label', window.RuntimeI18n.t('lang.select'));
      panel.querySelectorAll('.footer-lang-link').forEach(function (link) {
        link.classList.toggle('is-active', link.getAttribute('data-lang') === lang);
      });
    }

    function close() {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }

    languages.forEach(function (item) {
      var link = panel.querySelector('[data-lang="' + item.code + '"]');
      if (!link) return;
      link.addEventListener('click', function (event) {
        event.preventDefault();
        window.RuntimeI18n.setLanguage(item.code, { persist: true }).then(function (lang) {
          setLabel(lang);
          close();
        });
      });
    });

    btn.addEventListener('click', function () {
      var opening = panel.hidden;
      panel.hidden = !opening;
      btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });

    document.addEventListener('click', function (event) {
      if (!root.contains(event.target)) close();
    });

    window.addEventListener('i18n:change', function (event) {
      setLabel(event.detail && event.detail.lang ? event.detail.lang : window.RuntimeI18n.getLanguage());
    });

    setLabel(window.RuntimeI18n.getLanguage());
    return true;
  }

  function boot() {
    if (initFooterLanguage()) return;
    setTimeout(boot, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
