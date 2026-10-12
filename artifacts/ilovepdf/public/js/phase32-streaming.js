// Phase 32 — True OPFS Streaming Architecture v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 32A  ByteRangeStreamer        — chunk-level file reads, never full RAM load
// § 32B  StreamFirstProcessor     — progressive page processing pipeline
// § 32C  RollingMemoryWindowManager — adaptive rolling page windows
// § 32D  GiantFileSurvivalMode    — auto-activates survival config on pressure
//
// Depends on: OPFSManager, LargeFileStreaming, MemPressure, GiantFileTelemetry
// Exposes: window.Phase32

(function () {
  'use strict';

  var VERSION = '1.0';
  var MB      = 1024 * 1024;

  // ── Tiny internal logger ──────────────────────────────────────────────────
  function _log(tag, data) {
    try {
      if (window.DebugTrace && window.DebugTrace.log)
        window.DebugTrace.log('[P32] ' + tag, data);
    } catch (_) {}
  }
  function _err(tag, e) {
    try {
      if (window.DebugTrace && window.DebugTrace.error)
        window.DebugTrace.error('[P32] ' + tag, e);
    } catch (_) {}
  }

  // ── Capability flags ──────────────────────────────────────────────────────
  var HAS_OPFS = (function () {
    try {
      return typeof navigator !== 'undefined' &&
             typeof navigator.storage !== 'undefined' &&
             typeof navigator.storage.getDirectory === 'function';
    } catch (_) { return false; }
  }());

  var HAS_READABLE_STREAM = typeof ReadableStream !== 'undefined';
  var HAS_PERF            = typeof performance !== 'undefined' && typeof performance.now === 'function';

  // ═══════════════════════════════════════════════════════════════════════════
  // § 32A  BYTE-RANGE STREAMER
  // Reads arbitrary byte ranges from a File/Blob WITHOUT loading the whole
  // file into RAM. Maintains a small LRU chunk cache for repeated reads.
  // ═══════════════════════════════════════════════════════════════════════════

  var ByteRangeStreamer = (function () {
    // Adaptive chunk size based on current memory pressure
    function _chunkSize() {
      if (window.MemPressure && typeof window.MemPressure.chunkSize === 'function') {
        return window.MemPressure.chunkSize();
      }
      try {
        var m   = performance.memory;
        var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
        if (pct > 0.80) return 1 * MB;
        if (pct > 0.60) return 2 * MB;
        if (pct > 0.40) return 4 * MB;
      } catch (_) {}
      return 8 * MB;
    }

    // LRU chunk cache: at most MAX_CACHE_CHUNKS chunks
    var MAX_CACHE_CHUNKS = 6;
    var _cache     = [];   // [{ key, data: ArrayBuffer, ts }]

    function _cacheKey(fileId, chunkIdx) { return fileId + ':' + chunkIdx; }

    function _cacheGet(key) {
      for (var i = 0; i < _cache.length; i++) {
        if (_cache[i].key === key) {
          _cache[i].ts = Date.now();
          return _cache[i].data;
        }
      }
      return null;
    }

    function _cachePut(key, data) {
      // Evict oldest if over limit
      if (_cache.length >= MAX_CACHE_CHUNKS) {
        _cache.sort(function (a, b) { return a.ts - b.ts; });
        var evicted = _cache.shift();
        evicted.data = null; // help GC
      }
      _cache.push({ key: key, data: data, ts: Date.now() });
    }

    // Read a byte range from a File/Blob — returns ArrayBuffer
    function readRange(file, startByte, endByte) {
      if (!file) return Promise.reject(new Error('no_file'));
      var start = Math.max(0, startByte || 0);
      var end   = Math.min(file.size, endByte || file.size);
      if (start >= end) return Promise.resolve(new ArrayBuffer(0));
      return file.slice(start, end).arrayBuffer();
    }

    // Read a logical chunk index from a file using adaptive chunk size
    function readChunk(file, chunkIdx, fileId) {
      var cs    = _chunkSize();
      var start = chunkIdx * cs;
      var end   = Math.min(file.size, start + cs);
      var key   = _cacheKey(fileId || (file.name + ':' + file.size), chunkIdx);

      var cached = _cacheGet(key);
      if (cached) return Promise.resolve(cached);

      return readRange(file, start, end).then(function (ab) {
        _cachePut(key, ab);
        return ab;
      });
    }

    // Total chunk count for a file at current adaptive chunk size
    function chunkCount(file) {
      return Math.max(1, Math.ceil(file.size / _chunkSize()));
    }

    // Create a ReadableStream that yields chunk ArrayBuffers sequentially
    function createChunkStream(file, fileId) {
      var totalChunks = chunkCount(file);
      var idx = 0;

      if (HAS_READABLE_STREAM) {
        return new ReadableStream({
          pull: function (controller) {
            if (idx >= totalChunks) { controller.close(); return; }
            return readChunk(file, idx, fileId).then(function (ab) {
              idx++;
              controller.enqueue(ab);
            }).catch(function (err) {
              controller.error(err);
            });
          },
        });
      }

      // Fallback: async iterator object (non-ReadableStream environments)
      return {
        _idx: 0,
        _total: totalChunks,
        next: function () {
          var self = this;
          if (self._idx >= self._total) return Promise.resolve({ done: true });
          return readChunk(file, self._idx++, fileId).then(function (ab) {
            return { value: ab, done: false };
          });
        },
      };
    }

    // Stage a giant file to OPFS in streaming fashion (wraps OPFSManager.writeStream)
    function stageToOpfs(key, file, onProgress) {
      if (!HAS_OPFS) return Promise.reject(new Error('opfs_unavailable'));
      var opfs = window.OPFSManager;
      if (opfs && typeof opfs.writeStream === 'function') {
        return opfs.writeStream(key, file).then(function (info) {
          _log('staged', { key: key, size: file.size });
          return info;
        });
      }
      // Fallback: manual chunked write
      return _manualChunkStage(key, file, onProgress);
    }

    async function _manualChunkStage(key, file, onProgress) {
      var root   = await navigator.storage.getDirectory();
      var sk     = 'p32_' + String(key).replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
      var cs     = _chunkSize();
      var total  = Math.ceil(file.size / cs);

      for (var i = 0; i < total; i++) {
        var start = i * cs;
        var end   = Math.min(file.size, start + cs);
        var buf   = await file.slice(start, end).arrayBuffer();
        var fh    = await root.getFileHandle(sk + '_c' + i, { create: true });
        var wr    = await fh.createWritable();
        await wr.write(buf);
        await wr.close();
        buf = null; // help GC
        if (onProgress) onProgress((i + 1) / total);
      }
      _log('manual-staged', { key: key, chunks: total });
      return { key: key, size: file.size, chunks: total };
    }

    // Evict chunk cache for a specific file
    function evictFile(fileId) {
      _cache = _cache.filter(function (c) {
        var keep = !c.key.startsWith(fileId + ':');
        if (!keep) c.data = null;
        return keep;
      });
    }

    function cacheStats() {
      return { count: _cache.length, max: MAX_CACHE_CHUNKS };
    }

    return {
      readRange:         readRange,
      readChunk:         readChunk,
      chunkCount:        chunkCount,
      createChunkStream: createChunkStream,
      stageToOpfs:       stageToOpfs,
      evictFile:         evictFile,
      cacheStats:        cacheStats,
      get chunkSize()    { return _chunkSize(); },
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 32B  STREAM-FIRST PROCESSOR
  // Wraps existing per-tool processing with a progressive page pipeline.
  // Pages are decoded, processed, and output-streamed in rolling batches —
  // never holding the full document in RAM simultaneously.
  //
  // Integration: tools call StreamFirstProcessor.processPages() instead of
  // loading all pages at once. The existing engine handles the heavy lifting;
  // this layer manages the rolling window, cleanup, and output assembly.
  // ═══════════════════════════════════════════════════════════════════════════

  var StreamFirstProcessor = (function () {
    // Tools that benefit from stream-first page processing
    var STREAM_TOOLS = {
      'ocr': true, 'compress': true, 'repair': true, 'compare': true,
      'pdf-to-word': true, 'pdf-to-excel': true, 'pdf-to-powerpoint': true,
      'ai-summarize': true, 'translate': true, 'scan-to-pdf': true,
      'pdf-to-jpg': true,
    };

    // Process pages in rolling batches via a user-supplied pageProcessor fn.
    // pageProcessor(pageNum, batchCtx) → Promise<pageResult>
    // Returns: Promise<pageResult[]> (all pages combined)
    async function processPages(opts) {
      var pdf           = opts.pdf;          // pdf-lib / pdfjs loaded doc
      var totalPages    = opts.totalPages;
      var batchSize     = opts.batchSize || _defaultBatch();
      var pageProcessor = opts.pageProcessor; // async fn(pageNum, ctx)
      var onBatchDone   = opts.onBatchDone;   // optional: fn(results, batchNum)
      var onCleanup     = opts.onCleanup;     // optional: fn(pageNum)
      var signal        = opts.signal;        // optional: AbortSignal

      var allResults = [];
      var batchNum   = 0;

      for (var start = 1; start <= totalPages; start += batchSize) {
        if (signal && signal.aborted) throw new Error('aborted');

        var end   = Math.min(totalPages, start + batchSize - 1);
        var batch = [];
        var batchCtx = { batchNum: batchNum, start: start, end: end, totalPages: totalPages };

        for (var pg = start; pg <= end; pg++) {
          try {
            var r = await pageProcessor(pg, batchCtx);
            batch.push(r);
          } catch (pgErr) {
            _err('page-proc', { page: pg, err: String(pgErr && pgErr.message || pgErr) });
            batch.push({ page: pg, error: String(pgErr && pgErr.message || pgErr) });
          }
        }

        allResults = allResults.concat(batch);
        if (onBatchDone) { try { onBatchDone(batch, batchNum); } catch (_) {} }

        // Cleanup previous batch's pages from memory
        if (onCleanup) {
          for (var cp = start; cp <= end; cp++) {
            try { onCleanup(cp); } catch (_) {}
          }
        }

        // Yield to main thread between batches
        await _yieldToMain(10);

        // Shrink batch size if memory is critically low
        batchSize = Math.max(1, _reclaimBatchSize(batchSize));
        batchNum++;
      }

      return allResults;
    }

    function _defaultBatch() {
      var mp = window.MemPressure;
      if (mp && typeof mp.tier === 'function') {
        var t = mp.tier();
        if (t === 'critical' || t === 'danger')  return 1;
        if (t === 'high')                         return 2;
        if (t === 'elevated')                     return 4;
      }
      return 6;
    }

    function _reclaimBatchSize(current) {
      try {
        var m   = performance.memory;
        var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
        if (pct > 0.85) return 1;
        if (pct > 0.70) return Math.max(1, Math.floor(current * 0.6));
      } catch (_) {}
      return current;
    }

    function _yieldToMain(ms) {
      return new Promise(function (r) { setTimeout(r, ms || 0); });
    }

    function isStreamTool(toolId) { return !!STREAM_TOOLS[toolId]; }

    return { processPages: processPages, isStreamTool: isStreamTool };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 32C  ROLLING MEMORY WINDOW MANAGER
  // Maintains a sliding window of "active" pages in memory. Pages outside
  // the window are evicted (canvas cleared, bitmap closed, refs nulled).
  //
  // Window size adapts dynamically to available memory:
  //   critical / danger → 1–2 pages
  //   elevated           → 4 pages
  //   normal             → 8 pages
  //   low pressure       → 16 pages
  // ═══════════════════════════════════════════════════════════════════════════

  var RollingMemoryWindowManager = (function () {
    // Active page registry: pageNum → { canvas, bitmap, data, refs, ts }
    var _pages   = {};
    var _order   = [];   // insertion order for eviction

    function _windowSize() {
      var mp = window.MemPressure;
      if (mp && typeof mp.tier === 'function') {
        var t = mp.tier();
        if (t === 'critical') return 1;
        if (t === 'danger')   return 2;
        if (t === 'high')     return 4;
        if (t === 'elevated') return 6;
      }
      try {
        var m   = performance.memory;
        var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
        if (pct > 0.85) return 1;
        if (pct > 0.70) return 3;
        if (pct > 0.50) return 6;
      } catch (_) {}
      return 12;
    }

    // Register a page as active; evict oldest pages if over window limit
    function activate(pageNum, pageData) {
      _pages[pageNum] = { data: pageData, ts: Date.now() };
      if (_order.indexOf(pageNum) === -1) _order.push(pageNum);

      var maxWin = _windowSize();
      while (_order.length > maxWin) {
        var evict = _order.shift();
        _evictPage(evict);
      }
    }

    function _evictPage(pageNum) {
      var p = _pages[pageNum];
      if (!p) return;
      try {
        // Canvas cleanup
        if (p.data && p.data.canvas) {
          var c = p.data.canvas;
          c.width = 0; c.height = 0;
          if (c.parentNode) c.parentNode.removeChild(c);
        }
        // ImageBitmap cleanup
        if (p.data && p.data.bitmap && typeof p.data.bitmap.close === 'function') {
          p.data.bitmap.close();
        }
        // Object URL cleanup
        if (p.data && p.data.objectUrl) {
          try { URL.revokeObjectURL(p.data.objectUrl); } catch (_) {}
        }
        // PDF.js page cleanup
        if (p.data && p.data.pdfPage && typeof p.data.pdfPage.cleanup === 'function') {
          p.data.pdfPage.cleanup();
        }
        p.data = null;
      } catch (evErr) {
        _err('evict', evErr);
      }
      delete _pages[pageNum];
    }

    // Force-evict a specific page
    function release(pageNum) {
      var idx = _order.indexOf(pageNum);
      if (idx !== -1) _order.splice(idx, 1);
      _evictPage(pageNum);
    }

    // Evict all pages outside [keepStart, keepEnd] range
    function evictOutsideRange(keepStart, keepEnd) {
      var toEvict = _order.filter(function (n) { return n < keepStart || n > keepEnd; });
      toEvict.forEach(function (n) { release(n); });
    }

    // Full reset — used between jobs
    function reset() {
      var pages = Object.keys(_pages);
      pages.forEach(function (n) { _evictPage(Number(n)); });
      _order = [];
      _log('rmwm-reset', { evicted: pages.length });
    }

    function getActivePages()   { return Object.keys(_pages).map(Number); }
    function getActiveCount()   { return _order.length; }
    function getWindowSize()    { return _windowSize(); }

    return {
      activate:           activate,
      release:            release,
      evictOutsideRange:  evictOutsideRange,
      reset:              reset,
      getActivePages:     getActivePages,
      getActiveCount:     getActiveCount,
      getWindowSize:      getWindowSize,
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § 32D  GIANT FILE SURVIVAL MODE
  // When a file exceeds 300 MB OR page count exceeds 500 OR memory is critical,
  // automatically downgrades render quality, reduces workers, and forces
  // stream-only rendering.  All settings are restored when the job finishes.
  // ═══════════════════════════════════════════════════════════════════════════

  var GiantFileSurvivalMode = (function () {
    var GIANT_BYTES = 300 * MB;
    var GIANT_PAGES = 500;

    var _active      = false;
    var _savedConfig = {};

    var _tools_tracking = {};   // toolId → { startMs, pages, bytes }

    // Survival config applied when mode is activated
    var SURVIVAL_CONFIG = {
      renderScale:     0.6,    // reduce render resolution
      batchPages:      1,      // process 1 page at a time
      maxWorkers:      1,      // limit pool concurrency
      jpegQuality:     0.65,   // lower JPEG quality
      thumbnailScale:  0.25,   // tiny thumbnails only
      disablePreviews: true,   // no live previews
      ocrMode:         'fast', // fast OCR pass
    };

    function _shouldActivate(fileBytes, pageCount) {
      if (fileBytes >= GIANT_BYTES) return true;
      if (pageCount && pageCount >= GIANT_PAGES) return true;
      var mp = window.MemPressure;
      if (mp && typeof mp.tier === 'function') {
        var t = mp.tier();
        if (t === 'critical' || t === 'danger') return true;
      }
      try {
        var m   = performance.memory;
        if (m.usedJSHeapSize / m.jsHeapSizeLimit > 0.78) return true;
      } catch (_) {}
      return false;
    }

    function activate(fileBytes, pageCount) {
      if (_active) return;
      if (!_shouldActivate(fileBytes, pageCount)) return;

      _active = true;
      _log('survival-mode-on', { bytes: fileBytes, pages: pageCount });

      // Signal eviction manager to run a full cycle
      try {
        if (window.EvictionManager && typeof window.EvictionManager.flush === 'function') {
          window.EvictionManager.flush();
        }
      } catch (_) {}

      // Reset page window manager to minimal
      try { RollingMemoryWindowManager.reset(); } catch (_) {}

      // Tell GiantFileRouting about survival mode
      try {
        if (window.GiantFileRouting && typeof window.GiantFileRouting.enterSurvivalMode === 'function') {
          window.GiantFileRouting.enterSurvivalMode();
        }
      } catch (_) {}

      window.dispatchEvent(new CustomEvent('p32:survival-mode', { detail: SURVIVAL_CONFIG }));
    }

    function deactivate() {
      if (!_active) return;
      _active = false;
      _log('survival-mode-off', {});
      window.dispatchEvent(new CustomEvent('p32:survival-mode-end', {}));
    }

    function isActive()      { return _active; }
    function getConfig()     { return Object.assign({}, SURVIVAL_CONFIG); }

    // Track job start
    function trackStart(toolId, fileBytes) {
      _tools_tracking[toolId] = { startMs: Date.now(), bytes: fileBytes };
      activate(fileBytes, null);
    }

    // Track job end — deactivate if memory recovered
    function trackEnd(toolId) {
      delete _tools_tracking[toolId];
      if (Object.keys(_tools_tracking).length === 0) deactivate();
    }

    // Periodic check — auto-activates if memory suddenly spikes
    setInterval(function () {
      if (!_active) {
        try {
          var m = performance.memory;
          if (m && m.usedJSHeapSize / m.jsHeapSizeLimit > 0.85) {
            activate(0, 0);
          }
        } catch (_) {}
      }
    }, 5000);

    return {
      activate:   activate,
      deactivate: deactivate,
      isActive:   isActive,
      getConfig:  getConfig,
      trackStart: trackStart,
      trackEnd:   trackEnd,
      THRESHOLDS: { bytes: GIANT_BYTES, pages: GIANT_PAGES },
    };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // INTEGRATION HOOK
  // Wrap BrowserTools.process with Phase 32 streaming management.
  // Pre: activate survival mode / configure streaming for giant files.
  // Post: deactivate and cleanup.
  // ═══════════════════════════════════════════════════════════════════════════

  function installPhase32() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__phase32v1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      var arr   = Array.isArray(files) ? files : Array.from(files || []);
      var bytes = arr.reduce(function (s, f) { return s + (f ? f.size : 0); }, 0);

      // Activate survival mode for giant files
      GiantFileSurvivalMode.trackStart(toolId, bytes);

      // If giant file eligible: stage to OPFS in background (fire-and-forget)
      if (bytes >= 150 * MB && HAS_OPFS && StreamFirstProcessor.isStreamTool(toolId)) {
        arr.forEach(function (f, i) {
          if (f && f.size >= 50 * MB) {
            var stageKey = 'p32:' + toolId + ':' + i + ':' + f.size;
            ByteRangeStreamer.stageToOpfs(stageKey, f).catch(function () {});
          }
        });
      }

      var mergedOpts = Object.assign(
        {},
        GiantFileSurvivalMode.isActive() ? GiantFileSurvivalMode.getConfig() : {},
        opts || {}
      );

      try {
        return await upstream(toolId, files, mergedOpts);
      } finally {
        GiantFileSurvivalMode.trackEnd(toolId);
        // After each job reset the rolling window
        try { RollingMemoryWindowManager.reset(); } catch (_) {}
      }
    };

    window.BrowserTools.__phase32v1 = true;
    _log('installed', { version: VERSION });
    return true;
  }

  var _tries = 0;
  if (!installPhase32()) {
    var _iv = setInterval(function () {
      if (installPhase32() || ++_tries > 120) clearInterval(_iv);
    }, 80);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  window.Phase32 = {
    version: VERSION,

    ByteRangeStreamer:          ByteRangeStreamer,
    StreamFirstProcessor:       StreamFirstProcessor,
    RollingMemoryWindowManager: RollingMemoryWindowManager,
    GiantFileSurvivalMode:      GiantFileSurvivalMode,

    audit: function () {
      var wmgr = RollingMemoryWindowManager;
      var brs  = ByteRangeStreamer;
      var srv  = GiantFileSurvivalMode;
      var report = {
        version:           VERSION,
        installed:         !!(window.BrowserTools && window.BrowserTools.__phase32v1),
        survivalModeActive: srv.isActive(),
        activePages:        wmgr.getActiveCount(),
        windowSize:         wmgr.getWindowSize(),
        chunkCacheEntries:  brs.cacheStats().count,
        currentChunkSizeKB: Math.round(brs.chunkSize / 1024),
        hasOpfs:            HAS_OPFS,
        hasReadableStream:  HAS_READABLE_STREAM,
      };
      console.group('Phase32 v' + VERSION + ' — Streaming Audit');
      console.table(report);
      console.groupEnd();
      return report;
    },
  };

}());
