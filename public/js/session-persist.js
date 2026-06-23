// session-persist.js — Phase 3: Smart Session Persistence + Runtime Cache
// Cross-session persistence layer built on top of the existing ToolState system.
// Adds: localStorage TTL envelopes, tool options persistence, recent download
// metadata, runtime engine warm-state cache, session resume, and sleep/wake
// recovery. Completely additive — touches ZERO existing processing, security,
// Arc, worker, or BrowserTools code.
//
// window.SessionPersist API:
//   .save(slug, payload, ttlMs?)     — mirror flow state cross-session (2 h default)
//   .load(slug)                      — returns payload or null if expired/absent
//   .clear(slug)                     — remove stored state for slug
//   .clearExpired()                  — GC all stale entries
//   .saveOptions(slug, opts)         — persist tool options (7-day TTL)
//   .loadOptions(slug)               — restore tool options
//   .readDomOptions(tool)            — read current option values from DOM
//   .applyDomOptions(tool, opts)     — write saved options back to DOM (no events)
//   .saveDownload(entry)             — record a completed download (24 h TTL)
//   .getDownloads()                  — [{slug,name,size,ts}] non-expired
//   .saveRuntimeCache(stats)         — snapshot engine warm-state (12 h TTL)
//   .loadRuntimeCache()              — retrieve warm-state snapshot or null
//   .snapshotRuntimeCache()          — auto-read from RuntimeLazyEngineLoader
//   .saveResume(slug, step)          — record last-active tool (2 h TTL)
//   .loadResume()                    — {slug, step} or null
//   .clearResume()                   — wipe resume record
//   .maybeShowResumeBanner(curSlug)  — non-blocking banner for cross-tool resume
(function (G) {
  'use strict';
  if (G.SessionPersist) return;

  // ── Namespaced localStorage keys ─────────────────────────────────────────
  var LS_PREFIX  = 'ilpdf:sp:';   // per-slug flow state
  var OPT_PREFIX = 'ilpdf:opt:';  // per-slug tool options
  var DL_KEY     = 'ilpdf:dl';    // recent downloads array
  var RC_KEY     = 'ilpdf:rc';    // runtime engine cache
  var RESUME_KEY = 'ilpdf:res';   // last-active tool resume

  // ── TTL constants ─────────────────────────────────────────────────────────
  var TTL_SESSION  = 2  * 60 * 60 * 1000;       // 2 hours
  var TTL_OPTIONS  = 7  * 24 * 60 * 60 * 1000;  // 7 days
  var TTL_DOWNLOAD = 24 * 60 * 60 * 1000;       // 24 hours
  var TTL_RUNTIME  = 12 * 60 * 60 * 1000;       // 12 hours
  var MAX_DOWNLOADS = 10;

  // ── Safe localStorage helpers ─────────────────────────────────────────────
  function _lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }
  function _lsGet(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function _lsDel(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // ── TTL envelope ─────────────────────────────────────────────────────────
  // Wraps any data with an expiry timestamp so callers never see stale state.
  function _wrap(data, ttlMs) {
    return { d: data, e: Date.now() + (ttlMs || TTL_SESSION) };
  }
  function _unwrap(envelope) {
    if (!envelope || typeof envelope.e !== 'number') return null;
    if (Date.now() > envelope.e) return null;  // expired
    return envelope.d !== undefined ? envelope.d : null;
  }

  // ── Flow state — cross-session ToolState mirror ───────────────────────────
  // sessionStorage is cleared when the browser is fully closed; localStorage
  // survives. We mirror here with a 2-hour TTL so tool state feels persistent
  // across short browser sessions without accumulating stale data forever.
  function save(slug, payload, ttlMs) {
    if (!slug) return;
    _lsSet(LS_PREFIX + slug, _wrap(payload, ttlMs || TTL_SESSION));
  }

  function load(slug) {
    if (!slug) return null;
    return _unwrap(_lsGet(LS_PREFIX + slug));
  }

  function clear(slug) {
    if (!slug) return;
    _lsDel(LS_PREFIX + slug);
  }

  // ── Tool options (sticky — 7-day TTL) ────────────────────────────────────
  // Saves per-tool option values (compress level, OCR language, watermark
  // text, etc.) so users don't need to reconfigure on every visit.
  function saveOptions(slug, opts) {
    if (!slug || !opts || typeof opts !== 'object') return;
    if (!Object.keys(opts).length) return;
    _lsSet(OPT_PREFIX + slug, _wrap(opts, TTL_OPTIONS));
  }

  function loadOptions(slug) {
    if (!slug) return null;
    return _unwrap(_lsGet(OPT_PREFIX + slug));
  }

  // Read current option values from the live DOM (ids follow "opt-{opt.id}" pattern).
  function readDomOptions(tool) {
    var opts = {};
    if (!tool) return opts;
    // Standard options array (select, input, etc.)
    (tool.options || []).forEach(function (opt) {
      var el = document.getElementById('opt-' + opt.id);
      if (el && el.value !== '' && el.value !== undefined) {
        opts[opt.id] = el.value;
      }
    });
    // Compress tool uses a custom slider (opt-level) outside the options array
    if (tool.id === 'compress') {
      var slider = document.getElementById('opt-level');
      if (slider && slider.value !== '') opts['_compress_level'] = slider.value;
    }
    return opts;
  }

  // Write saved option values back to the DOM after the preview step renders.
  // Only sets .value — does NOT dispatch events to avoid triggering side-effects
  // such as the rotate tool's applyRotationAll() handler (GOTCHA #1).
  // The compress slider is special-cased: it fires `input` so the visual label
  // (managed by wireCompressSlider) updates to reflect the restored value.
  function applyDomOptions(tool, savedOpts) {
    if (!tool || !savedOpts || typeof savedOpts !== 'object') return;
    (tool.options || []).forEach(function (opt) {
      var el = document.getElementById('opt-' + opt.id);
      if (el && savedOpts[opt.id] !== undefined) {
        el.value = savedOpts[opt.id];
      }
    });
    if (tool.id === 'compress' && savedOpts['_compress_level'] !== undefined) {
      var slider = document.getElementById('opt-level');
      if (slider) {
        slider.value = savedOpts['_compress_level'];
        // Fire input so the slider label text updates — does NOT trigger processing.
        try { slider.dispatchEvent(new Event('input', { bubbles: false })); } catch (_) {}
      }
    }
  }

  // ── Recent downloads metadata (24-hour TTL per entry) ────────────────────
  // Records metadata about completed downloads so the user can see recent
  // outputs. NEVER stores file content — only name, size, slug, timestamp.
  function saveDownload(entry) {
    if (!entry || !entry.name) return;
    var list = getDownloads();
    list.unshift({
      slug: entry.slug || '',
      name: String(entry.name),
      size: entry.size || 0,
      ts:   Date.now(),
    });
    if (list.length > MAX_DOWNLOADS) list = list.slice(0, MAX_DOWNLOADS);
    _lsSet(DL_KEY, list);
  }

  function getDownloads() {
    var raw = _lsGet(DL_KEY);
    if (!Array.isArray(raw)) return [];
    var cutoff = Date.now() - TTL_DOWNLOAD;
    return raw.filter(function (d) { return d && typeof d.ts === 'number' && d.ts > cutoff; });
  }

  // ── Runtime engine warm-state cache (12-hour TTL) ─────────────────────────
  // Snapshots which CDN engines are loaded (pdf-lib, pdfjs, tesseract, etc.)
  // from RuntimeLazyEngineLoader. Used only for informational telemetry —
  // does NOT affect which engines actually load; that is controlled by
  // BrowserTools and RuntimeLazyEngineLoader exclusively.
  function saveRuntimeCache(stats) {
    if (!stats) return;
    _lsSet(RC_KEY, _wrap(stats, TTL_RUNTIME));
  }

  function loadRuntimeCache() {
    return _unwrap(_lsGet(RC_KEY));
  }

  function snapshotRuntimeCache() {
    try {
      if (G.RuntimeLazyEngineLoader && typeof G.RuntimeLazyEngineLoader.getStats === 'function') {
        saveRuntimeCache(G.RuntimeLazyEngineLoader.getStats());
      }
    } catch (_) {}
  }

  // ── Session resume (2-hour TTL) ───────────────────────────────────────────
  // Records the last active tool slug + step so we can offer to resume it
  // when the user returns to a different tool page.
  function saveResume(slug, step) {
    if (!slug) return;
    _lsSet(RESUME_KEY, _wrap({ slug: slug, step: step || 'upload', ts: Date.now() }, TTL_SESSION));
  }

  function loadResume() {
    return _unwrap(_lsGet(RESUME_KEY));
  }

  function clearResume() {
    _lsDel(RESUME_KEY);
  }

  // ── Auto-GC: prune expired entries ────────────────────────────────────────
  function clearExpired() {
    try {
      var now     = Date.now();
      var toKill  = [];
      var len     = localStorage.length;
      for (var i = 0; i < len; i++) {
        var key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(LS_PREFIX) || key.startsWith(OPT_PREFIX)) {
          var env = _lsGet(key);
          if (env && typeof env.e === 'number' && now > env.e) toKill.push(key);
        }
      }
      toKill.forEach(_lsDel);
      // Clean downloads array in-place
      var cleanDl = getDownloads();
      var rawDl   = _lsGet(DL_KEY);
      if (Array.isArray(rawDl) && cleanDl.length !== rawDl.length) _lsSet(DL_KEY, cleanDl);
    } catch (_) {}
  }

  // ── Sleep / wake recovery ─────────────────────────────────────────────────
  // When the page regains visibility after a long sleep (laptop lid close,
  // phone lock screen, etc.), snapshot the engine warm-state so it's recorded
  // before the next close, then emit a custom event so the tool page can
  // check whether cached data needs refreshing.
  var _lastVisible = Date.now();

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      _lastVisible = Date.now();
      snapshotRuntimeCache();  // capture what was warm before sleep
      return;
    }
    // Page became visible again
    var sleepMs = Date.now() - _lastVisible;
    _lastVisible = Date.now();

    if (sleepMs > 5 * 60 * 1000) {
      // Slept for more than 5 minutes — broadcast wake event, run GC
      try {
        G.dispatchEvent(new CustomEvent('ilovepdf:wake', { detail: { sleepMs: sleepMs } }));
      } catch (_) {}
      setTimeout(clearExpired, 300);
    }
  });

  // ── Resume banner ─────────────────────────────────────────────────────────
  // Shows a small non-blocking toast when the user is on a different tool page
  // and has a recent unfinished session on another tool. Purely informational —
  // the user clicks "Resume →" to navigate back, or dismisses it.
  function maybeShowResumeBanner(currentSlug) {
    try {
      var resume = loadResume();
      if (!resume) return;
      if (resume.step === 'upload') return;          // nothing to resume
      if (resume.slug === currentSlug) return;       // same tool → hydrateFlowState handles it

      var toolName = resume.slug
        .replace(/-/g, ' ')
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });

      var stepLabel = resume.step === 'download' ? 'download ready' : 'preview';

      var banner = document.createElement('div');
      banner.id  = 'sp-resume-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.style.cssText = [
        'position:fixed',
        'bottom:22px',
        'right:22px',
        'z-index:9998',
        'background:#1e293b',
        'color:#f1f5f9',
        'padding:12px 14px 12px 16px',
        'border-radius:12px',
        'box-shadow:0 6px 24px rgba(0,0,0,.4)',
        'font-size:13px',
        'line-height:1.45',
        'max-width:290px',
        'display:flex',
        'gap:10px',
        'align-items:flex-start',
        'font-family:inherit',
        'animation:sp-in .22s ease',
      ].join(';');

      banner.innerHTML = '<style>' +
        '@keyframes sp-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}' +
        '#sp-resume-banner a:hover{text-decoration:underline!important}' +
        '</style>' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;margin-bottom:2px;font-size:13.5px">Continue where you left off?</div>' +
          '<div style="color:#94a3b8;margin-bottom:8px;font-size:12px">' + toolName + ' &mdash; ' + stepLabel + '</div>' +
          '<a href="/' + resume.slug + (resume.step === 'download' ? '/download' : '/preview') + '" ' +
            'style="color:#60a5fa;font-weight:600;text-decoration:none;font-size:13px">Resume &rarr;</a>' +
        '</div>' +
        '<button id="sp-resume-dismiss" title="Dismiss" ' +
          'style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;line-height:1;padding:0 2px;flex-shrink:0">' +
          '&times;</button>';

      document.body.appendChild(banner);

      // Wire dismiss button
      var dismissBtn = document.getElementById('sp-resume-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', function () {
          try { banner.remove(); } catch (_) {}
        });
      }

      // Auto-dismiss after 8 seconds
      setTimeout(function () { try { banner.remove(); } catch (_) {} }, 8000);
    } catch (_) {}
  }

  // ── Init: run GC on startup (deferred, non-blocking) ─────────────────────
  setTimeout(clearExpired, 2500);

  // ── Expose ────────────────────────────────────────────────────────────────
  G.SessionPersist = Object.freeze({
    // Cross-session flow state
    save:             save,
    load:             load,
    clear:            clear,
    clearExpired:     clearExpired,
    // Tool options
    saveOptions:      saveOptions,
    loadOptions:      loadOptions,
    readDomOptions:   readDomOptions,
    applyDomOptions:  applyDomOptions,
    // Recent download metadata
    saveDownload:     saveDownload,
    getDownloads:     getDownloads,
    // Runtime engine warm-state cache
    saveRuntimeCache:     saveRuntimeCache,
    loadRuntimeCache:     loadRuntimeCache,
    snapshotRuntimeCache: snapshotRuntimeCache,
    // Session resume
    saveResume:            saveResume,
    loadResume:            loadResume,
    clearResume:           clearResume,
    maybeShowResumeBanner: maybeShowResumeBanner,
  });

}(window));
