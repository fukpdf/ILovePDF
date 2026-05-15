// RuntimeWorkspace v1.0 — Phase 9F
// =====================================================================
// Local document workspace. OPFS-backed, IndexedDB-indexed.
// Allows users to import, search, tag, and resume documents offline.
//
// Storage:
//   OPFS:  /ilovepdf-workspace/<uuid>/<filename>   — raw file bytes
//   IDB:   ilovepdf-workspace (workspace_docs store) — metadata index
//
// Features:
//   • Import any File into the workspace (stored in OPFS)
//   • Persistent metadata: name, size, type, tags, added date
//   • AI-powered search via RuntimeLocalAI embeddings
//   • Resumable workflows: save + restore step state per document
//   • Smart indexing: PDF page count, word count, detected language
//   • Offline persistence: all data survives refresh
//   • Session restoration: resume last-open document on next visit
//   • Workspace recovery: re-index from OPFS if IDB is wiped
//   • Storage quota tracking
//
// Expose: window.RuntimeWorkspace
//   .import(file, opts)          → Promise<WorkspaceDoc>
//   .search(query, opts)         → Promise<WorkspaceDoc[]>
//   .resume(docId)               → Promise<ResumedWorkflow>
//   .getStats()                  → WorkspaceStats
//   .list()                      → Promise<WorkspaceDoc[]>
//   .remove(docId)               → Promise<void>
//   .saveProgress(docId, state)  → Promise<void>
//   .getProgress(docId)          → Promise<state|null>
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeWorkspace) return;

  var LOG = '[WS9F]';

  // ── Storage config ────────────────────────────────────────────────────────
  var OPFS_DIR     = 'ilovepdf-workspace';
  var DB_NAME      = 'ilovepdf-workspace';
  var DB_STORE     = 'workspace_docs';
  var DB_PROGRESS  = 'workflow_progress';
  var DB_VERSION   = 1;

  var _opfsSupported = !!(typeof navigator !== 'undefined' &&
    navigator.storage && typeof navigator.storage.getDirectory === 'function');

  // ── IDB setup ─────────────────────────────────────────────────────────────
  var _db = null;

  function _openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          var st = db.createObjectStore(DB_STORE, { keyPath: 'id' });
          st.createIndex('name',    'name',    { unique: false });
          st.createIndex('added',   'added',   { unique: false });
          st.createIndex('type',    'type',    { unique: false });
        }
        if (!db.objectStoreNames.contains(DB_PROGRESS)) {
          db.createObjectStore(DB_PROGRESS, { keyPath: 'docId' });
        }
      };
      req.onsuccess  = function (ev) { _db = ev.target.result; resolve(_db); };
      req.onerror    = function ()   { reject(new Error('workspace IDB open failed')); };
    });
  }

  function _idbPut(store, record) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([store], 'readwrite');
        var req = tx.objectStore(store).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror    = function () { reject(tx.error); };
      });
    });
  }

  function _idbGet(store, key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([store], 'readonly');
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function _idbGetAll(store) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction([store], 'readonly');
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function _idbDelete(store, key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([store], 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror    = function () { reject(tx.error); };
      });
    });
  }

  // ── UUID ──────────────────────────────────────────────────────────────────
  function _uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'ws-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }

  // ── OPFS helpers ──────────────────────────────────────────────────────────
  function _opfsRoot() {
    return navigator.storage.getDirectory()
      .then(function (root) { return root.getDirectoryHandle(OPFS_DIR, { create: true }); });
  }

  function _opfsDocDir(docId) {
    return _opfsRoot().then(function (dir) {
      return dir.getDirectoryHandle(docId, { create: true });
    });
  }

  function _opfsWrite(docId, filename, buffer) {
    if (!_opfsSupported) return Promise.resolve();
    return _opfsDocDir(docId).then(function (dir) {
      return dir.getFileHandle(filename, { create: true });
    }).then(function (fh) {
      return fh.createWritable();
    }).then(function (ws) {
      return ws.write(buffer).then(function () { return ws.close(); });
    });
  }

  function _opfsRead(docId, filename) {
    if (!_opfsSupported) return Promise.reject(new Error('OPFS not supported'));
    return _opfsDocDir(docId).then(function (dir) {
      return dir.getFileHandle(filename);
    }).then(function (fh) {
      return fh.getFile();
    });
  }

  function _opfsDelete(docId) {
    if (!_opfsSupported) return Promise.resolve();
    return _opfsRoot().then(function (dir) {
      return dir.removeEntry(docId, { recursive: true });
    }).catch(function () {});
  }

  // ── Document analysis (lightweight, sync-style via heuristics) ────────────
  function _analyzeFile(file) {
    return new Promise(function (resolve) {
      var meta = {
        pageCount: null,
        wordCount: null,
        language:  null,
      };

      if (file.type === 'application/pdf') {
        // Quick page count: count /Page\b occurrences in first 128KB
        file.slice(0, 131072).arrayBuffer().then(function (buf) {
          var text = new TextDecoder('ascii', { fatal: false }).decode(buf);
          var pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
          meta.pageCount = pages || null;
          resolve(meta);
        }).catch(function () { resolve(meta); });
        return;
      }

      if (file.type.startsWith('text/')) {
        file.slice(0, 65536).text().then(function (text) {
          meta.wordCount = text.split(/\s+/).filter(Boolean).length;
          // Naive language detection by character frequency
          var latin  = (text.match(/[a-zA-Z]/g)  || []).length;
          var cjk    = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
          if (cjk > latin * 0.5) meta.language = 'cjk';
          else                   meta.language = 'latin';
          resolve(meta);
        }).catch(function () { resolve(meta); });
        return;
      }

      resolve(meta);
    });
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  function importFile(file, opts) {
    opts = opts || {};
    if (!file || !(file instanceof Blob)) return Promise.reject(new Error('file must be a File/Blob'));

    var docId    = _uuid();
    var filename = (file.name || 'document');

    return _analyzeFile(file).then(function (analysis) {
      return file.arrayBuffer().then(function (buf) {
        return _opfsWrite(docId, filename, buf).then(function () {
          var doc = {
            id:        docId,
            name:      filename,
            size:      file.size,
            type:      file.type || 'application/octet-stream',
            added:     Date.now(),
            tags:      opts.tags || [],
            pageCount: analysis.pageCount,
            wordCount: analysis.wordCount,
            language:  analysis.language,
            opfs:      _opfsSupported,
            // Embedding stored separately via RuntimeLocalAI
            embedding: null,
          };

          return _idbPut(DB_STORE, doc).then(function () {
            _stats.imported++;
            _stats.totalBytes += file.size;

            // Optionally generate embedding for search
            if (global.RuntimeLocalAI && opts.index !== false && file.type.startsWith('text/')) {
              file.slice(0, 4096).text().then(function (text) {
                return global.RuntimeLocalAI.run('embedding', text, {});
              }).then(function (res) {
                if (res && res.result && res.result.embedding) {
                  doc.embedding = res.result.embedding;
                  return _idbPut(DB_STORE, doc);
                }
              }).catch(function () {});
            }

            if (global.RuntimeEventBus) {
              try { global.RuntimeEventBus.emit('workspace:imported', { docId: docId, name: filename }); } catch (_) {}
            }
            if (global.RuntimeTelemetry) {
              try { global.RuntimeTelemetry.record('workspace:import', { size: file.size, type: file.type }); } catch (_) {}
            }

            return doc;
          });
        });
      });
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  function search(query, opts) {
    opts = opts || {};
    if (!query) return list();

    return _idbGetAll(DB_STORE).then(function (docs) {
      var q  = query.toLowerCase();
      var scored = docs.map(function (doc) {
        var score = 0;
        // Name match (highest weight)
        if (doc.name && doc.name.toLowerCase().includes(q)) score += 100;
        // Tag match
        if (doc.tags && doc.tags.some(function (t) { return t.toLowerCase().includes(q); })) score += 50;
        // Type match
        if (doc.type && doc.type.toLowerCase().includes(q)) score += 20;
        // Embedding cosine similarity (if available)
        if (doc.embedding && global.RuntimeLocalAI && score === 0) {
          // Try semantic match via embedding
          global.RuntimeLocalAI.run('embedding', query, {}).then(function (qr) {
            if (qr && qr.result && qr.result.embedding) {
              var cos = _cosine(doc.embedding, qr.result.embedding);
              score += cos * 40;
            }
          }).catch(function () {});
        }
        return { doc: doc, score: score };
      }).filter(function (x) { return x.score > 0; });

      scored.sort(function (a, b) { return b.score - a.score; });
      return scored.slice(0, opts.limit || 20).map(function (x) { return x.doc; });
    });
  }

  function _cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  function resume(docId) {
    return Promise.all([
      _idbGet(DB_STORE, docId),
      _idbGet(DB_PROGRESS, docId),
    ]).then(function (results) {
      var doc      = results[0];
      var progress = results[1];
      if (!doc) throw new Error('workspace:doc-not-found:' + docId);

      var resumed = { doc: doc, progress: progress || null, opfsAvailable: _opfsSupported };

      // Try to restore the file from OPFS
      if (_opfsSupported) {
        return _opfsRead(docId, doc.name).then(function (file) {
          resumed.file = file;
          return resumed;
        }).catch(function () {
          resumed.file = null;
          return resumed;
        });
      }

      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('workspace:resumed', { docId: docId }); } catch (_) {}
      }
      return resumed;
    });
  }

  // ── List ──────────────────────────────────────────────────────────────────
  function list() {
    return _idbGetAll(DB_STORE).then(function (docs) {
      return docs.sort(function (a, b) { return b.added - a.added; });
    });
  }

  // ── Remove ────────────────────────────────────────────────────────────────
  function remove(docId) {
    return Promise.all([
      _idbDelete(DB_STORE, docId),
      _idbDelete(DB_PROGRESS, docId),
      _opfsDelete(docId),
    ]).then(function () {
      _stats.removed++;
      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('workspace:removed', { docId: docId }); } catch (_) {}
      }
    });
  }

  // ── Progress save/restore ─────────────────────────────────────────────────
  function saveProgress(docId, state) {
    return _idbPut(DB_PROGRESS, { docId: docId, state: state, ts: Date.now() });
  }

  function getProgress(docId) {
    return _idbGet(DB_PROGRESS, docId).then(function (rec) {
      return rec ? rec.state : null;
    });
  }

  // ── Session restoration ───────────────────────────────────────────────────
  // Remember last-opened docId in sessionStorage
  function setLastDoc(docId) {
    try { sessionStorage.setItem('ws_last_doc', docId); } catch (_) {}
  }

  function getLastDoc() {
    try { return sessionStorage.getItem('ws_last_doc'); } catch (_) { return null; }
  }

  // ── Recovery: re-index from OPFS if IDB is empty ─────────────────────────
  function _recover() {
    if (!_opfsSupported) return Promise.resolve();
    return _idbGetAll(DB_STORE).then(function (docs) {
      if (docs.length > 0) return; // IDB has data — no recovery needed
      // Scan OPFS workspace dir
      return _opfsRoot().then(function (dir) {
        return dir.values ? _drainAsyncIter(dir.values()) : Promise.resolve([]);
      }).then(function (entries) {
        console.info(LOG, 'workspace recovery: found', entries.length, 'OPFS directories');
        // We can only recover basic metadata (name, size) from OPFS entries
        var promises = entries.map(function (entry) {
          if (entry.kind !== 'directory') return Promise.resolve();
          return dir.getDirectoryHandle(entry.name).then(function (docDir) {
            return docDir.values ? _drainAsyncIter(docDir.values()) : Promise.resolve([]);
          }).then(function (files) {
            var file = files[0];
            if (!file) return;
            return _idbPut(DB_STORE, {
              id: entry.name, name: file.name || 'recovered', size: 0,
              type: 'application/octet-stream', added: Date.now(),
              tags: ['recovered'], recovered: true,
            });
          }).catch(function () {});
        });
        return Promise.all(promises);
      });
    }).catch(function () {});
  }

  function _drainAsyncIter(iter) {
    var results = [];
    function step() {
      return iter.next().then(function (r) {
        if (r.done) return results;
        results.push(r.value);
        return step();
      });
    }
    return step();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = { imported: 0, removed: 0, searches: 0, resumes: 0, totalBytes: 0 };

  function getStats() {
    return list().then(function (docs) {
      return Object.assign({}, _stats, {
        totalDocs:   docs.length,
        opfsAvail:   _opfsSupported,
        totalBytes:  docs.reduce(function (a, d) { return a + (d.size || 0); }, 0),
        lastDoc:     getLastDoc(),
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _recover().catch(function () {});

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('workspace', global.RuntimeWorkspace); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('workspace:ready', { opfs: _opfsSupported }); } catch (_) {}
    }
    console.info(LOG, 'RuntimeWorkspace v1.0 ready — OPFS:', _opfsSupported);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 600);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 600); }, { once: true });
  }

  global.RuntimeWorkspace = {
    import:       importFile,
    search:       search,
    resume:       resume,
    list:         list,
    remove:       remove,
    saveProgress: saveProgress,
    getProgress:  getProgress,
    getStats:     getStats,
    setLastDoc:   setLastDoc,
    getLastDoc:   getLastDoc,
  };
}(window));
