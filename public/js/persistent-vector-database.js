/**
 * PHASE 57 — PERSISTENT VECTOR DATABASE
 * window.PersistentVectorDatabase
 *
 * 57A AnnVectorIndex         — ANN search, cosine/dot, shard partitioning
 * 57B PersistentEmbeddingStore — OPFS shards, IDB metadata, compaction
 * 57C CrossDocumentGraph      — semantic linking, topic clustering, knowledge graph
 * 57D RetrievalEngine         — hybrid keyword+vector, ANN ranking, reranking
 * 57E VectorMemoryManager     — quotas, eviction, background compaction, low-RAM
 *
 * Extends VectorMemoryEngine without replacing it. Adds ANN, cross-doc graph,
 * and richer retrieval. Purely additive.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[PVD]';
  var DIM      = 384;
  var MB       = 1024 * 1024;

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'pvd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 57E  VECTOR MEMORY MANAGER (loaded first, used by all subsystems)
  // ═══════════════════════════════════════════════════════════════════════════
  var VectorMemoryManager = (function () {
    var _quota   = 256 * MB; // 256 MB soft quota
    var _used    = 0;
    var _evictionPolicy = 'lru'; // lru | score
    var _registry = []; // { key, sizeBytes, lastUsed, score }

    function register(key, sizeBytes, score) {
      var existing = _registry.findIndex(function(r){return r.key===key;});
      if (existing >= 0) { _registry[existing].sizeBytes = sizeBytes; _registry[existing].lastUsed = Date.now(); return; }
      _registry.push({ key: key, sizeBytes: sizeBytes, lastUsed: Date.now(), score: score||0 });
      _used += sizeBytes;
      if (_used > _quota) _evict();
    }

    function touch(key) {
      var r = _registry.find(function(r){return r.key===key;});
      if (r) r.lastUsed = Date.now();
    }

    function deregister(key) {
      var idx = _registry.findIndex(function(r){return r.key===key;});
      if (idx >= 0) { _used -= _registry[idx].sizeBytes; _registry.splice(idx,1); }
    }

    function _evict() {
      if (!_registry.length) return;
      var sorted = _registry.slice().sort(function(a,b){
        return _evictionPolicy === 'score'
          ? a.score - b.score
          : a.lastUsed - b.lastUsed;
      });
      var target = _quota * 0.75;
      while (_used > target && sorted.length) {
        var victim = sorted.shift();
        log('evicting:', victim.key, 'size:', victim.sizeBytes);
        deregister(victim.key);
      }
    }

    function lowRamMode() {
      _quota = 64 * MB;
      _evict();
    }

    function emergencyEvacuate() {
      _quota = 16 * MB;
      _evict();
      _quota = 256 * MB;
    }

    function stats() {
      return { usedMB: (_used/MB).toFixed(2), quotaMB: (_quota/MB).toFixed(0), entries: _registry.length };
    }

    // Monitor memory pressure
    setInterval(function() {
      var mp = sys('MemPressure') || sys('MemoryPressureMonitor');
      var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      if (tier === 'critical') emergencyEvacuate();
      else if (tier === 'danger') lowRamMode();
    }, 15000);

    return { register: register, touch: touch, deregister: deregister, stats: stats,
             lowRamMode: lowRamMode, emergencyEvacuate: emergencyEvacuate };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 57B  PERSISTENT EMBEDDING STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var PersistentEmbeddingStore = (function () {
    var DB_NAME    = 'pvd_embeddings_v1';
    var SHARD_SIZE = 256; // embeddings per shard
    var _db        = null;
    var _opfsDir   = null;
    var _cache     = new Map(); // shardKey → Float32Array
    var _meta      = []; // { id, docId, shardKey, offset, text, lang, hash, ts }
    var _loaded    = false;

    // ── IDB ──
    function _openDb() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req = indexedDB.open(DB_NAME,1);
        req.onupgradeneeded = function(e){
          var db=e.target.result;
          ['embeddings','shards','docs'].forEach(function(s){
            if(!db.objectStoreNames.contains(s)){
              var os=db.createObjectStore(s,{keyPath:'id'});
              if(s==='embeddings') os.createIndex('doc','docId',{unique:false});
            }
          });
        };
        req.onsuccess=function(e){_db=e.target.result;res(_db);};
        req.onerror=function(){rej(req.error);};
      });
    }
    function _dbPut(store,obj){return _openDb().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readwrite');tx.objectStore(store).put(obj);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    function _dbGetAll(store,idx,key){return _openDb().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readonly'),req=idx?tx.objectStore(store).index(idx).getAll(key):tx.objectStore(store).getAll();req.onsuccess=function(){r(req.result||[]);};req.onerror=function(){r([]);};});}).catch(function(){return[];});}

    // ── OPFS ──
    async function _ensureOpfs() {
      if (_opfsDir) return _opfsDir;
      try {
        var root = await navigator.storage.getDirectory();
        _opfsDir = await root.getDirectoryHandle('pvd_shards', {create:true});
        return _opfsDir;
      } catch(e) { warn('OPFS unavailable:', e.message); return null; }
    }

    async function _writeShard(key, data) {
      var dir = await _ensureOpfs();
      if (dir) {
        try {
          var fh = await dir.getFileHandle(key + '.bin', {create:true});
          var wr = await fh.createWritable();
          await wr.write(data instanceof Float32Array ? data.buffer : data);
          await wr.close();
        } catch(e) { warn('writeShard OPFS fail:', e.message); }
      }
      // Also cache in RAM
      _cache.set(key, data instanceof Float32Array ? data : new Float32Array(data));
      VectorMemoryManager.register('shard:'+key, data.byteLength||data.length*4);
    }

    async function _readShard(key) {
      if (_cache.has(key)) { VectorMemoryManager.touch('shard:'+key); return _cache.get(key); }
      var dir = await _ensureOpfs();
      if (dir) {
        try {
          var fh   = await dir.getFileHandle(key + '.bin');
          var file = await fh.getFile();
          var buf  = await file.arrayBuffer();
          var fa   = new Float32Array(buf);
          _cache.set(key, fa);
          VectorMemoryManager.register('shard:'+key, buf.byteLength);
          return fa;
        } catch(_) {}
      }
      return null;
    }

    function _hashText(text) {
      var h=0;
      for(var i=0;i<Math.min(text.length,256);i++) h=(Math.imul(31,h)+text.charCodeAt(i))|0;
      return (h>>>0).toString(16);
    }

    async function load() {
      if (_loaded) return;
      var rows = await _dbGetAll('embeddings');
      _meta    = rows;
      _loaded  = true;
      log('PersistentEmbeddingStore loaded:', _meta.length, 'embeddings');
    }

    async function add(docId, text, vector, lang) {
      if (!_loaded) await load();
      // Deduplication
      var hash = _hashText(text);
      if (_meta.some(function(m){return m.docId===docId&&m.hash===hash;})) return null;

      var shardKey = 'shard_' + Math.floor(_meta.length/SHARD_SIZE).toString().padStart(4,'0');
      var offset   = _meta.length % SHARD_SIZE;
      var id       = uid();
      var rec      = { id:id, docId:docId, shardKey:shardKey, offset:offset,
                       text:text.slice(0,300), lang:lang||'en', hash:hash, ts:Date.now() };
      _meta.push(rec);
      await _dbPut('embeddings', rec);

      // Read current shard, insert, write back
      var existing = await _readShard(shardKey) || new Float32Array(SHARD_SIZE * DIM);
      if (vector && vector.length === DIM) existing.set(vector, offset * DIM);
      await _writeShard(shardKey, existing);

      return id;
    }

    async function getVector(rec) {
      var shard = await _readShard(rec.shardKey);
      if (!shard) return null;
      return shard.slice(rec.offset * DIM, (rec.offset + 1) * DIM);
    }

    function forDoc(docId)   { return _meta.filter(function(m){return m.docId===docId;}); }
    function allMeta()       { return _meta.slice(); }
    function count()         { return _meta.length; }
    function shardCount()    { return _cache.size; }

    async function compact() {
      // Remove duplicate hashes
      var seen = new Set();
      var deduped = _meta.filter(function(m){
        if (seen.has(m.docId+':'+m.hash)) return false;
        seen.add(m.docId+':'+m.hash); return true;
      });
      if (deduped.length < _meta.length) {
        log('compacted:', _meta.length - deduped.length, 'duplicates removed');
        _meta = deduped;
      }
    }

    async function verify() {
      var errors = 0;
      for (var i = 0; i < Math.min(_meta.length, 50); i++) {
        var vec = await getVector(_meta[i]);
        if (!vec) errors++;
      }
      return { ok: errors === 0, errors: errors, checked: Math.min(_meta.length, 50) };
    }

    async function removeDoc(docId) {
      _meta = _meta.filter(function(m){return m.docId!==docId;});
    }

    // Background compaction
    setInterval(function(){ compact().catch(function(){}); }, 120000);

    return { load:load, add:add, getVector:getVector, forDoc:forDoc, allMeta:allMeta,
             count:count, shardCount:shardCount, compact:compact, verify:verify, removeDoc:removeDoc };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 57A  ANN VECTOR INDEX (Approximate Nearest Neighbor)
  // ═══════════════════════════════════════════════════════════════════════════
  var AnnVectorIndex = (function () {
    // Simple LSH (Locality Sensitive Hashing) for ANN
    var NUM_TABLES = 8;
    var BITS       = 12;
    var _tables    = []; // each: Map(hash → [metaId, ...])
    var _planes    = []; // random hyperplanes for hashing
    var _initialized = false;

    function _initPlanes() {
      _planes = [];
      _tables = [];
      for (var t = 0; t < NUM_TABLES; t++) {
        var table = new Map();
        _tables.push(table);
        var tablePlanes = [];
        for (var b = 0; b < BITS; b++) {
          var plane = new Float32Array(DIM);
          for (var d = 0; d < DIM; d++) plane[d] = (Math.random() - 0.5) * 2;
          tablePlanes.push(plane);
        }
        _planes.push(tablePlanes);
      }
      _initialized = true;
    }

    function _hashVector(vec, tableIdx) {
      var planes = _planes[tableIdx];
      var bits   = 0;
      for (var b = 0; b < BITS; b++) {
        var dot = 0;
        for (var d = 0; d < DIM; d++) dot += planes[b][d] * vec[d];
        if (dot >= 0) bits |= (1 << b);
      }
      return bits;
    }

    function insert(id, vec) {
      if (!_initialized) _initPlanes();
      if (!vec || vec.length !== DIM) return;
      for (var t = 0; t < NUM_TABLES; t++) {
        var h = _hashVector(vec, t);
        if (!_tables[t].has(h)) _tables[t].set(h, []);
        _tables[t].get(h).push(id);
      }
    }

    function query(queryVec, candidates) {
      if (!_initialized || !queryVec || queryVec.length !== DIM) return [];
      // Find candidate IDs via LSH
      var candidateSet = new Set();
      for (var t = 0; t < NUM_TABLES; t++) {
        var h = _hashVector(queryVec, t);
        // Check exact bucket + adjacent (hamming distance 1)
        for (var b = 0; b <= BITS; b++) {
          var probe = b < BITS ? (h ^ (1<<b)) : h;
          var bucket = _tables[t].get(probe);
          if (bucket) bucket.forEach(function(id){ candidateSet.add(id); });
        }
      }
      // Also add all if too few candidates
      if (candidateSet.size < 10 && candidates) {
        candidates.slice(0, 50).forEach(function(c){ candidateSet.add(c.id); });
      }
      return Array.from(candidateSet);
    }

    function cosine(a, b) {
      if (!a||!b||a.length!==b.length) return 0;
      var dot=0,na=0,nb=0;
      for(var i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
      return dot/(Math.sqrt(na*nb)||1);
    }

    function dotProduct(a, b) {
      if (!a||!b||a.length!==b.length) return 0;
      var s=0; for(var i=0;i<a.length;i++) s+=a[i]*b[i]; return s;
    }

    function rebuild(allMeta, getVectorFn) {
      _initPlanes();
      log('rebuilding ANN index for', allMeta.length, 'vectors');
      var batch = allMeta.slice(); var i = 0;
      function step() {
        if (i >= batch.length) { log('ANN index built'); return; }
        var meta = batch[i++];
        getVectorFn(meta).then(function(vec){ if(vec) insert(meta.id, vec); step(); });
      }
      step();
    }

    function stats() {
      var buckets = 0;
      _tables.forEach(function(t){ buckets += t.size; });
      return { tables: NUM_TABLES, bits: BITS, totalBuckets: buckets, initialized: _initialized };
    }

    return { insert:insert, query:query, cosine:cosine, dotProduct:dotProduct,
             rebuild:rebuild, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 57C  CROSS-DOCUMENT GRAPH
  // ═══════════════════════════════════════════════════════════════════════════
  var CrossDocumentGraph = (function () {
    var _nodes = new Map(); // docId → { docId, title, topics, embedding, ts }
    var _edges = new Map(); // docId+'->'+docId2 → { score, relationship, shared }
    var _topics = new Map(); // topic → Set(docId)

    function addDoc(docId, opts) {
      opts = opts || {};
      var node = { docId:docId, title:opts.title||docId.slice(0,20), topics:[], embedding:null, ts:Date.now() };
      _nodes.set(docId, node);
      log('graph node:', docId);
    }

    function _extractTopics(text) {
      var words = (text||'').toLowerCase().split(/\W+/).filter(function(w){return w.length>4;});
      var freq  = {};
      words.forEach(function(w){ freq[w]=(freq[w]||0)+1; });
      return Object.keys(freq).sort(function(a,b){return freq[b]-freq[a];}).slice(0,20);
    }

    function indexDoc(docId, text, embedding) {
      var topics = _extractTopics(text);
      var node   = _nodes.get(docId) || { docId:docId, title:docId.slice(0,20), ts:Date.now() };
      node.topics    = topics;
      node.embedding = embedding;
      _nodes.set(docId, node);

      // Index by topic
      topics.forEach(function(t){
        if (!_topics.has(t)) _topics.set(t, new Set());
        _topics.get(t).add(docId);
      });

      // Score edges against existing docs
      _nodes.forEach(function(other, otherId) {
        if (otherId === docId || !other.topics || !other.topics.length) return;
        var shared = topics.filter(function(t){ return other.topics.includes(t); });
        if (shared.length < 2) return;
        var score  = shared.length / Math.sqrt(topics.length * other.topics.length);
        var edgeKey = [docId, otherId].sort().join('->');
        var rel = score > 0.5 ? 'similar' : score > 0.2 ? 'related' : 'loosely-related';
        _edges.set(edgeKey, { score:score, relationship:rel, shared:shared.slice(0,8) });
      });
    }

    function findRelated(docId, topK) {
      topK = topK || 5;
      var results = [];
      _edges.forEach(function(edge, key) {
        var [a, b] = key.split('->');
        var otherId = a === docId ? b : b === docId ? a : null;
        if (otherId) results.push(Object.assign({ otherId:otherId }, edge));
      });
      return results.sort(function(a,b){return b.score-a.score;}).slice(0, topK);
    }

    function findByTopic(topic, limit) {
      var docs = _topics.get(topic.toLowerCase()) || new Set();
      return Array.from(docs).slice(0, limit||10);
    }

    function cluster(k) {
      // Simple topic-based clustering
      var docs = Array.from(_nodes.values());
      if (!docs.length) return [];
      var clusters = {};
      docs.forEach(function(d){
        var mainTopic = d.topics && d.topics[0] || 'other';
        if (!clusters[mainTopic]) clusters[mainTopic] = [];
        clusters[mainTopic].push(d.docId);
      });
      return Object.keys(clusters).slice(0,k||10).map(function(t){ return { topic:t, docs:clusters[t] }; });
    }

    function generateKnowledgeGraph() {
      return {
        nodes: Array.from(_nodes.values()).map(function(n){ return { id:n.docId, label:n.title, topics:n.topics.slice(0,5) }; }),
        edges: Array.from(_edges.entries()).map(function(e){ var p=e[0].split('->'); return { source:p[0], target:p[1], score:e[1].score, relationship:e[1].relationship }; }),
        clusters: cluster(20),
        topTopics: Array.from(_topics.entries()).sort(function(a,b){return b[1].size-a[1].size;}).slice(0,20).map(function(e){return {topic:e[0],count:e[1].size};}),
      };
    }

    function stats() { return { nodes: _nodes.size, edges: _edges.size, topics: _topics.size }; }

    return { addDoc:addDoc, indexDoc:indexDoc, findRelated:findRelated, findByTopic:findByTopic,
             cluster:cluster, generateKnowledgeGraph:generateKnowledgeGraph, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 57D  RETRIEVAL ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var RetrievalEngine = (function () {

    async function _getQueryVector(query) {
      var LAF = sys('LabaAiFoundation');
      if (LAF && LAF.EmbeddingEngine && LAF.EmbeddingEngine.embed) {
        try { return await LAF.EmbeddingEngine.embed(query); } catch(_){}
      }
      var VME = sys('VectorMemoryEngine');
      if (VME && VME.ShardManager) {
        // Use heuristic embedding from VectorMemoryEngine
        var words = query.toLowerCase().split(/\W+/).filter(Boolean);
        var vec   = new Float32Array(384).fill(0);
        words.forEach(function(w){ var h=5381; for(var i=0;i<w.length;i++) h=((h<<5)+h)^w.charCodeAt(i); vec[Math.abs(h)%384]+=1; });
        var norm=0; for(var i=0;i<384;i++) norm+=vec[i]*vec[i]; norm=Math.sqrt(norm)||1;
        return vec.map(function(v){return v/norm;});
      }
      return null;
    }

    function _keywordScore(query, text) {
      var qw = new Set(query.toLowerCase().split(/\W+/).filter(function(w){return w.length>2;}));
      var tw = (text||'').toLowerCase().split(/\W+/);
      var h  = tw.filter(function(w){return qw.has(w);}).length;
      return qw.size ? h/qw.size : 0;
    }

    async function search(query, opts) {
      opts = opts || {};
      var topK   = opts.topK || 8;
      var docId  = opts.docId || null;
      var minScore = opts.minScore || 0.05;

      if (!query) return [];

      var queryVec = await _getQueryVector(query);

      // Get candidates via ANN if query vector is available
      var meta   = PersistentEmbeddingStore.allMeta();
      if (docId) meta = meta.filter(function(m){return m.docId===docId;});

      var annIds = queryVec ? AnnVectorIndex.query(queryVec, meta) : [];
      var annSet = new Set(annIds);

      // Score all candidates (ANN candidates + all if small corpus)
      var candidates = (annSet.size > 0 && meta.length > 100)
        ? meta.filter(function(m){return annSet.has(m.id);})
        : meta;

      var scored = [];
      for (var i = 0; i < Math.min(candidates.length, 500); i++) {
        var m    = candidates[i];
        var vec  = queryVec ? await PersistentEmbeddingStore.getVector(m) : null;
        var vscore = queryVec && vec ? AnnVectorIndex.cosine(queryVec, vec) : 0;
        var kscore = _keywordScore(query, m.text);
        var score  = vscore * 0.65 + kscore * 0.35;
        // OCR confidence weighting
        var ocrW   = typeof m.ocrConfidence === 'number' ? m.ocrConfidence : 1;
        score *= ocrW;
        if (score >= minScore) scored.push({ id:m.id, docId:m.docId, chunk:m.text, lang:m.lang, score:score, vscore:vscore, kscore:kscore });
        if (i % 50 === 0) await new Promise(function(r){setTimeout(r,0);}); // yield
      }

      // Rerank: diversity penalty
      scored.sort(function(a,b){return b.score-a.score;});
      var results = []; var seenTexts = new Set();
      for (var j = 0; j < scored.length && results.length < topK; j++) {
        var sig = scored[j].chunk.slice(0,40);
        if (!seenTexts.has(sig)) { seenTexts.add(sig); results.push(scored[j]); }
      }

      return results;
    }

    async function searchMultilingual(query, targetLang, opts) {
      opts = opts || {};
      // Search both original and translated
      var results = await search(query, opts);
      // Filter by language preference if strict
      if (opts.strict && targetLang) {
        results = results.filter(function(r){return !r.lang||r.lang===targetLang||r.lang==='en';});
      }
      return results;
    }

    return { search:search, searchMultilingual:searchMultilingual };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT — load embeddings and rebuild ANN index
  // ═══════════════════════════════════════════════════════════════════════════
  PersistentEmbeddingStore.load().then(function() {
    var meta = PersistentEmbeddingStore.allMeta();
    if (meta.length) {
      AnnVectorIndex.rebuild(meta, function(m){ return PersistentEmbeddingStore.getVector(m); });
    }
  }).catch(function(e){ warn('init error:', e.message); });

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.PersistentVectorDatabase = {
    version: VERSION,

    // Index document text (async background)
    index: async function(docId, text, lang, embedding) {
      if (!text) return;
      var chunks = (text.match(/[\s\S]{1,400}/g)||[]);
      CrossDocumentGraph.addDoc(docId, { title: docId.slice(0,30) });
      CrossDocumentGraph.indexDoc(docId, text, embedding||null);

      for (var i = 0; i < chunks.length; i++) {
        var vec = null;
        var LAF = sys('LabaAiFoundation');
        if (LAF && LAF.EmbeddingEngine) {
          try { vec = await LAF.EmbeddingEngine.embed(chunks[i]); } catch(_){}
        }
        var id = await PersistentEmbeddingStore.add(docId, chunks[i], vec, lang);
        if (vec && id) AnnVectorIndex.insert(id, vec);
        if (i % 20 === 0) await new Promise(function(r){setTimeout(r,20);}); // yield + respect memory
      }
      log('indexed', chunks.length, 'chunks for doc:', docId);
    },

    // Hybrid search
    search: function(query, opts) { return RetrievalEngine.search(query, opts); },

    // Multilingual search
    searchMultilingual: function(query, lang, opts) { return RetrievalEngine.searchMultilingual(query, lang, opts); },

    // Remove doc
    removeDoc: function(docId) { return PersistentEmbeddingStore.removeDoc(docId); },

    // Cross-document graph
    graph: {
      findRelated:  function(docId, k) { return CrossDocumentGraph.findRelated(docId, k); },
      findByTopic:  function(topic, k) { return CrossDocumentGraph.findByTopic(topic, k); },
      cluster:      function(k) { return CrossDocumentGraph.cluster(k); },
      generate:     function() { return CrossDocumentGraph.generateKnowledgeGraph(); },
      stats:        function() { return CrossDocumentGraph.stats(); },
    },

    // Compaction + integrity
    compact: function() { return PersistentEmbeddingStore.compact(); },
    verify:  function() { return PersistentEmbeddingStore.verify(); },
    rebuildIndex: function() {
      return PersistentEmbeddingStore.load().then(function() {
        AnnVectorIndex.rebuild(PersistentEmbeddingStore.allMeta(), function(m){ return PersistentEmbeddingStore.getVector(m); });
      });
    },

    stats: function() {
      return {
        embeddings: PersistentEmbeddingStore.count(),
        shards:     PersistentEmbeddingStore.shardCount(),
        annIndex:   AnnVectorIndex.stats(),
        graph:      CrossDocumentGraph.stats(),
        memory:     VectorMemoryManager.stats(),
      };
    },

    audit: function() {
      return { version:VERSION, ...window.PersistentVectorDatabase.stats() };
    },

    cleanup: function() {
      VectorMemoryManager.emergencyEvacuate();
      log('PersistentVectorDatabase cleaned up');
    },

    // Sub-systems
    EmbeddingStore:  PersistentEmbeddingStore,
    AnnIndex:        AnnVectorIndex,
    Graph:           CrossDocumentGraph,
    Retrieval:       RetrievalEngine,
    MemoryManager:   VectorMemoryManager,
  };

  log('PersistentVectorDatabase v' + VERSION + ' ready');
}());
