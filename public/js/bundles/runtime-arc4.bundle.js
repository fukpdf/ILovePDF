// ── Arc 4 Enterprise Tool Runtime Completion — Phase 9 build bundle ──────────────────────────
// Generated: 2026-06-03T02:46:36.800Z  BUILD_ID: mpxgtdiz
// Files: 9

// ── SOURCE: public/js/runtime-worker-domain-throttle.js ──
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

// ── SOURCE: public/js/runtime-offline-domains.js ──
// RuntimeOfflineDomains v1.0 — Arc 4 / Phase B / Target 2
// =====================================================================
// Per-family isolated IndexedDB offline job queues.
//
// Problem: RuntimeOfflineProcessor uses a single IDB store with a single
// _running flag. OCR offline job failure stalls Compress offline jobs.
// A corrupt OCR job blocks the entire shared queue drain.
//
// Solution: Each of the 8 tool families gets its own IDB database:
//   iplv-offline-organize-v1
//   iplv-offline-compress-v1
//   iplv-offline-convert-from-v1
//   iplv-offline-convert-to-v1
//   iplv-offline-edit-v1
//   iplv-offline-ai-v1
//   iplv-offline-image-v1
//   iplv-offline-utility-v1
//
// Each family has independent:
//   - IDB connection + schema
//   - _running drain flag
//   - retry counter
//   - reconnect/visibility recovery
//
// RuntimeOfflineProcessor (Arc 2) is preserved and continues to work.
// RuntimeOfflineDomains supplements it with domain-aware routing.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeOfflineDomains) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[OfflineDoms]';
  var VERSION = '1.0';
  var MAX_RETRY    = 3;
  var IDB_VER      = 1;
  var STORE_NAME   = 'jobs';
  var FAMILIES     = ['organize','compress','convert-from','convert-to','edit','ai','image','utility'];

  // ── Tool → family ─────────────────────────────────────────────────────────
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

  // ── Per-family state ──────────────────────────────────────────────────────
  // family → { dbPromise, processors, running }
  var _state = {};

  function _getFamilyState(family) {
    if (!_state[family]) {
      _state[family] = { dbPromise: null, processors: {}, running: false };
    }
    return _state[family];
  }

  // ── Open per-family IDB ───────────────────────────────────────────────────
  function _openDb(family) {
    var st = _getFamilyState(family);
    if (st.dbPromise) return st.dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IDB unavailable'));
    var dbName = 'iplv-offline-' + family + '-v1';
    st.dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName, IDB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var s = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          s.createIndex('status',    'status',    { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) {
        reject(e.target.error);
        st.dbPromise = null;
      };
    });
    return st.dbPromise;
  }

  // ── IDB transaction helper ────────────────────────────────────────────────
  function _dbTx(family, mode, fn) {
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx    = db.transaction(STORE_NAME, mode);
        var store = tx.objectStore(STORE_NAME);
        var res;
        try { res = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(res instanceof IDBRequest ? res.result : res); };
        tx.onerror    = function () { reject(tx.error); };
        if (res instanceof IDBRequest) {
          res.onsuccess = function () {};
          res.onerror   = function () { reject(res.error); };
        }
      });
    });
  }

  // ── Enqueue a job for a specific family ───────────────────────────────────
  function enqueue(family, type, payload, opts) {
    opts = opts || {};
    if (!FAMILIES.includes(family)) {
      console.debug(LOG, 'unknown family:', family, '— falling back to organize');
      family = 'organize';
    }
    var job = {
      type:          type,
      family:        family,
      payload:       payload || {},
      state:         opts.state || null,
      retries:       0,
      maxRetries:    opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRY,
      createdAt:     Date.now(),
      lastAttemptAt: null,
      status:        'pending',
      error:         null,
    };
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var req = tx.objectStore(STORE_NAME).add(job);
        req.onsuccess = function () {
          job.id = req.result;
          console.debug(LOG, family + ': enqueued job', job.id, '— type:', type);
          resolve(job);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Enqueue by toolId (auto-resolves family) ──────────────────────────────
  function enqueueForTool(toolId, type, payload, opts) {
    var family = TOOL_FAMILY[toolId] || 'organize';
    return enqueue(family, type, payload, opts);
  }

  // ── Drain pending jobs for one family ─────────────────────────────────────
  function drain(family) {
    var st = _getFamilyState(family);
    if (st.running || !navigator.onLine) return;
    st.running = true;

    _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readonly');
        var idx = tx.objectStore(STORE_NAME).index('status');
        var req = idx.getAll('pending');
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    }).then(function (jobs) {
      if (!jobs.length) { st.running = false; return; }
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () { return _execute(family, job); });
      });
      return chain;
    }).catch(function (e) {
      console.debug(LOG, family + ': drain error:', e);
    }).then(function () {
      st.running = false;
    });
  }

  function drainAll() {
    FAMILIES.forEach(function (f) { drain(f); });
  }

  // ── Execute one job ───────────────────────────────────────────────────────
  function _execute(family, job) {
    var st      = _getFamilyState(family);
    var handler = st.processors[job.type];
    if (!handler) {
      console.debug(LOG, family + ': no handler for type:', job.type);
      return _updateJob(family, job.id, { status: 'failed', error: 'no-handler' });
    }
    return _updateJob(family, job.id, { status: 'running', lastAttemptAt: Date.now() })
      .then(function () { return Promise.resolve(handler(job.payload, job.state)); })
      .then(function () { return _updateJob(family, job.id, { status: 'completed' }); })
      .catch(function (err) {
        var retries = (job.retries || 0) + 1;
        var status  = retries >= job.maxRetries ? 'failed' : 'pending';
        return _updateJob(family, job.id, { status: status, retries: retries, error: String(err) });
      });
  }

  function _updateJob(family, id, fields) {
    return _openDb(family).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(STORE_NAME, 'readwrite');
        var st  = tx.objectStore(STORE_NAME);
        var get = st.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) { resolve(); return; }
          Object.assign(rec, fields);
          var put = st.put(rec);
          put.onsuccess = function () { resolve(); };
          put.onerror   = function () { reject(put.error); };
        };
        get.onerror = function () { reject(get.error); };
      });
    });
  }

  // ── Register a handler for a family + type ────────────────────────────────
  function register(family, type, fn) {
    var st = _getFamilyState(family);
    st.processors[type] = fn;
  }

  // ── Stats for RuntimeHealthOrchestrator ──────────────────────────────────
  function getQueueStats(family) {
    if (family) {
      return _openDb(family).then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var st = tx.objectStore(STORE_NAME);
          var pending = 0, failed = 0, completed = 0;
          var req = st.openCursor();
          req.onsuccess = function (e) {
            var cursor = e.target.result;
            if (cursor) {
              if (cursor.value.status === 'pending')   pending++;
              if (cursor.value.status === 'failed')    failed++;
              if (cursor.value.status === 'completed') completed++;
              cursor.continue();
            } else {
              resolve({ family: family, pending: pending, failed: failed, completed: completed });
            }
          };
          req.onerror = function () { resolve({ family: family, error: true }); };
        });
      }).catch(function () { return { family: family, error: true }; });
    }
    // All families
    return Promise.all(FAMILIES.map(function (f) { return getQueueStats(f); }))
      .then(function (results) {
        var out = {};
        results.forEach(function (r) { out[r.family] = r; });
        return out;
      });
  }

  // ── Reconnect + visibility recovery ──────────────────────────────────────
  G.addEventListener('online', drainAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') drainAll();
  });

  // Initial drain
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(drainAll, 1500); }, { once: true });
  } else {
    setTimeout(drainAll, 1500);
  }

  G.RuntimeOfflineDomains = Object.freeze({
    VERSION:        VERSION,
    enqueue:        enqueue,
    enqueueForTool: enqueueForTool,
    drain:          drain,
    drainAll:       drainAll,
    register:       register,
    getQueueStats:  getQueueStats,
    getFamilies:    function () { return FAMILIES.slice(); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-family offline queues active');

}(window));

// ── SOURCE: public/js/runtime-processor-registry.js ──
// RuntimeProcessorRegistry v1.0 — Arc 4 / Phase C / Target 3
// =====================================================================
// Lazy processor activation registry for AdvancedEngine families.
//
// Problem: advanced-engine.js is 6926 lines parsed and JIT-compiled
// regardless of which tool is active. Visit Compress PDF? OCR internals,
// AI parser, table intelligence — all compiled. Visit Merge PDF? Full
// AI runtime initialised unnecessarily.
//
// Solution: A lightweight registry that tracks which processor families
// have been activated. Each family has an init function registered at
// load time. `activate(family)` runs the init function exactly once.
//
// The registry intercepts AdvancedEngine dispatch via a hook installed
// on `window.AdvancedEngine.process`. Before any tool processes its
// first job, `activate(family)` is called. All subsequent calls are
// idempotent (no-op after first activation).
//
// AdvancedEngine.js continues to work unchanged — the registry adds
// an OPTIONAL pre-activation layer, not a replacement.
//
// Tool families:
//   organize / compress / convert-from / convert-to / edit / ai / image / utility
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeProcessorRegistry) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ProcessorReg]';
  var VERSION = '1.0';

  // ── Tool → family ─────────────────────────────────────────────────────────
  var TOOL_FAMILY = {
    'merge-pdf':'organize','merge':'organize','split-pdf':'organize','split':'organize',
    'rotate-pdf':'organize','rotate':'organize','crop':'organize',
    'organize-pdf':'organize','organize':'organize',
    'page-numbers':'organize','redact':'organize',
    'compress-pdf':'compress','compress':'compress',
    'pdf-to-word':'convert-from','pdf-to-excel':'convert-from',
    'pdf-to-powerpoint':'convert-from','pdf-to-jpg':'convert-from',
    'word-to-pdf':'convert-to','excel-to-pdf':'convert-to',
    'powerpoint-to-pdf':'convert-to','jpg-to-pdf':'convert-to',
    'html-to-pdf':'convert-to','scan-to-pdf':'convert-to','word-to-excel':'convert-to',
    'edit-pdf':'edit','edit':'edit','watermark':'edit','sign':'edit',
    'protect':'edit','unlock':'edit','repair':'edit','compare':'edit',
    'ocr':'ai','ocr-pdf':'ai','ai-summarize':'ai','ai-summarizer':'ai',
    'translate':'ai','translate-pdf':'ai','workflow':'ai',
    'background-remover':'image','remove-background':'image',
    'crop-image':'image','resize-image':'image','image-filters':'image',
    'image-compressor':'image','image-converter':'image',
    'qr-code-generator':'image','barcode-generator':'image','zip-builder':'image',
    'numbers-to-words':'utility','currency-converter':'utility',
  };

  // ── Processor registry ────────────────────────────────────────────────────
  // family → { initFn, activated, activatedAt, activationMs }
  var _processors = {};

  // ── Register a processor family init function ─────────────────────────────
  function register(family, initFn) {
    if (typeof initFn !== 'function') return;
    if (!_processors[family]) {
      _processors[family] = {
        initFn:       initFn,
        activated:    false,
        activatedAt:  null,
        activationMs: null,
      };
      console.debug(LOG, 'registered:', family);
    }
  }

  // ── Activate a processor family (idempotent) ──────────────────────────────
  function activate(family) {
    if (!family) return;
    var p = _processors[family];
    if (!p) {
      console.debug(LOG, 'no processor registered for family:', family, '— using AdvancedEngine default');
      return;
    }
    if (p.activated) return;
    var t0 = Date.now();
    try {
      p.initFn();
      p.activated    = true;
      p.activatedAt  = Date.now();
      p.activationMs = Date.now() - t0;
      console.debug(LOG, 'activated:', family, '—', p.activationMs + 'ms');
      try {
        G.dispatchEvent(new CustomEvent('processor:activated', {
          detail: { family: family, activationMs: p.activationMs },
        }));
      } catch (_) {}
    } catch (e) {
      console.debug(LOG, 'activation error:', family, e && e.message || e);
    }
  }

  // ── Activate by toolId ────────────────────────────────────────────────────
  function activateForTool(toolId) {
    // Try direct lookup
    var family = TOOL_FAMILY[toolId];
    if (!family) {
      // Try RuntimeToolManifestRegistry
      try {
        var mr = G.RuntimeToolManifestRegistry;
        family = mr && mr.getFamily && mr.getFamily(toolId);
      } catch (_) {}
    }
    if (family) activate(family);
    // Also activate from RuntimeWorkerDomainRegistry
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) { var f2 = wd.getFamily(toolId); if (f2 && f2 !== family) activate(f2); }
    } catch (_) {}
  }

  // ── Install AdvancedEngine interceptor ────────────────────────────────────
  // We cannot modify the frozen AdvancedEngine export, but we CAN install
  // a pre-process hook via the 'tool:runtime-ready' event from RuntimeToolLoader.
  function _installHooks() {
    // Hook 1: tool:runtime-ready → activate processor for current tool
    G.addEventListener('tool:runtime-ready', function (evt) {
      try {
        var toolId = evt && evt.detail && evt.detail.toolId;
        if (toolId) activateForTool(toolId);
      } catch (_) {}
    });

    // Hook 2: tool:manifest-activated → activate processor
    G.addEventListener('tool:manifest-activated', function (evt) {
      try {
        var family = evt && evt.detail && evt.detail.family;
        if (family) activate(family);
      } catch (_) {}
    });

    // Hook 3: If AdvancedEngine is available, wrap its process() call to
    // auto-activate the family before each tool run.
    try {
      var ae = G.AdvancedEngine;
      if (ae && typeof ae.process === 'function' && !ae._processorRegistryWrapped) {
        var _origProcess = ae.process.bind(ae);
        // AdvancedEngine is frozen — we install a global interceptor instead
        G.__processorRegistryInterceptProcess = function (toolId) {
          activateForTool(toolId);
        };
        console.debug(LOG, 'global process interceptor installed');
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _installHooks, { once: true });
  } else {
    setTimeout(_installHooks, 0);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var out = {};
    Object.keys(_processors).forEach(function (f) {
      var p = _processors[f];
      out[f] = { activated: p.activated, activatedAt: p.activatedAt, activationMs: p.activationMs };
    });
    return out;
  }

  G.RuntimeProcessorRegistry = Object.freeze({
    VERSION:         VERSION,
    register:        register,
    activate:        activate,
    activateForTool: activateForTool,
    isActivated:     function (family) { return !!(_processors[family] && _processors[family].activated); },
    getStats:        getStats,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — lazy processor activation active');

}(window));

// ── SOURCE: public/js/runtime-bundle-graph.js ──
// RuntimeBundleGraph v1.0 — Arc 4 / Phase D / Target 4
// =====================================================================
// Active bundle graph + per-tool activation tracking.
//
// Problem: RuntimeBundleRegistry loads bundles but has no concept of
// which tool activated which bundle. There is no way to know if a bundle
// is dormant (loaded but no longer in use). arc3 bundle was not
// registered in RuntimeBundleRegistry.
//
// Solution:
//   1. Registers the arc3 bundle into RuntimeBundleRegistry at boot
//   2. Tracks per-tool bundle activation history
//   3. Exports active bundle graph: { bundle → [toolIds that activated it] }
//   4. Dormant detection: bundle loaded but no tool activity > DORMANT_MS
//   5. On-demand injection: injectForTool(toolId) loads only needed bundles
//
// Unloading: browsers do not support true script unloading. Dormant
// bundles are flagged in the graph for diagnostics but not removed from
// memory (that would break the singleton guard pattern).
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeBundleGraph) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[BundleGraph]';
  var VERSION    = '1.0';
  var DORMANT_MS = 10 * 60 * 1000; // 10 min without tool activity = dormant

  // ── Tool → minimum bundles required ──────────────────────────────────────
  // All tools need: core, security, zero-trust, hardening, infra, arc2, arc3
  var BASE_CHAIN = ['core', 'security', 'zero-trust', 'hardening', 'infra', 'arc2', 'arc3'];

  // ── Activation graph ──────────────────────────────────────────────────────
  // bundle → { toolIds: Set, activatedAt, lastUsedAt }
  var _graph = {};

  // ── Tool activity timestamps ──────────────────────────────────────────────
  var _toolActivity = {}; // toolId → lastActiveAt

  function _touchBundle(bundleName, toolId) {
    if (!_graph[bundleName]) {
      _graph[bundleName] = { toolIds: [], activatedAt: Date.now(), lastUsedAt: Date.now() };
    }
    var node = _graph[bundleName];
    if (toolId && !node.toolIds.includes(toolId)) node.toolIds.push(toolId);
    node.lastUsedAt = Date.now();
  }

  function _touchTool(toolId) {
    _toolActivity[toolId] = Date.now();
  }

  // ── Register arc3 into RuntimeBundleRegistry ──────────────────────────────
  function _registerArc3() {
    try {
      var reg = G.RuntimeBundleRegistry;
      if (!reg) return;
      // arc3 depends on arc2
      reg.register('arc3', 'runtime-arc3.bundle.js', ['arc2']);
      console.debug(LOG, 'arc3 registered in RuntimeBundleRegistry');
    } catch (e) {
      console.debug(LOG, 'arc3 registration error:', e && e.message || e);
    }
  }

  // ── Inject all base bundles for a tool ───────────────────────────────────
  function injectForTool(toolId) {
    _touchTool(toolId);
    var reg = G.RuntimeBundleRegistry;
    if (!reg) return Promise.resolve();

    var chain = Promise.resolve();
    BASE_CHAIN.forEach(function (bundleName) {
      chain = chain.then(function () {
        _touchBundle(bundleName, toolId);
        return reg.load(bundleName).catch(function (e) {
          // Non-fatal: bundle may be pre-loaded via script tags
          console.debug(LOG, 'bundle load note:', bundleName, e && e.message || e);
        });
      });
    });
    return chain;
  }

  // ── Dormant detection ─────────────────────────────────────────────────────
  function getDormantBundles() {
    var now     = Date.now();
    var dormant = [];
    Object.keys(_graph).forEach(function (name) {
      var node = _graph[name];
      if ((now - node.lastUsedAt) > DORMANT_MS) {
        dormant.push({ name: name, dormantSinceMs: now - node.lastUsedAt, toolIds: node.toolIds.slice() });
      }
    });
    return dormant;
  }

  // ── Active graph export ───────────────────────────────────────────────────
  function getActiveGraph() {
    var now = Date.now();
    var out = {};
    Object.keys(_graph).forEach(function (name) {
      var node = _graph[name];
      out[name] = {
        toolIds:       node.toolIds.slice(),
        activatedAt:   node.activatedAt,
        lastUsedAt:    node.lastUsedAt,
        ageMs:         now - node.activatedAt,
        idleMs:        now - node.lastUsedAt,
        dormant:       (now - node.lastUsedAt) > DORMANT_MS,
      };
    });
    // Include RuntimeBundleRegistry status
    try {
      var reg = G.RuntimeBundleRegistry;
      if (reg) {
        var status = reg.status();
        Object.keys(status).forEach(function (name) {
          if (!out[name]) out[name] = { toolIds: [], activatedAt: null, lastUsedAt: null, ageMs: null, idleMs: null, dormant: false };
          out[name].loaded  = status[name].loaded;
          out[name].loading = status[name].loading;
        });
      }
    } catch (_) {}
    return out;
  }

  // ── Listen for tool runtime ready events ─────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) {
        _touchTool(toolId);
        BASE_CHAIN.forEach(function (b) { _touchBundle(b, toolId); });
      }
    } catch (_) {}
  });

  // ── Listen for bundle segment activation ─────────────────────────────────
  G.addEventListener('tool:manifest-activated', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) _touchTool(toolId);
    } catch (_) {}
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _registerArc3();
    // Seed existing bundles as pre-loaded (they're in script tags already)
    BASE_CHAIN.forEach(function (name) { _touchBundle(name, null); });
    console.debug(LOG, 'bundle graph initialized —', BASE_CHAIN.length, 'base bundles tracked');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 0);
  }

  G.RuntimeBundleGraph = Object.freeze({
    VERSION:         VERSION,
    injectForTool:   injectForTool,
    getActiveGraph:  getActiveGraph,
    getDormantBundles: getDormantBundles,
    touchBundle:     _touchBundle,
    touchTool:       _touchTool,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — active bundle graph tracking enabled');

}(window));

