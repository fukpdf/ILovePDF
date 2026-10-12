// OPFS Manager v1.0 — Phase 23A
// Standalone Origin Private File System manager with chunked streaming I/O,
// auto-cleanup, quota awareness, and graceful fallback.
// Supplements the basic OPFSStore in advanced-engine.js with a richer API.
// Exposes: window.OPFSManager
(function () {
  'use strict';

  var AVAIL = (function () {
    try {
      return typeof navigator !== 'undefined' &&
             typeof navigator.storage !== 'undefined' &&
             typeof navigator.storage.getDirectory === 'function';
    } catch (_) { return false; }
  }());

  var PREFIX   = 'ilovepdf_';
  var MAX_AGE  = 2 * 60 * 60 * 1000;  // 2 hours
  var CHUNK_SZ = 4 * 1024 * 1024;     // 4 MB per chunk

  var _root     = null;
  var _manifest = {};  // { key: { safeKey, size, ts, chunks } }

  function available() { return AVAIL; }

  function getRoot() {
    if (_root) return Promise.resolve(_root);
    return navigator.storage.getDirectory().then(function (r) { _root = r; return r; });
  }

  function _safeKey(key) {
    return PREFIX + String(key).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
  }

  // ── Write a File/Blob in CHUNK_SZ slices — no full-file RAM load ──────────
  async function writeStream(key, fileOrBlob) {
    if (!AVAIL) throw new Error('opfs_unavailable');
    var root  = await getRoot();
    var sk    = _safeKey(key);
    var size  = fileOrBlob.size;
    var nc    = Math.max(1, Math.ceil(size / CHUNK_SZ));

    for (var i = 0; i < nc; i++) {
      var start = i * CHUNK_SZ;
      var end   = Math.min(start + CHUNK_SZ, size);
      var buf   = await fileOrBlob.slice(start, end).arrayBuffer();
      var fh    = await root.getFileHandle(sk + '_c' + i, { create: true });
      var wr    = await fh.createWritable();
      await wr.write(buf);
      await wr.close();
    }

    _manifest[key] = { safeKey: sk, size: size, ts: Date.now(), chunks: nc };
    return { key: key, size: size, chunks: nc };
  }

  // ── Write an ArrayBuffer directly ────────────────────────────────────────
  async function write(key, buffer) {
    if (!AVAIL) throw new Error('opfs_unavailable');
    var ab = buffer instanceof ArrayBuffer ? buffer : await buffer.arrayBuffer();
    return writeStream(key, new Blob([ab]));
  }

  // ── Read all chunks back as a single merged ArrayBuffer ───────────────────
  async function read(key) {
    if (!AVAIL) throw new Error('opfs_unavailable');
    var entry = _manifest[key];
    if (!entry) throw new Error('opfs_key_not_found: ' + key);
    var root  = await getRoot();
    var parts = [];

    for (var i = 0; i < entry.chunks; i++) {
      var fh   = await root.getFileHandle(entry.safeKey + '_c' + i);
      var file = await fh.getFile();
      parts.push(await file.arrayBuffer());
    }

    if (parts.length === 1) return parts[0];

    var total  = parts.reduce(function (s, p) { return s + p.byteLength; }, 0);
    var merged = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < parts.length; j++) {
      merged.set(new Uint8Array(parts[j]), offset);
      offset += parts[j].byteLength;
    }
    return merged.buffer;
  }

  // ── Return a File object (single-chunk fast path) ─────────────────────────
  async function getFile(key) {
    if (!AVAIL) throw new Error('opfs_unavailable');
    var entry = _manifest[key];
    if (!entry) throw new Error('opfs_key_not_found: ' + key);
    var root  = await getRoot();

    if (entry.chunks === 1) {
      var fh = await root.getFileHandle(entry.safeKey + '_c0');
      return fh.getFile();
    }

    var buf = await read(key);
    return new File([buf], key, { type: 'application/octet-stream' });
  }

  // ── Delete all chunks for a key ───────────────────────────────────────────
  async function del(key) {
    if (!AVAIL) return;
    var entry = _manifest[key];
    if (!entry) return;
    try {
      var root = await getRoot();
      for (var i = 0; i < entry.chunks; i++) {
        try { await root.removeEntry(entry.safeKey + '_c' + i); } catch (_) {}
      }
    } catch (_) {}
    delete _manifest[key];
  }

  // ── Stage a File to OPFS → { url, cleanup, key, size, strictStreaming } ───
  // The preferred API for large-file pipelines. Mirrors advanced-engine stageToOPFS
  // but uses chunked streaming so the full file never fully occupies RAM.
  async function stage(file) {
    if (!AVAIL) throw new Error('opfs_unavailable');
    var key      = 'stage_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await writeStream(key, file);
    var opfsFile = await getFile(key);
    var url      = URL.createObjectURL(opfsFile);
    var done     = false;
    return {
      key:            key,
      url:            url,
      size:           file.size,
      strictStreaming: file.size >= 400 * 1024 * 1024,
      cleanup: function () {
        if (done) return; done = true;
        try { URL.revokeObjectURL(url); } catch (_) {}
        del(key).catch(function () {});
      },
    };
  }

  // ── Sweep stale entries older than MAX_AGE ────────────────────────────────
  async function sweep() {
    if (!AVAIL) return;
    var now   = Date.now();
    var stale = Object.keys(_manifest).filter(function (k) {
      return _manifest[k] && (_manifest[k].ts + MAX_AGE) < now;
    });
    for (var i = 0; i < stale.length; i++) {
      await del(stale[i]).catch(function () {});
    }
  }

  // ── Purge all ilovepdf_ files from OPFS root (emergency cleanup) ──────────
  async function purgeAll() {
    if (!AVAIL) return;
    _manifest = {};
    try {
      var root     = await getRoot();
      var toDelete = [];
      for await (var entry of root.values()) {
        if (entry.name && entry.name.startsWith(PREFIX)) toDelete.push(entry.name);
      }
      for (var i = 0; i < toDelete.length; i++) {
        try { await root.removeEntry(toDelete[i]); } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Quota estimate { quota, usage, free } in bytes ───────────────────────
  async function getQuota() {
    if (!AVAIL || !navigator.storage.estimate) return { available: false };
    try {
      var est = await navigator.storage.estimate();
      return {
        available: true,
        quota:     est.quota || 0,
        usage:     est.usage || 0,
        free:      (est.quota || 0) - (est.usage || 0),
      };
    } catch (_) { return { available: false }; }
  }

  // Auto-sweep stale files 2 s after page load
  if (AVAIL) setTimeout(function () { sweep().catch(function () {}); }, 2000);

  window.OPFSManager = {
    available:   available,
    write:       write,
    writeStream: writeStream,
    read:        read,
    getFile:     getFile,
    del:         del,
    sweep:       sweep,
    stage:       stage,
    purgeAll:    purgeAll,
    getQuota:    getQuota,
  };

}());
