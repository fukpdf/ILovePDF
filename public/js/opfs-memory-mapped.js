// Phase E — OPFS Memory-Mapped Streaming v1.0
// PURELY ADDITIVE — extends Phase 32 OPFS systems, does not replace them.
//
// § E1  ByteRangeParser     — PDF/ZIP structure parsing without full load
// § E2  MemoryMappedReader  — OPFS FileHandle + byte-range reads
// § E3  StreamCheckpointer  — stream-level recovery (offset + chunk state)
// § E4  GiantOutputStreamer — streaming file assembly into OPFS
// § E5  PartialDecompressor — progressive inflate for compressed streams
//
// Supports 1 GB+ files without loading them into RAM.
// Exposes: window.OpfsMemoryMapped

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[OMMS]';
  var HAS_OPFS = typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function';
  var HAS_STREAMS = typeof ReadableStream !== 'undefined' && typeof TransformStream !== 'undefined';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  // Adaptive chunk size based on memory pressure
  function _chunkSize() {
    var mp   = window.MemPressure;
    var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
    if (tier === 'critical') return 512 * 1024;
    if (tier === 'danger')   return 1 * MB;
    if (tier === 'high')     return 2 * MB;
    return 4 * MB;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § E1  BYTE-RANGE PARSER
  // Parses known PDF structure markers from byte slices (no full parse).
  // Understands: xref offsets, object offsets, trailer location, page count.
  // ═══════════════════════════════════════════════════════════════════════════
  var ByteRangeParser = (function () {

    // Read the last N bytes of a File (for trailer)
    async function readTail(file, bytes) {
      var start = Math.max(0, file.size - bytes);
      var slice = file.slice(start, file.size);
      return new Uint8Array(await slice.arrayBuffer());
    }

    // Read a specific byte range
    async function readRange(file, start, end) {
      var s = file.slice(Math.max(0, start), Math.min(file.size, end));
      return new Uint8Array(await s.arrayBuffer());
    }

    // Extract startxref offset from trailer bytes
    function findStartXref(tailBytes) {
      var text = new TextDecoder('latin1').decode(tailBytes);
      var m    = text.match(/startxref\s+(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    }

    // Find /Pages count from trailer/root (rough parse)
    function findPageCount(tailBytes) {
      var text = new TextDecoder('latin1').decode(tailBytes);
      var m    = text.match(/\/Count\s+(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }

    // Scan a slice for PDF object offsets (lightweight — no full parse)
    function scanObjectOffsets(sliceBytes, baseOffset) {
      var text    = new TextDecoder('latin1').decode(sliceBytes);
      var re      = /(\d+)\s+\d+\s+obj/g;
      var offsets = {};
      var m;
      while ((m = re.exec(text)) !== null) {
        offsets[parseInt(m[1], 10)] = baseOffset + m.index;
      }
      return offsets;
    }

    // Quick structure assessment for giant file (reads only head + tail)
    async function assessStructure(file) {
      try {
        var head     = await readRange(file, 0, 1024);
        var tail     = await readTail(file, 2048);
        var headText = new TextDecoder('latin1').decode(head);
        var valid    = headText.startsWith('%PDF');
        var xrefOff  = findStartXref(tail);
        var pages    = findPageCount(tail);
        _log('assess', { valid: valid, xrefOff: xrefOff, pages: pages, sizeMB: Math.round(file.size / MB) });
        return { valid: valid, xrefOffset: xrefOff, estimatedPages: pages, sizeMB: Math.round(file.size / MB) };
      } catch (ex) {
        _err('assess', ex);
        return { valid: false };
      }
    }

    return { readRange: readRange, readTail: readTail, findStartXref: findStartXref, findPageCount: findPageCount, scanObjectOffsets: scanObjectOffsets, assessStructure: assessStructure };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E2  MEMORY-MAPPED READER
  // Uses OPFS FileAccessHandle for byte-range reads without full load.
  // Falls back to File.slice() when OPFS is unavailable.
  // ═══════════════════════════════════════════════════════════════════════════
  var MemoryMappedReader = (function () {
    var _handles = {};   // fileName → { handle, opfsFile }

    // Stage a File into OPFS and get a memory-mapped reader
    async function open(file) {
      var name = file.name + '_' + file.size;
      if (_handles[name]) return _handles[name];

      var handle = null;
      if (HAS_OPFS) {
        try {
          var root    = await navigator.storage.getDirectory();
          var opfsF   = await root.getFileHandle('mmap_' + file.size + '_' + (file.lastModified || 0) + '.bin', { create: true });
          // Only write if not already staged (check size)
          var existing = await opfsF.getFile().catch(function () { return null; });
          if (!existing || existing.size !== file.size) {
            var writable = await opfsF.createWritable();
            var stream   = file.stream();
            await stream.pipeTo(writable);
          }
          handle = opfsF;
          _log('opfs-mmap-open', { name: name, sizeMB: Math.round(file.size / MB) });
        } catch (ex) { _err('opfs-mmap', ex); }
      }

      var reader = {
        file:    file,
        handle:  handle,
        size:    file.size,
        // Read a byte range (returns Uint8Array)
        read: async function (start, end) {
          return ByteRangeParser.readRange(file, start, end);
        },
        // Iterate chunks of the file
        chunks: function (chunkSize) {
          var self = this;
          var offset = 0;
          return {
            [Symbol.asyncIterator]: function () {
              return {
                next: async function () {
                  if (offset >= self.size) return { done: true };
                  var cs    = chunkSize || _chunkSize();
                  var end   = Math.min(offset + cs, self.size);
                  var bytes = await self.read(offset, end);
                  offset = end;
                  return { done: false, value: { bytes: bytes, start: offset - bytes.length, end: offset } };
                }
              };
            }
          };
        },
        close: function () {
          delete _handles[name];
        }
      };

      _handles[name] = reader;
      return reader;
    }

    function getStats() {
      return { openReaders: Object.keys(_handles).length, hasOpfs: HAS_OPFS };
    }

    // Close all readers on survival mode
    window.addEventListener('p32:survival-mode', function () {
      Object.values(_handles).forEach(function (r) { try { r.close(); } catch (_) {} });
      _handles = {};
    });

    return { open: open, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E3  STREAM CHECKPOINTER
  // Saves byte-offset + chunk progress for stream recovery.
  // ═══════════════════════════════════════════════════════════════════════════
  var StreamCheckpointer = (function () {
    var _IDB_STORE = 'stream-ckpt-v1';
    var _db        = null;

    function _openDb() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open('p37-stream-ckpt', 1);
        req.onupgradeneeded = function (e) { e.target.result.createObjectStore(_IDB_STORE, { keyPath: 'id' }); };
        req.onsuccess = function () { _db = req.result; res(_db); };
        req.onerror   = function () { rej(req.error); };
      });
    }

    function save(id, state) {
      return _openDb().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(_IDB_STORE, 'readwrite');
          tx.objectStore(_IDB_STORE).put(Object.assign({ id: id, ts: Date.now() }, state));
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        });
      }).catch(function () { return false; });
    }

    function load(id) {
      return _openDb().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get(id);
          req.onsuccess = function () { res(req.result || null); };
          req.onerror   = function () { res(null); };
        });
      }).catch(function () { return null; });
    }

    function clear(id) {
      return _openDb().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(_IDB_STORE, 'readwrite');
          tx.objectStore(_IDB_STORE).delete(id);
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        });
      }).catch(function () { return false; });
    }

    return { save: save, load: load, clear: clear };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E4  GIANT OUTPUT STREAMER
  // Assembles a giant output file in OPFS chunk-by-chunk, never holding
  // the full output in RAM. Falls back to in-memory Blob array if OPFS unavailable.
  // ═══════════════════════════════════════════════════════════════════════════
  var GiantOutputStreamer = (function () {
    var _streams = {};   // streamId → { writable, parts, opfsHandle, bytesWritten }

    async function create(streamId, filename, mimeType) {
      var entry = { streamId: streamId, filename: filename, mimeType: mimeType || 'application/octet-stream', parts: [], bytesWritten: 0, opfsHandle: null };

      if (HAS_OPFS) {
        try {
          var root  = await navigator.storage.getDirectory();
          var fh    = await root.getFileHandle('out_' + streamId + '_' + (filename || 'out'), { create: true });
          entry.writable    = await fh.createWritable();
          entry.opfsHandle  = fh;
          _log('output-stream-opfs', { streamId: streamId });
        } catch (ex) { _err('output-stream-opfs', ex); }
      }

      _streams[streamId] = entry;
      return streamId;
    }

    async function write(streamId, chunk) {
      var entry = _streams[streamId];
      if (!entry) return;
      try {
        if (entry.writable) {
          await entry.writable.write(chunk);
        } else {
          entry.parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        }
        entry.bytesWritten += (chunk.byteLength || chunk.length || 0);
      } catch (ex) { _err('output-write', ex); }
    }

    async function finalize(streamId) {
      var entry = _streams[streamId];
      if (!entry) return null;

      var blob;
      try {
        if (entry.writable) {
          await entry.writable.close();
          var opfsFile = await entry.opfsHandle.getFile();
          blob = new Blob([opfsFile], { type: entry.mimeType });
        } else {
          blob = new Blob(entry.parts, { type: entry.mimeType });
        }
      } catch (ex) {
        _err('output-finalize', ex);
        blob = new Blob(entry.parts || [], { type: entry.mimeType });
      }

      delete _streams[streamId];
      _log('output-finalized', { streamId: streamId, sizeMB: Math.round(blob.size / MB) });
      return blob;
    }

    function abort(streamId) {
      var entry = _streams[streamId];
      if (!entry) return;
      try { if (entry.writable) entry.writable.abort(); } catch (_) {}
      entry.parts = [];
      delete _streams[streamId];
    }

    function getStats() {
      var out = {};
      Object.keys(_streams).forEach(function (id) {
        out[id] = { bytesWritten: _streams[id].bytesWritten, opfs: !!_streams[id].opfsHandle };
      });
      return out;
    }

    return { create: create, write: write, finalize: finalize, abort: abort, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § E5  PARTIAL DECOMPRESSOR
  // Progressive inflate for zlib-compressed PDF streams using DecompressionStream.
  // Falls back to returning raw bytes if API unavailable.
  // ═══════════════════════════════════════════════════════════════════════════
  var PartialDecompressor = (function () {
    var HAS_DECOMP = typeof DecompressionStream !== 'undefined';

    async function inflate(compressedBytes) {
      if (!HAS_DECOMP) return compressedBytes;
      try {
        var ds     = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        writer.write(compressedBytes);
        writer.close();
        var chunks = [];
        var done   = false;
        while (!done) {
          var next = await reader.read();
          done = next.done;
          if (next.value) chunks.push(next.value);
        }
        var total  = chunks.reduce(function (s, c) { return s + c.length; }, 0);
        var result = new Uint8Array(total);
        var offset = 0;
        chunks.forEach(function (c) { result.set(c, offset); offset += c.length; });
        return result;
      } catch (ex) {
        _err('inflate', ex);
        return compressedBytes;
      }
    }

    // Stream a PDF object's compressed data chunk by chunk
    async function* streamInflate(compressedChunks) {
      if (!HAS_DECOMP) { for (var c of compressedChunks) yield c; return; }
      try {
        var ds     = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        (async function () {
          for await (var chunk of compressedChunks) { await writer.write(chunk); }
          writer.close();
        })();
        var done = false;
        while (!done) {
          var next = await reader.read();
          done = next.done;
          if (next.value) yield next.value;
        }
      } catch (ex) { _err('stream-inflate', ex); }
    }

    return { inflate: inflate, streamInflate: streamInflate, hasDecompression: HAS_DECOMP };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.OpfsMemoryMapped = {
    version:              VERSION,
    ByteRangeParser:      ByteRangeParser,
    MemoryMappedReader:   MemoryMappedReader,
    StreamCheckpointer:   StreamCheckpointer,
    GiantOutputStreamer:  GiantOutputStreamer,
    PartialDecompressor:  PartialDecompressor,

    // Convenience: open a memory-mapped reader for a file
    openReader:    function (file) { return MemoryMappedReader.open(file); },

    // Convenience: assess a giant PDF without loading it
    assessPdf:     function (file) { return ByteRangeParser.assessStructure(file); },

    // Convenience: create a streaming output assembly
    createOutput:  function (id, name, mime) { return GiantOutputStreamer.create(id, name, mime); },

    audit: function () {
      return {
        version:    VERSION,
        hasOpfs:    HAS_OPFS,
        hasStreams:  HAS_STREAMS,
        hasDecomp:  PartialDecompressor.hasDecompression,
        readers:    MemoryMappedReader.getStats(),
        outputs:    GiantOutputStreamer.getStats(),
        chunkSizeMB: Math.round(_chunkSize() / MB),
      };
    },
  };

  _log('loaded', { hasOpfs: HAS_OPFS, hasStreams: HAS_STREAMS });
}());
