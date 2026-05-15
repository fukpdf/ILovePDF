// RuntimeResultCache v1.0 — Phase 8E
// =====================================================================
// Hash-based output cache. Prevents reprocessing identical inputs.
//
// Cache tiers:
//   Tier 1 — In-memory LRU (fastest, lost on page unload)
//            Stores ArrayBuffer results up to 10 MB each, 50 MB total.
//   Tier 2 — OPFS file cache (persists across refreshes)
//            Stores large ArrayBuffer results > 2 MB, up to 500 MB.
//   Tier 3 — IDB key-value (small results: AI text, OCR text, translations)
//            Stores string results up to 2 MB each, 20 MB total.
//
// Key function: SHA-256 (SubtleCrypto) or FNV-1a fallback.
// Eviction: LRU per tier, with size caps.
//
// Expose: window.RuntimeResultCache
//   .hash(buffer|string, opts?) → Promise<string>  — canonical cache key
//   .get(key, opts?)            → Promise<CacheHit|null>
//   .set(key, result, meta?)    → Promise<void>
//   .delete(key)                → Promise<void>
//   .clear(tier?)               → Promise<void>
//   .stats()                    → CacheStats
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeResultCache) return;

  var LOG = '[RRC8E]';

  // ── Constants ─────────────────────────────────────────────────────────────
  var MEM_MAX_BYTES  = 50  * 1024 * 1024;  // 50 MB in-memory cap
  var MEM_ENTRY_MAX  = 10  * 1024 * 1024;  // 10 MB max per entry
  var IDB_MAX_BYTES  = 20  * 1024 * 1024;  // 20 MB IDB cap
  var OPFS_MAX_BYTES = 500 * 1024 * 1024;  // 500 MB OPFS cap
  var OPFS_THRESHOLD = 2   * 1024 * 1024;  // results > 2 MB go to OPFS

  // ── Hashing ────────────────────────────────────────────────────────────────
  function _sha256(buffer) {
    if (global.crypto && global.crypto.subtle) {
      return global.crypto.subtle.digest('SHA-256', buffer).then(function (hashBuf) {
        var arr  = new Uint8Array(hashBuf);
        var hex  = '';
        for (var i = 0; i < arr.length; i++) {
          hex += ('0' + arr[i].toString(16)).slice(-2);
        }
        return hex;
      });
    }
    // FNV-1a 64-bit (approximated in 32-bit JS)
    return Promise.resolve(_fnv1a(buffer));
  }

  function _fnv1a(buffer) {
    var data  = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) :
                typeof buffer === 'string'    ? new TextEncoder().encode(buffer) :
                buffer;
    var h1 = 0x811c9dc5 >>> 0;
    var h2 = 0x811c9dc5 >>> 0;
    for (var i = 0; i < data.length; i++) {
      if (i % 2 === 0) {
        h1 = Math.imul(h1 ^ data[i], 0x01000193) >>> 0;
      } else {
        h2 = Math.imul(h2 ^ data[i], 0x01000193) >>> 0;
      }
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function hash(input, opts) {
    var buffer;
    if (input instanceof ArrayBuffer) {
      buffer = input;
    } else if (typeof input === 'string') {
      buffer = new TextEncoder().encode(input).buffer;
    } else if (input && input.buffer instanceof ArrayBuffer) {
      buffer = input.buffer;
    } else {
      return Promise.resolve(_fnv1a(String(input)));
    }
    // Optionally mix in tool + options
    var suffix = (opts && opts.tool) ? ':' + opts.tool : '';
    if (opts && opts.options) {
      try { suffix += ':' + JSON.stringify(opts.options); } catch (_) {}
    }
    return _sha256(buffer).then(function (h) { return h + suffix; });
  }

  // ── Tier 1: In-memory LRU ─────────────────────────────────────────────────
  // Map maintains insertion order; we use it as an LRU by delete-then-re-insert on access.
  var _memCache  = new Map();  // key → { result, size, ts, tool, hitCount }
  var _memBytes  = 0;

  var _memStats  = { hits: 0, misses: 0, evictions: 0, sets: 0 };

  function _memGet(key) {
    var entry = _memCache.get(key);
    if (!entry) { _memStats.misses++; return null; }
    // Move to end (most-recently-used)
    _memCache.delete(key);
    entry.hitCount++;
    entry.ts = Date.now();
    _memCache.set(key, entry);
    _memStats.hits++;
    return entry;
  }

  function _memSet(key, result, meta) {
    var size = (result instanceof ArrayBuffer) ? result.byteLength
             : (typeof result === 'string')    ? result.length * 2
             : 0;
    if (size > MEM_ENTRY_MAX) return; // too large for memory tier
    if (size > MEM_MAX_BYTES) return; // would exceed cap even alone

    // Remove existing entry if key already exists
    if (_memCache.has(key)) {
      _memBytes -= _memCache.get(key).size;
      _memCache.delete(key);
    }

    // Evict LRU entries until we have room
    while (_memBytes + size > MEM_MAX_BYTES && _memCache.size > 0) {
      var oldest = _memCache.keys().next().value;
      _memBytes -= _memCache.get(oldest).size;
      _memCache.delete(oldest);
      _memStats.evictions++;
    }

    _memCache.set(key, { result: result, size: size, ts: Date.now(), tool: meta && meta.tool, hitCount: 0 });
    _memBytes += size;
    _memStats.sets++;
  }

  function _memDelete(key) {
    var entry = _memCache.get(key);
    if (entry) { _memBytes -= entry.size; _memCache.delete(key); }
  }

  // ── Tier 3: IDB (small string results: AI, OCR, translation) ─────────────
  var DB_NAME    = 'ilovepdf-rt';
  var DB_STORE   = 'result_cache';
  var DB_VERSION = 3;
  var _db = null;
  var _idbStats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          var store = db.createObjectStore(DB_STORE, { keyPath: 'cacheKey' });
          store.createIndex('by_ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = function (ev) { _db = ev.target.result; resolve(_db); };
      req.onerror   = function ()   { reject(new Error('IDB open failed')); };
    });
  }

  function _idbGet(key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([DB_STORE], 'readwrite');
        var os  = tx.objectStore(DB_STORE);
        var req = os.get(key);
        req.onsuccess = function () {
          var rec = req.result;
          if (!rec) { _idbStats.misses++; resolve(null); return; }
          // Update ts for LRU
          rec.ts = Date.now();
          rec.hitCount = (rec.hitCount || 0) + 1;
          os.put(rec);
          _idbStats.hits++;
          resolve(rec);
        };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function _idbSet(key, result, meta) {
    if (typeof result !== 'string') return Promise.resolve(); // IDB tier is for strings only
    if (result.length * 2 > IDB_MAX_BYTES) return Promise.resolve();

    return _openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx  = db.transaction([DB_STORE], 'readwrite');
        var os  = tx.objectStore(DB_STORE);
        os.put({ cacheKey: key, result: result, size: result.length * 2, ts: Date.now(),
                 tool: meta && meta.tool, hitCount: 0 });
        tx.oncomplete = function () { _idbStats.sets++; resolve(); };
        tx.onerror    = function () { resolve(); };
      });
    }).then(function () {
      return _idbEvict();
    }).catch(function () {});
  }

  function _idbEvict() {
    return _openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx  = db.transaction([DB_STORE], 'readwrite');
        var os  = tx.objectStore(DB_STORE);
        var req = os.index('by_ts').getAll();
        req.onsuccess = function () {
          var rows  = req.result || [];
          var total = rows.reduce(function (a, r) { return a + (r.size || 0); }, 0);
          if (total <= IDB_MAX_BYTES) { resolve(); return; }
          // Evict oldest
          rows.sort(function (a, b) { return a.ts - b.ts; });
          var i = 0;
          while (total > IDB_MAX_BYTES && i < rows.length) {
            total -= (rows[i].size || 0);
            os.delete(rows[i].cacheKey);
            _idbStats.evictions++;
            i++;
          }
          resolve();
        };
        req.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function _idbDelete(key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction([DB_STORE], 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror    = function () { resolve(); };
      });
    }).catch(function () {});
  }

  // ── Tier 2: OPFS (large binary results > 2 MB) ────────────────────────────
  var OPFS_DIR   = '__result_cache__';
  var _opfsStats = { hits: 0, misses: 0, sets: 0, evictions: 0 };
  // In-memory manifest: key → { key, ts, size, tool }
  var _opfsManifest = new Map();
  var _opfsBytes    = 0;
  var _opfsReady    = false;

  function _opfsDir() {
    if (!navigator.storage || !navigator.storage.getDirectory) return Promise.reject(new Error('no-opfs'));
    return navigator.storage.getDirectory().then(function (root) {
      return root.getDirectoryHandle(OPFS_DIR, { create: true });
    });
  }

  function _safeFileName(key) {
    return key.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200) + '.bin';
  }

  function _opfsGet(key) {
    if (!_opfsReady) return Promise.resolve(null);
    var entry = _opfsManifest.get(key);
    if (!entry) { _opfsStats.misses++; return Promise.resolve(null); }
    return _opfsDir().then(function (dir) {
      return dir.getFileHandle(_safeFileName(key), { create: false });
    }).then(function (fh) {
      return fh.getFile();
    }).then(function (file) {
      return file.arrayBuffer();
    }).then(function (buf) {
      // Update manifest ts
      entry.ts = Date.now();
      entry.hitCount = (entry.hitCount || 0) + 1;
      _opfsStats.hits++;
      return { result: buf, tool: entry.tool, ts: entry.ts, hitCount: entry.hitCount };
    }).catch(function () {
      _opfsManifest.delete(key);
      _opfsStats.misses++;
      return null;
    });
  }

  function _opfsSet(key, result, meta) {
    if (!(result instanceof ArrayBuffer) || result.byteLength < OPFS_THRESHOLD) {
      return Promise.resolve();
    }
    if (result.byteLength > OPFS_MAX_BYTES) return Promise.resolve(); // too big even for OPFS

    return _opfsDir().then(function (dir) {
      return dir.getFileHandle(_safeFileName(key), { create: true }).then(function (fh) {
        return fh.createWritable().then(function (ws) {
          return ws.write(result).then(function () { return ws.close(); });
        });
      });
    }).then(function () {
      _opfsManifest.set(key, { key: key, ts: Date.now(), size: result.byteLength, tool: meta && meta.tool, hitCount: 0 });
      _opfsBytes += result.byteLength;
      _opfsStats.sets++;
      return _opfsEvict();
    }).catch(function () {});
  }

  function _opfsEvict() {
    if (_opfsBytes <= OPFS_MAX_BYTES) return Promise.resolve();
    var entries = Array.from(_opfsManifest.values()).sort(function (a, b) { return a.ts - b.ts; });
    return _opfsDir().then(function (dir) {
      var i = 0;
      var chain = Promise.resolve();
      while (_opfsBytes > OPFS_MAX_BYTES && i < entries.length) {
        (function (e) {
          chain = chain.then(function () {
            return dir.removeEntry(_safeFileName(e.key)).catch(function () {});
          }).then(function () {
            _opfsBytes -= e.size;
            _opfsManifest.delete(e.key);
            _opfsStats.evictions++;
          });
        }(entries[i]));
        i++;
      }
      return chain;
    }).catch(function () {});
  }

  // Load OPFS manifest on boot
  function _loadOpfsManifest() {
    return _opfsDir().then(function (dir) {
      var req = dir.values();
      return req.next ? _drainAsyncIterator(req) : Promise.resolve([]);
    }).then(function (entries) {
      _opfsReady = true;
      // We can only reconstruct basic manifest from file names + sizes
      entries.forEach(function (e) {
        var key = e.name ? e.name.replace(/\.bin$/, '') : null;
        if (key && !_opfsManifest.has(key)) {
          _opfsManifest.set(key, { key: key, ts: Date.now(), size: 0, hitCount: 0 });
        }
      });
    }).catch(function () { _opfsReady = false; });
  }

  function _drainAsyncIterator(iter) {
    var results = [];
    function step() {
      return iter.next().then(function (res) {
        if (res.done) return results;
        results.push(res.value);
        return step();
      });
    }
    return step();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function get(key, opts) {
    // Memory first
    var memHit = _memGet(key);
    if (memHit) return Promise.resolve({ result: memHit.result, tier: 'memory', hitCount: memHit.hitCount });

    // IDB for strings
    return _idbGet(key).then(function (idbHit) {
      if (idbHit) {
        _memSet(key, idbHit.result, idbHit); // promote to memory
        return { result: idbHit.result, tier: 'idb', hitCount: idbHit.hitCount };
      }
      // OPFS for binaries
      return _opfsGet(key).then(function (opfsHit) {
        if (opfsHit) {
          _memSet(key, opfsHit.result, opfsHit); // promote to memory
          return { result: opfsHit.result, tier: 'opfs', hitCount: opfsHit.hitCount };
        }
        return null;
      });
    });
  }

  function set(key, result, meta) {
    meta = meta || {};
    // Always store in memory if small enough
    _memSet(key, result, meta);
    // String results → IDB
    if (typeof result === 'string') {
      return _idbSet(key, result, meta);
    }
    // Large binary → OPFS; small binary → memory only (already set)
    if (result instanceof ArrayBuffer && result.byteLength >= OPFS_THRESHOLD) {
      return _opfsSet(key, result, meta);
    }
    return Promise.resolve();
  }

  function del(key) {
    _memDelete(key);
    return Promise.all([ _idbDelete(key) ]);
  }

  function clear(tier) {
    if (!tier || tier === 'memory') {
      _memCache.clear(); _memBytes = 0;
    }
    if (!tier || tier === 'idb') {
      return _openDb().then(function (db) {
        var tx = db.transaction([DB_STORE], 'readwrite');
        tx.objectStore(DB_STORE).clear();
        return new Promise(function (r) { tx.oncomplete = r; tx.onerror = r; });
      }).catch(function () {});
    }
    return Promise.resolve();
  }

  function stats() {
    return {
      memory: Object.assign({}, _memStats, { bytes: _memBytes, entries: _memCache.size, maxBytes: MEM_MAX_BYTES }),
      idb:    Object.assign({}, _idbStats,  { maxBytes: IDB_MAX_BYTES }),
      opfs:   Object.assign({}, _opfsStats, { bytes: _opfsBytes, entries: _opfsManifest.size, maxBytes: OPFS_MAX_BYTES, ready: _opfsReady }),
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _loadOpfsManifest().catch(function () {});
    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('resultCache', global.RuntimeResultCache); } catch (_) {}
    }
    console.info(LOG, 'RuntimeResultCache v1.0 ready — memory:', Math.round(MEM_MAX_BYTES / 1024 / 1024) + 'MB cap | OPFS:', Math.round(OPFS_MAX_BYTES / 1024 / 1024) + 'MB cap');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 400);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 400); }, { once: true });
  }

  global.RuntimeResultCache = { hash: hash, get: get, set: set, delete: del, clear: clear, stats: stats };
}(window));
