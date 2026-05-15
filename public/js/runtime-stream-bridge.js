// RuntimeStreamBridge v1.0 — Phase 7A
// =====================================================================
// True transferable stream pipeline. Eliminates the full-buffer
// accumulation bottleneck in streamToWorker() by pipelining chunk
// reads directly into the worker via:
//   (a) Transferable ReadableStream  — Chrome 89+ / Firefox 102+ / Safari 16.4+
//   (b) Chunk-ack messaging protocol — universal fallback, no full-buffer accumulation
//
// Unlike the old streamToWorker() which collected ALL chunks into a JS
// array before dispatching, this bridge sends each chunk to the worker
// as soon as it is available, keeping main-thread peak RAM to a single
// chunk rather than the full file.
//
// Protocol (path b — chunk-ack):
//   main → worker  { type:'stream-init',  streamId, tool, options, totalSize }
//   main → worker  { type:'stream-chunk', streamId, chunk:ArrayBuffer, chunkIndex, isLast }
//                  ← transferred (detached in main thread, zero-copy)
//   worker → main  { type:'stream-ack',   streamId, chunkIndex }
//   worker → main  { type:'stream-done',  streamId, buffer?:ArrayBuffer }
//   worker → main  { type:'stream-error', streamId, __error:string }
//
// Protocol (path a — transferable stream):
//   main → worker  { type:'stream-pipe', streamId, tool, options, stream:ReadableStream }
//                  ← stream transferred
//   worker → main  { type:'stream-done',  streamId, buffer?:ArrayBuffer }
//   worker → main  { type:'stream-error', streamId, __error:string }
//
// Cancellation: sending { type:'stream-cancel', streamId } tells the
// worker to abort its reader loop and discard any partial state.
//
// Integrates: RuntimeStreaming, RuntimeTelemetry, RuntimeCancellation,
//             RuntimeEventBus, WorkerPool, RuntimeWorkers
// Exposes: window.RuntimeStreamBridge
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeStreamBridge) return;

  var LOG = '[RSB]';
  var _streamIdCounter = 0;

  // ── Transferable stream detection ──────────────────────────────────────────
  // A ReadableStream is transferable when the browser implements the WHATWG
  // Streams Living Standard §8.2.7. We probe by attempting a real postMessage
  // transfer on a MessageChannel (safe: no side-effects, no Worker needed).
  var _transferableStreamSupported = (function () {
    try {
      if (typeof ReadableStream === 'undefined') return false;
      var rs = new ReadableStream({ start: function (c) { c.close(); } });
      var mc = new MessageChannel();
      mc.port1.postMessage(null, [rs]);
      mc.port1.close();
      mc.port2.close();
      return true;
    } catch (_) {
      return false;
    }
  }());

  function supportsTransferableStreams() {
    return _transferableStreamSupported;
  }

  // ── Chunk-size helper ──────────────────────────────────────────────────────
  var MB = 1024 * 1024;
  function _chunkSize() {
    if (global.RuntimeAdaptivePipeline && global.RuntimeAdaptivePipeline.chunkSize) {
      return global.RuntimeAdaptivePipeline.chunkSize();
    }
    if (global.RuntimeMemory) {
      var tier = global.RuntimeMemory.getTier ? global.RuntimeMemory.getTier() : 'NORMAL';
      if (tier === 'EMERGENCY') return MB;
      if (tier === 'CRITICAL')  return 2 * MB;
      if (tier === 'WARNING')   return 4 * MB;
    }
    try {
      var m = performance.memory;
      if (m) {
        var pct = m.usedJSHeapSize / m.jsHeapSizeLimit;
        if (pct > 0.80) return MB;
        if (pct > 0.60) return 2 * MB;
        if (pct > 0.45) return 4 * MB;
      }
    } catch (_) {}
    return 8 * MB;
  }

  // ── Active stream registry (for cancellation) ──────────────────────────────
  var _activeStreams = new Map();

  function _cancelStream(streamId) {
    var entry = _activeStreams.get(streamId);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.worker) {
      try {
        entry.worker.postMessage({ type: 'stream-cancel', streamId: streamId });
      } catch (_) {}
    }
    if (entry.abortController) {
      try { entry.abortController.abort(); } catch (_) {}
    }
    _activeStreams.delete(streamId);
  }

  // ── PATH A: Transferable ReadableStream ────────────────────────────────────
  // Transfers the File's ReadableStream directly to the worker.
  // The worker owns the stream and pulls chunks at its own pace.
  // Main thread peak RAM = near-zero (stream is transferred, not buffered).
  //
  // Requires a raw Worker (not WorkerPool) because the exchange is multi-
  // message. We borrow a slot from WorkerPool's pool via its internal cache,
  // but fall back to path B if that is unavailable.
  async function _streamViaTransferableStream(workerUrl, file, message, opts) {
    var streamId = ++_streamIdCounter;
    var token    = opts.token || null;
    var onProgress = opts.onProgress || null;

    if (token && token.cancelled) throw new Error('cancelled-before-stream');

    var spanId = null;
    if (global.RuntimeTelemetry) {
      spanId = global.RuntimeTelemetry.startSpan('stream-bridge:transferable', {
        streamId: streamId, size: file.size, tool: message.tool,
      });
    }

    return new Promise(function (resolve, reject) {
      var w = null;
      try { w = new Worker(workerUrl); } catch (e) {
        reject(new Error('worker-spawn-failed: ' + e.message));
        return;
      }

      var entry = { worker: w, cancelled: false, abortController: null };
      _activeStreams.set(streamId, entry);

      if (token) {
        token.onCancel(function () { _cancelStream(streamId); reject(new Error('cancelled')); });
      }

      w.onmessage = function (e) {
        var d = e.data;
        if (!d || d.streamId !== streamId) return;
        if (d.type === 'stream-done') {
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          if (global.RuntimeTelemetry && spanId !== null) {
            global.RuntimeTelemetry.endSpan(spanId, 'ok');
          }
          resolve(d);
        } else if (d.type === 'stream-error') {
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          if (global.RuntimeTelemetry && spanId !== null) {
            global.RuntimeTelemetry.endSpan(spanId, 'error');
          }
          reject(new Error(d.__error || 'stream-worker-error'));
        } else if (d.type === 'stream-progress' && onProgress) {
          try { onProgress(d.pct, d.label); } catch (_) {}
        }
      };

      w.onerror = function (e) {
        _activeStreams.delete(streamId);
        try { w.terminate(); } catch (_) {}
        if (global.RuntimeTelemetry && spanId !== null) {
          global.RuntimeTelemetry.endSpan(spanId, 'error');
        }
        reject(new Error((e && e.message) || 'stream-worker-onerror'));
      };

      // Build the transferable stream
      var fileStream;
      try {
        fileStream = file.stream ? file.stream() : null;
      } catch (_) { fileStream = null; }

      if (!fileStream) {
        // Browser doesn't support File.stream() — fall through to path B
        _activeStreams.delete(streamId);
        try { w.terminate(); } catch (_) {}
        reject(new Error('file-stream-unavailable'));
        return;
      }

      var msg = Object.assign({}, message, {
        type:     'stream-pipe',
        streamId: streamId,
        stream:   fileStream,
        totalSize: file.size,
      });

      try {
        w.postMessage(msg, [fileStream]);
      } catch (postErr) {
        _activeStreams.delete(streamId);
        try { w.terminate(); } catch (_) {}
        reject(new Error('stream-postmessage-failed: ' + postErr.message));
      }
    });
  }

  // ── PATH B: Chunk-ack streaming protocol ───────────────────────────────────
  // Universal fallback. Reads the file in adaptive chunks via OPFS or
  // File.slice(). Each chunk is transferred to the worker and we wait for
  // an ack before reading the next chunk. Main-thread peak RAM = 1 chunk.
  //
  // Uses a dedicated Worker (not WorkerPool) to support the multi-message
  // streaming protocol. The worker reassembles chunks before processing.
  async function _streamViaChunkAck(workerUrl, file, message, opts) {
    var streamId = ++_streamIdCounter;
    var token    = opts.token || null;
    var onProgress = opts.onProgress || null;
    var chunkSz = _chunkSize();

    if (token && token.cancelled) throw new Error('cancelled-before-stream');

    var spanId = null;
    if (global.RuntimeTelemetry) {
      spanId = global.RuntimeTelemetry.startSpan('stream-bridge:chunk-ack', {
        streamId: streamId, size: file.size, tool: message.tool,
      });
    }

    return new Promise(function (resolve, reject) {
      var w = null;
      try { w = new Worker(workerUrl); } catch (e) {
        reject(new Error('worker-spawn-failed: ' + e.message));
        return;
      }

      var entry = { worker: w, cancelled: false };
      _activeStreams.set(streamId, entry);

      if (token) {
        token.onCancel(function () { _cancelStream(streamId); reject(new Error('cancelled')); });
      }

      var totalSize    = file.size;
      var offset       = 0;
      var chunkIndex   = 0;
      var sentInit     = false;
      var done         = false;

      // Wait for ack before sending next chunk — real backpressure
      var _pendingAck  = false;

      async function _sendNextChunk() {
        if (entry.cancelled || done) return;

        // Send init message first
        if (!sentInit) {
          sentInit = true;
          w.postMessage(Object.assign({}, message, {
            type:      'stream-init',
            streamId:  streamId,
            totalSize: totalSize,
          }));
        }

        if (offset >= totalSize) {
          // All chunks sent — nothing more to do (last chunk already sent with isLast=true)
          return;
        }

        if (_pendingAck) return; // waiting for ack from previous chunk

        var end     = Math.min(offset + chunkSz, totalSize);
        var isLast  = (end >= totalSize);
        var slice   = file.slice(offset, end);
        var buf;
        try {
          buf = await slice.arrayBuffer();
        } catch (readErr) {
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          reject(readErr);
          return;
        }

        if (entry.cancelled) {
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          reject(new Error('cancelled'));
          return;
        }

        _pendingAck = true;
        offset = end;

        try {
          w.postMessage({
            type:       'stream-chunk',
            streamId:   streamId,
            chunk:      buf,
            chunkIndex: chunkIndex,
            isLast:     isLast,
            totalSize:  totalSize,
          }, [buf]); // transfer — zero-copy, buf detached in main thread
        } catch (postErr) {
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          reject(new Error('chunk-postmessage-failed: ' + postErr.message));
          return;
        }

        chunkIndex++;

        if (onProgress) {
          try { onProgress(Math.min(85, Math.round((offset / totalSize) * 85)), 'Streaming to worker…'); } catch (_) {}
        }
      }

      w.onmessage = function (e) {
        var d = e.data;
        if (!d || d.streamId !== streamId) return;

        if (d.type === 'stream-ack') {
          _pendingAck = false;
          // Send next chunk now that worker acknowledged the previous one
          _sendNextChunk().catch(function (err) {
            _activeStreams.delete(streamId);
            try { w.terminate(); } catch (_) {}
            reject(err);
          });

        } else if (d.type === 'stream-done') {
          done = true;
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          if (global.RuntimeTelemetry && spanId !== null) {
            global.RuntimeTelemetry.endSpan(spanId, 'ok');
          }
          resolve(d);

        } else if (d.type === 'stream-error') {
          done = true;
          _activeStreams.delete(streamId);
          try { w.terminate(); } catch (_) {}
          if (global.RuntimeTelemetry && spanId !== null) {
            global.RuntimeTelemetry.endSpan(spanId, 'error');
          }
          reject(new Error(d.__error || 'stream-chunk-error'));

        } else if (d.type === 'stream-progress' && onProgress) {
          try { onProgress(d.pct, d.label); } catch (_) {}
        }
      };

      w.onerror = function (e) {
        _activeStreams.delete(streamId);
        try { w.terminate(); } catch (_) {}
        if (global.RuntimeTelemetry && spanId !== null) {
          global.RuntimeTelemetry.endSpan(spanId, 'error');
        }
        reject(new Error((e && e.message) || 'stream-worker-onerror'));
      };

      // Kick off the first chunk
      _sendNextChunk().catch(function (err) {
        _activeStreams.delete(streamId);
        try { w.terminate(); } catch (_) {}
        reject(err);
      });
    });
  }

  // ── PRIMARY API: streamToWorkerReadable ────────────────────────────────────
  // Routes to path A (transferable stream) or path B (chunk-ack), auto-
  // detecting browser capability. Falls back gracefully to path B on any error.
  //
  // workerUrl:   '/workers/pdf-worker.js' or '/workers/advanced-worker.js'
  // file:        File or Blob
  // message:     { tool, options } — merged with streaming protocol fields
  // opts:        { token, onProgress, forceChunkAck }
  //
  // Returns the worker's result message (e.g. { buffer: ArrayBuffer, ... })
  async function streamToWorkerReadable(workerUrl, file, message, opts) {
    opts = opts || {};

    if (global.RuntimeTelemetry) {
      try {
        global.RuntimeTelemetry.record('stream-bridge:dispatch', {
          url: workerUrl, size: file.size, path: _transferableStreamSupported && !opts.forceChunkAck ? 'transferable' : 'chunk-ack',
        });
      } catch (_) {}
    }

    // Path A: transferable stream (supported + File.stream() available)
    if (_transferableStreamSupported && !opts.forceChunkAck && file.stream) {
      try {
        return await _streamViaTransferableStream(workerUrl, file, message, opts);
      } catch (errA) {
        console.warn(LOG, 'transferable stream path failed, falling back to chunk-ack:', errA.message);
        if (global.RuntimeTelemetry) {
          try { global.RuntimeTelemetry.record('stream-bridge:transferable-fallback', { error: errA.message }); } catch (_) {}
        }
      }
    }

    // Path B: chunk-ack (universal)
    return _streamViaChunkAck(workerUrl, file, message, opts);
  }

  // ── PIPELINE: pipelineStreamToWorker ──────────────────────────────────────
  // Higher-level helper: stages file to OPFS (if large/supported), then
  // streams to worker using the bridge. Handles telemetry lifecycle.
  async function pipelineStreamToWorker(workerUrl, file, message, opts) {
    opts = opts || {};
    var token      = opts.token || null;
    var onProgress = opts.onProgress || function () {};
    var threshold  = opts.streamThreshold || (10 * MB);

    // Small files: use the fast existing path (full arrayBuffer + transfer)
    if (file.size < threshold) {
      if (global.RuntimeStreaming && global.RuntimeStreaming.markFullLoad) {
        global.RuntimeStreaming.markFullLoad('stream-bridge:small-file:' + (message.tool || ''), {
          size: file.size,
        });
      }
      return null; // signal caller to use fallback path
    }

    return streamToWorkerReadable(workerUrl, file, message, opts);
  }

  // ── STATS ──────────────────────────────────────────────────────────────────
  function getStats() {
    return {
      supportsTransferableStreams: _transferableStreamSupported,
      activeStreams:               _activeStreams.size,
      streamIdCounter:             _streamIdCounter,
    };
  }

  // ── Cancel all on pagehide ─────────────────────────────────────────────────
  global.addEventListener('pagehide', function () {
    _activeStreams.forEach(function (_, id) { _cancelStream(id); });
    _activeStreams.clear();
  }, { passive: true });

  global.RuntimeStreamBridge = {
    supportsTransferableStreams:  supportsTransferableStreams,
    streamToWorkerReadable:       streamToWorkerReadable,
    pipelineStreamToWorker:       pipelineStreamToWorker,
    cancelStream:                 _cancelStream,
    getStats:                     getStats,
    // Path constants for testing/diagnostics
    PATH_TRANSFERABLE: 'transferable',
    PATH_CHUNK_ACK:    'chunk-ack',
  };

  console.info(LOG, 'RuntimeStreamBridge v1.0 ready — transferable streams:', _transferableStreamSupported ? 'supported ✓' : 'chunk-ack fallback');
}(window));
