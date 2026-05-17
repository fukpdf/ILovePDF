// Tool i18n Bridge — Phase 21 (patched: hydration-safe, SLUG_MAP-free for cards)
// Patches homepage tool card names/descriptions with translated strings
// whenever the language changes.
//
// Key fixes (see audit in commit message):
//   1. Cards rendered by home.js now carry data-tid — the canonical tool ID.
//      We read it directly instead of deriving it from the URL slug, which
//      required SLUG_MAP (never populated client-side) and broke for the 20+
//      tools where slug ≠ tid (merge-pdf ≠ merge, etc.).
//   2. Guard against _humaniseKey output: i18n.js returns the last dot-segment
//      capitalised ('tools.merge.title' → 'Title') when a key is missing.
//      The old code accepted 'Title' as a real translation (it passed the
//      translated !== rawKey check) and overwrote correct card text with it.
//      We now reject any value that equals the humanised last segment.
//   3. On first load (DOMContentLoaded + 100 ms), if the locale hasn't loaded
//      yet, patchToolCards is a no-op — cards retain the correct English text
//      set by home.js. The real patch fires on i18n:change once locale is warm.

(function () {
  'use strict';

  /* Return the humanised fallback that i18n._humaniseKey() would produce for
     the given key. Used to detect a cache-miss without accessing private state.
     e.g. 'tools.merge.title' → 'Title'
          'tools.merge.desc'  → 'Desc'
          'band.instant_title'→ 'Instant title'                                */
  function humanisedFallback(key) {
    var last = key.split('.').pop() || key;
    return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
  }

  /* Resolve a translation key, returning null when i18n hasn't loaded the
     key yet (cold-cache miss or key genuinely absent from every locale).
     Unlike window.t(), this function never returns the humanised fallback —
     it returns null so callers can keep the existing DOM text instead.        */
  function safeT(key) {
    if (typeof window.t !== 'function') return null;
    var v = window.t(key);
    if (!v || v === key || v === humanisedFallback(key)) return null;
    return v;
  }

  // Extract tool ID from a tool card's href attribute.
  // Used only when data-tid is absent (legacy cards, tool.html SPA nav).
  // Handles three URL formats:
  //   1. /tool.html?id=merge  → query param              → 'merge'
  //   2. /merge-pdf           → SLUG_MAP lookup → tid   (if SLUG_MAP present)
  //   3. /numbers-to-words    → slug used directly        → 'numbers-to-words'
  function toolIdFromHref(href) {
    if (!href) return null;
    try {
      var url = new URL(href, location.origin);
      var qid = url.searchParams.get('id');
      if (qid) return qid;
      var slug = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (!slug) return null;
      var map = window.SLUG_MAP;
      if (map && map[slug]) return map[slug].id;
      return slug;
    } catch (_) {
      return null;
    }
  }

  // Patch all .tool anchor elements on the current page.
  function patchToolCards() {
    if (typeof window.t !== 'function') return;

    document.querySelectorAll('a.tool[href]').forEach(function (card) {
      /* Prefer data-tid (stamped by home.js renderTools()) — it is the
         canonical internal tool ID and does not require SLUG_MAP.
         Fall back to href-based resolution for cards rendered by other
         means (e.g. mobile overlay, SPA navigation on tool.html).            */
      var id = card.dataset.tid || toolIdFromHref(card.getAttribute('href'));
      if (!id) return;

      var h4 = card.querySelector('h4');
      var p  = card.querySelector('p');

      if (h4) {
        var titleVal = safeT('tools.' + id + '.title');
        if (titleVal !== null) {
          h4.textContent = titleVal;
          /* Ensure data-i18n is present so future _applyToDOM() calls also
             translate this node (safety net for dynamically injected cards). */
          if (!h4.hasAttribute('data-i18n'))
            h4.setAttribute('data-i18n', 'tools.' + id + '.title');
        }
      }
      if (p) {
        var descVal = safeT('tools.' + id + '.desc');
        if (descVal !== null) {
          p.textContent = descVal;
          if (!p.hasAttribute('data-i18n'))
            p.setAttribute('data-i18n', 'tools.' + id + '.desc');
        }
      }
    });

    // Also patch [data-i18n-tool] attributes for custom placements
    document.querySelectorAll('[data-i18n-tool]').forEach(function (el) {
      var id  = el.dataset.i18nTool;
      var key = el.dataset.i18nKey || 'title';
      if (!id) return;
      var val = safeT('tools.' + id + '.' + key);
      if (val !== null) el.textContent = val;
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

  // Re-render the full tool step on language change so template-literal
  // content (generated by tool-page.js renderStep) is also translated.
  // Only re-render the upload step to avoid disrupting in-progress work.
  function scheduleToolPageRerender() {
    setTimeout(function () {
      if (typeof window.renderStep === 'function') {
        try {
          // Only re-render upload step — preview/download preserve user state
          if (!window.Flow || window.Flow.step === 'upload') {
            window.renderStep();
          }
        } catch (_) {}
      }
    }, 50);
  }

  /* ── Debug Corruption Scanner (Requirement 9) ───────────────────────────
     Scans every rendered tool card across ALL rendering pipelines:
       a.tool       — homepage grid (home.js)
       a.tp-tool    — /tools directory page (tools-page.js)
       a.mo-row     — mobile overlay (mobile-nav.js)
     Logs a warning for any card whose name/desc element contains the
     placeholder strings 'Title' or 'Desc', or is completely empty.
     Call conditions: after patchToolCards() and after i18n:change.
     In production this is a silent no-op; in development it surfaces
     hidden rendering bugs before users see them.                            */
  function debugScanForCorruption() {
    try {
      var bad = [];
      var selectors = [
        { sel: 'a.tool',    nameEl: 'h4',             descEl: 'p'              },
        { sel: 'a.tp-tool', nameEl: '.tp-tool-name',  descEl: '.tp-tool-desc'  },
        { sel: 'a.mo-row',  nameEl: '.mo-row-name',   descEl: null             },
      ];
      selectors.forEach(function (s) {
        document.querySelectorAll(s.sel).forEach(function (card) {
          var tid = card.dataset.tid || '(no-tid)';
          var nameEl = s.nameEl ? card.querySelector(s.nameEl) : null;
          var descEl = s.descEl ? card.querySelector(s.descEl) : null;
          var name = nameEl ? nameEl.textContent.trim() : null;
          var desc = descEl ? descEl.textContent.trim() : null;
          if (name === 'Title' || name === '') {
            bad.push({ type: 'TITLE_CORRUPT', tid: tid, text: name, sel: s.sel });
          }
          if (desc === 'Desc' || desc === '') {
            bad.push({ type: 'DESC_CORRUPT',  tid: tid, text: desc, sel: s.sel });
          }
        });
      });
      if (bad.length > 0) {
        console.warn('[ToolI18nBridge] \u26a0 CORRUPTION: ' + bad.length + ' card(s) showing placeholder text. Details:');
        bad.forEach(function (b) {
          console.warn('  [' + b.type + '] selector=' + b.sel + ' tid=' + b.tid + ' text="' + b.text + '"');
        });
      }
    } catch (_) { /* scanner must never throw */ }
  }

  // Listen for language changes
  window.addEventListener('i18n:change', function () {
    scheduleToolPatch();
    scheduleToolPageRerender();
    /* Run scanner 500 ms after locale switch — enough time for all renderers
       (home.js, tools-page.js, mobile-nav.js) to finish their re-renders.   */
    setTimeout(debugScanForCorruption, 500);
  });

  // Run on initial page load (after i18n engine has loaded and applied a locale)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(scheduleToolPatch, 100);
      /* Initial load scan: 2 s gives all lazy renderers time to hydrate.    */
      setTimeout(debugScanForCorruption, 2000);
    });
  } else {
    setTimeout(scheduleToolPatch, 100);
    setTimeout(debugScanForCorruption, 2000);
  }

  // Also expose manual trigger for third-party callers
  window.ToolI18nBridge = { patch: patchToolCards, scan: debugScanForCorruption };
})();
