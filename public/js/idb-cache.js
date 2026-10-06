// IndexedDB Cache — persists binary assets (WASM bytes, model weights, CDN scripts)
// across page loads. Entries expire after TTL_MS (default 7 days).
// Size-aware LRU eviction prevents unbounded growth on mobile.
//
// Mobile limit: 50 MB. Desktop limit: 200 MB.
// Eviction: oldest-first (LRU by write timestamp) until under limit.
//
// Usage:
//   const data = await window.IDBCache.get('my-key');   // ArrayBuffer | null
//   await window.IDBCache.set('my-key', arrayBuffer);
//   await window.IDBCache.remove('my-key');
//   await window.IDBCache.clear();
//   await window.IDBCache.evict(maxBytes);              // optional manual evict
//   await window.IDBCache.getStats();                   // { count, totalBytes, ... }
(function () {
  'use strict';

  var DB_NAME  = 'ilovepdf-asset-cache';
  var STORE    = 'assets';
  var VERSION  = 1;
  var TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

  var _isMobile     = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  var MAX_BYTES     = _isMobile ? 50 * 1024 * 1024 : 200 * 1024 * 1024;

  var _dbPromise = null;

  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function (e) { reject(e.target.error); };
      } catch (e) { reject(e); }
    });
    return _dbPromise;
  }

  // Estimate byte size of a stored value
  function _estimateSize(data) {
    if (!data) return 0;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data))    return data.byteLength;
    try { return JSON.stringify(data).length * 2; } catch (_) { return 512; }
  }

  async function get(key) {
    try {
      var db = await openDb();
      return new Promise(function (resolve) {
        var tx  = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function (e) {
          var rec = e.target.result;
          if (!rec) return resolve(null);
          if (Date.now() - rec.ts > TTL_MS) return resolve(null); // expired
          resolve(rec.data);
        };
        req.onerror = function () { resolve(null); };
      });
    } catch (_) { return null; }
  }

  async function set(key, data) {
    try {
      var db = await openDb();
      await new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: key, data: data, ts: Date.now() });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function () { resolve(false); };
      });
      // Trigger background size eviction for large entries (non-blocking)
      if (_estimateSize(data) > 512 * 1024) {
        evict().catch(function () {});
      }
      return true;
    } catch (_) { return false; }
  }

  async function remove(key) {
    try {
      var db = await openDb();
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function () { resolve(false); };
      });
    } catch (_) { return false; }
  }

  async function clear() {
    try {
      var db = await openDb();
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function () { resolve(false); };
      });
    } catch (_) { return false; }
  }

  // LRU eviction: delete oldest entries until total estimated size ≤ maxBytes.
  // Also removes entries older than TTL_MS.
  async function evict(maxBytes) {
    if (maxBytes == null) maxBytes = MAX_BYTES;
    try {
      var db = await openDb();
      var records = await new Promise(function (resolve) {
        var tx  = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror   = function ()  { resolve([]); };
      });

      // Remove expired entries first
      var now     = Date.now();
      var expired = records.filter(function (r) { return now - r.ts > TTL_MS; });
      var live    = records.filter(function (r) { return now - r.ts <= TTL_MS; });

      for (var i = 0; i < expired.length; i++) {
        await remove(expired[i].key);
      }

      // Sort live entries oldest-first (LRU)
      live.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });

      var totalSize = live.reduce(function (sum, r) { return sum + _estimateSize(r.data); }, 0);
      var evicted   = expired.length;

      for (var j = 0; j < live.length && totalSize > maxBytes; j++) {
        await remove(live[j].key);
        totalSize -= _estimateSize(live[j].data);
        evicted++;
      }

      return { evicted: evicted, remainingBytes: totalSize, limitBytes: maxBytes };
    } catch (_) {
      return { evicted: 0, remainingBytes: 0, limitBytes: maxBytes };
    }
  }

  // Return cache statistics without modifying data.
  async function getStats() {
    try {
      var db = await openDb();
      var records = await new Promise(function (resolve) {
        var tx  = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function (e) { resolve(e.target.result || []); };
        req.onerror   = function ()  { resolve([]); };
      });
      var now       = Date.now();
      var live      = records.filter(function (r) { return now - r.ts <= TTL_MS; });
      var totalSize = live.reduce(function (sum, r) { return sum + _estimateSize(r.data); }, 0);
      return {
        count:      live.length,
        totalBytes: totalSize,
        limitBytes: MAX_BYTES,
        usage:      (totalSize / MAX_BYTES * 100).toFixed(1) + '%',
        expired:    records.length - live.length,
      };
    } catch (_) {
      return { count: 0, totalBytes: 0, limitBytes: MAX_BYTES, usage: '0%', expired: 0 };
    }
  }

  // Cache-aware fetch: checks IDB first, then network, then stores in IDB.
  async function fetchCached(url) {
    var cached = await get(url);
    if (cached) return cached;
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + url);
    var buf = await resp.arrayBuffer();
    await set(url, buf).catch(function () {});
    return buf;
  }

  window.IDBCache = { get, set, remove, clear, fetchCached, evict, getStats };
}());
