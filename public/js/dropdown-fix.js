/* dropdown-fix.js
 * Auto-corrects viewport overflow for all header dropdowns.
 * Runs after chrome.js renders the nav (deferred / DOMContentLoaded).
 *
 * Strategy:
 *  1. For each .nav-item with a .dd (simple dropdown):
 *     - When it opens, check right edge against viewport.
 *     - If overflowing → flip to right-anchored (right:0, left:auto).
 *     - Also guard against left overflow (rare, but possible on tiny screens).
 *  2. For .nav-item.has-mega .mega (All Tools, already right-anchored in CSS):
 *     - Verify the panel stays within 100vw.
 *     - If it somehow overflows left on ultra-narrow viewports, clamp it.
 *  3. Add max-width safety net to every dropdown to prevent reflow damage.
 *
 * Zero side-effects: Only writes inline style.left / style.right on open;
 * resets them on close so subsequent viewports start fresh.
 */

(function () {
  'use strict';

  const MARGIN = 8; // px clearance from viewport edge

  /**
   * Clamp a dropdown element so it stays within the viewport.
   * Resets any previous inline overrides first, then measures and applies.
   * @param {HTMLElement} dd - The dropdown element (.dd or .mega)
   */
  function clampToViewport(dd) {
    if (!dd) return;

    // Reset previous inline overrides so getBoundingClientRect gives truth.
    dd.style.left   = '';
    dd.style.right  = '';
    dd.style.maxWidth = '';

    const rect = dd.getBoundingClientRect();
    const vw   = window.innerWidth;

    // Right overflow — shift so right edge stays MARGIN px from viewport
    if (rect.right > vw - MARGIN) {
      dd.style.left  = 'auto';
      dd.style.right = '0';
    }

    // Left overflow — shift so left edge stays MARGIN px from viewport
    const rect2 = dd.getBoundingClientRect(); // re-measure after possible change
    if (rect2.left < MARGIN) {
      dd.style.left  = MARGIN + 'px';
      dd.style.right = 'auto';
      // Prevent the dropdown from being wider than the available space
      dd.style.maxWidth = (vw - MARGIN * 2) + 'px';
    }
  }

  /**
   * Reset inline overrides when dropdown closes.
   * @param {HTMLElement} dd
   */
  function resetDropdown(dd) {
    if (!dd) return;
    dd.style.left     = '';
    dd.style.right    = '';
    dd.style.maxWidth = '';
  }

  /**
   * Observe an .nav-item for is-open class additions; clamp its dropdown.
   * @param {HTMLElement} item - .nav-item element
   */
  function watchNavItem(item) {
    if (!item) return;
    const dd = item.querySelector('.dd, .mega');
    if (!dd) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.attributeName !== 'class') return;
        if (item.classList.contains('is-open')) {
          // Use rAF so layout is complete before we measure
          requestAnimationFrame(() => clampToViewport(dd));
        } else {
          resetDropdown(dd);
        }
      });
    });

    observer.observe(item, { attributes: true, attributeFilter: ['class'] });
  }

  /**
   * Also handle hover — CSS :hover opens .dd without .is-open.
   * We listen to mouseenter/mouseleave on the item to detect CSS-only opens.
   * @param {HTMLElement} item
   */
  function watchHover(item) {
    if (!item) return;
    const dd = item.querySelector('.dd');
    if (!dd) return;

    item.addEventListener('mouseenter', () => {
      requestAnimationFrame(() => clampToViewport(dd));
    });
    item.addEventListener('mouseleave', () => resetDropdown(dd));
  }

  function init() {
    // Simple dropdowns (Organize, Convert)
    ['nav-organize', 'nav-convert'].forEach((id) => {
      const item = document.getElementById(id);
      watchNavItem(item);
      watchHover(item);
    });

    // All Tools mega dropdown
    const allToolsItem = document.getElementById('all-tools-item');
    watchNavItem(allToolsItem);
    // Mega is already CSS-hover opened — watch hover too
    if (allToolsItem) {
      const mega = allToolsItem.querySelector('.mega');
      allToolsItem.addEventListener('mouseenter', () => {
        requestAnimationFrame(() => clampToViewport(mega));
      });
      allToolsItem.addEventListener('mouseleave', () => resetDropdown(mega));
    }

    // Recalculate on viewport resize (e.g. rotating device)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        document.querySelectorAll('.nav-item.is-open .dd, .nav-item.is-open .mega').forEach(clampToViewport);
      }, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
