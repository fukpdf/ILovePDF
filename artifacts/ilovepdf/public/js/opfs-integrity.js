// Phase 40C — OPFS Integrity System v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § C1  CRC32Engine        — fast CRC32 checksum for bytes
// § C2  WriteJournal       — before/after write log; replay on reload
// § C3  StagedWriteVerifier— write → verify → commit (never corrupt partial)
// § C4  OrphanRecovery     — detects and removes stale temp files
// § C5  IntegrityCheck     — on-demand checksum validation of OPFS files
//
// Exposes: window.OpfsIntegrity

(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG_PFX  = '[OI]';
  var HAS_OPFS = typeof navigator !== 'undefined' && typeof navigator.storage !== 'undefined' && typeof navigator.storage.getDirectory === 'function';
  var MB       = 1024 * 1024;

  function _log(t, d)  { try { window.DebugTrace && window.DebugTrace.log  && window.DebugTrace.log (LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _warn(t, d) { try { console.warn(LOG_PFX, t, d || ''); } catch (_) {} }


  // ═══════════════════════════════════════════════════════════════════════════
  // § C1  CRC32 ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var CRC32Engine = (function () {
    var _table = (function () {
      var t = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    }());

    function crc32(bytes) {
      var crc = 0xFFFFFFFF;
      var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      for (var i = 0; i < arr.length; i++) crc = _table[(crc ^ arr[i]) & 0xFF] ^ (crc >>> 8);
      return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
    }

    return { crc32: crc32 };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C2  WRITE JOURNAL (IDB-backed)
  // ═══════════════════════════════════════════════════════════════════════════
  var WriteJournal = (function () {
    var _DB    = 'p40-opfs-journal';
    var _STORE = 'journal';
    var _db    = null;

    function _open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(_DB, 1);
        req.onupgradeneeded = function (e) { e.target.result.createObjectStore(_STORE, { keyPath: 'id' }); };
        req.onsuccess = function () { _db = req.result; res(_db); };
        req.onerror   = function () { rej(req.error); };
      });
    }

    function write(id, entry) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(_STORE, 'readwrite');
          tx.objectStore(_STORE).put(Object.assign({ id: id, ts: Date.now() }, entry));
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        });
      }).catch(function () { return false; });
    }

    function read(id) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction(_STORE, 'readonly').objectStore(_STORE).get(id);
          req.onsuccess = function () { res(req.result || null); };
          req.onerror   = function () { res(null); };
        });
      }).catch(function () { return null; });
    }

    function remove(id) {
      return _open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction(_STORE, 'readwrite');
          tx.objectStore(_STORE).delete(id);
          tx.oncomplete = function () { res(true); };
          tx.onerror    = function () { res(false); };
        });
      }).catch(function () { return false; });
    }

    function getAll() {
      return _open().then(function (db) {
        return new Promise(function (res) {
          var req = db.transaction(_STORE, 'readonly').objectStore(_STORE).getAll();
          req.onsuccess = function () { res(req.result || []); };
          req.onerror   = function () { res([]); };
        });
      }).catch(function () { return []; });
    }

    return { write: write, read: read, remove: remove, getAll: getAll };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C3  STAGED WRITE VERIFIER
  // Write to temp file → verify CRC → rename to final; never corrupts original.
  // ═══════════════════════════════════════════════════════════════════════════
  var StagedWriteVerifier = (function () {

    async function writeVerified(filename, bytes, mimeType) {
      if (!HAS_OPFS) return { success: false, reason: 'no-opfs' };
      var tmpName = 'tmp_' + Date.now() + '_' + filename;
      var crc     = CRC32Engine.crc32(bytes);
      var writeId = 'write_' + Date.now();

      // Journal: begin
      await WriteJournal.write(writeId, { stage: 'begin', filename: filename, tmpName: tmpName, crc: crc, sizeBytes: bytes.byteLength || bytes.length });

      try {
        var root   = await navigator.storage.getDirectory();
        var tmpH   = await root.getFileHandle(tmpName, { create: true });
        var wr     = await tmpH.createWritable();
        await wr.write(bytes instanceof ArrayBuffer ? bytes : bytes.buffer || bytes);
        await wr.close();

        // Verify: read back and CRC-check
        var tmpF    = await tmpH.getFile();
        var readBuf = await tmpF.arrayBuffer();
        var readCrc = CRC32Engine.crc32(new Uint8Array(readBuf));

        if (readCrc !== crc) {
          await WriteJournal.write(writeId, { stage: 'crc-fail', expected: crc, got: readCrc });
          _warn('crc-mismatch', { file: filename, expected: crc, got: readCrc });
          return { success: false, reason: 'crc-mismatch', expected: crc, got: readCrc };
        }

        // Commit: save final under permanent name (OPFS no rename API — copy then delete tmp)
        var finalH = await root.getFileHandle(filename, { create: true });
        var finalW = await finalH.createWritable();
        await finalW.write(readBuf);
        await finalW.close();

        // Remove tmp
        try { await root.removeEntry(tmpName); } catch (_) {}

        // Journal: committed
        await WriteJournal.remove(writeId);
        _log('staged-write-ok', { filename: filename, crc: crc, sizeKB: Math.round((bytes.byteLength || bytes.length) / 1024) });
        return { success: true, crc: crc, filename: filename };

      } catch (ex) {
        await WriteJournal.write(writeId, { stage: 'error', err: ex.message });
        _warn('staged-write-err', ex.message);
        return { success: false, reason: ex.message };
      }
    }

    async function replayPending() {
      var pending = await WriteJournal.getAll();
      var begun   = pending.filter(function (j) { return j.stage === 'begin'; });
      _log('replay-pending', { count: begun.length });
      // For each incomplete write: just clean up tmp files and journal entries
      for (var entry of begun) {
        try {
          var root = await navigator.storage.getDirectory();
          try { await root.removeEntry(entry.tmpName); } catch (_) {}
        } catch (_) {}
        await WriteJournal.remove(entry.id);
      }
      return begun.length;
    }

    return { writeVerified: writeVerified, replayPending: replayPending };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C4  ORPHAN RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════
  var OrphanRecovery = (function () {
    var MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 24h

    async function findOrphans() {
      if (!HAS_OPFS) return [];
      var orphans = [];
      try {
        var root = await navigator.storage.getDirectory();
        for await (var [name, handle] of root.entries()) {
          // Temp files: start with tmp_ or mmap_ or out_
          if (/^(tmp_|mmap_|out_)/.test(name)) {
            var f   = await handle.getFile().catch(function () { return null; });
            var age = f ? Date.now() - (f.lastModified || 0) : MAX_AGE_MS + 1;
            if (age > MAX_AGE_MS) orphans.push({ name: name, ageh: Math.round(age / 3600000) });
          }
        }
      } catch (_) {}
      return orphans;
    }

    async function removeOrphans() {
      var orphans = await findOrphans();
      var removed = 0;
      if (!HAS_OPFS) return { removed: 0, orphans: [] };
      try {
        var root = await navigator.storage.getDirectory();
        for (var o of orphans) {
          try { await root.removeEntry(o.name); removed++; } catch (_) {}
        }
      } catch (_) {}
      _log('orphan-recovery', { removed: removed });
      return { removed: removed, orphans: orphans };
    }

    // Run on load
    setTimeout(function () { removeOrphans().catch(function () {}); }, 5000);

    return { findOrphans: findOrphans, removeOrphans: removeOrphans };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § C5  INTEGRITY CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  var IntegrityCheck = (function () {

    async function checkFile(filename, expectedCrc) {
      if (!HAS_OPFS) return { ok: false, reason: 'no-opfs' };
      try {
        var root = await navigator.storage.getDirectory();
        var fh   = await root.getFileHandle(filename, { create: false });
        var f    = await fh.getFile();
        var buf  = await f.arrayBuffer();
        var crc  = CRC32Engine.crc32(new Uint8Array(buf));
        var ok   = !expectedCrc || crc === expectedCrc;
        return { ok: ok, crc: crc, expected: expectedCrc, sizeMB: Math.round(f.size / MB) };
      } catch (ex) {
        return { ok: false, reason: ex.message };
      }
    }

    async function checkAll() {
      if (!HAS_OPFS) return { ok: true, files: [], note: 'no-opfs' };
      var results = [];
      try {
        var root = await navigator.storage.getDirectory();
        for await (var [name, handle] of root.entries()) {
          if (/^tmp_/.test(name)) continue;
          var r = await checkFile(name, null);
          results.push(Object.assign({ name: name }, r));
        }
      } catch (_) {}
      _log('integrity-check', { files: results.length });
      return { ok: results.every(function (r) { return r.ok; }), files: results };
    }

    return { checkFile: checkFile, checkAll: checkAll };
  }());


  // ── Replay pending journal entries on boot ─────────────────────────────────
  setTimeout(function () {
    StagedWriteVerifier.replayPending().catch(function () {});
  }, 2000);


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.OpfsIntegrity = {
    version:              VERSION,
    CRC32Engine:          CRC32Engine,
    WriteJournal:         WriteJournal,
    StagedWriteVerifier:  StagedWriteVerifier,
    OrphanRecovery:       OrphanRecovery,
    IntegrityCheck:       IntegrityCheck,

    writeVerified: function (name, bytes, mime) { return StagedWriteVerifier.writeVerified(name, bytes, mime); },
    checkFile:     function (name, crc)         { return IntegrityCheck.checkFile(name, crc); },
    crc32:         function (bytes)             { return CRC32Engine.crc32(bytes); },

    audit: async function () {
      var orphans = await OrphanRecovery.findOrphans();
      var check   = await IntegrityCheck.checkAll();
      var pending = await WriteJournal.getAll();
      return {
        version:        VERSION,
        hasOpfs:        HAS_OPFS,
        orphans:        orphans.length,
        integrityOk:    check.ok,
        filesChecked:   check.files.length,
        pendingWrites:  pending.length,
      };
    },
  };

  _log('loaded', { hasOpfs: HAS_OPFS });
}());
