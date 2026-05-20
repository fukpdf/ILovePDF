// RuntimePinnedTools v1.0 — Pinned Recent Tools
// =====================================================================
// Extends the recent-tools system with pin/unpin capability.
// Pinned tools float to the top of the recent-tools UI and persist
// across sessions. Max 5 pinned tools.
//
// Storage: localStorage 'iplv_pinned_v1' (array of slugs)
//
// UI: Injects a "Pinned" section into any element with class
//     'recent-tools-container' or 'iplv-recent-tools'.
//     Adds a pin button to each tool card when RuntimePinnedTools is ready.
//
// Exposes: window.RuntimePinnedTools
//   .pin(slug)        — pin a tool (max 5)
//   .unpin(slug)      — unpin a tool
//   .toggle(slug)     — pin if unpinned, unpin if pinned
//   .isPinned(slug)   — boolean
//   .getAll()         — ordered array of pinned slugs
//   .clearAll()       — clear all pins
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimePinnedTools) return;

  var LOG      = '[RPT]';
  var LS_KEY   = 'iplv_pinned_v1';
  var MAX_PINS = 5;

  // ── Storage helpers ───────────────────────────────────────────────────────
  function _load() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(function (s) { return typeof s === 'string' && s; }) : [];
    } catch (_) { return []; }
  }

  function _save(pins) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(pins.slice(0, MAX_PINS))); } catch (_) {}
  }

  // ── Core operations ───────────────────────────────────────────────────────
  function pin(slug) {
    if (!slug) return false;
    var pins = _load();
    if (pins.indexOf(slug) !== -1) return false;
    if (pins.length >= MAX_PINS) { pins.shift(); } // drop oldest when over limit
    pins.push(slug);
    _save(pins);
    _renderAll();
    _emitChange(slug, 'pin');
    return true;
  }

  function unpin(slug) {
    if (!slug) return false;
    var pins = _load();
    var idx  = pins.indexOf(slug);
    if (idx === -1) return false;
    pins.splice(idx, 1);
    _save(pins);
    _renderAll();
    _emitChange(slug, 'unpin');
    return true;
  }

  function toggle(slug) { return isPinned(slug) ? unpin(slug) : pin(slug); }

  function isPinned(slug) { return _load().indexOf(slug) !== -1; }

  function getAll() { return _load(); }

  function clearAll() { try { localStorage.removeItem(LS_KEY); } catch (_) {} _renderAll(); }

  function _emitChange(slug, action) {
    try {
      G.dispatchEvent(new CustomEvent('iplv:pin-changed', { detail: { slug: slug, action: action } }));
    } catch (_) {}
    try {
      if (G.RuntimeAnalytics) G.RuntimeAnalytics.track('tool:' + action, { tool_id: slug });
    } catch (_) {}
  }

  // ── UI Injection ──────────────────────────────────────────────────────────
  var _CSS_INJECTED = false;

  function _injectCSS() {
    if (_CSS_INJECTED) return;
    _CSS_INJECTED = true;
    var s = document.createElement('style');
    s.id  = 'iplv-pinned-css';
    s.textContent = [
      '.iplv-pinned-section{padding:12px 16px 4px;border-bottom:1px solid rgba(0,0,0,.06)}',
      '.iplv-pinned-section h4{font-size:11px;font-weight:600;text-transform:uppercase;',
      'letter-spacing:.06em;color:#9ca3af;margin:0 0 8px}',
      '.iplv-pinned-grid{display:flex;flex-wrap:wrap;gap:6px}',
      '.iplv-pinned-chip{display:flex;align-items:center;gap:5px;padding:5px 10px;',
      'border-radius:20px;background:#f3f4f6;font-size:12px;font-weight:500;',
      'color:#374151;cursor:pointer;border:none;text-decoration:none;',
      'transition:background .15s,transform .1s}',
      '.iplv-pinned-chip:hover{background:#e5e7eb;transform:scale(1.03)}',
      '.iplv-pinned-chip .pin-icon{font-size:11px;opacity:.6}',
      '.iplv-pinned-chip .unpin-btn{',
      'background:none;border:none;cursor:pointer;padding:0 0 0 4px;',
      'font-size:13px;line-height:1;color:#9ca3af;',
      'display:flex;align-items:center}',
      '.iplv-pinned-chip .unpin-btn:hover{color:#ef4444}',
      // Pin button on tool cards
      '.iplv-tool-pin-btn{',
      'position:absolute;top:6px;right:6px;',
      'background:none;border:none;cursor:pointer;padding:3px;',
      'font-size:14px;opacity:0;transition:opacity .15s;',
      'z-index:2;color:#9ca3af}',
      '.tool-card:hover .iplv-tool-pin-btn,',
      '.iplv-tool-pin-btn.pinned{opacity:1}',
      '.iplv-tool-pin-btn.pinned{color:#4f46e5}',
      '.iplv-tool-pin-btn:hover{color:#4f46e5}',
      '@media(prefers-color-scheme:dark){',
      '.iplv-pinned-section h4{color:#6b7280}',
      '.iplv-pinned-chip{background:#1f2937;color:#d1d5db}',
      '.iplv-pinned-chip:hover{background:#374151}',
      '}',
      'body.iplv-lite .iplv-pinned-chip{transition:none}',
      'body.iplv-lite .iplv-tool-pin-btn{transition:none}',
    ].join('');
    document.head.appendChild(s);
  }

  function _toolName(slug) {
    var names = {
      'merge-pdf':'Merge PDF','split-pdf':'Split PDF','rotate-pdf':'Rotate PDF',
      'crop-pdf':'Crop PDF','organize-pdf':'Organize PDF','compress-pdf':'Compress PDF',
      'pdf-to-word':'PDF to Word','pdf-to-powerpoint':'PDF to PPT','pdf-to-excel':'PDF to Excel',
      'pdf-to-jpg':'PDF to JPG','word-to-pdf':'Word to PDF','powerpoint-to-pdf':'PPT to PDF',
      'excel-to-pdf':'Excel to PDF','jpg-to-pdf':'JPG to PDF','html-to-pdf':'HTML to PDF',
      'edit-pdf':'Edit PDF','watermark-pdf':'Watermark PDF','sign-pdf':'Sign PDF',
      'add-page-numbers':'Page Numbers','redact-pdf':'Redact PDF',
      'protect-pdf':'Protect PDF','unlock-pdf':'Unlock PDF',
      'repair-pdf':'Repair PDF','ocr-pdf':'OCR PDF','compare-pdf':'Compare PDF',
      'ai-summarizer':'AI Summarizer','translate-pdf':'Translate PDF',
      'background-remover':'Background Remover','crop-image':'Crop Image',
      'resize-image':'Resize Image','image-filters':'Image Filters',
      'qr-code-generator':'QR Code','barcode-generator':'Barcode','zip-builder':'ZIP Builder',
      'currency-converter':'Currency','numbers-to-words':'Num to Words',
    };
    return names[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function _renderAll() {
    _injectCSS();
    var pins = _load();

    document.querySelectorAll('[data-pinned-tools]').forEach(function (el) {
      _renderPinnedSection(el, pins);
    });

    // Update all pin buttons
    document.querySelectorAll('.iplv-tool-pin-btn[data-pin-slug]').forEach(function (btn) {
      var slug = btn.getAttribute('data-pin-slug');
      btn.classList.toggle('pinned', isPinned(slug));
      btn.title = isPinned(slug) ? 'Unpin tool' : 'Pin for quick access';
      btn.textContent = isPinned(slug) ? '📌' : '📍';
    });
  }

  function _renderPinnedSection(container, pins) {
    var existing = container.querySelector('.iplv-pinned-section');
    if (!pins.length) {
      if (existing) existing.remove();
      return;
    }

    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'iplv-pinned-section';
      container.prepend(existing);
    }

    existing.innerHTML = '<h4>📌 Pinned</h4><div class="iplv-pinned-grid"></div>';
    var grid = existing.querySelector('.iplv-pinned-grid');

    pins.forEach(function (slug) {
      var chip = document.createElement('div');
      chip.className = 'iplv-pinned-chip';
      chip.innerHTML =
        '<a href="/' + slug + '" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:4px">' +
          '<span class="pin-icon">📌</span>' +
          '<span>' + _toolName(slug) + '</span>' +
        '</a>' +
        '<button class="unpin-btn" title="Unpin" data-unpin="' + slug + '">×</button>';
      grid.appendChild(chip);
    });

    existing.querySelectorAll('.unpin-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        unpin(btn.getAttribute('data-unpin'));
      });
    });
  }

  // ── Inject pin buttons into tool cards ────────────────────────────────────
  function _injectPinButtons() {
    _injectCSS();
    // Add pin button to tool-cards that don't already have one
    document.querySelectorAll('.tool-card[data-slug], .recent-tool[data-slug]').forEach(function (card) {
      if (card.querySelector('.iplv-tool-pin-btn')) return;
      var slug = card.getAttribute('data-slug');
      if (!slug) return;
      var btn = document.createElement('button');
      btn.className = 'iplv-tool-pin-btn' + (isPinned(slug) ? ' pinned' : '');
      btn.setAttribute('data-pin-slug', slug);
      btn.title     = isPinned(slug) ? 'Unpin tool' : 'Pin for quick access';
      btn.textContent = isPinned(slug) ? '📌' : '📍';
      btn.style.position = 'absolute';
      // Ensure card has position:relative for absolute positioning
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggle(slug);
      });
      card.appendChild(btn);
    });
  }

  // ── MutationObserver: pick up dynamically added tool cards ────────────────
  var _observer = null;
  function _startObserver() {
    if (_observer || typeof MutationObserver === 'undefined') return;
    _observer = new MutationObserver(function (muts) {
      var changed = muts.some(function (m) { return m.addedNodes.length > 0; });
      if (changed) {
        clearTimeout(_observer._debounce);
        _observer._debounce = setTimeout(_injectPinButtons, 250);
      }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function _init() {
    _injectCSS();
    _renderAll();
    _injectPinButtons();
    _startObserver();
    console.debug(LOG, 'ready — pins:', _load().length);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimePinnedTools = { pin: pin, unpin: unpin, toggle: toggle, isPinned: isPinned, getAll: getAll, clearAll: clearAll };

}(window));
