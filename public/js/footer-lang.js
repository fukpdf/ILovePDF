/* Homepage footer language selector.
   Single owner for the footer dropdown: opening, selection, persistence,
   label state and outside-click handling. */
(function () {
  'use strict';

  function boot() {
    if (window.__ILOVE_SHARED_FOOTER_LANG_WIRED) return;
window.__ILOVE_SHARED_FOOTER_LANG_WIRED = true;
var root = document.getElementById('footer-lang-sel');
    var btn = document.getElementById('footer-lang-btn');
    var label = document.getElementById('footer-lang-label');
    var panel = document.getElementById('footer-lang-panel');

    if (!root || !btn || !label || !panel) return false;
    if (!window.RuntimeI18n || typeof window.RuntimeI18n.setLanguage !== 'function') {
      setTimeout(boot, 50);
      return true;
    }

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

    function open() {
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });

    panel.addEventListener('click', function (e) {
      var link = e.target.closest('.footer-lang-link[data-lang]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();

      var lang = link.getAttribute('data-lang');
      if (!lang) return;

      link.setAttribute('aria-busy', 'true');
      window.RuntimeI18n.setLanguage(lang, { persist: true })
        .then(function (selected) {
          setLabel(selected);
          close();
        })
        .catch(function (err) {
          console.error('[FooterLanguage] language switch failed', err);
        })
        .finally(function () {
          link.removeAttribute('aria-busy');
        });
    });

    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    window.addEventListener('i18n:change', function (e) {
      setLabel(e.detail && e.detail.lang ? e.detail.lang : window.RuntimeI18n.getLanguage());
    });

    setLabel(window.RuntimeI18n.getLanguage());
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}());
