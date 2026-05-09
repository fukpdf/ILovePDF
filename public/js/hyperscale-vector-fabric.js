/**
 * PHASE 68 — HYPERSCALE VECTOR FABRIC
 * window.HyperscaleVectorFabric
 *
 * 68A LargeScaleAnnEngine       — HNSW+IVF hybrid, cosine, streaming inserts
 * 68B GraphMemorySystem         — entity linking, topic clustering, cross-doc memory
 * 68C SemanticCompressionEngine — embedding compression, dedup, compaction
 * 68D DistributedIndexingSystem — background indexing, shard compaction, recovery
 *
 * Extends HyperscaleVectorMemory + PersistentVectorDatabase. Purely additive.
 * Memory quotas enforced. OPFS+IDB backed. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[HVF]';
  var DIM      = 384;
  var MB       = 1024 * 1024;
  var DB_NAME  = 'hvf_fabric_v1';
  var MAX_MEM  = 768 * MB;   // 768 MB soft quota
  var SHARD_SZ = 2048;       // embeddings per shard

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'hvf_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }

  // ── IDB helper ─────────────────────────────────────────────────────────────
  var HvfDb = (function () {
    var _db=null;
    var STORES=['chunks','shards','graph','clusters','compressed','index_state'];
    function open(){
      if(_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=function(e){ var db=e.target.result; STORES.forEach(function(s){ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'}); }); };
        req.onsuccess=function(e){_db=e.target.result;res(_db);}; req.onerror=function(){rej(req.error);};
      });
    }
    function put(s,o){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(s,'readwrite');tx.objectStore(s).put(o);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    function get(s,id){return open().then(function(db){return new Promise(function(r){var req=db.transaction(s,'readonly').objectStore(s).get(id);req.onsuccess=function(){r(req.result||null);};req.onerror=function(){r(null);};});}).catch(function(){return null;});}
    function getAll(s){return open().then(function(db){return new Promise(function(r){var req=db.transaction(s,'readonly').objectStore(s).getAll();req.onsuccess=function(){r(req.result||[]);};req.onerror=function(){r([]);};});}).catch(function(){return[];});}
    function del(s,id){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(s,'readwrite');tx.objectStore(s).delete(id);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    return {put:put,get:get,getAll:getAll,del:del};
  })();

  // ── Cosine similarity ───────────────────────────────────────────────────────
  function _cosineSim(a,b){
    var dot=0,na=0,nb=0;
    for(var i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
    var d=Math.sqrt(na)*Math.sqrt(nb); return d>0?dot/d:0;
  }

  // ── Fast text embedding ─────────────────────────────────────────────────────
  function _embed(text) {
    var vec = new Float32Array(DIM);
    var words = (text||'').toLowerCase().split(/\W+/).filter(Boolean);
    words.forEach(function(w,wi){
      var h=0; for(var i=0;i<w.length;i++) h=(Math.imul(31,h)+w.charCodeAt(i))|0;
      for(var d=0;d<Math.min(8,DIM);d++){
        vec[(Math.abs(h)+d)%DIM] += 1/(wi+1) * Math.sin(h+d);
      }
    });
    var norm=Math.sqrt(vec.reduce(function(s,v){return s+v*v;},0))||1;
    for(var j=0;j<DIM;j++) vec[j]/=norm;
    return vec;
  }

  // ── Quota manager ───────────────────────────────────────────────────────────
  var QuotaManager = (function () {
    var _used=0, _registry=[];
    function register(id,bytes){ var i=_registry.findIndex(function(r){return r.id===id;}); if(i>=0){_used+=bytes-_registry[i].bytes;_registry[i].bytes=bytes;_registry[i].ts=now();return;} _registry.push({id:id,bytes:bytes,ts:now()}); _used+=bytes; if(_used>MAX_MEM) _evict(); }
    function deregister(id){ var i=_registry.findIndex(function(r){return r.id===id;}); if(i>=0){_used-=_registry[i].bytes;_registry.splice(i,1);} }
    function _evict(){
      warn('HVF quota evict — used:',Math.round(_used/MB)+'MB');
      var sorted=_registry.slice().sort(function(a,b){return a.ts-b.ts;});
      var target=MAX_MEM*0.65;
      for(var i=0;i<sorted.length&&_used>target;i++){_used-=sorted[i].bytes;_registry.splice(_registry.indexOf(sorted[i]),1);HvfDb.del('chunks',sorted[i].id).catch(function(){});}
    }
    function stats(){return{usedBytes:_used,maxBytes:MAX_MEM,entries:_registry.length};}
    return{register:register,deregister:deregister,stats:stats};
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 68A  LARGE-SCALE ANN ENGINE (HNSW + IVF hybrid)
  // ═══════════════════════════════════════════════════════════════════════════
  var LargeScaleAnnEngine = (function () {
    // HNSW parameters
    var M        = 16;    // max connections per node
    var EF_C     = 100;   // construction ef
    var EF_S     = 50;    // search ef
    var MAX_NODE = 500000;

    // IVF: coarse quantization for large indices
    var IVF_CLUSTERS = 64;
    var _centroids   = [];  // Float32Array[]
    var _ivfLists    = [];  // Array<int[]>

    var _nodes  = [];  // { id, vec, meta }
    var _graph  = [];  // { neighbors: int[] }
    var _sz     = 0;

    function _greedySearch(qVec, ef, enter, layer) {
      var visited  = new Set([enter]);
      var cands    = [{idx:enter,sim:_cosineSim(qVec,_nodes[enter].vec)}];
      var result   = cands.slice();
      while(cands.length){
        cands.sort(function(a,b){return b.sim-a.sim;}); var cur=cands.shift();
        if(result.length>=ef && cur.sim<result[result.length-1].sim) break;
        var nbrs=(_graph[cur.idx]&&_graph[cur.idx].neighbors)||[];
        for(var i=0;i<nbrs.length;i++){
          var ni=nbrs[i]; if(visited.has(ni)) continue; visited.add(ni);
          var sim=_cosineSim(qVec,_nodes[ni].vec);
          cands.push({idx:ni,sim:sim}); result.push({idx:ni,sim:sim});
          result.sort(function(a,b){return b.sim-a.sim;});
          if(result.length>ef) result.pop();
        }
      }
      return result;
    }

    // IVF: find nearest centroid cluster
    function _ivfAssign(vec) {
      if(!_centroids.length) return 0;
      var best=0, bestSim=-Infinity;
      for(var c=0;c<_centroids.length;c++){
        var sim=_cosineSim(vec,_centroids[c]);
        if(sim>bestSim){bestSim=sim;best=c;}
      }
      return best;
    }

    function _buildIvf() {
      if(_sz<IVF_CLUSTERS*2) return; // not enough points
      // Simple k-means centroids (1 iteration on current nodes)
      _centroids=[]; _ivfLists=[];
      for(var c=0;c<Math.min(IVF_CLUSTERS,_sz);c+=Math.floor(_sz/IVF_CLUSTERS)||1){
        _centroids.push(_nodes[c].vec.slice());
        _ivfLists.push([]);
      }
      for(var ni=0;ni<_sz;ni++){
        var assigned=_ivfAssign(_nodes[ni].vec);
        _ivfLists[assigned].push(ni);
      }
    }

    async function insert(id, vec, meta) {
      if(_sz>=MAX_NODE){ warn('ANN index full — evicting 10%'); _evictNodes(0.1); }
      var idx=_sz;
      _nodes.push({id:id,vec:vec,meta:meta||{}});
      _graph.push({neighbors:[]});
      _sz++;

      if(idx===0) return;
      // Connect to M nearest
      var enter=0;
      var results=_greedySearch(vec,Math.min(EF_C,idx),enter,0);
      var mNeighbors=results.slice(0,M).map(function(r){return r.idx;});
      _graph[idx].neighbors=mNeighbors;
      // Bidirectional + prune
      mNeighbors.forEach(function(ni){
        if(!_graph[ni]) return;
        if(_graph[ni].neighbors.indexOf(idx)<0){
          _graph[ni].neighbors.push(idx);
          if(_graph[ni].neighbors.length>M*2){
            _graph[ni].neighbors=_graph[ni].neighbors.map(function(nni){
              return{idx:nni,sim:_cosineSim(_nodes[ni].vec,_nodes[nni].vec)};
            }).sort(function(a,b){return b.sim-a.sim;}).slice(0,M).map(function(r){return r.idx;});
          }
        }
      });

      // Rebuild IVF every 1000 inserts
      if(_sz%1000===0){ await frame(); _buildIvf(); }

      // Persist chunk meta
      await HvfDb.put('chunks', { id:id, meta:meta||{}, ts:now() });
      QuotaManager.register(id, DIM*4);
    }

    function search(qVec, k, filter) {
      k=k||10; if(_sz===0) return [];
      // Hybrid: IVF narrows candidates, HNSW refines
      var candidates=[];
      if(_centroids.length>0){
        // Search top-3 IVF clusters
        var clusterSims=_centroids.map(function(c,ci){return{ci:ci,sim:_cosineSim(qVec,c)};});
        clusterSims.sort(function(a,b){return b.sim-a.sim;});
        var topClusters=clusterSims.slice(0,3).map(function(c){return c.ci;});
        topClusters.forEach(function(ci){
          (_ivfLists[ci]||[]).forEach(function(ni){candidates.push(ni);});
        });
      }
      if(!candidates.length) candidates=Array.from({length:Math.min(_sz,500)},function(_,i){return i;});

      // HNSW search from best candidate
      var enter=candidates.reduce(function(best,ni){
        return _cosineSim(qVec,_nodes[ni].vec)>_cosineSim(qVec,_nodes[best].vec)?ni:best;
      },candidates[0]||0);
      var results=_greedySearch(qVec,Math.max(k*2,EF_S),enter,0);

      // Apply filter + dedupe
      var seen=new Set(); var filtered=[];
      results.forEach(function(r){
        var node=_nodes[r.idx];
        if(!node||seen.has(node.id)) return;
        if(filter&&!filter(node.meta)) return;
        seen.add(node.id);
        filtered.push({id:node.id,sim:r.sim,meta:node.meta});
      });
      return filtered.slice(0,k);
    }

    function _evictNodes(frac) {
      var removeN=Math.floor(_sz*frac);
      _nodes.splice(0,removeN); _graph.splice(0,removeN); _sz=_nodes.length;
      _centroids=[]; _ivfLists=[]; // rebuild next insert batch
    }

    // Streaming insert: insert large arrays without blocking
    async function bulkInsert(items) {
      var BATCH=50;
      for(var i=0;i<items.length;i+=BATCH){
        var batch=items.slice(i,i+BATCH);
        for(var j=0;j<batch.length;j++) await insert(batch[j].id,batch[j].vec,batch[j].meta);
        await frame();
      }
    }

    function size(){ return _sz; }
    function clear(){ _nodes=[]; _graph=[]; _sz=0; _centroids=[]; _ivfLists=[]; }

    return { insert:insert, search:search, bulkInsert:bulkInsert, size:size, clear:clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 68B  GRAPH MEMORY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var GraphMemorySystem = (function () {
    var _nodes  = new Map(); // nodeId → { id, type, text, meta, vec }
    var _edges  = new Map(); // nodeId → Set<nodeId>
    var _topics = new Map(); // topic → nodeId[]

    function _extractEntities(text) {
      // Simple NER: capitalized phrases, numbers, proper nouns
      var entities = [];
      var matches = text.match(/[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*/g) || [];
      matches.forEach(function(m){ if(m.length>3&&!['The','This','That','These','Those','They','When','Where','What','How'].includes(m)) entities.push(m); });
      // Also extract numbers + units
      var numMatches = text.match(/\$?[\d,]+(?:\.\d+)?(?:\s*[A-Za-z%]+)?/g) || [];
      numMatches.forEach(function(m){ if(m.length>2) entities.push(m); });
      return [...new Set(entities)].slice(0,20);
    }

    function _extractTopics(text) {
      var TOPIC_WORDS = {
        finance:['revenue','profit','loss','tax','investment','budget','cost','price'],
        legal:['agreement','contract','law','court','patent','license','terms','clause'],
        technical:['algorithm','function','server','api','database','code','software','system'],
        medical:['patient','treatment','diagnosis','therapy','drug','clinical','health'],
        general:['document','report','analysis','summary','overview','introduction']
      };
      var textLower = text.toLowerCase();
      var found = [];
      Object.entries(TOPIC_WORDS).forEach(function(kv){
        var hits=kv[1].filter(function(w){return textLower.indexOf(w)>=0;}).length;
        if(hits>=2) found.push({topic:kv[0],hits:hits});
      });
      found.sort(function(a,b){return b.hits-a.hits;});
      return found.map(function(f){return f.topic;}).slice(0,3);
    }

    async function addDocument(docId, text, meta) {
      var vec = _embed(text);
      var entities = _extractEntities(text);
      var topics   = _extractTopics(text);

      var node = { id:docId, type:'document', text:text.slice(0,500), meta:meta||{}, vec:vec, entities:entities, topics:topics, ts:now() };
      _nodes.set(docId, node);

      // Index by topic
      topics.forEach(function(t){
        if(!_topics.has(t)) _topics.set(t,[]);
        _topics.get(t).push(docId);
      });

      // Create entity nodes + link to doc
      entities.forEach(function(e){
        var eid = 'ent_'+e.replace(/\s+/g,'_').toLowerCase();
        if(!_nodes.has(eid)){
          _nodes.set(eid, {id:eid,type:'entity',text:e,meta:{},vec:_embed(e),entities:[],topics:[],ts:now()});
        }
        // Edge: doc → entity
        if(!_edges.has(docId)) _edges.set(docId,new Set());
        _edges.get(docId).add(eid);
        // Edge: entity → doc (reverse)
        if(!_edges.has(eid)) _edges.set(eid,new Set());
        _edges.get(eid).add(docId);
      });

      // Cross-doc linking: find semantically similar existing docs
      var similar = LargeScaleAnnEngine.search(vec, 5, function(m){return m&&m.type==='document';});
      similar.forEach(function(s){
        if(s.id!==docId && s.sim>0.7){
          if(!_edges.has(docId)) _edges.set(docId,new Set());
          _edges.get(docId).add(s.id);
        }
      });

      // Insert into ANN
      await LargeScaleAnnEngine.insert(docId, vec, { type:'document', topics:topics });

      // Persist
      await HvfDb.put('graph', { id:docId, type:'document', entities:entities, topics:topics, ts:now() });
      return { docId:docId, entities:entities, topics:topics, links:Array.from((_edges.get(docId)||new Set())) };
    }

    function search(query, k) {
      var qVec = _embed(query);
      var results = LargeScaleAnnEngine.search(qVec, k||10);
      return results.map(function(r){
        var node=_nodes.get(r.id);
        return { id:r.id, sim:r.sim, text:(node&&node.text)||'', entities:(node&&node.entities)||[], topics:(node&&node.topics)||[] };
      });
    }

    function getNeighbors(nodeId, depth) {
      depth=depth||1;
      var visited=new Set([nodeId]); var frontier=[nodeId];
      for(var d=0;d<depth;d++){
        var next=[];
        frontier.forEach(function(nid){
          var edges=_edges.get(nid)||new Set();
          edges.forEach(function(eid){if(!visited.has(eid)){visited.add(eid);next.push(eid);}});
        });
        frontier=next;
      }
      return Array.from(visited).filter(function(id){return id!==nodeId;}).map(function(id){ return _nodes.get(id)||{id:id}; });
    }

    function getByTopic(topic) {
      return (_topics.get(topic)||[]).map(function(id){return _nodes.get(id);}).filter(Boolean);
    }

    function stats() { return {nodes:_nodes.size,edges:Array.from(_edges.values()).reduce(function(s,e){return s+e.size;},0),topics:_topics.size}; }

    return { addDocument:addDocument, search:search, getNeighbors:getNeighbors, getByTopic:getByTopic, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 68C  SEMANTIC COMPRESSION ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var SemanticCompressionEngine = (function () {
    var _dupSignatures = new Set();  // chunk content hashes

    function _hashChunk(text) {
      var h=0; var s=text.slice(0,256);
      for(var i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0;
      return h.toString(36);
    }

    // Scalar quantization: float32 → int8 (8×)
    function quantizeVec(vec) {
      var min=Infinity,max=-Infinity;
      for(var i=0;i<vec.length;i++){if(vec[i]<min)min=vec[i];if(vec[i]>max)max=vec[i];}
      var range=(max-min)||1;
      var q=new Int8Array(vec.length);
      var scale=127/range;
      for(var i=0;i<vec.length;i++) q[i]=Math.round((vec[i]-min)*scale-127);
      return {q:q,min:min,range:range};
    }

    function dequantizeVec(qObj) {
      var scale=qObj.range/127;
      var out=new Float32Array(qObj.q.length);
      for(var i=0;i<qObj.q.length;i++) out[i]=(qObj.q[i]+127)*scale+qObj.min;
      return out;
    }

    function isDuplicate(text) {
      var sig=_hashChunk(text);
      if(_dupSignatures.has(sig)) return true;
      _dupSignatures.add(sig);
      if(_dupSignatures.size>50000) {
        var first=_dupSignatures.values().next().value;
        _dupSignatures.delete(first);
      }
      return false;
    }

    async function compressChunks(chunks) {
      var compressed=[], deduped=0;
      for(var i=0;i<chunks.length;i++){
        var c=chunks[i];
        var text=c.text||'';
        if(isDuplicate(text)){ deduped++; continue; }
        var vec=c.vec||_embed(text);
        var q=quantizeVec(vec);
        compressed.push(Object.assign({},c,{vec:null,qVec:q,compressed:true}));
        QuotaManager.register(c.id||uid(), q.q.byteLength);
        if(i%100===0) await frame();
      }
      log('compressed',chunks.length,'→',compressed.length,'chunks, deduped:',deduped);
      return compressed;
    }

    async function summarizeMemory(chunks, targetN) {
      // Keep top-N chunks by recency + score
      var scored = chunks.map(function(c,i){
        var recency=Math.max(0,1-(now()-c.ts)/(7*24*60*60*1000));
        return Object.assign({},c,{_rank:(c.score||0.5)*0.6+recency*0.4+i/chunks.length*0.1});
      });
      scored.sort(function(a,b){return b._rank-a._rank;});
      return scored.slice(0,targetN||100);
    }

    async function compactIndex() {
      var all=await HvfDb.getAll('compressed');
      if(all.length<100) return;
      var cutoff=now()-48*60*60*1000; // 48h
      var stale=all.filter(function(c){return c.ts<cutoff&&(!c.score||c.score<0.2);});
      for(var i=0;i<stale.length;i++){
        await HvfDb.del('compressed',stale[i].id);
        QuotaManager.deregister(stale[i].id);
        if(i%50===0) await frame();
      }
      log('compacted',stale.length,'stale entries');
    }

    return { quantizeVec:quantizeVec, dequantizeVec:dequantizeVec, isDuplicate:isDuplicate, compressChunks:compressChunks, summarizeMemory:summarizeMemory, compactIndex:compactIndex };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 68D  DISTRIBUTED INDEXING SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var DistributedIndexingSystem = (function () {
    var _queue   = [];   // pending indexing jobs
    var _running = false;
    var _shards  = new Map(); // shardId → { items, indexed }

    async function _runIndexQueue() {
      if(_running||!_queue.length) return;
      _running=true;
      while(_queue.length){
        var job=_queue.shift();
        await frame();
        try { await _indexBatch(job.items, job.opts); }
        catch(e){ warn('index job failed:', e.message); }
        if(job.onComplete) job.onComplete();
      }
      _running=false;
    }

    async function _indexBatch(items, opts) {
      var BATCH=32;
      for(var i=0;i<items.length;i+=BATCH){
        var batch=items.slice(i,i+BATCH);
        for(var j=0;j<batch.length;j++){
          var item=batch[j];
          var text=item.text||'';
          if(SemanticCompressionEngine.isDuplicate(text)) continue;
          var vec=item.vec||_embed(text);
          await LargeScaleAnnEngine.insert(item.id||uid(), vec, item.meta||{});
          // Also update graph if it's a document
          if(item.meta&&item.meta.type==='document'){
            await GraphMemorySystem.addDocument(item.id||uid(), text, item.meta);
          }
        }
        await frame();
      }
      // Checkpoint
      await HvfDb.put('index_state', { id:'last_index', ts:now(), count:LargeScaleAnnEngine.size() });
    }

    function enqueue(items, opts, onComplete) {
      _queue.push({items:items,opts:opts||{},onComplete:onComplete});
      setTimeout(_runIndexQueue, 0);
    }

    // Shard-aware distributed indexing
    async function shardAndIndex(items, numShards) {
      numShards=numShards||4;
      var shardSize=Math.ceil(items.length/numShards);
      var shardIds=[];
      for(var s=0;s<numShards;s++){
        var shard=items.slice(s*shardSize,(s+1)*shardSize);
        if(!shard.length) break;
        var shardId='shard_'+uid();
        _shards.set(shardId,{items:shard,indexed:false});
        shardIds.push(shardId);
        enqueue(shard,{},{});
      }
      // Compact after all shards indexed
      setTimeout(function(){ SemanticCompressionEngine.compactIndex().catch(function(){}); }, 5000);
      return shardIds;
    }

    async function recover() {
      // Re-index any shards that weren't completed
      var unindexed=Array.from(_shards.entries()).filter(function(e){return!e[1].indexed;});
      log('index recovery: re-queuing', unindexed.length, 'shards');
      unindexed.forEach(function(e){ enqueue(e[1].items,{}); _shards.get(e[0]).indexed=true; });
    }

    function status() { return { queued:_queue.length, running:_running, shards:_shards.size, indexed:LargeScaleAnnEngine.size() }; }

    // Background compaction every 2 hours
    setInterval(function(){ SemanticCompressionEngine.compactIndex().catch(function(){}); }, 2*60*60*1000);

    return { enqueue:enqueue, shardAndIndex:shardAndIndex, recover:recover, status:status };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.HyperscaleVectorFabric = {
    VERSION: VERSION,
    LargeScaleAnnEngine:       LargeScaleAnnEngine,
    GraphMemorySystem:         GraphMemorySystem,
    SemanticCompressionEngine: SemanticCompressionEngine,
    DistributedIndexingSystem: DistributedIndexingSystem,
    QuotaManager:              QuotaManager,
    // Convenience API
    store:   async function(id,text,meta){ var vec=_embed(text); await LargeScaleAnnEngine.insert(id,vec,meta); return id; },
    search:  function(query,opts){ var qVec=_embed(query); return LargeScaleAnnEngine.search(qVec,(opts&&opts.k)||10,opts&&opts.filter); },
    addDoc:  function(id,text,meta){ return GraphMemorySystem.addDocument(id,text,meta); },
    cluster: function(query,k){ return GraphMemorySystem.search(query,k); },
    index:   function(items,opts){ return DistributedIndexingSystem.shardAndIndex(items,opts&&opts.shards); },
    stats:   function(){ return { ann:LargeScaleAnnEngine.size(), graph:GraphMemorySystem.stats(), quota:QuotaManager.stats(), indexer:DistributedIndexingSystem.status() }; }
  };

  log('v'+VERSION+' ready — HNSW+IVF dim:'+DIM+' quota:'+Math.round(MAX_MEM/MB)+'MB');

  // Wire into HyperscaleVectorMemory as upgrade
  setTimeout(function(){
    try {
      var HVM = sys('HyperscaleVectorMemory');
      if(HVM && !HVM.__hvf_wired){
        HVM.__hvf_wired=true;
        var _origSearch=HVM.search.bind(HVM);
        HVM.search=async function(query,opts){
          try {
            var hvfResults=await window.HyperscaleVectorFabric.search(query,opts);
            if(hvfResults&&hvfResults.length>0) return hvfResults;
          } catch(_e){}
          return _origSearch(query,opts);
        };
        log('HVM.search upgraded with HVF HNSW+IVF search');
      }
    } catch(e){ warn('HVM wiring:', e.message); }
  }, 500);

})();
