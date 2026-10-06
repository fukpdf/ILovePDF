// about-contact-form.js
// Phase 2 — Inline Script Migration (Task 2)
//
// Extracted from about.html inline script (was lines 249-398).
// Contact form AJAX handler with anti-spam, bot detection, and Formspree integration.
(function () {
  'use strict';

  var COOLDOWN_MS  = 8000;  // anti-spam: 8 s lockout after a successful send
  var MIN_FILL_MS  = 1500;  // bot-style instant fills are ignored
  var SUCCESS_TEXT = 'Thanks! Your message was sent. We usually reply within 24 hours.';
  var lastSubmitAt = 0;

  // Stamp the time each form was opened, to catch instant bot submissions.
  document.addEventListener('DOMContentLoaded', function () {
    var forms = document.querySelectorAll('.contact-form');
    Array.prototype.forEach.call(forms, function (f) { f.dataset.openedAt = Date.now(); });
    // Also stamp when a <details> is expanded — gives a fresh "fill window".
    var toggles = document.querySelectorAll('.cc-toggle');
    Array.prototype.forEach.call(toggles, function (d) {
      d.addEventListener('toggle', function () {
        if (!d.open) return;
        var f = d.querySelector('.contact-form');
        if (f) f.dataset.openedAt = Date.now();
      });
    });
  });

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = 'cf-status' + (kind ? ' is-' + kind : '');
  }

  function startCooldown(form, btn, txt, load) {
    var seconds = Math.ceil(COOLDOWN_MS / 1000);
    btn.disabled = true;
    txt.hidden = true;
    load.hidden = false;
    // Reuse the loading slot to show a countdown so users know why it's locked.
    var loadIcon = load.querySelector('svg');
    var origHTML = load.innerHTML;
    var tick = function () {
      load.innerHTML = '<span aria-hidden="true">&#x23F1;</span> Please wait ' + seconds + 's\u2026';
      if (--seconds < 0) {
        clearInterval(timer);
        load.innerHTML = origHTML;
        load.hidden = true;
        txt.hidden  = false;
        btn.disabled = false;
        if (loadIcon && window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      }
    };
    tick();
    var timer = setInterval(tick, 1000);
  }

  document.addEventListener('submit', async function (ev) {
    var form = ev.target;
    if (!form.matches || !form.matches('.contact-form')) return;
    ev.preventDefault();

    var status = form.querySelector('.cf-status');
    var btn    = form.querySelector('.cf-btn');
    var txt    = form.querySelector('.cf-btn-text');
    var load   = form.querySelector('.cf-btn-loading');

    // Block double-clicks while a submit is in flight.
    if (btn.disabled) return;

    // Per-page submit cooldown (across all 3 forms).
    var sinceLast = Date.now() - lastSubmitAt;
    if (lastSubmitAt && sinceLast < COOLDOWN_MS) {
      setStatus(status, 'Please wait a few seconds before sending another message.', 'info');
      return;
    }

    // HTML5 validation (focuses the first invalid field automatically).
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    // Honeypot — silently drop bots.
    if (form.elements['_gotcha'] && form.elements['_gotcha'].value) return;
    // Time-trap: if the form was filled & submitted in <1.5 s, it's a bot.
    var openedAt = parseInt(form.dataset.openedAt || '0', 10);
    if (openedAt && (Date.now() - openedAt) < MIN_FILL_MS) return;

    var id = form.getAttribute('data-formspree') || '';

    // Until the owner pastes a real Formspree ID, fall back to mailto.
    if (!id || id.indexOf('YOUR_') === 0) {
      var emailLink = form.closest('.contact-card').querySelector('.cc-email');
      var to = emailLink ? emailLink.getAttribute('href').replace('mailto:', '') : 'hello@ilovepdf.cyou';
      var subject = (form.elements['_subject'] && form.elements['_subject'].value) || 'ILovePDF contact';
      var body = '';
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.name.charAt(0) === '_' || el.type === 'hidden' || el.type === 'submit') return;
        var lbl = (el.labels && el.labels[0]) ? el.labels[0].textContent.trim() : el.name;
        body += lbl + ': ' + (el.value || '') + '\n\n';
      });
      window.location.href = 'mailto:' + to
        + '?subject=' + encodeURIComponent(subject)
        + '&body='    + encodeURIComponent(body);
      setStatus(status, 'Opening your email app\u2026', 'info');
      return;
    }

    // Loading state.
    btn.disabled = true;
    txt.hidden = true;
    load.hidden = false;
    setStatus(status, '', '');

    try {
      var res = await fetch('https://formspree.io/f/' + id, {
        method:  'POST',
        headers: { 'Accept': 'application/json' },
        body:    new FormData(form),
      });
      if (res.ok) {
        lastSubmitAt = Date.now();
        setStatus(status, SUCCESS_TEXT, 'ok');
        form.reset();
        form.dataset.openedAt = Date.now();
        // On mobile, scroll the success message into view above the keyboard.
        if (window.innerWidth < 768 && status.scrollIntoView) {
          status.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        startCooldown(form, btn, txt, load);
      } else {
        var data = null;
        try { data = await res.json(); } catch (_) {}
        var msg = (data && data.errors && data.errors[0] && data.errors[0].message)
                || 'Something went wrong. Please email us directly instead.';
        setStatus(status, msg, 'err');
        btn.disabled = false; txt.hidden = false; load.hidden = true;
      }
    } catch (_) {
      setStatus(status, 'Network error. Please email us directly instead.', 'err');
      btn.disabled = false; txt.hidden = false; load.hidden = true;
    }
  });

  // Mobile-keyboard fix: when an input gains focus, scroll it into view above
  // the on-screen keyboard so the user can always see what they're typing.
  document.addEventListener('focusin', function (ev) {
    var el = ev.target;
    if (!el.matches || !el.matches('.contact-form input, .contact-form textarea')) return;
    if (window.innerWidth >= 768) return;
    setTimeout(function () {
      if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 250);
  });
}());
