// Large File Streaming v1.0 — Phase 25A
// Extends OPFSManager with true stream-first large-file infrastructure.
// Never loads giant files into RAM. Uses adaptive chunk sizing from MemPressure.
// Exposes: window.LargeFileStreaming
// Depends on: OPFSManager (Phase 23A), MemPressure (Phase 23A)
(function () {
  'use strict';

  var MB = 1024 * 1024;

  // ── Adaptive chunk sizing (delegates to MemPressure if available) ──────────
  function getChunkSize() {
    if (window.MemPressure && typeof window.MemPressure.chunkSize === 'function') {
      return window.MemPressure.chunkSize();
    }
    // Fallback tiers
    try {
      var used = performance.memory.usedJSHeapSize;
      var lim  = performance.memory.jsHeapSizeLimit;
      var pct  = used / lim;
      if (pct > 0.80) return 1 * MB;
      if (pct > 0.65) return 2 * MB;
      if (pct > 0.50) return 4 * MB;
    } catch (_) {}
    return 8 * MB;
  }

  // ── Checkpoint store (IDB-backed, survives page reload) ───────────────────
  var CheckpointStore = (function () {
    var DB_NAME = 'ilovepdf-lfs-cp';
    var STORE   = 'checkpoints';
    var VER     = 1;
    var TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours
    var _db     = null;

    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        try {
          var req = indexedDB.open(DB_NAME, VER);
          req.onupgradeneeded = function (ev) {
            var db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
              db.createObjectStore(STORE, { keyPath: 'id' });
            }
          };
          req.onsuccess = function () { _db = req.result; res(_db); };
          req.onerror   = function () { rej(req.error); };
        } catch (e) { rej(e); }
      });
    }

    function save(id, data) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ id: id, data: data, ts: Date.now() });
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    function load(id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx  = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).get(id);
            req.onsuccess = function () {
              var r = req.result;
              if (!r || Date.now() - r.ts > TTL_MS) return res(null);
              res(r.data);
            };
            req.onerror = function () { res(null); };
          } catch (_) { res(null); }
        });
      }).catch(function () { return null; });
    }

    function clear(id) {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = function () { res(true); };
            tx.onerror    = function () { res(false); };
          } catch (_) { res(false); }
        });
      }).catch(function () { return false; });
    }

    function sweep() {
      return open().then(function (db) {
        return new Promise(function (res) {
          try {
            var cutoff = Date.now() - TTL_MS;
            var tx     = db.transaction(STORE, 'readwrite');
            var req    = tx.objectStore(STORE).openCursor();
            req.onsuccess = function (ev) {
              var cur = ev.target.result;
              if (!cur) return res();
              if ((cur.value.ts || 0) < cutoff) cur.delete();
              cur.continue();
            };
            req.onerror = function () { res(); };
          } catch (_) { res(); }
        });
      }).catch(function () {});
    }

    // Auto-sweep on load
    if (typeof indexedDB !== 'undefined') {
      setTimeout(function () { sweep().catch(function () {}); }, 3000);
    }

    return { save: save, load: load, clear: clear };
  }());

  // ── Rolling Writer ────────────────────────────────────────────────────────
  // Accepts incoming ArrayBuffer chunks and flushes them to OPFS incrementally.
  // Never accumulates the whole file in memory.
  function createRollingWriter(key) {
    var opfs    = window.OPFSManager;
    var chunks  = [];
    var totalBytes = 0;
    var chunkIndex = 0;
    var _root   = null;
    var _prefix = null;
    var _closed = false;

    var PREFIX = 'ilovepdf_rw_' + String(key).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60) + '_';

    async function _getRoot() {
      if (_root) return _root;
      _root = await navigator.storage.getDirectory();
      return _root;
    }

    // Write one chunk directly to OPFS without buffering
    async function push(arrayBuffer) {
      if (_closed) throw new Error('rolling_writer_closed');
      var root = await _getRoot();
      var chunkName = PREFIX + 'c' + (chunkIndex++);
      var fh = await root.getFileHandle(chunkName, { create: true });
      var wr = await fh.createWritable();
      await wr.write(arrayBuffer);
      await wr.close();
      totalBytes += arrayBuffer.byteLength;
      chunks.push({ name: chunkName, size: arrayBuffer.byteLength });
      // Yield to main thread
      await new Promise(function (r) { setTimeout(r, 0); });
      return { chunkIndex: chunkIndex - 1, totalBytes: totalBytes };
    }

    // Checkpoint — save resume state to IDB
    async function checkpoint(extraMeta) {
      var meta = Object.assign({ key: key, chunks: chunks.slice(), totalBytes: totalBytes, chunkIndex: chunkIndex }, extraMeta || {});
      await CheckpointStore.save('rw:' + key, meta);
      return meta;
    }

    // Finalize — return a single merged File without ever holding it all in RAM
    // (streams chunk-by-chunk via ReadableStream → WritableStream)
    async function finalize() {
      _closed = true;
      if (!chunks.length) return new Blob([]);

      var root   = await _getRoot();
      var blobs  = [];

      for (var i = 0; i < chunks.length; i++) {
        try {
          var fh   = await root.getFileHandle(chunks[i].name);
          var file = await fh.getFile();
          blobs.push(file);
        } catch (_) {}
      }

      return new Blob(blobs, { type: 'application/octet-stream' });
    }

    // Cleanup — remove all chunk files
    async function cleanup() {
      _closed = true;
      var root = await _getRoot().catch(function () { return null; });
      if (!root) return;
      for (var i = 0; i < chunks.length; i++) {
        try { await root.removeEntry(chunks[i].name); } catch (_) {}
      }
      chunks.length = 0;
      await CheckpointStore.clear('rw:' + key).catch(function () {});
    }

    // Resume from a saved checkpoint (returns false if none found)
    async function resumeFromCheckpoint() {
      var saved = await CheckpointStore.load('rw:' + key);
      if (!saved) return false;
      chunks      = saved.chunks  || [];
      totalBytes  = saved.totalBytes || 0;
      chunkIndex  = saved.chunkIndex || 0;
      return true;
    }

    return {
      push:                 push,
      checkpoint:           checkpoint,
      finalize:             finalize,
      cleanup:              cleanup,
      resumeFromCheckpoint: resumeFromCheckpoint,
      getStats: function () {
        return { key: key, chunks: chunks.length, totalBytes: totalBytes, chunkIndex: chunkIndex };
      },
    };
  }

  // ── Rolling Read Iterator ─────────────────────────────────────────────────
  // Iterates over an OPFS-stored file in adaptive-sized chunks.
  // Usage: for await (const { buffer, offset, end } of rollingReadIterator(key)) { ... }
  function rollingReadIterator(key) {
    var opfs = window.OPFSManager;

    return {
      [Symbol.asyncIterator]: function () {
        var entry    = null;
        var chunkIdx = 0;
        var fileIdx  = 0;
        var filePos  = 0;
        var _root    = null;
        var done     = false;
        var totalRead = 0;

        return {
          next: async function () {
            if (done) return { done: true, value: null };

            // First call: resolve the manifest entry
            if (!entry) {
              try {
                _root = await navigator.storage.getDirectory();
                // Delegate manifest lookup to OPFSManager internals
                // We'll read chunk files sequentially by naming convention
                entry = { ready: true };
              } catch (_) {
                done = true;
                return { done: true, value: null };
              }
            }

            var chunkSize = getChunkSize();

            // Use OPFSManager's read API via the existing chunk model
            // This iterator reads via getFile and slices adaptively
            try {
              var file = await opfs.getFile(key);
              if (!file) { done = true; return { done: true, value: null }; }
              if (filePos >= file.size) { done = true; return { done: true, value: null }; }

              var end = Math.min(filePos + chunkSize, file.size);
              var buf = await file.slice(filePos, end).arrayBuffer();
              var off = filePos;
              filePos = end;
              totalRead += buf.byteLength;

              return { done: false, value: { buffer: buf, offset: off, end: end, total: file.size } };
            } catch (_) {
              done = true;
              return { done: true, value: null };
            }
          },
        };
      },
    };
  }

  // ── appendStream ──────────────────────────────────────────────────────────
  // Append an ArrayBuffer to an existing OPFS-staged file key.
  // Creates a new chunk beyond the existing ones.
  async function appendStream(key, arrayBuffer) {
    var opfs  = window.OPFSManager;
    if (!opfs || !opfs.available()) throw new Error('opfs_unavailable');
    var root  = await navigator.storage.getDirectory();
    // Derive the safe key the same way OPFSManager does
    var sk    = 'ilovepdf_' + String(key).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
    // Find the next available chunk index by probing
    var idx   = 0;
    while (true) {
      try { await root.getFileHandle(sk + '_c' + idx); idx++; } catch (_) { break; }
    }
    var fh = await root.getFileHandle(sk + '_c' + idx, { create: true });
    var wr = await fh.createWritable();
    await wr.write(arrayBuffer);
    await wr.close();
    return { key: key, chunkAdded: idx };
  }

  // ── createChunkedFile ─────────────────────────────────────────────────────
  // Create a file handle for sequential chunked writes (returns RollingWriter API).
  function createChunkedFile(key) {
    return createRollingWriter(key);
  }

  // ── readChunkRange ────────────────────────────────────────────────────────
  // Read a specific byte range from an OPFS-stored file without full load.
  async function readChunkRange(key, startByte, endByte) {
    var opfs = window.OPFSManager;
    if (!opfs || !opfs.available()) throw new Error('opfs_unavailable');
    try {
      var file = await opfs.getFile(key);
      if (!file) throw new Error('opfs_key_not_found: ' + key);
      var end  = endByte !== undefined ? Math.min(endByte, file.size) : file.size;
      return await file.slice(startByte || 0, end).arrayBuffer();
    } catch (e) {
      throw new Error('readChunkRange failed: ' + (e.message || e));
    }
  }

  // ── safeFlush ─────────────────────────────────────────────────────────────
  // Flush a WritableStream writer safely, creating a checkpoint.
  async function safeFlush(writer, checkpointId, meta) {
    if (!writer) return false;
    try {
      if (typeof writer.close === 'function') await writer.close();
      if (checkpointId) await CheckpointStore.save(checkpointId, Object.assign({ flushedAt: Date.now() }, meta || {}));
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── stageGiantFile ────────────────────────────────────────────────────────
  // Stage a giant file (500MB+) to OPFS without ever fully loading into RAM.
  // Uses Blob.stream() → async chunked write.
  async function stageGiantFile(file, onProgress) {
    var opfs = window.OPFSManager;
    if (!opfs || !opfs.available()) {
      // Fallback: use OPFSManager.stage() which already does chunked writes
      return opfs ? opfs.stage(file) : null;
    }

    var key     = 'giant_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var writer  = createRollingWriter(key);
    var size    = file.size;
    var pos     = 0;
    var done_b  = false;

    // Stream the file in adaptive chunks
    var reader;
    if (file.stream && typeof file.stream === 'function') {
      var stream = file.stream();
      reader     = stream.getReader();
    }

    if (reader) {
      var buffer = new Uint8Array(0);
      var chunkTarget = getChunkSize();

      while (true) {
        var _r = await reader.read();
        if (_r.done) {
          if (buffer.byteLength > 0) {
            await writer.push(buffer.buffer);
            pos += buffer.byteLength;
            if (onProgress) onProgress(pos, size);
          }
          break;
        }
        // Accumulate until we have a full chunk, then flush
        var incoming = new Uint8Array(_r.value);
        var merged   = new Uint8Array(buffer.byteLength + incoming.byteLength);
        merged.set(buffer, 0);
        merged.set(incoming, buffer.byteLength);
        buffer = merged;
        merged = null;

        if (buffer.byteLength >= chunkTarget) {
          await writer.push(buffer.buffer.slice(0));
          pos += buffer.byteLength;
          if (onProgress) onProgress(pos, size);
          buffer = new Uint8Array(0);
          chunkTarget = getChunkSize(); // re-read adaptive chunk size
          // Checkpoint every 64MB
          if (pos % (64 * MB) < chunkTarget) {
            await writer.checkpoint({ stagedBytes: pos });
          }
          // Yield to browser
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }
    } else {
      // Fallback: slice-based chunked write
      while (pos < size) {
        var chunkSz = getChunkSize();
        var end     = Math.min(pos + chunkSz, size);
        var buf     = await file.slice(pos, end).arrayBuffer();
        await writer.push(buf);
        pos = end;
        if (onProgress) onProgress(pos, size);
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }

    var blob    = await writer.finalize();
    var url     = URL.createObjectURL(blob);
    var cleaned = false;

    return {
      key:            key,
      url:            url,
      size:           size,
      strictStreaming: size >= 400 * MB,
      cleanup: function () {
        if (cleaned) return;
        cleaned = true;
        try { URL.revokeObjectURL(url); } catch (_) {}
        writer.cleanup().catch(function () {});
      },
    };
  }

  // ── Orphan recovery ───────────────────────────────────────────────────────
  // Remove stale giant_ and ilovepdf_rw_ chunk files from OPFS root.
  async function recoverOrphans(maxAgeMs) {
    var MAX = maxAgeMs || 4 * 60 * 60 * 1000;
    try {
      var root = await navigator.storage.getDirectory();
      var toDelete = [];
      var now = Date.now();
      for await (var entry of root.values()) {
        if (!entry.name) continue;
        var isOurs = entry.name.startsWith('ilovepdf_rw_') || entry.name.startsWith('ilovepdf_giant_');
        if (!isOurs) continue;
        // Try to get last modified time via File
        try {
          var fh = await root.getFileHandle(entry.name);
          var f  = await fh.getFile();
          if (now - f.lastModified > MAX) toDelete.push(entry.name);
        } catch (_) {
          toDelete.push(entry.name); // can't stat → assume stale
        }
      }
      for (var i = 0; i < toDelete.length; i++) {
        try { await root.removeEntry(toDelete[i]); } catch (_) {}
      }
      return { recovered: toDelete.length };
    } catch (_) {
      return { recovered: 0 };
    }
  }

  // Run orphan recovery at startup (after 5s delay)
  setTimeout(function () {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      recoverOrphans().catch(function () {});
    }
  }, 5000);

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  window.LargeFileStreaming = {
    version:              '1.0',
    // Core streaming
    appendStream:         appendStream,
    createChunkedFile:    createChunkedFile,
    readChunkRange:       readChunkRange,
    createRollingWriter:  createRollingWriter,
    rollingReadIterator:  rollingReadIterator,
    safeFlush:            safeFlush,
    stageGiantFile:       stageGiantFile,
    // Checkpoint / resume
    CheckpointStore:      CheckpointStore,
    // Maintenance
    recoverOrphans:       recoverOrphans,
    // Adaptive config
    getChunkSize:         getChunkSize,
  };

}());
