// Giant File Telemetry v1.0 — Phase 25J
// Deep diagnostics for giant-file processing.
// Records: peak memory, active canvases, active bitmaps, page windows,
//          render queue, OCR retries, worker restarts, chunk streaming progress,
//          eviction activity, OPFS usage.
// Patches AdvancedEngine.auditLargeFile() onto the existing AdvancedEngine API.
// Exposes: window.GiantFileTelemetry
// Depends on: MemPressure, EvictionManager, GiantFileRouting, OPFSManager (all Phase 25)
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Event log ─────────────────────────────────────────────────────────────
  var MAX_LOG = 500;
  var _log = [];  // [{ ts, event, data }]

  function record(event, data) {
    if (_log.length >= MAX_LOG) _log.shift();
    _log.push({ ts: Date.now(), event: event, data: data || {} });
  }

  // ── Peak memory tracking ───────────────────────────────────────────────────
  var _peakMemMB = 0;
  var _peakCanvases = 0;
  var _peakBitmaps  = 0;
  var _ocrRetries   = 0;
  var _workerRestarts = 0;
  var _chunkStats   = { totalChunks: 0, totalBytes: 0, activeWriters: 0 };
  var _renderStats  = { totalRenders: 0, failedRenders: 0, activeRenderTasks: 0 };
  var _ocrStats     = { pagesOcred: 0, pagesRetried: 0, avgConfidence: 0, confSamples: 0 };
  var _evictionStats = { canvases: 0, bitmaps: 0, pages: 0, blobs: 0, emergencyFlushes: 0 };
  var _opfsStats    = { bytesWritten: 0, bytesRead: 0, filesCreated: 0 };

  // ── Metric update helpers ─────────────────────────────────────────────────
  function recordMemSample() {
    try {
      if (performance && performance.memory) {
        var mb = performance.memory.usedJSHeapSize / MB;
        if (mb > _peakMemMB) _peakMemMB = mb;
      }
    } catch (_) {}
  }

  function recordOcrPage(confidence) {
    _ocrStats.pagesOcred++;
    if (confidence != null) {
      var n  = _ocrStats.confSamples;
      _ocrStats.avgConfidence = (_ocrStats.avgConfidence * n + confidence) / (n + 1);
      _ocrStats.confSamples++;
    }
  }

  function recordOcrRetry(pageNum) {
    _ocrRetries++;
    _ocrStats.pagesRetried++;
    record('ocr.retry', { pageNum: pageNum, totalRetries: _ocrRetries });
  }

  function recordWorkerRestart(workerUrl) {
    _workerRestarts++;
    record('worker.restart', { workerUrl: workerUrl, total: _workerRestarts });
  }

  function recordChunkWrite(bytes) {
    _chunkStats.totalChunks++;
    _chunkStats.totalBytes += bytes;
    _opfsStats.bytesWritten += bytes;
    if (_chunkStats.totalChunks % 10 === 0) {
      record('chunk.progress', { totalMB: Math.round(_chunkStats.totalBytes / MB), chunks: _chunkStats.totalChunks });
    }
  }

  function recordRender(success) {
    _renderStats.totalRenders++;
    if (!success) _renderStats.failedRenders++;
  }

  function recordEviction(type) {
    if (type === 'canvas')   { _evictionStats.canvases++;       }
    if (type === 'bitmap')   { _evictionStats.bitmaps++;        }
    if (type === 'page')     { _evictionStats.pages++;          }
    if (type === 'blob')     { _evictionStats.blobs++;          }
    if (type === 'flush')    { _evictionStats.emergencyFlushes++; }
  }

  // ── Snapshot builder ───────────────────────────────────────────────────────
  function snapshot() {
    recordMemSample();

    var memPressureStats = {};
    if (window.MemPressure) {
      try { memPressureStats = window.MemPressure.stats(); } catch (_) {}
    }

    var evMgrStats = {};
    if (window.EvictionManager) {
      try { evMgrStats = window.EvictionManager.getStats(); } catch (_) {}
    }

    var routingStats = {};
    if (window.GiantFileRouting) {
      try { routingStats = window.GiantFileRouting.getStats(); } catch (_) {}
    }

    var opfsQuota = {};
    if (window.OPFSManager) {
      // Async — we return the cached value; call refreshOpfsQuota() for fresh data
      opfsQuota = _cachedOpfsQuota;
    }

    var vpmStats = window._vpmActiveInstance ?
      (typeof window._vpmActiveInstance.stats === 'function' ? window._vpmActiveInstance.stats() : {}) :
      {};

    return {
      timestamp:        Date.now(),
      memory: {
        peakMB:         Math.round(_peakMemMB),
        currentMB:      memPressureStats.usedMB || 0,
        limitMB:        memPressureStats.limitMB || 0,
        availMB:        memPressureStats.availMB || 0,
        tier:           memPressureStats.tier || 'unknown',
        pct:            memPressureStats.pct  || 0,
      },
      canvases: {
        active:         evMgrStats.activeCanvases || 0,
        peak:           _peakCanvases,
        released:       evMgrStats.canvasReleases || 0,
      },
      bitmaps: {
        active:         evMgrStats.activeBitmaps  || 0,
        peak:           _peakBitmaps,
        released:       evMgrStats.bitmapReleases || 0,
      },
      pageWindow:       vpmStats,
      renderQueue:      _renderStats,
      ocr: {
        pagesOcred:     _ocrStats.pagesOcred,
        pagesRetried:   _ocrStats.pagesRetried,
        avgConfidence:  Math.round(_ocrStats.avgConfidence),
        retries:        _ocrRetries,
      },
      workers: {
        restarts:       _workerRestarts,
        routing:        routingStats,
      },
      chunkStreaming:   Object.assign({}, _chunkStats, { totalMB: Math.round(_chunkStats.totalBytes / MB) }),
      evictions:        Object.assign({}, _evictionStats, { evmgr: evMgrStats }),
      opfs:             Object.assign({}, _opfsStats, opfsQuota),
      logEntries:       _log.length,
    };
  }

  var _cachedOpfsQuota = {};
  async function refreshOpfsQuota() {
    if (!window.OPFSManager || !window.OPFSManager.getQuota) return;
    try {
      _cachedOpfsQuota = await window.OPFSManager.getQuota();
    } catch (_) {}
  }
  // Refresh quota every 30s
  setInterval(refreshOpfsQuota, 30000);
  refreshOpfsQuota();

  // ── auditLargeFile ────────────────────────────────────────────────────────
  // Full console report for giant-file processing sessions.
  function auditLargeFile() {
    var s = snapshot();

    console.group('%c🗂️ Giant File Audit — Phase 25', 'color:#7c3aed;font-weight:700;font-size:14px');

    console.group('Memory');
    console.log('Peak:   ', s.memory.peakMB   + ' MB');
    console.log('Current:', s.memory.currentMB + ' MB  (' + s.memory.pct + '% of limit)');
    console.log('Avail:  ', s.memory.availMB   + ' MB');
    console.log('Tier:   ', s.memory.tier);
    console.groupEnd();

    console.group('Active Resources');
    console.log('Canvases active:', s.canvases.active, ' | peak:', s.canvases.peak, ' | released:', s.canvases.released);
    console.log('Bitmaps  active:', s.bitmaps.active,  ' | peak:', s.bitmaps.peak,  ' | released:', s.bitmaps.released);
    console.log('PDF Pages released:', (s.evictions.evmgr && s.evictions.evmgr.pageReleases) || 0);
    console.log('Blob URLs released:', (s.evictions.evmgr && s.evictions.evmgr.blobReleases) || 0);
    console.groupEnd();

    console.group('Virtual Page Window');
    if (s.pageWindow && s.pageWindow.loadedPages !== undefined) {
      console.log('Loaded pages:', s.pageWindow.loadedPages);
      console.log('Window size:', s.pageWindow.windowSize);
      console.log('Prefetched:', s.pageWindow.prefetched);
      console.log('Evictions:', s.pageWindow.evictions);
      console.log('Renders:', s.pageWindow.renders);
    } else {
      console.log('No active VirtualPageManager instance.');
    }
    console.groupEnd();

    console.group('Render Queue');
    console.log('Total renders:', s.renderQueue.totalRenders);
    console.log('Failed renders:', s.renderQueue.failedRenders);
    console.log('Active tasks:', s.renderQueue.activeRenderTasks);
    console.groupEnd();

    console.group('OCR Pipeline');
    console.log('Pages OCRed:', s.ocr.pagesOcred);
    console.log('Pages retried:', s.ocr.pagesRetried);
    console.log('Avg confidence:', s.ocr.avgConfidence + '%');
    console.log('Total retries:', s.ocr.retries);
    console.groupEnd();

    console.group('Workers');
    console.log('Worker restarts:', s.workers.restarts);
    if (s.workers.routing && s.workers.routing.giant) {
      console.log('Giant tasks dispatched:', s.workers.routing.giant.dispatched);
      console.log('Giant tasks completed:', s.workers.routing.giant.completed);
      console.log('Giant tasks failed:', s.workers.routing.giant.failed);
      console.log('Giant queue length:', s.workers.routing.giant.queueLength);
    }
    if (s.workers.routing && s.workers.routing.workerPool) {
      console.log('WorkerPool:', s.workers.routing.workerPool);
    }
    console.groupEnd();

    console.group('Chunk Streaming');
    console.log('Total chunks written:', s.chunkStreaming.totalChunks);
    console.log('Total MB streamed:', s.chunkStreaming.totalMB);
    console.groupEnd();

    console.group('Evictions');
    console.log('Canvases evicted:', s.evictions.canvases);
    console.log('Bitmaps evicted:', s.evictions.bitmaps);
    console.log('Pages evicted:', s.evictions.pages);
    console.log('Blobs evicted:', s.evictions.blobs);
    console.log('Emergency flushes:', s.evictions.emergencyFlushes);
    console.groupEnd();

    console.group('OPFS');
    if (s.opfs.available) {
      console.log('Quota:', Math.round((s.opfs.quota || 0) / MB) + ' MB');
      console.log('Used:', Math.round((s.opfs.usage || 0) / MB) + ' MB');
      console.log('Free:', Math.round((s.opfs.free || 0) / MB) + ' MB');
    } else {
      console.log('OPFS not available.');
    }
    console.log('Bytes written (this session):', Math.round(s.opfs.bytesWritten / MB) + ' MB');
    console.groupEnd();

    console.log('Event log entries:', s.logEntries);
    console.groupEnd();

    return s;
  }

  // ── Patch into AdvancedEngine when it's ready ─────────────────────────────
  function _patchAdvancedEngine() {
    if (!window.AdvancedEngine) return false;
    if (window.AdvancedEngine.auditLargeFile) return true; // already patched

    window.AdvancedEngine.auditLargeFile = auditLargeFile;

    // Also enhance the existing audit() with large-file section
    var _origAudit = window.AdvancedEngine.audit;
    window.AdvancedEngine.audit = function () {
      var result = _origAudit ? _origAudit.call(this) : null;
      var mem = window.MemPressure ? window.MemPressure.stats() : {};
      console.log('%cPhase 25 Large-File Stats:', 'color:#7c3aed;font-weight:600');
      console.log('  Memory tier:', mem.tier || 'unknown', '| used:', (mem.usedMB || 0) + 'MB');
      console.log('  Peak memory this session:', Math.round(_peakMemMB) + 'MB');
      console.log('  Worker restarts:', _workerRestarts, '| OCR retries:', _ocrRetries);
      console.log('  Evictions — canvases:', _evictionStats.canvases, '| bitmaps:', _evictionStats.bitmaps, '| emergency flushes:', _evictionStats.emergencyFlushes);
      if (window.GiantFileRouting) {
        var rs = window.GiantFileRouting.getStats();
        console.log('  Giant tasks:', rs.giant);
      }
      return result;
    };

    return true;
  }

  if (!_patchAdvancedEngine()) {
    var _patchRetries = 0;
    var _patchIv = setInterval(function () {
      if (_patchAdvancedEngine() || _patchRetries++ > 60) clearInterval(_patchIv);
    }, 150);
  }

  // ── Continuous memory sampling (every 5s) ─────────────────────────────────
  setInterval(function () {
    recordMemSample();
    // Sync eviction stats from EvictionManager
    if (window.EvictionManager) {
      var es = window.EvictionManager.getStats();
      _evictionStats.canvases       = es.canvasReleases  || 0;
      _evictionStats.bitmaps        = es.bitmapReleases  || 0;
      _evictionStats.pages          = es.pageReleases     || 0;
      _evictionStats.blobs          = es.blobReleases     || 0;
      _evictionStats.emergencyFlushes = es.emergencyFlushes || 0;
      _peakCanvases = Math.max(_peakCanvases, es.activeCanvases || 0);
      _peakBitmaps  = Math.max(_peakBitmaps,  es.activeBitmaps  || 0);
    }
  }, 5000);

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.GiantFileTelemetry = {
    version: '1.0',
    // Event recording
    record:              record,
    // Metric helpers
    recordMemSample:     recordMemSample,
    recordOcrPage:       recordOcrPage,
    recordOcrRetry:      recordOcrRetry,
    recordWorkerRestart: recordWorkerRestart,
    recordChunkWrite:    recordChunkWrite,
    recordRender:        recordRender,
    recordEviction:      recordEviction,
    // Reporting
    snapshot:            snapshot,
    auditLargeFile:      auditLargeFile,
    getLog: function () { return _log.slice(); },
    // Refresh OPFS quota manually
    refreshOpfsQuota:    refreshOpfsQuota,
  };

}());