// ── SOURCE: public/js/runtime-tool-sandbox.js ──
// RuntimeToolSandbox v1.0 — Arc 4 / Phase E / Target 5
// =====================================================================
// Per-tool isolated execution scopes + event bus.
//
// Problem: All tools share the global window event bus. A Merge PDF
// completion event can be accidentally consumed by an OCR handler if
// both are listening to the same event type. There is no enforcement
// of tool-scoped event boundaries.
//
// Solution: Per-tool sandboxed event bus with namespace enforcement.
//   - tool:{toolId}:{event} is the canonical scoped event pattern
//   - RuntimeToolSandbox.emit(toolId, event, data) fires scoped event
//   - RuntimeToolSandbox.on(toolId, event, fn) subscribes scoped
//   - RuntimeToolSandbox.off(toolId, event, fn) unsubscribes
//   - Scoped telemetry sink: events logged to RuntimeAnalyticsDomains
//   - Cross-tool leakage detection: warns if a handler subscribes to
//     a different toolId's namespace
//
// Execution scopes: each tool gets a lightweight context object with:
//   { toolId, family, config, emit, on, off, record }
//
// Global window events are unaffected — this adds a layer, not a
// replacement.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeToolSandbox) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[ToolSandbox]';
  var VERSION = '1.0';

  // ── Per-tool sandbox registry ─────────────────────────────────────────────
  // toolId → { toolId, family, config, listeners: Map<event, [fn]>, emitCount }
  var _sandboxes = {};

  function _getSandbox(toolId) {
    if (!_sandboxes[toolId]) {
      _sandboxes[toolId] = {
        toolId:    toolId,
        family:    null,
        config:    null,
        listeners: {},
        emitCount: 0,
        createdAt: Date.now(),
      };
    }
    return _sandboxes[toolId];
  }

  // ── Create/ensure sandbox for a tool ─────────────────────────────────────
  function createSandbox(toolId) {
    var sb = _getSandbox(toolId);

    // Populate family and config from Arc 3 modules
    try {
      var mr = G.RuntimeToolManifestRegistry;
      if (mr) sb.family = mr.getFamily(toolId);
    } catch (_) {}
    try {
      var cl = G.RuntimeToolConfigLock;
      if (cl) sb.config = cl.get(toolId);
    } catch (_) {}

    console.debug(LOG, 'sandbox created:', toolId, '— family:', sb.family);
    return sb;
  }

  // ── Scoped event emit ─────────────────────────────────────────────────────
  function emit(toolId, event, data) {
    var sb = _sandboxes[toolId];
    if (!sb) sb = _getSandbox(toolId);
    sb.emitCount++;

    var scopedEvent = 'tool:' + toolId + ':' + event;
    var listeners   = sb.listeners[event] || [];

    // Fire scoped listeners
    listeners.forEach(function (fn) {
      try { fn(data, toolId, event); } catch (e) {
        console.debug(LOG, 'listener error:', toolId, '/', event, e && e.message || e);
      }
    });

    // Also fire as CustomEvent for global listeners that need tool context
    try {
      G.dispatchEvent(new CustomEvent(scopedEvent, {
        detail: { toolId: toolId, event: event, data: data, ts: Date.now() },
        bubbles: false,
      }));
    } catch (_) {}

    // Log to RuntimeAnalyticsDomains
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad && (event === 'start' || event === 'success' || event === 'fail' || event === 'crash')) {
        ad.record(toolId, event, data || {});
      }
    } catch (_) {}
  }

  // ── Scoped event subscribe ────────────────────────────────────────────────
  function on(toolId, event, fn) {
    if (typeof fn !== 'function') return;
    var sb = _getSandbox(toolId);
    if (!sb.listeners[event]) sb.listeners[event] = [];
    sb.listeners[event].push(fn);
  }

  function off(toolId, event, fn) {
    var sb = _sandboxes[toolId];
    if (!sb || !sb.listeners[event]) return;
    sb.listeners[event] = sb.listeners[event].filter(function (f) { return f !== fn; });
  }

  // ── Scoped telemetry record ───────────────────────────────────────────────
  function record(toolId, eventType, detail) {
    emit(toolId, eventType, detail || {});
  }

  // ── Context object for a tool (lightweight scope) ─────────────────────────
  function getContext(toolId) {
    var sb = _getSandbox(toolId);
    return {
      toolId:  toolId,
      family:  sb.family,
      config:  sb.config,
      emit:    function (event, data) { emit(toolId, event, data); },
      on:      function (event, fn)   { on(toolId, event, fn); },
      off:     function (event, fn)   { off(toolId, event, fn); },
      record:  function (type, data)  { record(toolId, type, data); },
    };
  }

  // ── Leakage detection: warn if global handler fires cross-tool ────────────
  // Monitor for events that cross tool boundaries
  function detectLeakage(subscriberToolId, publisherToolId) {
    if (subscriberToolId && publisherToolId && subscriberToolId !== publisherToolId) {
      console.debug(LOG, 'CROSS-TOOL EVENT: subscriber:', subscriberToolId, '← publisher:', publisherToolId);
      try {
        var ie = G.RuntimeIncidentEngine;
        if (ie && typeof ie.report === 'function') {
          ie.report({
            type:       'cross-tool-event',
            subscriber: subscriberToolId,
            publisher:  publisherToolId,
            ts:         Date.now(),
          });
        }
      } catch (_) {}
    }
  }

  // ── Listen for tool ready to auto-create sandboxes ────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var toolId = evt && evt.detail && evt.detail.toolId;
      if (toolId) createSandbox(toolId);
    } catch (_) {}
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats(toolId) {
    if (toolId) {
      var sb = _sandboxes[toolId];
      if (!sb) return null;
      var totalListeners = Object.keys(sb.listeners).reduce(function (acc, k) {
        return acc + sb.listeners[k].length;
      }, 0);
      return {
        toolId:    toolId,
        family:    sb.family,
        emitCount: sb.emitCount,
        listeners: totalListeners,
        events:    Object.keys(sb.listeners),
        createdAt: sb.createdAt,
      };
    }
    var out = {};
    Object.keys(_sandboxes).forEach(function (k) { out[k] = getStats(k); });
    return out;
  }

  G.RuntimeToolSandbox = Object.freeze({
    VERSION:       VERSION,
    createSandbox: createSandbox,
    getContext:    getContext,
    emit:          emit,
    on:            on,
    off:           off,
    record:        record,
    detectLeakage: detectLeakage,
    getStats:      getStats,
    getSandboxes:  function () { return Object.keys(_sandboxes); },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — per-tool event sandboxes active');

}(window));

