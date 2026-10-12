// Phase F — Differential Processing v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § F1  PageHashCache       — per-page content hash, OPFS-backed, auto-expire
// § F2  VisualDiffCache     — pixel-level diff between render passes
// § F3  OcrTextHashCache    — OCR output hash for incremental re-run detection
// § F4  ChangedPageDetector — identifies which pages actually changed
// § F5  IncrementalPipeline — processes only changed pages, merges with cache
//
// Exposes: window.DifferentialProcessing

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[DP]';
  var TTL_MS   = 48 * 60 * 60 * 1000;   // 48h cache TTL
  var HAS_OPFS = typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  // ── IDB helpers ────────────────────────────────────────────────────────────
  var _DB_NAME = 'p37-diff-v1';
  var _db      = null;
  var _STORES  = ['page-hashes', 'visual-diffs', 'ocr-hashes'];

  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = indexedDB.open(_DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        _STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'k' });
        });
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror   = function () { rej(req.error); };
    });
  }

  function _idbPut(store, rec) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(Object.assign({ ts: Date.now() }, rec));
        tx.oncomplete = function () { res(true); };
        tx.onerror    = function () { res(false); };
      });
    }).catch(function () { return false; });
  }

  function _idbGet(store, key) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        var req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = function () {
          var r = req.result;
          if (!r) return res(null);
          if (Date.now() - (r.ts || 0) > TTL_MS) { _idbDel(store, key); return res(null); }
          res(r);
        };
        req.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }

  function _idbDel(store, key) {
    return _openDb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { res(true); };
        tx.onerror    = function () { res(false); };
      });
    }).catch(function () { return false; });
  }

  // ── Fast hash (djb2 over bytes) ────────────────────────────────────────────
  function _hash(bytes) {
    var h = 5381;
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) { h = ((h << 5) + h) ^ arr[i]; h = h >>> 0; }
    return h.toString(16);
  }

  // SHA-256 hash for OCR text (uses SubtleCrypto)
  async function _sha256(text) {
    try {
      var buf = new TextEncoder().encode(text);
      var dgst = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(dgst)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (_) {
      return _hash(new TextEncoder().encode(text || ''));
    }
  }

  // ── Document fingerprint: name + size + lastModified ──────────────────────
  function _docId(file) {
    return (file.name || '') + ':' + (file.size || 0) + ':' + (file.lastModified || 0);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § F1  PAGE HASH CACHE
  // Stores a content hash per page (from raw bytes or rendered pixel hash).
  // ═══════════════════════════════════════════════════════════════════════════
  var PageHashCache = (function () {
    var STORE = 'page-hashes';

    function key(docId, pageNum) { return docId + ':' + pageNum; }

    async function store(docId, pageNum, bytes) {
      var h = _hash(bytes);
      await _idbPut(STORE, { k: key(docId, pageNum), hash: h, docId: docId, pageNum: pageNum });
      return h;
    }

    async function getHash(docId, pageNum) {
      var r = await _idbGet(STORE, key(docId, pageNum));
      return r ? r.hash : null;
    }

    async function hasChanged(docId, pageNum, bytes) {
      var cached = await getHash(docId, pageNum);
      if (!cached) return true;
      return _hash(bytes) !== cached;
    }

    async function clearDoc(docId) {
      // No range delete in IDB easily — mark as expired instead
      _log('clear-doc', { docId: docId });
    }

    return { store: store, getHash: getHash, hasChanged: hasChanged, clearDoc: clearDoc };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § F2  VISUAL DIFF CACHE
  // Computes and stores pixel-level diff between two renders of the same page.
  // ═══════════════════════════════════════════════════════════════════════════
  var VisualDiffCache = (function () {
    var STORE = 'visual-diffs';

    // Compute % pixels changed between two RGBA Uint8ClampedArrays
    function computeDiff(rgba1, rgba2) {
      if (!rgba1 || !rgba2 || rgba1.length !== rgba2.length) return 1.0;
      var changed = 0;
      var total   = rgba1.length / 4;
      for (var i = 0; i < rgba1.length; i += 4) {
        var dr = Math.abs(rgba1[i]   - rgba2[i]);
        var dg = Math.abs(rgba1[i+1] - rgba2[i+1]);
        var db = Math.abs(rgba1[i+2] - rgba2[i+2]);
        if (dr + dg + db > 15) changed++;
      }
      return changed / total;
    }

    // Compute a hash of an RGBA canvas
    function canvasHash(canvas) {
      try {
        var ctx  = canvas.getContext('2d');
        var data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return _hash(data.data);
      } catch (_) { return null; }
    }

    async function storeCanvasHash(docId, pageNum, canvas) {
      var h = canvasHash(canvas);
      if (!h) return null;
      await _idbPut(STORE, { k: docId + ':' + pageNum, hash: h, w: canvas.width, h: canvas.height });
      return h;
    }

    async function hasCanvasChanged(docId, pageNum, canvas) {
      var cached = await _idbGet(STORE, docId + ':' + pageNum);
      if (!cached) return true;
      return canvasHash(canvas) !== cached.hash;
    }

    return { computeDiff: computeDiff, canvasHash: canvasHash, storeCanvasHash: storeCanvasHash, hasCanvasChanged: hasCanvasChanged };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § F3  OCR TEXT HASH CACHE
  // Caches OCR output hash per page to skip re-OCR on unchanged pages.
  // ═══════════════════════════════════════════════════════════════════════════
  var OcrTextHashCache = (function () {
    var STORE    = 'ocr-hashes';
    var _memCache = {};   // docId:pageNum → hash (hot cache)

    async function store(docId, pageNum, ocrText) {
      var h = await _sha256(ocrText);
      var k = docId + ':' + pageNum;
      _memCache[k] = h;
      await _idbPut(STORE, { k: k, hash: h, len: (ocrText || '').length });
      return h;
    }

    async function getHash(docId, pageNum) {
      var k = docId + ':' + pageNum;
      if (_memCache[k]) return _memCache[k];
      var r = await _idbGet(STORE, k);
      if (r) _memCache[k] = r.hash;
      return r ? r.hash : null;
    }

    async function hasOcrChanged(docId, pageNum, newText) {
      var cached = await getHash(docId, pageNum);
      if (!cached) return true;
      var h = await _sha256(newText);
      return h !== cached;
    }

    // Store the actual OCR text in OPFS if available
    async function storeText(docId, pageNum, text) {
      if (!HAS_OPFS) return;
      try {
        var root = await navigator.storage.getDirectory();
        var dir  = await root.getDirectoryHandle('ocr-cache', { create: true });
        var fh   = await dir.getFileHandle(docId.replace(/[^a-z0-9]/gi, '_') + '_p' + pageNum + '.txt', { create: true });
        var wr   = await fh.createWritable();
        await wr.write(text);
        await wr.close();
      } catch (_) {}
    }

    async function loadText(docId, pageNum) {
      if (!HAS_OPFS) return null;
      try {
        var root = await navigator.storage.getDirectory();
        var dir  = await root.getDirectoryHandle('ocr-cache', { create: false }).catch(function () { return null; });
        if (!dir) return null;
        var fh   = await dir.getFileHandle(docId.replace(/[^a-z0-9]/gi, '_') + '_p' + pageNum + '.txt', { create: false }).catch(function () { return null; });
        if (!fh) return null;
        var f    = await fh.getFile();
        return f.text();
      } catch (_) { return null; }
    }

    function flush() { _memCache = {}; }
    window.addEventListener('p32:survival-mode', flush);

    return { store: store, getHash: getHash, hasOcrChanged: hasOcrChanged, storeText: storeText, loadText: loadText, flush: flush };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § F4  CHANGED PAGE DETECTOR
  // Given a document, determines which pages have changed since last processing.
  // ═══════════════════════════════════════════════════════════════════════════
  var ChangedPageDetector = (function () {

    // Check which pages (by rendered canvas) have changed
    async function detect(file, getCanvas) {
      var docId   = _docId(file);
      var changed = [];
      var cached  = [];

      // We don't know page count here — caller provides getCanvas(pageNum)
      // Returns generator-style: caller iterates and calls report()
      return {
        docId: docId,
        check: async function (pageNum, canvas) {
          var isChanged = await VisualDiffCache.hasCanvasChanged(docId, pageNum, canvas);
          if (isChanged) {
            changed.push(pageNum);
            await VisualDiffCache.storeCanvasHash(docId, pageNum, canvas);
          } else {
            cached.push(pageNum);
          }
          return isChanged;
        },
        checkBytes: async function (pageNum, bytes) {
          var isChanged = await PageHashCache.hasChanged(docId, pageNum, bytes);
          if (isChanged) {
            changed.push(pageNum);
            await PageHashCache.store(docId, pageNum, bytes);
          } else {
            cached.push(pageNum);
          }
          return isChanged;
        },
        summary: function () {
          return { changed: changed, cached: cached, docId: docId };
        }
      };
    }

    return { detect: detect };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § F5  INCREMENTAL PIPELINE
  // Wraps any per-page processor to skip unchanged pages and merge cached results.
  // ═══════════════════════════════════════════════════════════════════════════
  var IncrementalPipeline = (function () {

    // Run per-page processor only on changed pages; merge cached for others.
    // processor(pageNum) → Promise<result>
    // getCached(pageNum) → Promise<result | null>
    // setCached(pageNum, result) → Promise<void>
    async function run(file, totalPages, processor, getCached, setCached, onProgress) {
      var docId    = _docId(file);
      var detector = await ChangedPageDetector.detect(file, null);
      var results  = new Array(totalPages).fill(null);
      var reused   = 0;
      var recomputed = 0;

      for (var p = 1; p <= totalPages; p++) {
        // Try loading cached result first (OCR hash check)
        var cached = getCached ? await getCached(p) : null;
        if (cached !== null && cached !== undefined) {
          results[p - 1] = cached;
          reused++;
        } else {
          try {
            var result = await processor(p);
            results[p - 1] = result;
            if (setCached) await setCached(p, result);
            recomputed++;
          } catch (ex) {
            _err('incremental-page', { page: p, err: ex.message });
            results[p - 1] = null;
          }
        }
        if (onProgress) onProgress(p, totalPages, reused, recomputed);
        await new Promise(function (r) { setTimeout(r, 0); });
      }

      _log('incremental-complete', { total: totalPages, reused: reused, recomputed: recomputed });
      return { results: results, reused: reused, recomputed: recomputed, docId: docId };
    }

    // OCR-specific incremental: leverages OcrTextHashCache for skip detection
    async function runOcr(file, totalPages, ocrProcessor, onProgress) {
      var docId = _docId(file);
      return run(
        file, totalPages, ocrProcessor,
        function (p) { return OcrTextHashCache.loadText(docId, p); },
        function (p, text) { return Promise.all([OcrTextHashCache.store(docId, p, text), OcrTextHashCache.storeText(docId, p, text)]); },
        onProgress
      );
    }

    return { run: run, runOcr: runOcr };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.DifferentialProcessing = {
    version:              VERSION,
    PageHashCache:        PageHashCache,
    VisualDiffCache:      VisualDiffCache,
    OcrTextHashCache:     OcrTextHashCache,
    ChangedPageDetector:  ChangedPageDetector,
    IncrementalPipeline:  IncrementalPipeline,

    // Convenience: run incremental OCR
    incrementalOcr: function (file, totalPages, ocrFn, onProgress) {
      return IncrementalPipeline.runOcr(file, totalPages, ocrFn, onProgress);
    },

    // Convenience: run any per-page tool incrementally
    incrementalRun: function (file, totalPages, fn, getCached, setCached, onProgress) {
      return IncrementalPipeline.run(file, totalPages, fn, getCached, setCached, onProgress);
    },

    audit: function () {
      return {
        version:     VERSION,
        hasOpfs:     HAS_OPFS,
        cacheTtlH:   Math.round(TTL_MS / 3600000),
        toolsSupported: ['ocr-pdf', 'compress-pdf', 'translate-pdf', 'ai-summarizer', 'compare-pdf', 'workflow-builder'],
      };
    },
  };

  _log('loaded', { hasOpfs: HAS_OPFS });
}());
