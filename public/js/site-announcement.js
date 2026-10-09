/* ILovePDF Site Announcements: lightweight, config-driven and homepage-only. */
(() => {
  'use strict';
  const CONFIG = Object.freeze({
    enabled: true,
    version: '2026-10-major-improvements-1',
    showAfterMs: 1200,
    dismissForDays: 7,
    storageKey: 'ilovepdf:site-announcement:v1',
    eyebrow: "WE'RE WORKING TO MAKE THINGS BETTER",
    title: 'A Message to Our Community',
    intro: 'We sincerely apologize for any inconvenience you may have experienced. We are making major improvements to deliver a faster, smoother, and more reliable PDF experience.',
    features: [
      { icon: 'zap', title: 'Faster performance', detail: 'A smoother, more responsive experience.' },
      { icon: 'layers', title: 'Improved tools', detail: 'A more polished and dependable workflow.' },
      { icon: 'heart', title: 'Built around you', detail: 'Thoughtful improvements to everyday PDF tasks.' }
    ],
    closing: 'Thank you for your patience and for being part of our journey. We appreciate your trust while we continue improving ILovePDF.',
    action: 'Continue to ILovePDF',
    footer: 'Your PDFs. Made simpler.'
  });
  if (!CONFIG.enabled || window.self !== window.top) return;
  const readState = () => {
    try { const raw = localStorage.getItem(CONFIG.storageKey); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
  };
  const shouldShow = () => {
    const state = readState();
    if (!state || state.version !== CONFIG.version) return true;
    const dismissedAt = Number(state.dismissedAt);
    return !Number.isFinite(dismissedAt) || dismissedAt <= 0 ||
      Date.now() - dismissedAt >= CONFIG.dismissForDays * 86400000;
  };
  const rememberDismissal = () => {
    try { localStorage.setItem(CONFIG.storageKey, JSON.stringify({ version: CONFIG.version, dismissedAt: Date.now() })); }
    catch (_) { /* Storage restrictions must never block site use. */ }
  };
  const icon = (name) => {
    const paths = {
      zap: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
      layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
      heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
      close: '<path d="m18 6-12 12M6 6l12 12"/>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (paths[name] || paths.file) + '</svg>';
  };
  function showAnnouncement() {
    if (!shouldShow() || document.getElementById('ilpdf-announcement-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ilpdf-announcement-overlay';
    overlay.className = 'ilpdf-announcement-overlay';
    const featureMarkup = CONFIG.features.map(item =>
      '<div class="ilpdf-announcement-feature"><span class="ilpdf-announcement-feature-icon">' + icon(item.icon) +
      '</span><span class="ilpdf-announcement-feature-copy"><strong>' + item.title +
      '</strong><span>' + item.detail + '</span></span></div>').join('');
    overlay.innerHTML =
      '<section class="ilpdf-announcement" role="dialog" aria-modal="true" aria-labelledby="ilpdf-announcement-title" aria-describedby="ilpdf-announcement-intro">' +
      '<button class="ilpdf-announcement-close" type="button" aria-label="Close announcement">' + icon('close') + '</button>' +
      '<div class="ilpdf-announcement-brand"><span class="ilpdf-announcement-brand-icon">' + icon('file') +
      '</span><span>iLove<span class="ilpdf-announcement-brand-accent">PDF</span></span></div>' +
      '<div class="ilpdf-announcement-rule"></div><div class="ilpdf-announcement-content">' +
      '<div class="ilpdf-announcement-emblem">' + icon('heart') + '</div><p class="ilpdf-announcement-eyebrow">' + CONFIG.eyebrow +
      '</p><h2 id="ilpdf-announcement-title">' + CONFIG.title + '</h2><p id="ilpdf-announcement-intro" class="ilpdf-announcement-intro">' +
      CONFIG.intro + '</p><div class="ilpdf-announcement-features">' + featureMarkup + '</div><p class="ilpdf-announcement-closing">' +
      CONFIG.closing + '</p><button class="ilpdf-announcement-action" type="button">' + CONFIG.action +
      '</button><p class="ilpdf-announcement-footer">' + CONFIG.footer + '</p></div></section>';
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector('[role="dialog"]');
    const closeButton = overlay.querySelector('.ilpdf-announcement-close');
    const actionButton = overlay.querySelector('.ilpdf-announcement-action');
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; rememberDismissal(); overlay.classList.remove('is-visible');
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      window.setTimeout(() => {
        overlay.remove();
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      }, 180);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') {
        const items = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
      }
    };
    closeButton.addEventListener('click', close);
    actionButton.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    window.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => { overlay.classList.add('is-visible'); closeButton.focus(); });
  }
  const schedule = () => window.setTimeout(showAnnouncement, CONFIG.showAfterMs);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();
})();