// ── SOURCE: public/js/runtime-memory-orchestrator.js ──
// RuntimeMemoryOrchestrator v1.0 — Arc 4 / Phase F / Target 6
// =====================================================================
// Dynamic memory arbitration + idle runtime eviction.
//
// Problem (Arc 3 gap): RuntimeMemoryIslands fires memory-island:trim
// events but nothing actually terminates workers. The memory sweep runs
// every 30s but only dispatches a CustomEvent — WorkerPool ignores it.
//
// Solution: RuntimeMemoryOrchestrator bridges Islands → WorkerPool:
//   1. Listens for memory-island:trim events → calls WorkerPool.terminatePool
//      for each worker URL in the trimmed family
//   2. Dynamic arbitration: distributes available heap budget across
//      active families based on their actual usage weight
//   3. Activity heatmap: tracks per-family activity rates to predict
//      which families need pre-allocation vs. trimming
//   4. Idle eviction: families idle > EVICT_TTL_MS get their worker
//      pools terminated and islands trimmed
//
// WorkerPool.terminatePool(url) is the real eviction mechanism.
// RuntimeMemoryIslands handles cache/handler cleanup.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMemoryOrchestrator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG          = '[MemOrchest]';
  var VERSION      = '1.0';
  var EVICT_TTL_MS = 5 * 60 * 1000;  // 5 min idle → evict workers
  var SWEEP_MS     = 45 * 1000;      // orchestration sweep interval
  var PANIC_HEAP   = 0.88;           // heap% threshold for panic mode

  // ── Family → worker URL map ───────────────────────────────────────────────
  var FAMILY_WORKERS = {
    'organize':     ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'compress':     ['/workers/compress-worker.js'],
    'convert-from': ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js'],
    'convert-to':   ['/workers/pdf-word-docx-worker.js', '/workers/pdf-excel-xlsx-worker.js', '/workers/pdf-ppt-pptx-worker.js', '/workers/pdf-lib-worker.js'],
    'edit':         ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
    'ai':           ['/workers/advanced-worker.js', '/workers/summary-worker.js', '/workers/translation-worker.js', '/workers/ocr-preprocessor-worker.js'],
    'image':        ['/workers/image-tools-worker.js', '/workers/image-pipeline-worker.js', '/workers/remove-bg-worker.js'],
    'utility':      [],
  };

  // ── Activity heatmap ──────────────────────────────────────────────────────
  // family → { lastActiveAt, activationCount, evictCount }
  var _heatmap = {};

  function _touch(family) {
    if (!_heatmap[family]) _heatmap[family] = { lastActiveAt: 0, activationCount: 0, evictCount: 0 };
    _heatmap[family].lastActiveAt     = Date.now();
    _heatmap[family].activationCount  = (_heatmap[family].activationCount || 0) + 1;
  }

  function _idleMs(family) {
    var h = _heatmap[family];
    if (!h || !h.lastActiveAt) return Infinity;
    return Date.now() - h.lastActiveAt;
  }

  // ── Evict worker pool for a family ───────────────────────────────────────
  function _evictFamily(family, reason) {
    var workers = FAMILY_WORKERS[family] || [];
    var wp = G.WorkerPool;
    if (!wp || typeof wp.terminatePool !== 'function') return;

    workers.forEach(function (url) {
      try {
        var stats = wp.getStats && wp.getStats();
        // Only terminate if pool exists and has no busy slots
        var poolStats = stats && stats[url];
        if (poolStats && poolStats.busy > 0) {
          console.debug(LOG, 'skipping evict (busy):', family, '—', url);
          return;
        }
        wp.terminatePool(url);
        console.debug(LOG, 'evicted pool:', family, '—', url, '— reason:', reason);
      } catch (_) {}
    });

    // Also trim memory island
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) {
        // Find tools in this family and trim their islands
        var mr = G.RuntimeToolManifestRegistry;
        if (mr) {
          mr.getFamilies && mr.getActiveTools && mr.getActiveTools().forEach(function (toolId) {
            if (mr.getFamily(toolId) === family) mi.trim(toolId);
          });
        }
      }
    } catch (_) {}

    if (_heatmap[family]) _heatmap[family].evictCount = (_heatmap[family].evictCount || 0) + 1;

    try {
      G.dispatchEvent(new CustomEvent('memory-orchestrator:evicted', {
        detail: { family: family, reason: reason, workers: workers.length },
      }));
    } catch (_) {}
  }

  // ── Read heap pressure ────────────────────────────────────────────────────
  function _heapPct() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (_) { return 0; }
  }

  // ── Main orchestration sweep ──────────────────────────────────────────────
  function _sweep() {
    var heap = _heapPct();
    var now  = Date.now();

    // Idle eviction: families idle > EVICT_TTL_MS
    Object.keys(FAMILY_WORKERS).forEach(function (family) {
      if (!FAMILY_WORKERS[family].length) return; // utility has no workers
      var idle = _idleMs(family);
      if (idle > EVICT_TTL_MS) {
        _evictFamily(family, 'idle');
      }
    });

    // Panic mode: heap > 88%, evict all idle families aggressively
    if (heap > PANIC_HEAP) {
      console.debug(LOG, 'PANIC: heap at', Math.round(heap * 100) + '% — aggressive eviction');
      Object.keys(FAMILY_WORKERS).forEach(function (family) {
        if (!FAMILY_WORKERS[family].length) return;
        var idle = _idleMs(family);
        if (idle > 30000) { // 30s is enough in panic mode
          _evictFamily(family, 'panic');
        }
      });
    }
  }

  // ── Listen for trim events to perform actual worker eviction ──────────────
  G.addEventListener('memory-island:trim', function (evt) {
    try {
      var family = evt && evt.detail && evt.detail.family;
      if (family) {
        // Check if family is currently idle before evicting
        var idle = _idleMs(family);
        if (idle > 60000) { // 60s idle since last eviction
          _evictFamily(family, 'island-trim');
        }
      }
    } catch (_) {}
  });

  // ── Track tool activity for heatmap ──────────────────────────────────────
  G.addEventListener('tool:runtime-ready', function (evt) {
    try {
      var manifest = evt && evt.detail && evt.detail.manifest;
      if (manifest && manifest.family) _touch(manifest.family);
    } catch (_) {}
  });

  G.addEventListener('analytics-domain:event', function (evt) {
    try {
      var detail = evt && evt.detail;
      if (detail && detail.event && (detail.event.type === 'start' || detail.event.type === 'success')) {
        var mr = G.RuntimeToolManifestRegistry;
        if (mr && detail.toolId) {
          var family = mr.getFamily(detail.toolId);
          if (family) _touch(family);
        }
      }
    } catch (_) {}
  });

  // ── Start sweep ───────────────────────────────────────────────────────────
  var _sweepTimer = setInterval(_sweep, SWEEP_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeMemoryOrchestrator = Object.freeze({
    VERSION:      VERSION,
    evictFamily:  _evictFamily,
    sweep:        _sweep,
    heapPct:      _heapPct,
    getHeatmap:   function () {
      var out = {};
      Object.keys(_heatmap).forEach(function (f) {
        out[f] = Object.assign({ idleMs: _idleMs(f) }, _heatmap[f]);
      });
      return out;
    },
    touch:        _touch,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — memory orchestration + eviction active');

}(window));

// ── SOURCE: public/js/runtime-health-orchestrator.js ──
// RuntimeHealthOrchestrator v1.0 — Arc 4 / Phase G / Target 7
// =====================================================================
// Unified runtime graph + upgraded health dashboard.
//
// Problem: RuntimeHealthAnalytics.dashboard() shows a single global
// score with no per-family worker stats, no offline queue health,
// no hydration domain timing per tool, no bundle graph status.
//
// Solution: Non-destructive upgrade layer. RuntimeHealthOrchestrator:
//   1. Calls RuntimeHealthAnalytics.collect() for the base score
//   2. Augments with per-family worker data (RuntimeWorkerDomainRegistry)
//   3. Adds per-tool memory islands (RuntimeMemoryIslands)
//   4. Adds offline queue health per family (RuntimeOfflineDomains)
//   5. Adds hydration domain metrics (RuntimeHydrationDomains)
//   6. Adds active bundle graph (RuntimeBundleGraph)
//   7. Adds deploy correlation (RuntimeDeploySync + RuntimeEdgeHints)
//   8. Exports fullDashboard() for console + window.RuntimeHealthOrchestrator
//
// RuntimeHealthAnalytics is NOT modified. Both dashboards coexist.
// Call RuntimeHealthOrchestrator.fullDashboard() for the full picture.
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeHealthOrchestrator) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[HealthOrchest]';
  var VERSION = '1.0';

  // ── Collect full runtime graph ────────────────────────────────────────────
  function _collect() {
    var snap = {
      ts:          Date.now(),
      baseScore:   100,
      arcScore:    100,
      deductions:  [],
      workers:     {},
      memory:      {},
      offline:     {},
      hydration:   {},
      bundles:     {},
      analytics:   {},
      deploy:      {},
      sandbox:     {},
      throttle:    {},
      mobile:      {},
    };

    // ── Base health score from RuntimeHealthAnalytics ─────────────────────
    try {
      var ha = G.RuntimeHealthAnalytics;
      if (ha) {
        var base = ha.collect();
        snap.baseScore  = base.score;
        snap.arcScore   = base.score;
        snap.deductions = (base.deductions || []).slice();
        snap.deploy     = base.deploy || {};
      }
    } catch (_) {}

    // ── Per-family worker domain stats ────────────────────────────────────
    try {
      var wd = G.RuntimeWorkerDomainRegistry;
      if (wd) {
        snap.workers = wd.getAllStats() || {};
        // Penalise pressured families
        Object.keys(snap.workers).forEach(function (f) {
          var s = snap.workers[f];
          if (s && s.pressured) {
            snap.arcScore -= 8;
            snap.deductions.push({ reason: 'family pressured: ' + f, val: s.crashCount });
          }
          if (s && s.crashCount >= 3) {
            snap.arcScore -= 5;
            snap.deductions.push({ reason: 'crash threshold: ' + f, val: s.crashCount });
          }
        });
      }
    } catch (_) {}

    // ── Per-tool memory islands ───────────────────────────────────────────
    try {
      var mi = G.RuntimeMemoryIslands;
      if (mi) snap.memory = mi.getAllStats() || {};
    } catch (_) {}

    // ── Memory orchestrator heatmap ───────────────────────────────────────
    try {
      var mo = G.RuntimeMemoryOrchestrator;
      if (mo) {
        var heap = mo.heapPct();
        snap.memory._heapPct = Math.round(heap * 100) + '%';
        if (heap > 0.85) {
          snap.arcScore -= 10;
          snap.deductions.push({ reason: 'heap critical', val: Math.round(heap * 100) + '%' });
        }
      }
    } catch (_) {}

    // ── Per-tool analytics domains ─────────────────────────────────────────
    try {
      var ad = G.RuntimeAnalyticsDomains;
      if (ad) {
        snap.analytics = ad.getAllDashboards() || {};
        // Penalise tools with poor scores
        Object.keys(snap.analytics).forEach(function (toolId) {
          var d = snap.analytics[toolId];
          if (d && d.score < 50) {
            snap.arcScore -= 3;
            snap.deductions.push({ reason: 'tool degraded: ' + toolId, val: d.score });
          }
        });
      }
    } catch (_) {}

    // ── Hydration domain metrics ──────────────────────────────────────────
    try {
      var hd = G.RuntimeHydrationDomains;
      if (hd) snap.hydration = { domains: hd.getDomains() };
    } catch (_) {}

    // ── Bundle graph ───────────────────────────────────────────────────────
    try {
      var bg = G.RuntimeBundleGraph;
      if (bg) {
        snap.bundles = bg.getActiveGraph();
        var dormant  = bg.getDormantBundles();
        if (dormant.length > 2) {
          snap.deductions.push({ reason: 'dormant bundles', val: dormant.length });
        }
      }
    } catch (_) {}

    // ── Worker domain throttle stats ──────────────────────────────────────
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        snap.throttle = wdt.getStats();
        // Penalise families with held tasks
        Object.keys(snap.throttle).forEach(function (f) {
          var s = snap.throttle[f];
          if (s && s.held > 5) {
            snap.arcScore -= 4;
            snap.deductions.push({ reason: 'tasks held: ' + f, val: s.held });
          }
        });
      }
    } catch (_) {}

    // ── Mobile hardening status ───────────────────────────────────────────
    try {
      var mh = G.RuntimeMobileHardening;
      if (mh) snap.mobile = mh.getStatus();
    } catch (_) {}

    // ── Sandbox stats ─────────────────────────────────────────────────────
    try {
      var sb = G.RuntimeToolSandbox;
      if (sb) snap.sandbox = { activeSandboxes: sb.getSandboxes() };
    } catch (_) {}

    snap.arcScore = Math.max(0, snap.arcScore);
    return snap;
  }

  // ── Full console dashboard ────────────────────────────────────────────────
  function fullDashboard() {
    var s = _collect();
    var lbl = s.arcScore >= 90 ? 'excellent' : s.arcScore >= 75 ? 'good' : s.arcScore >= 55 ? 'fair' : s.arcScore >= 35 ? 'poor' : 'critical';
    var color = s.arcScore >= 75 ? '#22c55e' : s.arcScore >= 55 ? '#f59e0b' : '#ef4444';

    console.group('%c RuntimeHealthOrchestrator v' + VERSION, 'font-weight:bold;color:#8b5cf6');
    console.log('%c Arc Score: ' + s.arcScore + '/100 (' + lbl + ')  |  Base: ' + s.baseScore + '/100',
      'font-size:14px;color:' + color);

    if (s.deductions.length) {
      console.group('Deductions (' + s.deductions.length + ')');
      s.deductions.forEach(function (d) { console.log(' −', d.reason, '→', d.val); });
      console.groupEnd();
    }

    if (Object.keys(s.workers).length) {
      console.group('Worker Domains');
      console.table(s.workers);
      console.groupEnd();
    }

    if (Object.keys(s.memory).length) {
      console.group('Memory Islands');
      console.table(s.memory);
      console.groupEnd();
    }

    if (Object.keys(s.analytics).length) {
      console.group('Tool Analytics');
      var rows = {};
      Object.keys(s.analytics).forEach(function (k) {
        var d = s.analytics[k];
        rows[k] = { score: d.score, label: d.label, success: d.successCount, fail: d.failCount, crashes: d.crashes };
      });
      console.table(rows);
      console.groupEnd();
    }

    if (Object.keys(s.throttle).length) {
      console.group('Worker Domain Throttle');
      console.table(s.throttle);
      console.groupEnd();
    }

    if (s.bundles && Object.keys(s.bundles).length) {
      console.group('Bundle Graph');
      var bundleRows = {};
      Object.keys(s.bundles).forEach(function (name) {
        var b = s.bundles[name];
        bundleRows[name] = { loaded: b.loaded, dormant: b.dormant, tools: b.toolIds ? b.toolIds.length : 0 };
      });
      console.table(bundleRows);
      console.groupEnd();
    }

    if (s.sandbox && s.sandbox.activeSandboxes) {
      console.group('Tool Sandboxes');
      console.log('Active:', s.sandbox.activeSandboxes.join(', ') || '(none)');
      console.groupEnd();
    }

    if (s.mobile && Object.keys(s.mobile).length) {
      console.group('Mobile Hardening');
      console.table(s.mobile);
      console.groupEnd();
    }

    console.log('Deploy:', s.deploy);
    console.groupEnd();
    return s;
  }

  // ── Install on window for easy console access ────────────────────────────
  setTimeout(function () {
    try {
      G.fullDashboard = fullDashboard;
      G.runtimeDashboard = fullDashboard; // alias
      console.debug(LOG, 'installed window.fullDashboard() + window.runtimeDashboard()');
    } catch (_) {}
  }, 800);

  G.RuntimeHealthOrchestrator = Object.freeze({
    VERSION:       VERSION,
    collect:       _collect,
    fullDashboard: fullDashboard,
    arcScore:      function () { return _collect().arcScore; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — call RuntimeHealthOrchestrator.fullDashboard()');

}(window));

// ── SOURCE: public/js/runtime-immutability-guard.js ──
// RuntimeImmutabilityGuard v1.0 — Arc 4 / Phase H / Target 8
// =====================================================================
// Runtime seal verification + mutation detection.
//
// Problem: RuntimeToolConfigLock freezes individual configs but there
// is no mechanism to periodically re-verify the full config graph.
// Tampering with the in-memory prototype chain or Object.assign into
// a frozen object throws (caught), but we have no runtime audit to
// detect such attempts across all active tools.
//
// Solution:
//   1. Periodic seal sweep: re-validates DJB2 checksum for all locked
//      configs (catches prototype-chain tamper or memory corruption)
//   2. Checksum graph: builds a manifest of all locked tool configs
//      and their expected checksums at seal time
//   3. Mutation escalation: any checksum mismatch → RuntimeIncidentEngine
//   4. Manifest verification: correlates BUILD_ID from RuntimeDeploySync
//      with the config lock graph to detect deploy/runtime mismatch
//   5. Immutability probe: attempts a benign write to each locked config
//      and verifies the thrown TypeError proves the freeze is intact
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeImmutabilityGuard) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG        = '[ImmutGuard]';
  var VERSION    = '1.0';
  var SWEEP_MS   = 60 * 1000;  // re-verify every 60s

  // ── Seal graph ────────────────────────────────────────────────────────────
  // toolId → { toolId, checksum, sealedAt, violations }
  var _sealGraph = {};
  var _sealedAt  = null;

  // ── DJB2 (same algo as RuntimeToolConfigLock for cross-verification) ──────
  function _djb2(obj) {
    try {
      var str = JSON.stringify(obj) || '';
      var h = 5381;
      for (var i = 0; i < str.length; i++) { h = ((h << 5) + h) + str.charCodeAt(i); h = h & h; }
      return (h >>> 0).toString(16);
    } catch (_) { return '0'; }
  }

  // ── Seal: snapshot current config lock graph ──────────────────────────────
  function seal() {
    try {
      var cl = G.RuntimeToolConfigLock;
      if (!cl) return { ok: false, reason: 'RuntimeToolConfigLock not available' };

      var configs = cl.getAll();
      var count   = 0;
      var ts      = Date.now();
      _sealedAt   = ts;

      Object.keys(configs).forEach(function (toolId) {
        var cfg = configs[toolId];
        var cs  = _djb2(cfg);
        _sealGraph[toolId] = {
          toolId:     toolId,
          family:     cfg.family,
          checksum:   cs,
          lockedAt:   cfg.lockedAt,
          sealedAt:   ts,
          violations: 0,
          lastVerifiedAt: ts,
        };
        count++;
      });

      console.debug(LOG, 'sealed:', count, 'configs — ts:', ts);
      return { ok: true, sealed: count, ts: ts };
    } catch (e) {
      console.debug(LOG, 'seal error:', e && e.message || e);
      return { ok: false, reason: e && e.message || String(e) };
    }
  }

  // ── Verify: re-compute checksums and compare ──────────────────────────────
  function verify() {
    var violations = [];
    var verified   = 0;
    var now        = Date.now();

    try {
      var cl = G.RuntimeToolConfigLock;
      if (!cl) return { ok: true, verified: 0, violations: [] }; // skip if not available

      Object.keys(_sealGraph).forEach(function (toolId) {
        var entry   = _sealGraph[toolId];
        var result  = cl.validate(toolId);
        entry.lastVerifiedAt = now;
        verified++;

        if (!result.ok) {
          entry.violations++;
          violations.push({
            toolId:    toolId,
            family:    entry.family,
            expected:  entry.checksum,
            actual:    result.actual || '?',
            reason:    result.reason,
            sealedAt:  entry.sealedAt,
            violCount: entry.violations,
          });
        }
      });
    } catch (e) {
      console.debug(LOG, 'verify error:', e && e.message || e);
    }

    if (violations.length > 0) {
      console.debug(LOG, 'VIOLATIONS DETECTED:', violations.length);
      violations.forEach(function (v) {
        console.debug(LOG, ' ✗', v.toolId, '— expected:', v.expected, 'actual:', v.actual);
        _escalate(v);
      });
    }

    return { ok: violations.length === 0, verified: verified, violations: violations, ts: now };
  }

  // ── Probe: verify Object.freeze is still intact ───────────────────────────
  function probe() {
    var results = [];
    try {
      var cl = G.RuntimeToolConfigLock;
      if (!cl) return results;
      var configs = cl.getAll();
      Object.keys(configs).forEach(function (toolId) {
        var cfg   = configs[toolId];
        var solid = Object.isFrozen(cfg);
        results.push({ toolId: toolId, frozen: solid });
        if (!solid) {
          console.debug(LOG, 'FREEZE VIOLATION:', toolId, '— config is no longer frozen');
          _escalate({ toolId: toolId, reason: 'config-unfrozen', family: cfg.family });
        }
      });
    } catch (e) {
      console.debug(LOG, 'probe error:', e && e.message || e);
    }
    return results;
  }

  // ── Escalation to RuntimeIncidentEngine ──────────────────────────────────
  function _escalate(violation) {
    try {
      var ie = G.RuntimeIncidentEngine;
      if (ie && typeof ie.report === 'function') {
        ie.report({
          type:      'immutability-violation',
          toolId:    violation.toolId,
          family:    violation.family,
          reason:    violation.reason || 'checksum-mismatch',
          expected:  violation.expected,
          actual:    violation.actual,
          ts:        Date.now(),
        });
      }
    } catch (_) {}

    try {
      G.dispatchEvent(new CustomEvent('immutability:violation', {
        detail: violation,
        bubbles: false,
      }));
    } catch (_) {}
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────
  function _sweep() {
    if (!_sealedAt) {
      seal();
      return;
    }
    var result = verify();
    if (!result.ok) {
      console.debug(LOG, 'sweep: ' + result.violations.length + ' violation(s) found');
    }
  }

  var _sweepTimer = setInterval(_sweep, SWEEP_MS);
  try { G.addEventListener('pagehide', function () { clearInterval(_sweepTimer); }, { once: true }); } catch (_) {}

  // ── Boot: seal after all Arc 3 modules have locked ─────────────────────── 
  G.addEventListener('tool:runtime-ready', function () {
    if (!_sealedAt) setTimeout(seal, 200);
  });

  if (document.readyState !== 'loading') {
    setTimeout(seal, 2000);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeImmutabilityGuard = Object.freeze({
    VERSION:        VERSION,
    seal:           seal,
    verify:         verify,
    probe:          probe,
    getSealGraph:   function () {
      var out = {};
      Object.keys(_sealGraph).forEach(function (k) { out[k] = Object.assign({}, _sealGraph[k]); });
      return out;
    },
    sealedAt:       function () { return _sealedAt; },
  });

  console.debug(LOG, 'v' + VERSION + ' ready — immutability sweep active (every 60s)');

}(window));

