// ILovePDF — Runtime Streaming Engine v2.0 — Phase 6B
// =====================================================================
// Phase 2 (T034) stub layer REPLACED with real OPFS streaming engine.
//
// Provides:
//   RuntimeStreaming.openFile(file)              — stage file to OPFS
//   RuntimeStreaming.createChunkReader(file,opts) — real async chunk iterator
//   RuntimeStreaming.streamToWorker(handle,fn,opts) — stream chunks → worker
//   RuntimeStreaming.streamFromWorker(result,opts)  — wrap result → stream
//   RuntimeStreaming.processPartial(file,fn,opts)   — chunk-aware processor
//   RuntimeStreaming.shouldStream(file)             — real OPFS gate
//   RuntimeStreaming.isReady()                     — true when OPFS available
//   RuntimeStreaming.getCapabilities()             — live capability probe
//
// All prior stub APIs remain — callers using the Phase 2 surface continue
// to work without modification. New callers use the Phase 6B surface.
//
// Streaming is gated: files < STREAM_THRESHOLD_BYTES use the original
// full-read path. Files >= threshold use OPFS chunked streaming when
// the browser supports it. Graceful fallback to full-read otherwise.
//
// Integrates: RuntimeTelemetry, RuntimeEventBus, RuntimeProgress,
//             RuntimeCancellation, RuntimeScheduler, P1 streamMarkers
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeStreaming) return;

  var LOG = '[RSE]';

  // ── Configuration ─────────────────────────────────────────────────────────
  var STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024;  // 10 MB — stream above this
  var DEFAULT_CHUNK_BYTES    =  4 * 1024 * 1024;  //  4 MB chunks
  var OPFS_DIR               = 'ilovepdf-stream';  // OPFS subdirectory name
  var MAX_OPFS_FILE_AGE_MS   = 30 * 60 * 1000;    // 30 min — sweep stale OPFS files

  // ── Capability detection ──────────────────────────────────────────────────
  var _opfsSupported = !!(
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  );
  var _readableStreamSupported = typeof ReadableStream !== 'undefined';
  var _transferableStream = _readableStreamSupported &&
    _safe(function () { return typeof new ReadableStream().pipeTo === 'function'; }, false);

  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }

  // ── Stream markers (Phase 2 backward compat) ──────────────────────────────
  var _markers = [];

  function markFullLoad(label, opts) {
    var m = { label: label, opts: opts || {}, ts: Date.now() };
    _markers.push(m);
    if (global.P1 && global.P1.streamMarker) {
      try { global.P1.streamMarker(label, opts); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('stream:marker', { label: label }); } catch (_) {}
    }
    return null;
  }

  // ── OPFS root handle ──────────────────────────────────────────────────────
  var _opfsRoot = null;

  async function _getOpfsDir() {
    if (!_opfsSupported) throw new Error('OPFS not available');
    if (!_opfsRoot) {
      var root = await navigator.storage.getDirectory();
      _opfsRoot = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    }
    return _opfsRoot;
  }

  // ── Phase 6B — openFile ───────────────────────────────────────────────────
  // Copies a File/Blob into OPFS for byte-range access.
  // Returns: { handle: FileSystemFileHandle, name, size, opfsName }
  // Falls back silently to { handle: null, file } if OPFS unavailable.
  async function openFile(file) {
    if (!file) throw new Error('openFile: file required');
    if (!_opfsSupported) return { handle: null, file: file, opfs: false };

    var opfsName = 'stream-' + Date.now() + '-' + (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');

    try {
      var dir    = await _getOpfsDir();
      var handle = await dir.getFileHandle(opfsName, { create: true });
      var writable = await handle.createWritable();

      // Stream the file into OPFS in chunks to avoid OOM on large files
      var chunkSize = DEFAULT_CHUNK_BYTES;
      var offset = 0;
      while (offset < file.size) {
        var slice = file.slice(offset, offset + chunkSize);
        var ab    = await slice.arrayBuffer();
        await writable.write(ab);
        offset += chunkSize;

        if (global.RuntimeTelemetry) {
          try {
            global.RuntimeTelemetry.record('stream:opfs-write-chunk', {
              name: file.name, offset: offset, total: file.size,
            });
          } catch (_) {}
        }
      }
      await writable.close();

      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('stream:chunk', { label: 'opfs-open', chunkIndex: 0, chunkBytes: file.size, totalBytes: file.size }); } catch (_) {}
      }

      return { handle: handle, opfsName: opfsName, name: file.name, size: file.size, opfs: true };

    } catch (err) {
      console.warn(LOG, 'openFile OPFS write failed, falling back to memory:', err.message);
      return { handle: null, file: file, opfs: false };
    }
  }

  // ── Phase 6B — createChunkReader ─────────────────────────────────────────
  // Returns an async generator that yields Uint8Array chunks.
  // If OPFS handle is provided, reads from OPFS byte-ranges.
  // If only a File is provided, uses File.slice() for chunking.
  // Falls back to yielding the full ArrayBuffer if chunking fails.
  async function* createChunkReader(fileOrHandle, opts) {
    opts = opts || {};
    var chunkSize = opts.chunkBytes || DEFAULT_CHUNK_BYTES;
    var token     = opts.token || null;

    // Determine source
    var isOpfsHandle = fileOrHandle && fileOrHandle.opfs && fileOrHandle.handle;
    var file = isOpfsHandle ? null : (fileOrHandle && fileOrHandle.file ? fileOrHandle.file : fileOrHandle);
    var totalSize = fileOrHandle ? (fileOrHandle.size || (file && file.size) || 0) : 0;

    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('stream:chunk-read-start', { size: totalSize, opfs: !!isOpfsHandle }); } catch (_) {}
    }

    if (isOpfsHandle) {
      // OPFS byte-range path
      try {
        var opfsFile = await fileOrHandle.handle.getFile();
        var offset = 0;
        var chunkIndex = 0;
        while (offset < opfsFile.size) {
          if (token && token.cancelled) { return; }
          var end   = Math.min(offset + chunkSize, opfsFile.size);
          var slice = opfsFile.slice(offset, end);
          var ab    = await slice.arrayBuffer();
          yield new Uint8Array(ab);

          recordChunk('opfs-read', chunkIndex, ab.byteLength, opfsFile.size);
          offset += chunkSize;
          chunkIndex++;

          if (opts.onProgress) {
            try { opts.onProgress(Math.round((offset / opfsFile.size) * 100)); } catch (_) {}
          }
        }
        return;
      } catch (err) {
        console.warn(LOG, 'OPFS chunk read failed, falling back to full read:', err.message);
        // Fall through to full-read fallback
      }
    }

    // File.slice() path (no OPFS, or OPFS failed)
    if (file && file.size <= DEFAULT_CHUNK_BYTES * 2) {
      // Small file — just read whole thing
      var ab = await file.arrayBuffer();
      yield new Uint8Array(ab);
      return;
    }

    if (file) {
      var off = 0;
      var ci  = 0;
      while (off < file.size) {
        if (token && token.cancelled) { return; }
        var sliceEnd = Math.min(off + chunkSize, file.size);
        var sliceAb  = await file.slice(off, sliceEnd).arrayBuffer();
        yield new Uint8Array(sliceAb);
        recordChunk('file-slice', ci, sliceAb.byteLength, file.size);
        off += chunkSize;
        ci++;
        if (opts.onProgress) {
          try { opts.onProgress(Math.round((off / file.size) * 100)); } catch (_) {}
        }
      }
      return;
    }

    // Last resort: if we got a raw ArrayBuffer
    if (fileOrHandle instanceof ArrayBuffer) {
      yield new Uint8Array(fileOrHandle);
    }
  }

  // ── Phase 6B — streamToWorker ─────────────────────────────────────────────
  // Streams chunks from an openFile() handle to a worker function.
  // workerFn receives: (chunk: Uint8Array, chunkIndex, isLast, totalSize) → Promise<any>
  // Results are collected and returned as an array.
  // Falls back to full-file workerFn call if streaming not needed.
  async function streamToWorker(fileOrHandle, workerFn, opts) {
    opts = opts || {};
    var token    = opts.token || null;
    var totalSize = fileOrHandle ? (fileOrHandle.size || (fileOrHandle.file && fileOrHandle.file.size) || 0) : 0;

    // Use full-read path for small files
    if (totalSize < STREAM_THRESHOLD_BYTES || !_opfsSupported) {
      var srcFile = fileOrHandle && fileOrHandle.file ? fileOrHandle.file : fileOrHandle;
      if (srcFile && typeof srcFile.arrayBuffer === 'function') {
        markFullLoad('stream-to-worker:small-file', { size: totalSize });
        var ab = await srcFile.arrayBuffer();
        return [await workerFn(new Uint8Array(ab), 0, true, totalSize)];
      }
    }

    // Streaming path
    var results    = [];
    var chunkIndex = 0;
    var chunks     = [];

    // Phase 7A: pipeline streaming — dispatch each chunk immediately without
    // accumulating all chunks in RAM. Peak main-thread RAM = 1 chunk (not full file).
    // Uses a look-ahead of 1 chunk to detect isLast without pre-loading everything.
    var reader = createChunkReader(fileOrHandle, { token: token, onProgress: opts.onProgress });
    var _hasPeeked = false;
    var _peekedChunk = null;

    for await (var chunk of reader) {
      if (_hasPeeked) {
        // Previous chunk is NOT the last — dispatch it now
        if (token && token.cancelled) break;
        var result = await workerFn(_peekedChunk, chunkIndex, false, totalSize);
        results.push(result);
        chunkIndex++;
        // Yield to event loop between chunks for backpressure / UI responsiveness
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      _hasPeeked    = true;
      _peekedChunk  = chunk;
    }

    // Dispatch the final chunk (isLast = true)
    if (_hasPeeked && _peekedChunk !== null && !(token && token.cancelled)) {
      var lastResult = await workerFn(_peekedChunk, chunkIndex, true, totalSize);
      results.push(lastResult);
    }

    return results;
  }

  // ── Phase 6B — streamFromWorker ───────────────────────────────────────────
  // Wraps a worker result (ArrayBuffer / Uint8Array / Blob) in a ReadableStream.
  // Consumers can pipe the stream to a WritableStream or collect chunks.
  function streamFromWorker(result, opts) {
    opts = opts || {};

    if (!_readableStreamSupported) {
      // Fallback: return plain buffer
      return { stream: null, buffer: result };
    }

    var buffer = null;
    if (result instanceof ArrayBuffer)          buffer = result;
    else if (result instanceof Uint8Array)      buffer = result.buffer;
    else if (result && result.buffer instanceof ArrayBuffer) buffer = result.buffer;

    if (!buffer) return { stream: null, buffer: null, error: 'unsupported result type' };

    var chunkSize = opts.chunkBytes || DEFAULT_CHUNK_BYTES;
    var totalSize = buffer.byteLength;
    var offset = 0;

    var stream = new ReadableStream({
      pull: function (controller) {
        if (offset >= totalSize) { controller.close(); return; }
        var end   = Math.min(offset + chunkSize, totalSize);
        var chunk = buffer.slice(offset, end);
        controller.enqueue(new Uint8Array(chunk));
        offset = end;
        recordChunk('worker-out', Math.floor(offset / chunkSize), chunk.byteLength, totalSize);
      },
      cancel: function () {
        if (global.RuntimeTelemetry) {
          try { global.RuntimeTelemetry.record('stream:from-worker-cancelled', {}); } catch (_) {}
        }
      },
    });

    return { stream: stream, totalSize: totalSize };
  }

  // ── processPartial (upgraded from stub) ───────────────────────────────────
  // For large files: chunks and calls fn per chunk, aggregating results.
  // For small files: calls fn(file) once (original behavior).
  async function processPartial(file, fn, opts) {
    opts = opts || {};
    var shouldUseStream = await shouldStream(file);

    if (!shouldUseStream) {
      markFullLoad('process-partial:full-read:' + (opts.label || 'unknown'), { size: file && file.size });
      return fn(file);
    }

    // Stream path: open to OPFS, chunk, call fn per chunk
    var handle  = await openFile(file);
    var results = await streamToWorker(handle, function (chunk, idx, isLast, total) {
      return fn(chunk, { chunkIndex: idx, isLast: isLast, totalSize: total });
    }, opts);

    // Cleanup OPFS file
    if (handle.opfs && handle.opfsName) {
      try {
        var dir = await _getOpfsDir();
        await dir.removeEntry(handle.opfsName);
      } catch (_) {}
    }

    return results;
  }

  // ── renderIncremental (upgraded from stub) ────────────────────────────────
  async function renderIncremental(pages, fn, opts) {
    opts = opts || {};
    if (!Array.isArray(pages) || pages.length <= 5) {
      return fn(pages);
    }
    // Stream pages in batches of 5 to keep UI responsive
    var BATCH = 5;
    var results = [];
    for (var i = 0; i < pages.length; i += BATCH) {
      var batch = pages.slice(i, i + BATCH);
      var r = await fn(batch, { batchIndex: Math.floor(i / BATCH), isLast: i + BATCH >= pages.length });
      results.push(r);
      // Yield to event loop between batches
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    return results;
  }

  // ── shouldStream (real implementation) ────────────────────────────────────
  async function shouldStream(file) {
    if (!file || file.size < STREAM_THRESHOLD_BYTES) return false;
    if (!_opfsSupported) return false;
    try {
      // Quick quota check
      var estimate = await navigator.storage.estimate();
      var quota    = estimate.quota || 0;
      var usage    = estimate.usage || 0;
      var available = quota - usage;
      // Need at least 2× the file size free in OPFS
      if (file.size * 2 > available) {
        console.warn(LOG, 'OPFS quota insufficient for', (file.size / 1024 / 1024).toFixed(1) + 'MB file');
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── OPFS stale file sweep ─────────────────────────────────────────────────
  async function sweepOpfs() {
    if (!_opfsSupported) return;
    try {
      var dir = await _getOpfsDir();
      var cutoff = Date.now() - MAX_OPFS_FILE_AGE_MS;
      for await (var [name, handle] of dir.entries()) {
        if (!name.startsWith('stream-')) continue;
        try {
          var ts = parseInt(name.split('-')[1], 10);
          if (ts && ts < cutoff) {
            await dir.removeEntry(name);
            if (global.RuntimeTelemetry) {
              try { global.RuntimeTelemetry.record('stream:opfs-sweep', { name: name }); } catch (_) {}
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Chunk telemetry (Phase 2 compat) ──────────────────────────────────────
  function recordChunk(label, chunkIndex, chunkBytes, totalBytes) {
    if (global.RuntimeTelemetry) {
      try {
        global.RuntimeTelemetry.record('stream:chunk', {
          label: label, chunk: chunkIndex,
          bytes: chunkBytes, total: totalBytes,
          pct: totalBytes > 0 ? Math.round((chunkBytes / totalBytes) * 100) : 0,
        });
      } catch (_) {}
    }
    if (global.RuntimeEventBus) {
      try {
        global.RuntimeEventBus.emit('stream:chunk', {
          label: label, chunkIndex: chunkIndex, chunkBytes: chunkBytes, totalBytes: totalBytes,
        });
      } catch (_) {}
    }
  }

  // ── scheduleStreamable (Phase 2 compat) ──────────────────────────────────
  function scheduleStreamable(fn, opts) {
    opts = opts || {};
    if (global.RuntimeScheduler) {
      return global.RuntimeScheduler.run(fn, {
        type: opts.type || 'render', priority: opts.priority || 'normal',
        label: opts.label || 'streamable', token: opts.token,
      });
    }
    return fn(function () {});
  }

  // ── canUseIDB (Phase 2 compat) ────────────────────────────────────────────
  function canUseIDB() {
    return typeof indexedDB !== 'undefined' && !!(global.RuntimeIDB || global.IDBCache);
  }

  // ── Capability report ──────────────────────────────────────────────────────
  function getCapabilities() {
    return {
      opfsAvailable:       _opfsSupported,
      idbAvailable:        canUseIDB(),
      readableStream:      _readableStreamSupported,
      transferableStream:  _transferableStream,
      streamEngineActive:  _opfsSupported,  // ← now true when OPFS is present
      streamThresholdMB:   Math.round(STREAM_THRESHOLD_BYTES / 1024 / 1024),
      defaultChunkMB:      Math.round(DEFAULT_CHUNK_BYTES / 1024 / 1024),
      markerCount:         _markers.length,
    };
  }

  function isReady() {
    return _opfsSupported && _readableStreamSupported;
  }

  // ── P1 stream marker compat ───────────────────────────────────────────────
  var _origGetMarkers = global.P1 && global.P1.getStreamMarkers ? global.P1.getStreamMarkers : null;
  if (global.P1) {
    global.P1.getStreamMarkers = function () {
      var base = _origGetMarkers ? _origGetMarkers() : [];
      return base.concat(_markers);
    };
  }

  // ── Register with RuntimeCleanup ──────────────────────────────────────────
  if (global.RuntimeCleanup && global.RuntimeCleanup.register) {
    try {
      global.RuntimeCleanup.register('opfs-sweep', function () {
        return sweepOpfs();
      }, { phase: 'idle', priority: 'low' });
    } catch (_) {}
  }

  // ── Telemetry on boot ──────────────────────────────────────────────────────
  (function _reportCapabilities() {
    var caps = getCapabilities();
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('stream:capabilities', caps); } catch (_) {}
    }
    console.info(LOG, 'RuntimeStreaming v2.0 ready — OPFS:', caps.opfsAvailable ? 'available ✓' : 'unavailable',
      '| threshold:', caps.streamThresholdMB + 'MB | chunks:', caps.defaultChunkMB + 'MB each');
  }());

  global.RuntimeStreaming = {
    // Phase 6B — new real APIs
    openFile:            openFile,
    createChunkReader:   createChunkReader,
    streamToWorker:      streamToWorker,
    streamFromWorker:    streamFromWorker,
    sweepOpfs:           sweepOpfs,
    isReady:             isReady,

    // Phase 7A — transferable stream bridge integration
    // Delegates to RuntimeStreamBridge (loaded separately). Checked lazily so
    // the bridge module can load after RuntimeStreaming without ordering issues.
    supportsTransferableStreams: function () {
      return global.RuntimeStreamBridge
        ? global.RuntimeStreamBridge.supportsTransferableStreams()
        : false;
    },
    streamToWorkerReadable: function (workerUrl, file, message, opts) {
      if (!global.RuntimeStreamBridge) {
        return Promise.reject(new Error('RuntimeStreamBridge not loaded — load runtime-stream-bridge.js'));
      }
      return global.RuntimeStreamBridge.streamToWorkerReadable(workerUrl, file, message, opts);
    },
    pipelineStreamToWorker: function (workerUrl, file, message, opts) {
      if (!global.RuntimeStreamBridge) return Promise.resolve(null);
      return global.RuntimeStreamBridge.pipelineStreamToWorker(workerUrl, file, message, opts);
    },

    // Phase 2 compat (upgraded)
    markFullLoad:        markFullLoad,
    processPartial:      processPartial,
    renderIncremental:   renderIncremental,
    recordChunk:         recordChunk,
    scheduleStreamable:  scheduleStreamable,
    shouldStream:        shouldStream,
    canUseIDB:           canUseIDB,
    getCapabilities:     getCapabilities,
    getMarkers:          function () { return _markers.slice(); },
  };

  console.debug(LOG, 'ready — T034/P6B streaming engine active (StreamEngine: live)');
}(window));
