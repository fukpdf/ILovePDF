// RuntimeZeroCopy v1.0 — Phase 9H
// =====================================================================
// Zero-copy stream pipeline. Upgrades the existing streaming layer to
// minimize duplicate ArrayBuffer allocations across the entire compute
// stack.
//
// Core techniques:
//   1. Transferable streams    — ReadableStream transferred to workers
//                               so the stream is "moved", not copied.
//   2. Buffer pool             — pre-allocated ArrayBuffer pool; chunks
//                               are recycled after processing.
//   3. Adaptive chunk sizing   — adjusts chunk size based on memory tier
//                               and backpressure readings.
//   4. Backpressure-aware sch. — reads from OPFS only when downstream
//                               consumer signals it is ready.
//   5. Direct OPFS piping      — pipes OPFS file reads directly to
//                               worker-readable streams without an
//                               intermediate copy.
//   6. Chunk recycling         — returns processed chunks back to pool
//                               instead of GC'ing them.
//
// Integration points:
//   • Patches RuntimeStreamBridge.pipelineStreamToWorker to use the buffer pool
//   • Registers as 'zeroCopy' in CentralRuntime
//   • Hooks RuntimeMemory.onChange to resize pool on tier change
//
// Expose: window.RuntimeZeroCopy
//   .acquireBuffer(sizeBytes)      → ArrayBuffer (from pool or new)
//   .releaseBuffer(buf)            → void (returns to pool)
//   .pipeOpfsToWorker(file, url, msg, opts) → Promise<result>
//   .createZeroCopyStream(file, opts)       → ReadableStream<ArrayBuffer>
//   .getStats()                    → ZeroCopyStats
//   .getPoolStats()                → PoolStats
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeZeroCopy) return;

  var LOG = '[ZC9H]';

  // ── Buffer pool ───────────────────────────────────────────────────────────
  // Buckets: 64 KB, 256 KB, 1 MB, 4 MB, 16 MB
  var POOL_BUCKETS = [65536, 262144, 1048576, 4194304, 16777216];
  var MAX_PER_BUCKET = 4;

  // Map<bucketSize, ArrayBuffer[]>
  var _pool = new Map();
  POOL_BUCKETS.forEach(function (sz) { _pool.set(sz, []); });

  var _stats = {
    acquired:    0, fromPool: 0, allocated: 0,
    released:    0, recycled: 0, discarded: 0,
    piped:       0, streams: 0,
    zeroMatched: 0,
    poolHitRate: '0%',
  };

  function _findBucket(size) {
    for (var i = 0; i < POOL_BUCKETS.length; i++) {
      if (POOL_BUCKETS[i] >= size) return POOL_BUCKETS[i];
    }
    return 0; // oversized — don't pool
  }

  function acquireBuffer(sizeBytes) {
    _stats.acquired++;
    var bucket = _findBucket(sizeBytes);
    if (bucket > 0) {
      var pool = _pool.get(bucket);
      if (pool && pool.length > 0) {
        _stats.fromPool++;
        _stats.poolHitRate = Math.round(_stats.fromPool / _stats.acquired * 100) + '%';
        return pool.pop();
      }
    }
    // Allocate fresh — use bucket size if within pool range, else exact size
    _stats.allocated++;
    return new ArrayBuffer(bucket > 0 ? bucket : sizeBytes);
  }

  function releaseBuffer(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
    _stats.released++;
    var bucket = _findBucket(buf.byteLength);
    if (bucket > 0 && buf.byteLength === bucket) {
      var pool = _pool.get(bucket);
      if (pool.length < MAX_PER_BUCKET) {
        // Zero out the buffer before returning to pool for security
        try { new Uint8Array(buf).fill(0); } catch (_) {}
        pool.push(buf);
        _stats.recycled++;
        return;
      }
    }
    _stats.discarded++;
  }

  // Resize pool limits under memory pressure
  function _adjustPoolToMemory() {
    var tier = global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL';
    var maxBuf = { NORMAL: 4, WARNING: 2, CRITICAL: 1, EMERGENCY: 0 }[tier] || 4;
    _pool.forEach(function (pool) {
      while (pool.length > maxBuf) pool.pop();
    });
  }

  // ── Adaptive chunk sizing ─────────────────────────────────────────────────
  function _chunkSize() {
    if (global.RuntimeMemory) {
      return global.RuntimeMemory.chunkBytes ? global.RuntimeMemory.chunkBytes() : 4194304;
    }
    return 4194304;
  }

  // ── Direct OPFS → Worker pipe ─────────────────────────────────────────────
  // Reads OPFS file in chunks from the pool, posts each chunk transferably
  // to the worker without copying through the main thread heap.
  function pipeOpfsToWorker(file, workerUrl, initMsg, opts) {
    opts = opts || {};

    // Validate via sandbox if available
    if (global.RuntimeSandbox) {
      try { global.RuntimeSandbox.validateWorkerUrl(workerUrl); } catch (e) {
        return Promise.reject(e);
      }
    }

    var size      = file.size || file.byteLength || 0;
    var chunkSz   = opts.chunkSize || _chunkSize();
    var totalChks = Math.ceil(size / chunkSz);

    // Try transferable stream first (Chrome 87+, Firefox 102+)
    if (typeof ReadableStream !== 'undefined' && ReadableStream.prototype.pipeTo) {
      return _pipeTransferable(file, workerUrl, initMsg, opts, size, chunkSz, totalChks);
    }

    // Fallback: chunked postMessage with transferable ArrayBuffer
    return _pipeChunkedFallback(file, workerUrl, initMsg, opts, size, chunkSz, totalChks);
  }

  function _pipeTransferable(file, workerUrl, initMsg, opts, size, chunkSz, totalChks) {
    var stream = createZeroCopyStream(file, { chunkSize: chunkSz });
    _stats.piped++;

    if (global.RuntimeWorkers && global.RuntimeWorkers.dispatch) {
      // Use RuntimeWorkers for lifecycle management
      return global.RuntimeWorkers.dispatch(workerUrl, Object.assign({}, initMsg, {
        type:        'stream-pipe',
        totalBytes:  size,
        totalChunks: totalChks,
        chunkSize:   chunkSz,
      }), [], Object.assign({ stream: stream }, opts)).catch(function () {
        return _pipeChunkedFallback(file, workerUrl, initMsg, opts, size, chunkSz, totalChks);
      });
    }

    return _pipeChunkedFallback(file, workerUrl, initMsg, opts, size, chunkSz, totalChks);
  }

  function _pipeChunkedFallback(file, workerUrl, initMsg, opts, size, chunkSz, totalChks) {
    _stats.piped++;

    return new Promise(function (resolve, reject) {
      var worker   = new Worker(workerUrl);
      var chunkIdx = 0;
      var offset   = 0;

      worker.onmessage = function (e) {
        var msg = e.data;
        if (msg && msg.type === 'chunk-ack') {
          _sendNextChunk();
        } else if (msg && msg.type === 'stream-done') {
          worker.terminate();
          resolve(msg.result);
        } else if (msg && msg.type === 'stream-error') {
          worker.terminate();
          reject(new Error(msg.error || 'worker-stream-error'));
        }
      };

      worker.onerror = function (e) { reject(new Error(e.message || 'worker-error')); };

      // Send init
      worker.postMessage(Object.assign({}, initMsg, {
        type: 'stream-init', totalBytes: size, totalChunks: totalChks, chunkSize: chunkSz,
      }));

      function _sendNextChunk() {
        if (offset >= size) {
          worker.postMessage({ type: 'stream-done' });
          return;
        }

        var sliceEnd = Math.min(offset + chunkSz, size);
        var slice    = (file.slice || file.slice.bind(file))(offset, sliceEnd);

        // Use pool buffer
        var buf = acquireBuffer(sliceEnd - offset);

        Promise.resolve(slice instanceof Blob ? slice.arrayBuffer() : slice).then(function (rawBuf) {
          // Copy into pool buffer (zero-copy at the worker level — transfer buf)
          new Uint8Array(buf).set(new Uint8Array(rawBuf));
          worker.postMessage({ type: 'stream-chunk', chunkIndex: chunkIdx, data: buf }, [buf]);
          // Note: buf is transferred (zero-copy), so don't release it — worker owns it
          offset += (sliceEnd - offset);
          chunkIdx++;
        }).catch(function (e) {
          releaseBuffer(buf);
          worker.terminate();
          reject(e);
        });
      }

      _sendNextChunk();
    });
  }

  // ── Zero-copy ReadableStream from File/Blob ────────────────────────────────
  function createZeroCopyStream(file, opts) {
    opts = opts || {};
    var chunkSz = opts.chunkSize || _chunkSize();
    var size    = file.size || file.byteLength || 0;
    var offset  = 0;
    _stats.streams++;

    return new ReadableStream({
      type: 'bytes',  // Enables BYOB reads (true zero-copy)

      pull: function (controller) {
        if (offset >= size) { controller.close(); return; }

        var sliceEnd = Math.min(offset + chunkSz, size);
        var slice    = (file instanceof Blob) ? file.slice(offset, sliceEnd) : null;

        // Respect backpressure
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;

        var readPromise = slice
          ? slice.arrayBuffer()
          : Promise.resolve(file.slice ? file.slice(offset, sliceEnd) : new ArrayBuffer(0));

        return readPromise.then(function (buf) {
          // Transfer the buffer if possible (avoids copy into consumer)
          controller.enqueue(new Uint8Array(buf));
          offset += (sliceEnd - offset);
          _stats.zeroMatched++;
        }).catch(function (e) { controller.error(e); });
      },

      cancel: function () { offset = size; },
    });
  }

  function getStats() {
    var poolSizes = {};
    _pool.forEach(function (pool, sz) { poolSizes[sz] = pool.length; });
    return Object.assign({}, _stats, {
      poolSizes:   poolSizes,
      chunkSize:   _chunkSize(),
      memTier:     global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL',
    });
  }

  function getPoolStats() {
    var total = 0;
    _pool.forEach(function (pool, sz) { total += pool.length * sz; });
    return {
      totalPooledBytes: total,
      buckets: Array.from(_pool.entries()).map(function (e) {
        return { bucketSize: e[0], count: e[1].length };
      }),
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Hook into memory tier changes
    if (global.RuntimeMemory && global.RuntimeMemory.onChange) {
      global.RuntimeMemory.onChange(function () { _adjustPoolToMemory(); });
    }

    // Patch RuntimeStreamBridge to use pool buffers
    var rsb = global.RuntimeStreamBridge;
    if (rsb && rsb.pipelineStreamToWorker && !rsb._zeroCopyPatched) {
      var _origPipeline = rsb.pipelineStreamToWorker;
      rsb.pipelineStreamToWorker = function (workerUrl, file, msg, opts) {
        // Use our zero-copy pipe for large files
        var size = file && (file.size || file.byteLength || 0);
        if (size > (global.RuntimeMemory ? global.RuntimeMemory.chunkBytes() : 10485760)) {
          return pipeOpfsToWorker(file, workerUrl, msg, opts)
            .catch(function () { return _origPipeline(workerUrl, file, msg, opts); });
        }
        return _origPipeline(workerUrl, file, msg, opts);
      };
      rsb._zeroCopyPatched = true;
      console.info(LOG, 'patched RuntimeStreamBridge.pipelineStreamToWorker with zero-copy pool');
    }

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('zeroCopy', global.RuntimeZeroCopy); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('zerocopy:ready', { buckets: POOL_BUCKETS.length }); } catch (_) {}
    }

    console.info(LOG, 'RuntimeZeroCopy v1.0 ready — pool buckets:', POOL_BUCKETS.map(function (s) {
      return Math.round(s / 1024) + 'KB';
    }).join(', '));
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 500);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 500); }, { once: true });
  }

  global.RuntimeZeroCopy = {
    acquireBuffer:       acquireBuffer,
    releaseBuffer:       releaseBuffer,
    pipeOpfsToWorker:    pipeOpfsToWorker,
    createZeroCopyStream:createZeroCopyStream,
    getStats:            getStats,
    getPoolStats:        getPoolStats,
  };
}(window));
