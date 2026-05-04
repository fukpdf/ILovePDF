// IndexedDB Cache — persists binary assets (WASM bytes, model weights, CDN scripts)
// across page loads. Entries expire after TTL_MS (default 7 days).
//
// Usage:
//   const data = await window.IDBCache.get('my-key');   // ArrayBuffer | null
//   await window.IDBCache.set('my-key', arrayBuffer);
//   await window.IDBCache.remove('my-key');
//   await window.IDBCache.clear();
(function () {
  const DB_NAME  = 'ilovepdf-asset-cache';
  const STORE    = 'assets';
  const VERSION  = 1;
  const TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

  let _dbPromise = null;

  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
      } catch (e) {
        reject(e);
      }
    });
    return _dbPromise;
  }

  async function get(key) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx  = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = (e) => {
          const rec = e.target.result;
          if (!rec) return resolve(null);
          if (Date.now() - rec.ts > TTL_MS) return resolve(null); // expired
          resolve(rec.data);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function set(key, data) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, data, ts: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  async function remove(key) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  async function clear() {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  // Cache-aware fetch: checks IDB first, then network, then stores in IDB.
  async function fetchCached(url) {
    const cached = await get(url);
    if (cached) return cached;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Fetch failed: ' + resp.status + ' ' + url);
    const buf = await resp.arrayBuffer();
    await set(url, buf).catch(() => {}); // non-fatal if IDB is unavailable
    return buf;
  }

  window.IDBCache = { get, set, remove, clear, fetchCached };
})();
