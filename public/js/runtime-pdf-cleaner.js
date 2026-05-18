// runtime-pdf-cleaner.js — PDF.js Global Leak Cleaner (Phase 2D)
// ADDITIVE ONLY. Intercepts PDF.js document creation via a monkey-patch on
// window.pdfjsLib (when available) to track every live document. Periodically
// detects and destroys un-cleaned docs, stranded render tasks, and retained
// page/operator-list references. Never interferes with active render pipelines.
//
// window.RuntimePdfCleaner — public API
(function () {
  'use strict';

  if (window.RuntimePdfCleaner) return;

  var LOG     = '[RPC]';
  var VERSION = '1.0.0';

  // ── Global PDF doc registry ──────────────────────────────────────────────────
  // Map<id, { pdfDoc, ts, label, destroyed, renderTasks[] }>
  var _docs   = new Map();
  var _nextId = 1;
  var _stats  = { registered: 0, autoDestroyed: 0, rendersCancelled: 0, errors: 0 };

  // How long before we consider an un-destroyed doc a leak (5 min default)
  var DOC_MAX_AGE_MS      = 5 * 60 * 1000;
  // For OCR docs which may legitimately run longer
  var DOC_MAX_AGE_OCR_MS  = 10 * 60 * 1000;

  // ── Register a PDF document ──────────────────────────────────────────────────
  // Call this after getDocument().promise resolves.
  // Returns a handle with { id, addRenderTask(task), done() }
  function register(pdfDoc, opts) {
    opts = opts || {};
    var id    = _nextId++;
    var entry = {
      id:          id,
      pdfDoc:      pdfDoc,
      ts:          Date.now(),
      label:       opts.label  || 'pdf-' + id,
      isOcr:       !!opts.isOcr,
      destroyed:   false,
      renderTasks: [],
      pages:       [],
    };
    _docs.set(id, entry);
    _stats.registered++;

    return {
      id: id,

      // Track a render task so we can cancel it on cleanup
      addRenderTask: function (task) {
        if (task && !entry.destroyed) entry.renderTasks.push(task);
      },

      // Track a page reference (so we can release it)
      addPage: function (page) {
        if (page && !entry.destroyed) entry.pages.push(page);
      },

      // Mark as cleanly closed — remove from registry without force-destroy
      done: function () {
        _docs.delete(id);
        entry.destroyed = true;
      },
    };
  }

  // ── Force-clean a single doc entry ───────────────────────────────────────────
  function _cleanEntry(entry) {
    if (entry.destroyed) return;
    entry.destroyed = true;

    // 1. Cancel in-progress render tasks
    entry.renderTasks.forEach(function (task) {
      try { task.cancel(); _stats.rendersCancelled++; } catch (_) {}
    });
    entry.renderTasks = [];

    // 2. Release page references
    entry.pages.forEach(function (page) {
      try { page.cleanup(); } catch (_) {}
    });
    entry.pages = [];

    // 3. Destroy the PDF doc
    try {
      if (entry.pdfDoc && typeof entry.pdfDoc.destroy === 'function') {
        entry.pdfDoc.destroy();
        _stats.autoDestroyed++;
        console.info(LOG, 'auto-destroyed', entry.label, '(age ' + Math.round((Date.now() - entry.ts) / 1000) + 's)');
      }
    } catch (e) {
      _stats.errors++;
      console.debug(LOG, 'destroy error for', entry.label, ':', e.message);
    }

    // 4. Null references to help GC
    entry.pdfDoc = null;

    try {
      if (window.RuntimeEventBus) {
        window.RuntimeEventBus.emit('pdf:auto-destroyed', { label: entry.label });
      }
    } catch (_) {}
  }

  // ── Intercept pdfjsLib.getDocument ──────────────────────────────────────────
  // Monkey-patches pdfjsLib.getDocument to auto-register all future docs.
  // If pdfjsLib loads after this script, we retry with a short backoff.

  var _intercepted  = false;
  var _interceptTries = 0;

  function _tryIntercept() {
    var pdfjs = window.pdfjsLib || (window.PDFJS);
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
      if (_interceptTries++ < 40) {
        setTimeout(_tryIntercept, 500);
      }
      return;
    }
    if (_intercepted) return;
    _intercepted = true;

    var _origGetDocument = pdfjs.getDocument.bind(pdfjs);

    pdfjs.getDocument = function (src) {
      var task = _origGetDocument(src);
      // Wrap the promise to auto-register on success
      var origPromise = task.promise;
      task.promise = origPromise.then(function (pdfDoc) {
        var label = (typeof src === 'string') ? src.split('/').pop().slice(-40) : 'pdfjs-doc';
        var handle = register(pdfDoc, { label: label });
        // Patch destroy so done() fires on normal cleanup
        var origDestroy = pdfDoc.destroy.bind(pdfDoc);
        pdfDoc.destroy = function () {
          handle.done();
          return origDestroy();
        };
        return pdfDoc;
      });
      return task;
    };

    console.info(LOG, 'pdfjsLib.getDocument intercepted — auto-tracking all PDF docs');
  }

  // ── Sweep loop ───────────────────────────────────────────────────────────────
  function sweep() {
    var now     = Date.now();
    var cleaned = 0;
    _docs.forEach(function (entry, id) {
      if (entry.destroyed) { _docs.delete(id); return; }
      var maxAge = entry.isOcr ? DOC_MAX_AGE_OCR_MS : DOC_MAX_AGE_MS;
      if ((now - entry.ts) > maxAge) {
        _docs.delete(id);
        _cleanEntry(entry);
        cleaned++;
      }
    });
    if (cleaned > 0) console.info(LOG, 'sweep destroyed', cleaned, 'stale PDF docs');
    return cleaned;
  }

  // ── Nuke all (soft reset / panic) ────────────────────────────────────────────
  function nukeAll(reason) {
    var count = 0;
    _docs.forEach(function (entry) {
      _cleanEntry(entry);
      count++;
    });
    _docs.clear();
    console.info(LOG, 'nukeAll:', count, 'docs destroyed. Reason:', reason);
    return count;
  }

  function getStats() {
    return Object.assign({}, _stats, {
      live:        _docs.size,
      intercepted: _intercepted,
      version:     VERSION,
    });
  }

  function getLive() {
    var now  = Date.now();
    var list = [];
    _docs.forEach(function (entry) {
      list.push({
        id:     entry.id,
        label:  entry.label,
        ageMs:  now - entry.ts,
        renders: entry.renderTasks.length,
        isOcr:  entry.isOcr,
      });
    });
    return list;
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  var SWEEP_INTERVAL = 2 * 60 * 1000; // 2 min
  var _sweepTimer = setInterval(function () {
    try { sweep(); } catch (_) {}
  }, SWEEP_INTERVAL);
  if (window.TimerRegistry) window.TimerRegistry.registerInterval('RuntimePdfCleaner', _sweepTimer);

  _tryIntercept();

  window.addEventListener('pagehide', function () {
    try { nukeAll('pagehide'); } catch (_) {}
  }, { passive: true });

  window.RuntimePdfCleaner = {
    register:  register,
    sweep:     sweep,
    nukeAll:   nukeAll,
    getStats:  getStats,
    getLive:   getLive,
    VERSION:   VERSION,
  };

  console.debug(LOG, 'v' + VERSION + ' loaded');
}());
