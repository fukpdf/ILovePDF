// Tool i18n Bridge — Phase 21
// Patches homepage tool card names/descriptions with translated strings
// whenever the language changes. Uses window.SLUG_MAP (from tools-config.js)
// to map href slugs → tool IDs, then calls window.t('tools.{id}.title').

(function () {
  'use strict';

  // Extract tool ID from a tool card's href attribute.
  // Handles three URL formats:
  //   1. /merge-pdf           → slug lookup in SLUG_MAP → 'merge'
  //   2. /tool.html?id=merge  → query param              → 'merge'
  //   3. /numbers-to-words    → direct slug match         → 'numbers-to-words'
  function toolIdFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const qid = url.searchParams.get('id');
      if (qid) return qid;
      const slug = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (!slug) return null;
      const map = window.SLUG_MAP;
      if (map && map[slug]) return map[slug].id;
      return slug;
    } catch {
      return null;
    }
  }

  // Patch all .tool anchor elements on the current page.
  function patchToolCards() {
    if (typeof window.t !== 'function') return;

    document.querySelectorAll('a.tool[href]').forEach(card => {
      const id = toolIdFromHref(card.getAttribute('href'));
      if (!id) return;

      const h4 = card.querySelector('h4');
      const p  = card.querySelector('p');

      if (h4) {
        const translated = window.t(`tools.${id}.title`);
        if (translated && translated !== `tools.${id}.title`) {
          h4.textContent = translated;
        }
      }
      if (p) {
        const translated = window.t(`tools.${id}.desc`);
        if (translated && translated !== `tools.${id}.desc`) {
          p.textContent = translated;
        }
      }
    });

    // Also patch [data-i18n-tool] attributes for custom placements
    document.querySelectorAll('[data-i18n-tool]').forEach(el => {
      const id  = el.dataset.i18nTool;
      const key = el.dataset.i18nKey || 'title';
      if (!id) return;
      const translated = window.t(`tools.${id}.${key}`);
      if (translated && translated !== `tools.${id}.${key}`) {
        el.textContent = translated;
      }
    });
  }

  // Patch tool.html page heading/description (single-tool page)
  function patchToolPage() {
    if (typeof window.t !== 'function') return;
    if (typeof window.resolveToolIdFromUrl !== 'function') return;

    const id = window.resolveToolIdFromUrl();
    if (!id) return;

    const titleEl = document.getElementById('tool-page-title');
    const descEl  = document.getElementById('tool-page-desc');

    if (titleEl) {
      const translated = window.t(`tools.${id}.title`);
      if (translated && translated !== `tools.${id}.title`) {
        titleEl.textContent = translated;
        document.title = translated + ' — ILovePDF';
      }
    }
    if (descEl) {
      const translated = window.t(`tools.${id}.desc`);
      if (translated && translated !== `tools.${id}.desc`) {
        descEl.textContent = translated;
      }
    }
  }

  // Run after renderTools() has updated the DOM.
  // home.js calls renderTools() synchronously on i18n:change,
  // so we delay by one microtask/macrotask to guarantee DOM is updated.
  function scheduleToolPatch() {
    setTimeout(() => {
      patchToolCards();
      patchToolPage();
    }, 0);
  }

  // Listen for language changes
  window.addEventListener('i18n:change', scheduleToolPatch);

  // Run on initial page load (after i18n engine has loaded and applied a locale)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(scheduleToolPatch, 100));
  } else {
    setTimeout(scheduleToolPatch, 100);
  }

  // Also expose manual trigger for third-party callers
  window.ToolI18nBridge = { patch: patchToolCards };
})();
