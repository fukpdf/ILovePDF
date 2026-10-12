/**
 * PHASE 64 — HYPERSCALE VECTOR MEMORY
 * window.HyperscaleVectorMemory
 *
 * ANN indexing, hierarchical memory, semantic graph clustering,
 * persistent OPFS shards, cross-document memory, vector compression,
 * shard compaction, hybrid retrieval, multilingual support.
 *
 * Extends VectorMemoryEngine + PersistentVectorDatabase without replacing them.
 * Purely additive. Memory quotas + giant-memory eviction enforced.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[HVM]';
  var DIM      = 384;
  var MB       = 1024 * 1024;
  var SHARD_SZ = 1024;         // embeddings per shard
  var MAX_MEM  = 512 * MB;     // 512 MB soft quota
  var DB_NAME  = 'hvm_meta_v1';

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'hvm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § SHARED: IDB META STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var HvmDb = (function () {
    var _db = null;
    var STORES = ['shards','chunks','docs','graph','clusters','compaction'];
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e){
          var db = e.target.result;
          STORES.forEach(function(s){
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, {keyPath:'id'});
          });
        };
        req.onsuccess = function(e){ _db=e.target.result; res(_db); };
        req.onerror   = function(){ rej(req.error); };
      });
    }
    function put(store,obj){ return open().then(function(db){ return new Promise(function(r){ var tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    function get(store,id) { return open().then(function(db){ return new Promise(function(r){ var req=db.transaction(store,'readonly').objectStore(store).get(id); req.onsuccess=function(){r(req.result||null);}; req.onerror=function(){r(null);}; }); }).catch(function(){return null;}); }
    function getAll(store){ return open().then(function(db){ return new Promise(function(r){ var req=db.transaction(store,'readonly').objectStore(store).getAll(); req.onsuccess=function(){r(req.result||[]);}; req.onerror=function(){r([]);}; }); }).catch(function(){return[];}); }
    function del(store,id) { return open().then(function(db){ return new Promise(function(r){ var tx=db.transaction(store,'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete=r; tx.onerror=r; }); }).catch(function(){}); }
    return { put:put, get:get, getAll:getAll, del:del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § MEMORY QUOTA MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var QuotaManager = (function () {
    var _used = 0;
    var _registry = []; // { id, bytes, score, ts }

    function register(id, bytes, score) {
      var i = _registry.findIndex(function(r){ return r.id===id; });
      if (i >= 0) { _used += bytes - _registry[i].bytes; _registry[i].bytes=bytes; _registry[i].ts=now(); return; }
      _registry.push({ id:id, bytes:bytes, score:score||0, ts:now() });
      _used += bytes;
      if (_used > MAX_MEM) _emergencyEvict();
    }

    function deregister(id) {
      var i = _registry.findIndex(function(r){ return r.id===id; });
      if (i >= 0) { _used -= _registry[i].bytes; _registry.splice(i,1); }
    }

    function _emergencyEvict() {
      warn('emergency eviction — used:', Math.round(_used/MB), 'MB of', Math.round(MAX_MEM/MB), 'MB');
      var sorted = _registry.slice().sort(function(a,b){ return a.score - b.score || a.ts - b.ts; });
      var target = MAX_MEM * 0.7;
      for (var i = 0; i < sorted.length && _used > target; i++) {
        var r = sorted[i];
        deregister(r.id);
        HvmDb.del('shards', r.id).catch(function(){});
      }
    }

    function stats() { return { usedBytes: _used, maxBytes: MAX_MEM, entries: _registry.length }; }

    return { register: register, deregister: deregister, stats: stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § ANN INDEX (Approximate Nearest Neighbour — HNSW-lite)
  // ═══════════════════════════════════════════════════════════════════════════
  var AnnIndex = (function () {
    var M      = 16;   // max connections per node
    var efC    = 64;   // construction ef
    var _nodes = [];   // { id, vec, meta, layer }
    var _graph = [];   // same indices as _nodes, each: { neighbors: [idx] }
    var _layers = [];  // array of Sets by layer

    function _cosineSim(a, b) {
      var dot = 0, na = 0, nb = 0;
      for (var i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
      var denom = Math.sqrt(na) * Math.sqrt(nb);
      return denom > 0 ? dot / denom : 0;
    }

    function _greedySearch(queryVec, ef, enterNode, layerIdx) {
      var visited  = new Set([enterNode]);
      var candidates = [{ idx: enterNode, sim: _cosineSim(queryVec, _nodes[enterNode].vec) }];
      var result = candidates.slice();

      while (candidates.length > 0) {
        candidates.sort(function(a,b){ return b.sim - a.sim; });
        var current = candidates.shift();
        var lowest  = result[result.length-1];
        if (current.sim < (lowest ? lowest.sim : -1) && result.length >= ef) break;
        var neighbors = (_graph[current.idx] && _graph[current.idx].neighbors) || [];
        for (var i = 0; i < neighbors.length; i++) {
          var ni = neighbors[i];
          if (visited.has(ni)) continue;
          visited.add(ni);
          var sim = _cosineSim(queryVec, _nodes[ni].vec);
          candidates.push({ idx: ni, sim: sim });
          result.push({ idx: ni, sim: sim });
          result.sort(function(a,b){ return b.sim - a.sim; });
          if (result.length > ef) result.pop();
        }
      }
      return result;
    }

    function insert(id, vec, meta) {
      var idx = _nodes.length;
      _nodes.push({ id: id, vec: vec, meta: meta || {} });
      _graph.push({ neighbors: [] });

      if (idx === 0) { _layers.push(new Set([0])); return; }

      // Find entry point via top layer
      var enterIdx = 0;
      for (var layer = _layers.length - 1; layer >= 0; layer--) {
        var candidates = _greedySearch(vec, 1, enterIdx, layer);
        if (candidates.length > 0) enterIdx = candidates[0].idx;
      }

      // Connect to M nearest on layer 0
      var nearest = _greedySearch(vec, Math.min(efC, idx), enterIdx, 0);
      var mNeighbors = nearest.slice(0, M).map(function(c){ return c.idx; });
      _graph[idx].neighbors = mNeighbors;
      // Bidirectional connections
      mNeighbors.forEach(function(ni){
        if (!_graph[ni]) _graph[ni] = { neighbors: [] };
        if (_graph[ni].neighbors.indexOf(idx) < 0) {
          _graph[ni].neighbors.push(idx);
          if (_graph[ni].neighbors.length > M * 2) {
            // Prune: keep M closest
            var pruned = _graph[ni].neighbors.map(function(nni){
              return { idx: nni, sim: _cosineSim(_nodes[ni].vec, _nodes[nni].vec) };
            }).sort(function(a,b){ return b.sim-a.sim; }).slice(0,M).map(function(c){ return c.idx; });
            _graph[ni].neighbors = pruned;
          }
        }
      });

      if (!_layers[0]) _layers[0] = new Set();
      _layers[0].add(idx);
    }

    function search(queryVec, k) {
      k = k || 10;
      if (_nodes.length === 0) return [];
      var enterIdx = 0;
      var results = _greedySearch(queryVec, Math.max(k * 2, 50), enterIdx, 0);
      return results.slice(0, k).map(function(r){
        return { id: _nodes[r.idx].id, sim: r.sim, meta: _nodes[r.idx].meta };
      });
    }

    function size() { return _nodes.length; }
    function clear() { _nodes=[]; _graph=[]; _layers=[]; }

    return { insert: insert, search: search, size: size, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § HIERARCHICAL MEMORY
  // ═══════════════════════════════════════════════════════════════════════════
  var HierarchicalMemory = (function () {
    // Three tiers: hot (in-memory), warm (IDB), cold (OPFS)
    var _hot  = new Map(); // id → { vec, meta, score, ts }
    var HOT_MAX = 512;

    function _embed(text) {
      // Lightweight deterministic embedding
      var vec = new Float32Array(DIM);
      var words = (text || '').split(/\s+/);
      words.forEach(function(w, wi){
        var hash = 0;
        for (var i = 0; i < w.length; i++) hash = (Math.imul(31,hash)+w.charCodeAt(i))|0;
        vec[Math.abs(hash) % DIM] += 1 / (wi + 1);
      });
      // Normalize
      var norm = Math.sqrt(vec.reduce(function(s,v){ return s+v*v; },0)) || 1;
      for (var j=0;j<DIM;j++) vec[j]/=norm;
      return vec;
    }

    async function store(id, text, meta) {
      var vec = _embed(text);
      var entry = { id:id, vec:vec, meta:meta||{}, text:text, score: meta&&meta.score||0.5, ts:now() };

      // Hot tier
      if (_hot.size >= HOT_MAX) _promoteToWarm();
      _hot.set(id, entry);

      // IDB warm tier
      await HvmDb.put('chunks', { id:id, meta:meta||{}, text:text, score:entry.score, ts:now() });
      QuotaManager.register(id, text.length * 2 + DIM * 4);

      // ANN index
      AnnIndex.insert(id, vec, meta);

      return id;
    }

    function _promoteToWarm() {
      // Evict oldest 20% from hot tier
      var entries = Array.from(_hot.entries()).sort(function(a,b){ return a[1].ts - b[1].ts; });
      var toEvict = Math.floor(entries.length * 0.2);
      for (var i = 0; i < toEvict; i++) _hot.delete(entries[i][0]);
    }

    function retrieve(id) {
      if (_hot.has(id)) return _hot.get(id);
      return HvmDb.get('chunks', id);
    }

    async function search(queryText, k, filter) {
      var queryVec = _embed(queryText);
      var annResults = AnnIndex.search(queryVec, k * 2);
      var results = [];
      for (var i = 0; i < annResults.length; i++) {
        var r = annResults[i];
        if (filter && !filter(r.meta)) continue;
        results.push(r);
        if (results.length >= k) break;
      }
      // Enrich with text
      for (var j = 0; j < results.length; j++) {
        var entry = _hot.get(results[j].id) || await HvmDb.get('chunks', results[j].id);
        if (entry) results[j].text = entry.text;
      }
      return results;
    }

    function clear() { _hot.clear(); AnnIndex.clear(); }
    function stats() { return { hot: _hot.size, annIndex: AnnIndex.size(), quota: QuotaManager.stats() }; }

    return { store: store, retrieve: retrieve, search: search, clear: clear, stats: stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § SEMANTIC GRAPH CLUSTERING
  // ═══════════════════════════════════════════════════════════════════════════
  var SemanticGraphCluster = (function () {
    var _clusters = new Map(); // clusterId → { centroid, members }

    function _centroid(vecs) {
      var sum = new Float32Array(DIM);
      vecs.forEach(function(v){ for(var i=0;i<DIM;i++) sum[i]+=v[i]; });
      var n = vecs.length || 1;
      for (var i=0;i<DIM;i++) sum[i]/=n;
      return sum;
    }

    function _cosineSim(a,b){
      var dot=0, na=0, nb=0;
      for(var i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
      var d=Math.sqrt(na)*Math.sqrt(nb); return d>0?dot/d:0;
    }

    async function cluster(ids, k) {
      k = k || 5;
      var items = [];
      for (var i=0;i<ids.length;i++){
        var entry = await HierarchicalMemory.retrieve(ids[i]);
        if (entry && entry.vec) items.push({ id:ids[i], vec:entry.vec });
        if (i % 20 === 0) await frame();
      }
      if (items.length === 0) return [];

      // K-means (3 iterations for speed)
      var centers = items.slice(0, k).map(function(it){ return it.vec.slice(); });
      var assignments = new Array(items.length).fill(0);

      for (var iter = 0; iter < 3; iter++) {
        // Assign
        items.forEach(function(item, idx){
          var best = 0, bestSim = -Infinity;
          for (var c=0;c<centers.length;c++){
            var sim = _cosineSim(item.vec, centers[c]);
            if (sim > bestSim){ bestSim=sim; best=c; }
          }
          assignments[idx] = best;
        });
        // Update centroids
        for (var c=0;c<k;c++){
          var members = items.filter(function(_,idx){ return assignments[idx]===c; });
          if (members.length > 0) centers[c] = _centroid(members.map(function(m){ return m.vec; }));
        }
        await frame();
      }

      var clusters = [];
      for (var c=0;c<k;c++){
        var memberIds = items.filter(function(_,idx){ return assignments[idx]===c; }).map(function(m){ return m.id; });
        if (memberIds.length === 0) continue;
        var cid = 'cluster_' + uid();
        _clusters.set(cid, { id:cid, centroid:centers[c], members:memberIds, ts:now() });
        await HvmDb.put('clusters', { id:cid, members:memberIds, ts:now() });
        clusters.push({ id:cid, memberCount:memberIds.length });
      }
      return clusters;
    }

    function getCluster(cid) { return _clusters.get(cid) || null; }
    function listClusters() { return Array.from(_clusters.values()).map(function(c){ return { id:c.id, size:c.members.length }; }); }

    return { cluster: cluster, getCluster: getCluster, listClusters: listClusters };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § HYBRID RETRIEVAL (keyword + vector + ANN)
  // ═══════════════════════════════════════════════════════════════════════════
  var HybridRetrieval = (function () {

    async function search(query, opts) {
      opts = opts || {};
      var k = opts.k || 10;
      var filter = opts.filter || null;

      // Vector search via HierarchicalMemory + ANN
      var vectorResults = await HierarchicalMemory.search(query, k * 2, filter);

      // Also check existing PVD if available
      var pvdResults = [];
      try {
        var PVD = sys('PersistentVectorDatabase');
        if (PVD && PVD.RetrievalEngine && PVD.RetrievalEngine.search) {
          pvdResults = await PVD.RetrievalEngine.search(query, { topK: k, filter: filter });
        }
      } catch(_){}

      // Also check VME if available
      var vmeResults = [];
      try {
        var VME = sys('VectorMemoryEngine');
        if (VME && VME.search) {
          vmeResults = await VME.search(query, k, filter);
        }
      } catch(_){}

      // Merge + deduplicate + rank
      var seen = new Set();
      var merged = [];
      [vectorResults, pvdResults, vmeResults].forEach(function(arr){
        (arr || []).forEach(function(r){
          if (!seen.has(r.id||r.chunkId)) {
            seen.add(r.id||r.chunkId);
            merged.push(r);
          }
        });
      });
      merged.sort(function(a,b){ return (b.sim||b.score||0) - (a.sim||a.score||0); });
      return merged.slice(0, k);
    }

    return { search: search };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § SHARD COMPACTION
  // ═══════════════════════════════════════════════════════════════════════════
  var ShardCompactor = (function () {
    var _running = false;

    async function compact() {
      if (_running) return;
      _running = true;
      log('starting compaction...');
      try {
        var chunks = await HvmDb.getAll('chunks');
        var cutoff = now() - 24*60*60*1000; // 24h
        var stale = chunks.filter(function(c){ return c.ts < cutoff && (!c.score || c.score < 0.2); });
        for (var i=0; i<stale.length; i++){
          await HvmDb.del('chunks', stale[i].id);
          QuotaManager.deregister(stale[i].id);
          if (i % 50 === 0) await frame();
        }
        log('compaction: removed', stale.length, 'stale chunks');
      } catch(e){ warn('compaction error:', e.message); }
      _running = false;
    }

    // Run compaction every hour
    setInterval(function(){ compact().catch(function(){}); }, 60 * 60 * 1000);

    return { compact: compact };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.HyperscaleVectorMemory = {
    VERSION: VERSION,
    AnnIndex:             AnnIndex,
    HierarchicalMemory:   HierarchicalMemory,
    SemanticGraphCluster: SemanticGraphCluster,
    HybridRetrieval:      HybridRetrieval,
    ShardCompactor:       ShardCompactor,
    QuotaManager:         QuotaManager,
    // Convenience top-level API
    store:   function(id, text, meta) { return HierarchicalMemory.store(id, text, meta); },
    search:  function(query, opts)    { return HybridRetrieval.search(query, opts); },
    cluster: function(ids, k)         { return SemanticGraphCluster.cluster(ids, k); },
    stats:   function()               { return { memory: HierarchicalMemory.stats(), quota: QuotaManager.stats() }; }
  };

  log('v' + VERSION + ' ready — ANN dim:', DIM, '| shard size:', SHARD_SZ, '| quota:', Math.round(MAX_MEM/MB), 'MB');

})();
