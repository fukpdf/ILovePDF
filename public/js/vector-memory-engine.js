/**
 * PHASE 47 — REAL VECTOR MEMORY SYSTEM
 * window.VectorMemoryEngine
 *
 * Persistent semantic memory across documents.
 * OPFS shards + IndexedDB metadata layer.
 * Purely additive. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION    = '1.0';
  var LOG        = '[VME]';
  var SHARD_SIZE = 512;        // embeddings per shard
  var DIM        = 384;        // embedding dimension (MiniLM-L6)
  var DB_NAME    = 'vme_meta_v1';
  var MAX_SHARDS = 64;

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § A1  IDB METADATA LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var MetaDB = (function () {
    var _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          ['chunks','shards','docs'].forEach(function (s) {
            if (!db.objectStoreNames.contains(s)) {
              var os = db.createObjectStore(s, { keyPath: 'id' });
              if (s === 'chunks') { os.createIndex('doc',  'docId',   { unique: false }); os.createIndex('shard','shardId', { unique: false }); }
              if (s === 'docs')   { os.createIndex('slug', 'slug',    { unique: false }); }
            }
          });
        };
        req.onsuccess = function (e) { _db = e.target.result; res(_db); };
        req.onerror   = function ()  { rej(req.error); };
      });
    }
    function put(store, obj)    { return open().then(function (db) { return new Promise(function (r) { var tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    function get(store, id)     { return open().then(function (db) { return new Promise(function (r) { var req = db.transaction(store,'readonly').objectStore(store).get(id); req.onsuccess=function(){r(req.result||null);}; req.onerror=function(){r(null);}; }); }).catch(function(){return null;}); }
    function getAll(store, idx, key) {
      return open().then(function (db) {
        return new Promise(function (r) {
          var tx  = db.transaction(store, 'readonly');
          var req = idx ? tx.objectStore(store).index(idx).getAll(key) : tx.objectStore(store).getAll();
          req.onsuccess = function () { r(req.result || []); }; req.onerror = function () { r([]); };
        });
      }).catch(function () { return []; });
    }
    function del(store, id) { return open().then(function (db) { return new Promise(function (r) { var tx = db.transaction(store,'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    return { put: put, get: get, getAll: getAll, del: del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A2  OPFS SHARD STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var OpfsShardStore = (function () {
    var _root  = null;
    var _dir   = null;
    var _ready = false;

    async function _ensureDir() {
      if (_dir) return _dir;
      try {
        _root = await navigator.storage.getDirectory();
        _dir  = await _root.getDirectoryHandle('vme_shards', { create: true });
        _ready = true;
        return _dir;
      } catch (e) { warn('OPFS unavailable:', e.message); return null; }
    }

    async function writeShard(shardId, data) {
      var dir = await _ensureDir();
      if (!dir) return false;
      try {
        var fh     = await dir.getFileHandle(shardId + '.bin', { create: true });
        var writable = await fh.createWritable();
        await writable.write(data);
        await writable.close();
        return true;
      } catch (e) { warn('writeShard failed', shardId, e.message); return false; }
    }

    async function readShard(shardId) {
      var dir = await _ensureDir();
      if (!dir) return null;
      try {
        var fh   = await dir.getFileHandle(shardId + '.bin');
        var file = await fh.getFile();
        return await file.arrayBuffer();
      } catch (e) { return null; }
    }

    async function deleteShard(shardId) {
      var dir = await _ensureDir();
      if (!dir) return;
      try { await dir.removeEntry(shardId + '.bin'); } catch (_) {}
    }

    function isAvailable() { return _ready || (typeof navigator !== 'undefined' && !!navigator.storage && !!navigator.storage.getDirectory); }
    return { writeShard: writeShard, readShard: readShard, deleteShard: deleteShard, isAvailable: isAvailable };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A3  VECTOR SHARD MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var VectorShardManager = (function () {
    var _cache = new Map();  // shardId → Float32Array (rows × DIM)

    function _pack(vectors) {
      var n   = vectors.length;
      var buf = new Float32Array(n * DIM);
      for (var i = 0; i < n; i++) {
        var v = vectors[i];
        if (v && v.length === DIM) buf.set(v, i * DIM);
      }
      return buf;
    }

    function _unpack(buf) {
      var arr = new Float32Array(buf);
      var n   = Math.floor(arr.length / DIM);
      var out = [];
      for (var i = 0; i < n; i++) out.push(arr.slice(i * DIM, (i + 1) * DIM));
      return out;
    }

    async function writeShard(shardId, vectors) {
      var packed = _pack(vectors);
      _cache.set(shardId, packed);
      await OpfsShardStore.writeShard(shardId, packed.buffer);
      return shardId;
    }

    async function readShard(shardId) {
      if (_cache.has(shardId)) return _unpack(_cache.get(shardId).buffer);
      var buf = await OpfsShardStore.readShard(shardId);
      if (!buf) return [];
      var fa = new Float32Array(buf);
      _cache.set(shardId, fa);
      return _unpack(buf);
    }

    function evictShard(shardId) {
      _cache.delete(shardId);
      // Keep OPFS shard; just free RAM
    }

    function cacheSize() { return _cache.size; }
    function evictLRU(keep) {
      if (_cache.size <= keep) return;
      var keys = Array.from(_cache.keys());
      keys.slice(0, _cache.size - keep).forEach(function (k) { _cache.delete(k); });
    }

    return { writeShard: writeShard, readShard: readShard, evictShard: evictShard, cacheSize: cacheSize, evictLRU: evictLRU };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A4  EMBEDDING INDEX (in-memory chunk registry)
  // ═══════════════════════════════════════════════════════════════════════════
  var EmbeddingIndex = (function () {
    var _chunks = [];       // { id, docId, shardId, shardOffset, chunk, lang }
    var _loaded = false;

    async function load() {
      if (_loaded) return;
      var rows = await MetaDB.getAll('chunks');
      _chunks = rows;
      _loaded = true;
      log('index loaded:', _chunks.length, 'chunks');
    }

    async function add(docId, chunkText, vector, lang) {
      if (!_loaded) await load();
      var shardId = 'shard_' + Math.floor(_chunks.length / SHARD_SIZE).toString().padStart(4,'0');
      var offset  = _chunks.length % SHARD_SIZE;
      var id      = uid();
      var meta    = { id: id, docId: docId, shardId: shardId, shardOffset: offset, chunk: chunkText.slice(0, 300), lang: lang || 'en', ts: Date.now() };
      _chunks.push(meta);
      await MetaDB.put('chunks', meta);

      // Update shard
      var existing = await VectorShardManager.readShard(shardId);
      existing[offset] = vector;
      await VectorShardManager.writeShard(shardId, existing);
      return id;
    }

    function listDocChunks(docId) { return _chunks.filter(function (c) { return c.docId === docId; }); }
    function list() { return _chunks.slice(); }
    function count() { return _chunks.length; }

    async function removeDoc(docId) {
      var toRemove = listDocChunks(docId);
      for (var i = 0; i < toRemove.length; i++) await MetaDB.del('chunks', toRemove[i].id);
      _chunks = _chunks.filter(function (c) { return c.docId !== docId; });
    }

    return { load: load, add: add, listDocChunks: listDocChunks, list: list, count: count, removeDoc: removeDoc };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A5  SIMILARITY KERNEL
  // ═══════════════════════════════════════════════════════════════════════════
  var SimilarityKernel = (function () {
    function cosine(a, b) {
      if (!a || !b || a.length !== b.length) return 0;
      var dot = 0, na = 0, nb = 0;
      for (var i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
      }
      return dot / (Math.sqrt(na * nb) || 1);
    }

    function keywordScore(query, text) {
      var qw = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      var tw = text.toLowerCase().split(/\W+/);
      var hits = 0;
      tw.forEach(function (w) { if (qw.has(w)) hits++; });
      return qw.size ? hits / qw.size : 0;
    }

    return { cosine: cosine, keywordScore: keywordScore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A6  HYBRID RETRIEVER
  // ═══════════════════════════════════════════════════════════════════════════
  var HybridRetriever = (function () {
    async function search(queryVec, queryText, docId, topK, opts) {
      opts = opts || {};
      var chunks = docId ? EmbeddingIndex.listDocChunks(docId) : EmbeddingIndex.list();
      if (!chunks.length) return [];

      // Group by shard for batch read
      var byShardId = {};
      chunks.forEach(function (c) {
        if (!byShardId[c.shardId]) byShardId[c.shardId] = [];
        byShardId[c.shardId].push(c);
      });

      var results = [];
      var shardIds = Object.keys(byShardId);
      for (var i = 0; i < shardIds.length; i++) {
        var sid = shardIds[i];
        var vecs = await VectorShardManager.readShard(sid);
        var metas = byShardId[sid];
        for (var j = 0; j < metas.length; j++) {
          var meta   = metas[j];
          var vec    = vecs[meta.shardOffset];
          var vscore = queryVec && vec ? SimilarityKernel.cosine(queryVec, vec) : 0;
          var kscore = SimilarityKernel.keywordScore(queryText, meta.chunk);
          var score  = vscore * 0.7 + kscore * 0.3;
          results.push({ id: meta.id, docId: meta.docId, chunk: meta.chunk, score: score, vscore: vscore, kscore: kscore });
        }
      }

      results.sort(function (a, b) { return b.score - a.score; });
      VectorShardManager.evictLRU(8); // memory protection
      return results.slice(0, topK || 5);
    }
    return { search: search };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A7  ADAPTIVE EMBEDDING PIPELINE
  // ═══════════════════════════════════════════════════════════════════════════
  var AdaptiveEmbeddingPipeline = (function () {
    var _queue   = [];
    var _running = false;
    var _paused  = false;

    function _embed(text) {
      var LAF = sys('LabaAiFoundation');
      if (LAF && LAF.EmbeddingEngine && LAF.EmbeddingEngine.embed) return LAF.EmbeddingEngine.embed(text);
      // Heuristic fallback
      var words = text.toLowerCase().split(/\W+/).filter(Boolean);
      var vec   = new Float32Array(DIM).fill(0);
      words.forEach(function (w) {
        var h = 5381;
        for (var i = 0; i < w.length; i++) h = ((h << 5) + h) ^ w.charCodeAt(i);
        vec[Math.abs(h) % DIM] += 1;
      });
      var norm = 0; for (var i = 0; i < DIM; i++) norm += vec[i] * vec[i]; norm = Math.sqrt(norm) || 1;
      return Promise.resolve(vec.map(function (v) { return v / norm; }));
    }

    async function _processQueue() {
      if (_running || _paused || !_queue.length) return;
      _running = true;
      while (_queue.length && !_paused) {
        var item = _queue.shift();
        try {
          var vec = await _embed(item.text);
          await EmbeddingIndex.add(item.docId, item.text, vec, item.lang);
          item.resolve(vec);
        } catch (e) { item.reject(e); }
        await new Promise(function (r) { setTimeout(r, 2); }); // yield
      }
      _running = false;
    }

    function enqueue(docId, text, lang) {
      return new Promise(function (res, rej) {
        _queue.push({ docId: docId, text: text, lang: lang || 'en', resolve: res, reject: rej });
        setTimeout(_processQueue, 0);
      });
    }

    function pause()  { _paused = true; }
    function resume() { _paused = false; _processQueue(); }
    function pending() { return _queue.length; }

    return { enqueue: enqueue, pause: pause, resume: resume, pending: pending };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A8  MEMORY COMPACTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var MemoryCompactor = (function () {
    async function compact() {
      var allShards = await MetaDB.getAll('shards');
      VectorShardManager.evictLRU(4);
      log('compact: shard cache size now', VectorShardManager.cacheSize());
    }
    function checkPressure() {
      var mp = sys('MemPressure');
      if (mp && typeof mp.tier === 'function') {
        var tier = mp.tier();
        if (tier === 'danger' || tier === 'critical') { AdaptiveEmbeddingPipeline.pause(); compact(); }
        else AdaptiveEmbeddingPipeline.resume();
      }
    }
    setInterval(checkPressure, 15000);
    return { compact: compact };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A9  SEMANTIC CLUSTERER (basic k-means stub)
  // ═══════════════════════════════════════════════════════════════════════════
  var SemanticClusterer = (function () {
    function cluster(docId, k) {
      k = k || 5;
      var chunks = EmbeddingIndex.listDocChunks(docId);
      if (!chunks.length) return [];
      // Return evenly spaced samples as cluster centers
      var step = Math.max(1, Math.floor(chunks.length / k));
      return chunks.filter(function (_, i) { return i % step === 0; }).slice(0, k);
    }
    return { cluster: cluster };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A10  CROSS-DOCUMENT REASONER
  // ═══════════════════════════════════════════════════════════════════════════
  var CrossDocumentReasoner = (function () {
    async function findSimilarAcross(text, docIds, topK) {
      var LAF = sys('LabaAiFoundation');
      var qVec = LAF && LAF.EmbeddingEngine ? await LAF.EmbeddingEngine.embed(text) : null;
      var all  = [];
      for (var i = 0; i < docIds.length; i++) {
        var results = await HybridRetriever.search(qVec, text, docIds[i], topK || 3);
        all = all.concat(results);
      }
      all.sort(function (a,b) { return b.score - a.score; });
      return all.slice(0, topK || 10);
    }
    return { findSimilarAcross: findSimilarAcross };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A11  CONTEXT WINDOW BUILDER
  // ═══════════════════════════════════════════════════════════════════════════
  var ContextWindowBuilder = (function () {
    async function build(query, docId, maxTokens) {
      maxTokens = maxTokens || 2048;
      var LAF  = sys('LabaAiFoundation');
      var qVec = LAF && LAF.EmbeddingEngine ? await LAF.EmbeddingEngine.embed(query) : null;
      var results = await HybridRetriever.search(qVec, query, docId, 12);
      var window = []; var tokens = 0;
      for (var i = 0; i < results.length; i++) {
        var t = Math.ceil(results[i].chunk.length / 4);
        if (tokens + t > maxTokens) break;
        window.push(results[i].chunk);
        tokens += t;
      }
      return window.join('\n\n');
    }
    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A12  BACKGROUND INDEXING QUEUE
  // ═══════════════════════════════════════════════════════════════════════════
  var BackgroundIndexer = (function () {
    var _jobs = [];
    var _busy = false;

    function schedule(docId, texts, lang) {
      _jobs.push({ docId: docId, texts: texts, lang: lang || 'en', ts: Date.now() });
      if (!_busy) _run();
    }

    async function _run() {
      if (!_jobs.length) { _busy = false; return; }
      _busy = true;
      var job = _jobs.shift();
      log('indexing', job.texts.length, 'chunks for doc', job.docId);
      for (var i = 0; i < job.texts.length; i++) {
        try { await AdaptiveEmbeddingPipeline.enqueue(job.docId, job.texts[i], job.lang); }
        catch (_) {}
        if (i % 20 === 0) await new Promise(function (r) { setTimeout(r, 50); });
      }
      log('indexed', job.docId);
      setTimeout(_run, 100);
    }

    return { schedule: schedule, pending: function () { return _jobs.length + AdaptiveEmbeddingPipeline.pending(); } };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § A13  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  EmbeddingIndex.load().catch(function (e) { warn('index load error', e.message); });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.VectorMemoryEngine = {
    version:  VERSION,

    // Index a document's text chunks (background)
    index: function (docId, text, lang) {
      var chunks = text.match(/[\s\S]{1,400}/g) || [];
      BackgroundIndexer.schedule(docId, chunks, lang);
    },

    // Synchronous search (returns cached results or empty)
    search: function (query, docId, topK) {
      var chunks = docId ? EmbeddingIndex.listDocChunks(docId) : EmbeddingIndex.list();
      if (!chunks.length) return [];
      var qw = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return chunks
        .map(function (c) { return { chunk: c.chunk, docId: c.docId, score: SimilarityKernel.keywordScore(query, c.chunk) }; })
        .filter(function (r) { return r.score > 0; })
        .sort(function (a,b) { return b.score - a.score; })
        .slice(0, topK || 5);
    },

    // Async semantic search (uses vector similarity)
    searchAsync: function (query, docId, topK) {
      var LAF = sys('LabaAiFoundation');
      var qVecP = LAF && LAF.EmbeddingEngine ? LAF.EmbeddingEngine.embed(query) : Promise.resolve(null);
      return qVecP.then(function (qVec) { return HybridRetriever.search(qVec, query, docId, topK || 5); });
    },

    // Cross-document search
    searchAcross: function (query, topK) {
      var docIds = EmbeddingIndex.list().map(function (c) { return c.docId; }).filter(function (v,i,a) { return a.indexOf(v) === i; });
      return CrossDocumentReasoner.findSimilarAcross(query, docIds, topK || 10);
    },

    // Build context window for a query
    buildContext: function (query, docId, maxTokens) { return ContextWindowBuilder.build(query, docId, maxTokens); },

    // Remove doc from index
    removeDoc: function (docId) { return EmbeddingIndex.removeDoc(docId); },

    // Stats
    stats: function () { return { chunks: EmbeddingIndex.count(), shardCache: VectorShardManager.cacheSize(), pending: BackgroundIndexer.pending(), opfs: OpfsShardStore.isAvailable() }; },

    // Audit hook
    audit: function () {
      return { version: VERSION, chunks: EmbeddingIndex.count(), shardCacheSize: VectorShardManager.cacheSize(), pendingJobs: BackgroundIndexer.pending(), opfsAvailable: OpfsShardStore.isAvailable() };
    },

    // Cleanup hook
    cleanup: function () { MemoryCompactor.compact(); AdaptiveEmbeddingPipeline.pause(); VectorShardManager.evictLRU(0); },

    // Sub-systems exposed for integration
    ShardManager:    VectorShardManager,
    EmbeddingIndex:  EmbeddingIndex,
    Retriever:       HybridRetriever,
    Clusterer:       SemanticClusterer,
    CrossDoc:        CrossDocumentReasoner,
    ContextBuilder:  ContextWindowBuilder,
    BackgroundIndex: BackgroundIndexer,
    Compactor:       MemoryCompactor,
  };

  log('VectorMemoryEngine v' + VERSION + ' ready');
}());
