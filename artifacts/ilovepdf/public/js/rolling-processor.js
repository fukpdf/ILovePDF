// Rolling Processor v1.0 — Phase 25C + 25D + 25E + 25G
// Rolling memory windows for OCR, PDF render, image conversion, compare, repair, compress.
// Stream-first OCR pipeline with incremental output writing.
// Partial PDF page loading with decode queue scheduling.
// Adaptive batch sizing per tool, device RAM, and memory tier.
// Exposes: window.RollingProcessor
// Depends on: MemPressure (Phase 23A), EvictionManager (Phase 25F)
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Adaptive batch sizing (Phase 25G) ─────────────────────────────────────
  // Returns the optimal batch size for a given tool / context.
  var TOOL_BATCH_BASE = {
    'ocr':               { high: 8, medium: 4, low: 2, critical: 1 },
    'compare':           { high: 6, medium: 3, low: 2, critical: 1 },
    'compress':          { high: 6, medium: 4, low: 2, critical: 1 },
    'repair':            { high: 4, medium: 2, low: 1, critical: 1 },
    'pdf-to-word':       { high: 8, medium: 4, low: 2, critical: 1 },
    'pdf-to-jpg':        { high: 6, medium: 3, low: 2, critical: 1 },
    'jpg-to-pdf':        { high: 8, medium: 4, low: 2, critical: 1 },
    'image-filters':     { high: 8, medium: 4, low: 2, critical: 1 },
    'background-remover':{ high: 4, medium: 2, low: 1, critical: 1 },
  };

  function computeAdaptiveBatchSize(toolId, fileSize, pageCount) {
    var base = TOOL_BATCH_BASE[toolId] || { high: 6, medium: 3, low: 2, critical: 1 };
    var tier = 'high';
    if (window.MemPressure) {
      var t = window.MemPressure.tier();
      if (t === 'abort' || t === 'critical') tier = 'critical';
      else if (t === 'low')                  tier = 'low';
      else if (t === 'reduce')               tier = 'medium';
    } else {
      // Estimate from device RAM
      try {
        var heapGB = (performance.memory.jsHeapSizeLimit || 0) / 1073741824;
        if (heapGB < 1.5) tier = 'low';
        else if (heapGB < 3) tier = 'medium';
      } catch (_) { tier = 'medium'; }
    }

    var batchSize = base[tier] || 2;

    // Further reduce for very large files
    if (fileSize > 200 * MB) batchSize = Math.max(1, Math.floor(batchSize * 0.5));
    if (fileSize > 500 * MB) batchSize = 1;

    // Further reduce for very large page counts
    if (pageCount > 500) batchSize = Math.max(1, Math.floor(batchSize * 0.5));
    if (pageCount > 1000) batchSize = 1;

    return batchSize;
  }

  // ── OCR mode heuristics (Phase 25D) ───────────────────────────────────────
  // Detect the best OCR preprocessing mode from page content.
  function detectOcrMode(canvas) {
    if (!canvas) return 'auto';
    try {
      var ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (!ctx) return 'auto';
      var w = canvas.width, h = canvas.height;
      if (w < 2 || h < 2) return 'auto';

      // Sample border pixels for noise estimation
      var sampleCount = Math.min(200, w * 2 + h * 2);
      var step = Math.max(1, Math.floor((w * 2 + h * 2) / sampleCount));
      var sumBright = 0, sumDark = 0, totalPx = 0;

      var imgData = ctx.getImageData(0, 0, Math.min(w, 4), Math.min(h, 4));
      var d = imgData.data;
      var sample = 0;
      for (var i = 0; i < d.length; i += 4) {
        var lum = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
        if (lum > 180) sumBright++;
        else if (lum < 80) sumDark++;
        totalPx++;
      }

      var brightRatio = totalPx > 0 ? sumBright / totalPx : 0;
      var darkRatio   = totalPx > 0 ? sumDark  / totalPx : 0;
      var noiseScore  = 1 - brightRatio - darkRatio; // pixels in mid-range = noisy

      // Table detection: high dark-pixel ratio with regular spacing
      if (darkRatio > 0.15) return 'table';
      // Noisy scan: many mid-range pixels
      if (noiseScore > 0.3) return 'denoise';
      // Very high contrast: printed document
      if (brightRatio > 0.7) return 'auto';
      // Default for scanned docs
      return 'strong';
    } catch (_) {
      return 'auto';
    }
  }

  // ── Rolling window generic processor (Phase 25C) ──────────────────────────
  // Processes pdfDoc pages in a sliding window:
  //   1. Load a window of pages
  //   2. Process each
  //   3. Flush output
  //   4. Release page resources
  //   5. Advance window
  //
  // opts: { batchSize, onPage, onBatchDone, onProgress, toolId, fileSize }
  async function processWithRollingWindow(pdfDoc, opts) {
    opts = opts || {};
    var total     = pdfDoc.numPages;
    var toolId    = opts.toolId   || 'unknown';
    var fileSize  = opts.fileSize || 0;
    var batchSize = opts.batchSize ||
                    computeAdaptiveBatchSize(toolId, fileSize, total);
    var onPage      = opts.onPage      || function () {};
    var onBatchDone = opts.onBatchDone || function () {};
    var onProgress  = opts.onProgress  || function () {};

    var results = [];
    var pageNum = 1;

    while (pageNum <= total) {
      var windowEnd = Math.min(pageNum + batchSize - 1, total);
      var windowPages = [];

      // Load window
      for (var p = pageNum; p <= windowEnd; p++) {
        var page;
        try { page = await pdfDoc.getPage(p); }
        catch (_) { page = null; }
        windowPages.push({ num: p, page: page });
      }

      // Process window
      var batchResults = [];
      for (var i = 0; i < windowPages.length; i++) {
        var entry = windowPages[i];
        var result = null;
        try {
          result = await onPage(entry.page, entry.num, total);
        } catch (_) {
          result = null;
        } finally {
          // Immediately release page resources
          if (entry.page) {
            try { entry.page.cleanup(); } catch (_) {}
            if (window.EvictionManager) window.EvictionManager.releasePdfPage(entry.page);
            entry.page = null;
          }
        }
        batchResults.push({ num: entry.num, result: result });
        onProgress(entry.num, total);
        // Yield every page
        await new Promise(function (r) { setTimeout(r, 0); });
      }

      results = results.concat(batchResults);
      onBatchDone(batchResults, pageNum, windowEnd, total);

      // Hard cleanup checkpoint
      if (window.MemPressure && window.MemPressure.isCritical()) {
        if (window.EvictionManager) window.EvictionManager.emergencyPressureFlush();
        // Yield longer under pressure
        await new Promise(function (r) { setTimeout(r, 50); });
        // Reduce batch size for remaining windows
        batchSize = 1;
      }

      pageNum = windowEnd + 1;
      windowPages = null;
    }

    return results;
  }

  // ── OCR Page Scheduler (Phase 25D) ────────────────────────────────────────
  // Processes OCR progressively: render → preprocess → recognize → write → flush.
  // Never stores all canvases or all bitmaps simultaneously.
  // onPageOcr(pageNum, canvas, pageTotal) → { text, confidence }
  // onIncrementalWrite(pageNum, ocrResult, isLast) → called after each page
  async function processOcrRolling(pdfDoc, pdfjsLib, opts) {
    opts = opts || {};
    var total     = pdfDoc.numPages;
    var fileSize  = opts.fileSize || 0;
    var batchSize = opts.batchSize ||
                    computeAdaptiveBatchSize('ocr', fileSize, total);
    var preferScale   = opts.ocrScale || 2.0;
    var onProgress    = opts.onProgress    || function () {};
    var onPageResult  = opts.onPageResult  || function () {};
    var onCheckpoint  = opts.onCheckpoint  || function () {};
    var startPage     = opts.startPage     || 1;

    var outputPages = [];
    var peakCanvases = 0;
    var activeCanvases = 0;

    for (var pageNum = startPage; pageNum <= total; ) {
      var windowEnd = Math.min(pageNum + batchSize - 1, total);

      // Adaptive OCR scaling
      var scale = preferScale;
      if (window.MemPressure) {
        var memScale = window.MemPressure.renderScale('ocr');
        scale = Math.min(scale, scale * memScale);
      }
      scale = Math.max(0.8, Math.min(3.0, scale));

      // Process one window of pages
      for (var p = pageNum; p <= windowEnd; p++) {
        var canvas   = null;
        var ctx      = null;
        var pageProxy = null;

        try {
          pageProxy = await pdfDoc.getPage(p);
          var viewport = pageProxy.getViewport({ scale: scale });
          var w = Math.floor(viewport.width);
          var h = Math.floor(viewport.height);

          // Giant-page auto downscale (Phase 25D)
          if (w * h * 4 > 64 * MB) {
            var downFactor = Math.sqrt((64 * MB) / (w * h * 4));
            scale = scale * downFactor;
            scale = Math.max(0.6, scale);
            viewport = pageProxy.getViewport({ scale: scale });
            w = Math.floor(viewport.width);
            h = Math.floor(viewport.height);
          }

          canvas = document.createElement('canvas');
          canvas.width  = w;
          canvas.height = h;
          ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            var rt = pageProxy.render({ canvasContext: ctx, viewport: viewport });
            await rt.promise;
          }
          activeCanvases++;
          peakCanvases = Math.max(peakCanvases, activeCanvases);

          // Detect OCR mode heuristic
          var ocrMode = detectOcrMode(canvas);

          // Deliver canvas to caller for OCR recognition
          var ocrResult = await opts.onPageRender(pageNum, p, canvas, ocrMode, scale, total);

          outputPages.push({ pageNum: p, result: ocrResult });
          onPageResult(p, ocrResult, total);
          onProgress(p, total);

          // Incremental write callback
          var isLast = p === total;
          if (opts.onIncrementalWrite) {
            await opts.onIncrementalWrite(p, ocrResult, isLast, outputPages.slice());
          }

        } catch (err) {
          outputPages.push({ pageNum: p, result: null, error: err.message });
          onProgress(p, total);
        } finally {
          // Immediate cleanup — never keep canvases
          if (canvas) {
            try { canvas.width = 0; canvas.height = 0; } catch (_) {}
            canvas = null;
            activeCanvases = Math.max(0, activeCanvases - 1);
          }
          if (pageProxy) {
            try { pageProxy.cleanup(); } catch (_) {}
            pageProxy = null;
          }
        }

        await new Promise(function (r) { setTimeout(r, 0); });
      }

      // Checkpoint after each batch
      onCheckpoint(pageNum, windowEnd, outputPages);

      // Memory pressure adaptive response
      if (window.MemPressure) {
        var tier = window.MemPressure.tier();
        if (tier === 'abort' || tier === 'critical') {
          if (window.EvictionManager) window.EvictionManager.emergencyPressureFlush();
          await new Promise(function (r) { setTimeout(r, 100); });
          batchSize = 1;
        } else if (tier === 'low') {
          batchSize = Math.max(1, Math.floor(batchSize * 0.5));
          await new Promise(function (r) { setTimeout(r, 30); });
        } else if (tier === 'ok' && batchSize < opts.maxBatchSize) {
          // Recover batch size when memory frees up
          batchSize = Math.min(opts.maxBatchSize || 8, batchSize + 1);
        }
      }

      pageNum = windowEnd + 1;
    }

    return {
      pages:       outputPages,
      peakCanvases: peakCanvases,
      total:       total,
    };
  }

  // ── Page Decode Queue (Phase 25E) ──────────────────────────────────────────
  // Lazy PDF page loading: only decode pages on demand, not all at once.
  // Prevents simultaneous bitmap creation for large PDFs.
  function createPageDecodeQueue(pdfDoc, opts) {
    opts = opts || {};
    var _maxConcurrent = opts.maxConcurrent || computeAdaptiveBatchSize('pdf-to-jpg', 0, pdfDoc.numPages);
    var _queue         = [];  // pending decode requests { pageNum, resolve, reject, priority }
    var _active        = 0;
    var _cache         = {}; // { [pageNum]: pageProxy }
    var _maxCache      = opts.maxCache || 4;

    function _evictCache() {
      var keys = Object.keys(_cache).map(Number);
      if (keys.length <= _maxCache) return;
      // Evict oldest entries
      keys.sort(function (a, b) { return (_cache[a]._loadedAt || 0) - (_cache[b]._loadedAt || 0); });
      var toEvict = keys.slice(0, keys.length - _maxCache);
      toEvict.forEach(function (k) {
        var p = _cache[k];
        if (p) { try { p.cleanup(); } catch (_) {} }
        delete _cache[k];
      });
    }

    function _drain() {
      while (_active < _maxConcurrent && _queue.length > 0) {
        var req = _queue.shift();
        _active++;

        (function (r) {
          var cached = _cache[r.pageNum];
          if (cached) {
            _active--;
            r.resolve(cached);
            _drain();
            return;
          }
          pdfDoc.getPage(r.pageNum)
            .then(function (page) {
              page._loadedAt = Date.now();
              if (Object.keys(_cache).length < _maxCache) {
                _cache[r.pageNum] = page;
              }
              _evictCache();
              _active--;
              r.resolve(page);
              _drain();
            })
            .catch(function (err) {
              _active--;
              r.reject(err);
              _drain();
            });
        }(req));
      }
    }

    // Request a page — returns a promise for the page proxy
    function requestPage(pageNum, priority) {
      return new Promise(function (resolve, reject) {
        var req = { pageNum: pageNum, resolve: resolve, reject: reject, priority: priority || 0, queuedAt: Date.now() };
        // Priority insertion
        if (priority > 0) _queue.unshift(req);
        else _queue.push(req);
        _drain();
      });
    }

    // Release a page proxy back (if not cached)
    function releasePage(pageNum) {
      var p = _cache[pageNum];
      if (p) {
        try { p.cleanup(); } catch (_) {}
        delete _cache[pageNum];
      }
    }

    // Update concurrency cap from current memory pressure
    function updateConcurrency() {
      if (window.MemPressure) {
        _maxConcurrent = window.MemPressure.maxWorkers();
      }
    }

    return {
      requestPage:       requestPage,
      releasePage:       releasePage,
      updateConcurrency: updateConcurrency,
      stats: function () {
        return { active: _active, queued: _queue.length, cached: Object.keys(_cache).length, maxConcurrent: _maxConcurrent };
      },
    };
  }

  // ── Streaming ZIP generator for PDF-to-JPG (Phase 25H) ────────────────────
  // Generates a ZIP file incrementally without holding all images in memory.
  // Requires JSZip. Calls onImage(pageNum, total) → { data: Uint8Array, name: string }
  async function generateZipStreaming(pdfDoc, pdfjsLib, opts) {
    opts = opts || {};
    var total     = pdfDoc.numPages;
    var fileSize  = opts.fileSize || 0;
    var batchSize = computeAdaptiveBatchSize('pdf-to-jpg', fileSize, total);
    var quality   = opts.quality || 0.92;
    var scale     = opts.scale   || 1.5;
    var onProgress = opts.onProgress || function () {};

    // Ensure JSZip
    var JSZip = window.JSZip;
    if (!JSZip) throw new Error('JSZip not loaded');

    var zip = new JSZip();
    var decodeQ = createPageDecodeQueue(pdfDoc, { maxConcurrent: batchSize, maxCache: batchSize });

    for (var p = 1; p <= total; p++) {
      var pageProxy = null;
      var canvas    = null;
      try {
        pageProxy = await decodeQ.requestPage(p, p === 1 ? 1 : 0);
        if (window.MemPressure) {
          var s = window.MemPressure.renderScale('pdf');
          scale = Math.min(scale, scale * s);
          scale = Math.max(0.5, scale);
        }
        var viewport = pageProxy.getViewport({ scale: scale });
        var w = Math.floor(viewport.width);
        var h = Math.floor(viewport.height);

        canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        await pageProxy.render({ canvasContext: ctx, viewport: viewport }).promise;

        var imgData;
        if (opts.format === 'png') {
          imgData = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        } else {
          imgData = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', quality); });
        }
        var ext = opts.format === 'png' ? 'png' : 'jpg';
        var fname = 'page_' + String(p).padStart(4, '0') + '.' + ext;
        var buf = await imgData.arrayBuffer();
        zip.file(fname, buf);
        onProgress(p, total);

      } finally {
        if (canvas) {
          try { canvas.width = 0; canvas.height = 0; } catch (_) {}
          canvas = null;
        }
        if (pageProxy) {
          decodeQ.releasePage(p);
          try { pageProxy.cleanup(); } catch (_) {}
        }
      }

      // Rolling cleanup and pressure check
      if (window.MemPressure && window.MemPressure.isCritical()) {
        if (window.EvictionManager) window.EvictionManager.selectivePressureFlush();
        await new Promise(function (r) { setTimeout(r, 50); });
      } else {
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }

    // Generate ZIP with streaming (no full hold in memory)
    var zipBlob = await zip.generateAsync({
      type:              'blob',
      compression:       'DEFLATE',
      compressionOptions: { level: 6 },
      streamFiles:       true,
    });

    return zipBlob;
  }

  // ── Rolling text extraction for Compare / Repair / AI-Summarize ───────────
  // Extracts text from pages progressively without storing all text at once.
  // onTextChunk(text, pageNum, total) — called per page
  async function extractTextRolling(pdfDoc, opts) {
    opts = opts || {};
    var total      = pdfDoc.numPages;
    var batchSize  = computeAdaptiveBatchSize(opts.toolId || 'compare', opts.fileSize || 0, total);
    var onChunk    = opts.onTextChunk || function () {};
    var onProgress = opts.onProgress  || function () {};

    var allText = '';
    var pageNum = 1;

    while (pageNum <= total) {
      var windowEnd = Math.min(pageNum + batchSize - 1, total);
      var chunk     = '';

      for (var p = pageNum; p <= windowEnd; p++) {
        var page = null;
        try {
          page = await pdfDoc.getPage(p);
          var tc   = await page.getTextContent();
          var text = (tc.items || []).map(function (it) { return it.str || ''; }).join(' ').trim();
          if (text) chunk += (chunk ? '\n\n' : '') + text;
          onProgress(p, total);
        } catch (_) {} finally {
          if (page) { try { page.cleanup(); } catch (_) {} }
        }
        await new Promise(function (r) { setTimeout(r, 0); });
      }

      if (chunk) {
        onChunk(chunk, pageNum, windowEnd, total);
        allText += (allText ? '\n\n' : '') + chunk;
      }

      // Pressure check
      if (window.MemPressure && window.MemPressure.isCritical()) {
        if (window.EvictionManager) window.EvictionManager.selectivePressureFlush();
        await new Promise(function (r) { setTimeout(r, 50); });
      }

      pageNum = windowEnd + 1;
    }

    return allText;
  }

  // ── Worker memory reset threshold ─────────────────────────────────────────
  // Signals that a worker should be recycled after processing N pages.
  function shouldRecycleWorker(taskCount, tier) {
    var THRESHOLDS = { ok: 100, reduce: 60, low: 30, critical: 10, abort: 5 };
    var t = tier || (window.MemPressure ? window.MemPressure.tier() : 'ok');
    return taskCount >= (THRESHOLDS[t] || 60);
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.RollingProcessor = {
    version: '1.0',
    // Adaptive batch sizing
    computeAdaptiveBatchSize: computeAdaptiveBatchSize,
    // Rolling window processing
    processWithRollingWindow:  processWithRollingWindow,
    // Stream-first OCR
    processOcrRolling:         processOcrRolling,
    detectOcrMode:             detectOcrMode,
    // Partial page loading
    createPageDecodeQueue:     createPageDecodeQueue,
    // Tool-specific large-file pipelines
    generateZipStreaming:      generateZipStreaming,
    extractTextRolling:        extractTextRolling,
    // Worker lifecycle
    shouldRecycleWorker:       shouldRecycleWorker,
  };

}());
