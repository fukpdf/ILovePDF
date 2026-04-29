/* tool-state.js — Persistent state for the 3-step tool flow.
 *
 * Strategy:
 *   • sessionStorage holds the LIGHT state (slug, step, file metadata,
 *     result HTML / download URL) so it survives a tab refresh.
 *   • IndexedDB holds the HEAVY blobs (actual File objects + the result
 *     blob if the download URL is a blob: URL) so refresh on /preview or
 *     /download keeps things truly working — not just visually present.
 *
 * Scope is per tool slug: switching from /merge-pdf to /compress-pdf
 * does NOT inherit the previous tool's files, but switching does NOT
 * wipe them either (the user can come back).
 *
 * Public API:
 *   ToolState.save(slug, payload)
 *   ToolState.load(slug) -> { meta, files, result } | null
 *   ToolState.clear(slug)
 *   ToolState.putBlob(slug, key, blob)
 *   ToolState.getBlob(slug, key) -> Promise<Blob|null>
 *
 * `payload` shape (what tool-page.js passes in):
 *   {
 *     step,                // 'upload' | 'preview' | 'download'
 *     files: [{ id, name, size, type, rotation }],
 *     result: { html, downloadUrl, filename, isBlob }
 *   }
 */
(function () {
  const SS_PREFIX = 'ilovepdf:toolState:';
  const DB_NAME   = 'ilovepdf-tools';
  const DB_STORE  = 'blobs';
  const DB_VER    = 1;

  // Lazily open / upgrade the IndexedDB. Wrapped in a single shared
  // promise so concurrent callers don't trigger multiple opens.
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      } catch (e) {
        // Private mode / disabled storage → fall back gracefully.
        reject(e);
      }
    });
    return dbPromise;
  }

  function blobKey(slug, key) { return `${slug}::${key}`; }

  async function putBlob(slug, key, blob) {
    if (!blob) return;
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(blob, blobKey(slug, key));
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* non-fatal — refresh will simply lose the blob */ }
  }

  async function getBlob(slug, key) {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const r  = tx.objectStore(DB_STORE).get(blobKey(slug, key));
        r.onsuccess = () => res(r.result || null);
        r.onerror   = () => rej(r.error);
      });
    } catch (e) { return null; }
  }

  // Wipe every key for this slug. Cheaper than a per-key delete loop and
  // safe because keys are namespaced "{slug}::*".
  async function clearBlobs(slug) {
    try {
      const db = await openDB();
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const prefix = slug + '::';
      await new Promise((res, rej) => {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = e => {
          const c = e.target.result;
          if (!c) return res();
          if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete();
          c.continue();
        };
        cursorReq.onerror = () => rej(cursorReq.error);
      });
    } catch (e) { /* ignore */ }
  }

  function save(slug, payload) {
    if (!slug) return;
    try {
      const body = { ts: Date.now(), slug, ...payload };
      sessionStorage.setItem(SS_PREFIX + slug, JSON.stringify(body));
    } catch (_) { /* quota / disabled — non-fatal */ }
  }

  function load(slug) {
    if (!slug) return null;
    try {
      const raw = sessionStorage.getItem(SS_PREFIX + slug);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function clear(slug) {
    if (!slug) return;
    try { sessionStorage.removeItem(SS_PREFIX + slug); } catch (_) {}
    clearBlobs(slug);
  }

  // Helper: detect blob: URLs in a result HTML snippet so we know whether
  // we need to re-issue a fresh URL.createObjectURL after hydration.
  function rewriteBlobHrefs(html, freshUrl) {
    if (!html || !freshUrl) return html;
    return html.replace(
      /href=(["'])blob:[^"']+\1/g,
      `href="${freshUrl}"`
    );
  }

  window.ToolState = {
    save, load, clear,
    putBlob, getBlob, clearBlobs,
    rewriteBlobHrefs,
  };
})();