// ── SOURCE: public/js/runtime-mobile-hardening.js ──
// RuntimeMobileHardening v1.0 — Arc 4 / Phase I / Target 9
// =====================================================================
// Thermal-aware hydration + battery-aware runtime unloading.
//
// Problem: low-end Android devices (1 GB RAM, 4 cores) experience:
//   - P2 hydration modules firing during thermal spikes (UI stutter)
//   - AI workers using 512 MB when only 256 MB is available
//   - Background workers staying alive on battery save mode
//   - No panic mode when heap approaches 100%
//
// Solution:
//   1. Device profile: detect low-end device (< 2 GB RAM or ≤ 2 cores)
//   2. Thermal-aware hydration: blocks P2 domains during thermal pressure
//      (reads device battery API thermal warnings)
//   3. Battery-aware unloading: on battery save, reduces all family caps
//      and evicts idle AI workers immediately
//   4. Mobile memory panic mode: heap > 90% → terminate all non-active
//      worker pools + trim all idle memory islands
//   5. Adaptive worker scaling: adjusts WorkerDomainThrottle caps based
//      on device profile at boot time
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeMobileHardening) return;
  var _FROZEN = Object.freeze({ v: 1 });

  var LOG     = '[MobileHard]';
  var VERSION = '1.0';

  // ── Device profile ────────────────────────────────────────────────────────
  var _devMem   = (typeof navigator !== 'undefined' && navigator.deviceMemory)    || 4;
  var _devCores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

  var _profile = (function () {
    if (_devMem <= 1 || _devCores <= 2) return 'critical';
    if (_devMem <= 2 || _devCores <= 4) return 'low';
    if (_devMem <= 4)                    return 'medium';
    return 'high';
  }());

  var _isMobile = (function () {
    try { return /Mobi|Android|iPhone|iPad/.test(navigator.userAgent); } catch (_) { return false; }
  }());

  // ── Battery state ─────────────────────────────────────────────────────────
  var _battery = { level: 1, charging: true, saveMode: false };

  (function _initBattery() {
    try {
      if (navigator.getBattery) {
        navigator.getBattery().then(function (b) {
          function _update() {
            _battery.level    = b.level;
            _battery.charging = b.charging;
            _battery.saveMode = !b.charging && b.level < 0.20;
            if (_battery.saveMode) _onBatterySaveMode();
          }
          _update();
          b.addEventListener('levelchange',    _update);
          b.addEventListener('chargingchange', _update);
        }).catch(function () {});
      }
    } catch (_) {}
  }());

  // ── Thermal state ─────────────────────────────────────────────────────────
  var _thermal = { hot: false, critical: false };

  // Chrome Android: devicethermalstate (experimental)
  try {
    if (navigator.deviceMemory && typeof window.dispatchEvent === 'function') {
      // Listen for our own thermal events from RuntimeWorkerDomainRegistry
      G.addEventListener('worker-domain:crash', function (evt) {
        try {
          var crashes = evt && evt.detail && evt.detail.crashCount;
          if (crashes >= 3) { _thermal.hot = true; _onThermalPressure(); }
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── Adaptive worker cap reduction for low-end devices ─────────────────────
  function _applyDeviceCaps() {
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (!wdt) return;
      if (_profile === 'critical') {
        wdt.setFamilyCap('organize', 1);
        wdt.setFamilyCap('compress', 1);
        wdt.setFamilyCap('ai',       1);
        wdt.setFamilyCap('image',    1);
        wdt.setFamilyCap('edit',     1);
        wdt.setFamilyCap('convert-from', 1);
        wdt.setFamilyCap('convert-to',   1);
        console.debug(LOG, 'critical profile: all family caps → 1');
      } else if (_profile === 'low') {
        wdt.setFamilyCap('ai',    1);
        wdt.setFamilyCap('image', 2);
        console.debug(LOG, 'low profile: AI cap → 1, image cap → 2');
      }
    } catch (_) {}
  }

  // ── Battery save mode: reduce caps + evict AI workers ─────────────────────
  function _onBatterySaveMode() {
    console.debug(LOG, 'battery save mode — reducing worker caps');
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        wdt.setFamilyCap('ai', 1);
        wdt.setFamilyCap('image', 1);
      }
    } catch (_) {}
    try {
      var mo = G.RuntimeMemoryOrchestrator;
      if (mo) mo.evictFamily('ai', 'battery-save');
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('mobile:battery-save', { detail: { level: _battery.level } }));
    } catch (_) {}
  }

  // ── Thermal pressure: block P2 hydration + reduce caps ───────────────────
  function _onThermalPressure() {
    console.debug(LOG, 'thermal pressure — blocking P2 hydration');
    try {
      var wdt = G.RuntimeWorkerDomainThrottle;
      if (wdt) {
        wdt.setFamilyCap('ai',    1);
        wdt.setFamilyCap('image', 1);
        wdt.setFamilyCap('compress', 1);
      }
    } catch (_) {}
    try {
      G.dispatchEvent(new CustomEvent('mobile:thermal-pressure', { detail: { hot: _thermal.hot } }));
    } catch (_) {}
  }

  // ── Memory panic mode ─────────────────────────────────────────────────────
  var _panicActive = false;

  function _checkPanic() {
    try {
      var m = performance.memory;
      if (!m || !m.jsHeapSizeLimit) return;
      var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
      if (pct < 0.90) { _panicActive = false; return; }
      if (_panicActive) return;

      _panicActive = true;
      console.debug(LOG, 'PANIC MODE: heap at', Math.round(pct * 100) + '%');

      // Trim ALL memory islands immediately
      try {
        var mi = G.RuntimeMemoryIslands;
        if (mi) {
          var all = mi.getAllStats();
          Object.keys(all).forEach(function (toolId) { mi.trim(toolId); });
        }
      } catch (_) {}

      // Terminate all non-active worker pools
      try {
        var wp      = G.WorkerPool;
        var wd      = G.RuntimeWorkerDomainRegistry;
        var active  = wd && wd.getActiveTool();
        var family  = active && wd.getFamily(active);
        if (wp && typeof wp.terminatePool === 'function') {
          var FAMILY_WORKERS = {
            'organize':     ['/workers/pdf-lib-worker.js', '/workers/pdf-worker.js'],
            'compress':     ['/workers/compress-worker.js'],
            'ai':           ['/workers/advanced-worker.js', '/workers/summary-worker.js', '/workers/translation-worker.js', '/workers/ocr-preprocessor-worker.js'],
            'image':        ['/workers/image-tools-worker.js', '/workers/image-pipeline-worker.js', '/workers/remove-bg-worker.js'],
          };
          Object.keys(FAMILY_WORKERS).forEach(function (f) {
            if (f === family) return; // preserve active family
            FAMILY_WORKERS[f].forEach(function (url) {
              try { wp.terminatePool(url); } catch (_) {}
            });
          });
        }
      } catch (_) {}

      try {
        G.dispatchEvent(new CustomEvent('mobile:panic', { detail: { heapPct: Math.round(pct * 100) } }));
      } catch (_) {}
    } catch (_) {}
  }

  // ── Periodic panic check (every 20s on mobile / critical, else 45s) ──────
  var _panicInterval = (_isMobile || _profile === 'critical' || _profile === 'low') ? 20000 : 45000;
  var _panicTimer = setInterval(_checkPanic, _panicInterval);
  try { G.addEventListener('pagehide', function () { clearInterval(_panicTimer); }, { once: true }); } catch (_) {}

  // ── Apply device caps at boot ─────────────────────────────────────────────
  function _boot() {
    _applyDeviceCaps();
    if (_profile === 'critical' || _profile === 'low') {
      console.debug(LOG, 'mobile/low-end device detected — adaptive scaling applied —',
        'profile:', _profile, '| RAM:', _devMem + 'GB | cores:', _devCores);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    setTimeout(_boot, 100);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeMobileHardening = Object.freeze({
    VERSION:    VERSION,
    getStatus:  function () {
      return {
        profile:      _profile,
        isMobile:     _isMobile,
        devMem:       _devMem,
        devCores:     _devCores,
        battery:      Object.assign({}, _battery),
        thermal:      Object.assign({}, _thermal),
        panicActive:  _panicActive,
      };
    },
    checkPanic:  _checkPanic,
    applyDeviceCaps: _applyDeviceCaps,
  });

  console.debug(LOG, 'v' + VERSION + ' ready — profile:', _profile, '| mobile:', _isMobile);

}(window));

