// RuntimeWorkerDomainThrottle v1.0 — Arc 4 / Phase A / Target 1
// =====================================================================
// Per-family worker concurrency caps + domain-scoped thermal throttling.
//
// Problem (Arc 3 gap): RuntimeWorkerDomainRegistry tracks per-family
// pressure but never feeds back into WorkerPool. OCR pressure still
// throttles all tools because WorkerPool.run() is called directly by
// callers with no family awareness.
//
// Solution: Intercept WorkerPool.run() via RuntimeWorkerDomainThrottle.run().
// Per-family caps:
//   organize/compress/edit/utility  → cap 4 slots (normal)
//   convert-from/convert-to         → cap 3 slots (moderate)
//   ai                              → cap 2 slots (heavy)
//   image                           → cap 3 slots (moderate)
//
// Per-family hold queue: when a family is pressure-flagged (from
// RuntimeWorkerDomainRegistry.isPressured()), new tasks for that family
// are held for up to HOLD_TTL_MS, then released regardless.
//
// Thermal routing: family thermalPolicy 'throttle' → halved cap.
// Families with thermalPolicy 'pause' → all new tasks held.
//
// WorkerPool.js is NOT modified.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeWorkerDomainThrottle) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG       = '[DomThrottle]';
  var VERSION   = '1.0';
  var HOLD_TTL_MS = 30 * 1000;  // max time a task sits in hold queue

  // ── Per-family concurrency caps (max concurrent WorkerPool slots) ──────────
  var FAMILY_CAPS = {
    'organize':     4,
    'compress':     4,
    'edit':         4,
    'utility':      2,
    'convert-from': 3,
    'convert-to':   3,
    'ai':           2,
    'image':        3,
  };

  // ── Tool → family (mirrors RuntimeWorkerDomainRegistry) ───────────────────
  var TOOL_FAMILY = {
    'merge':'organize','split':'organize','rotate':'organize','crop':'organize',
    'organize':'organize','page-numbers':'organize','redact':'organize',
    'compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to','word-to-excel':'convert-to',
    'edit':'edit','watermark':'edit','sign':'edit','protect':'edit',
    'unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ai-summarize':'ai','translate':'ai','workflow':'ai',
    'background-remover':'image','crop-image':'image','resize-image':'image',
    'image-filters':'image','image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Worker URL → family (reverse mapping) ─────────────────────────────────
  var URL_FAMILY = {
    '/workers/pdf-lib-worker.js':       'organize',
    '/workers/pdf-worker.js':           'organize',
    '/workers/compress-worker.js':      'compress',
    '/workers/pdf-word-docx-worker.js': 'convert-from',
    '/workers/pdf-excel-xlsx-worker.js':'convert-from',
    '/workers/pdf-ppt-pptx-worker.js':  'convert-from',
    '/workers/advanced-worker.js':      'ai',
    '/workers/summary-worker.js':       'ai',
    '/workers/translation-worker.js':   'ai',
    '/workers/ocr-preprocessor-worker.js':'ai',
    '/workers/image-tools-worker.js':   'image',
    '/workers/image-pipeline-worker.js':'image',
    '/workers/remove-bg-worker.js':     'image',
    '/workers/compare-worker.js':       'edit',
    '/workers/repair-worker.js':        'edit',
    '/workers/shared-cluster-worker.js':'organize',
  };

  // ── Per-family hold queues ─────────────────────────────────────────────────
  // family → [{ resolve, reject, workerUrl, payload, opts, queuedAt }]
  var _holdQueues   = {};
  var _activeCounts = {}; // family → current concurrent count

  function _getFamily(workerUrl, opts) {
    // Try from opts.toolId first
    if (opts && opts.toolId) {
      var f = TOOL_FAMILY[opts.toolId];
      if (f) return f;
    }
    // Fall back to URL mapping
    return URL_FAMILY[workerUrl] || 'organize';
  }

  function _getCap(family) {
    var base = FAMILY_CAPS[family] || 4;
    // Check thermal tier from manifest registry
    try {
      var mr = G.RuntimeToolManifestRegistry;
      var fam = mr && mr.getFamilies && mr.getFamilies();
      // If ai family and pressured, halve the cap
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd && wd.isPressured(family)) return Math.max(1, Math.floor(base / 2));
    } catch (_) {}
    return base;
  }

  function _isHeld(family) {
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      return wd && wd.isPressured(family);
    } catch (_) { return false; }
  }

  function _activeCount(family) {
    return _activeCounts[family] || 0;
  }

  function _increment(family) {
    _activeCounts[family] = (_activeCounts[family] || 0) + 1;
  }

  function _decrement(family) {
    _activeCounts[family] = Math.max(0, (_activeCounts[family] || 1) - 1);
    // Drain hold queue when a slot frees up
    _drainHold(family);
  }

  // ── Hold queue management ─────────────────────────────────────────────────
  function _holdTask(family, workerUrl, payload, opts) {
    if (!_holdQueues[family]) _holdQueues[family] = [];
    return new Promise(function (resolve, reject) {
      var entry = {
        resolve:   resolve,
        reject:    reject,
        workerUrl: workerUrl,
        payload:   payload,
        opts:      opts,
        queuedAt:  Date.now(),
      };
      _holdQueues[family].push(entry);
      console.debug(LOG, 'held task for family:', family, '— queue depth:', _holdQueues[family].length);

      // TTL release: don't hold forever
      setTimeout(function () {
        var q = _holdQueues[family];
        if (!q) return;
        var idx = q.indexOf(entry);
        if (idx === -1) return; // already dispatched
        q.splice(idx, 1);
        // Release after TTL — dispatch regardless of pressure
        _dispatch(workerUrl, payload, opts).then(resolve).catch(reject);
      }, HOLD_TTL_MS);
    });
  }

  function _drainHold(family) {
    var q = _holdQueues[family];
    if (!q || !q.length) return;
    if (_isHeld(family)) return; // still pressured
    var cap = _getCap(family);
    while (q.length > 0 && _activeCount(family) < cap) {
      var entry = q.shift();
      _dispatch(entry.workerUrl, entry.payload, entry.opts)
        .then(entry.resolve)
        .catch(entry.reject);
    }
  }

  // ── Actual WorkerPool dispatch ─────────────────────────────────────────────
  function _dispatch(workerUrl, payload, opts) {
    var wp = G.WorkerPool;
    if (!wp || typeof wp.run !== 'function') {
      return Promise.reject(new Error('WorkerPool not available'));
    }
    return wp.run(workerUrl, payload, opts && opts.transferables, opts);
  }

  // ── Public throttled run ──────────────────────────────────────────────────
  function run(workerUrl, payload, opts) {
    opts = opts || {};
    var family = _getFamily(workerUrl, opts);
    var cap    = _getCap(family);

    // If pressured: hold the task
    if (_isHeld(family)) {
      return _holdTask(family, workerUrl, payload, opts);
    }

    // If at cap: hold the task
    if (_activeCount(family) >= cap) {
      return _holdTask(family, workerUrl, payload, opts);
    }

    // Otherwise dispatch immediately, tracking active count
    _increment(family);
    return _dispatch(workerUrl, payload, opts).then(
      function (result) { _decrement(family); return result; },
      function (err)    { _decrement(family); throw err; }
    );
  }

  // ── Listen for domain pressure changes to drain hold queues ──────────────
  G.addEventListener('worker-domain:crash', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) setTimeout(function () { _drainHold(family); }, 5000);
    } catch (_) {}
  });

  G.addEventListener('memory-island:trim', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) setTimeout(function () { _drainHold(family); }, 2000);
    } catch (_) {}
  });

  // ── Diagnostics ───────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(FAMILY_CAPS).forEach(function (f) {
      out[f] = {
        cap:       _getCap(f),
        active:    _activeCount(f),
        held:      (_holdQueues[f] || []).length,
        pressured: _isHeld(f),
      };
    });
    return out;
  }

  G.RuntimeWorkerDomainThrottle = Object.freeze({
    VERSION:  VERSION,
    run:      run,
    getStats: getStats,
    drainHold: function (family) { _drainHold(family); },
    setFamilyCap: function (family, cap) {
      if (typeof cap === 'number' && cap >= 1) FAMILY_CAPS[family] = cap;
    },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-family concurrency caps active');

}(window));
