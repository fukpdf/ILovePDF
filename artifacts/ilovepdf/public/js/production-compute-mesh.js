/**
 * PHASE 69 — PRODUCTION COMPUTE MESH
 * window.ProductionComputeMesh
 *
 * 69A AbuseProtectionSystem     — rate limiting, quotas, suspicion detection
 * 69B QuotaManagementEngine     — CPU/GPU/mem/bandwidth/daily caps
 * 69C IdentityAndTrustLayer     — peer identity, reputation, isolation, decay
 * 69D BillingAndUsageEngine     — compute accounting, offline accumulation
 * 69E BandwidthEconomicsEngine  — adaptive chunk sizing, congestion, mobile routing
 *
 * IMPORTANT: All distributed compute remains OFF by default.
 * Purely additive. Extends BrowserComputeCloud. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[PCM]';
  var MB       = 1024 * 1024;
  var DB_NAME  = 'pcm_production_v1';
  var _enabled = false;  // Distributed compute OFF by default

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'pcm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }

  function _requireEnabled(name) {
    if (!_enabled) { warn(name+': P2P compute OFF — call ProductionComputeMesh.enable()'); return false; }
    return true;
  }

  // ── IDB helper ─────────────────────────────────────────────────────────────
  var PcmDb = (function () {
    var _db=null;
    var STORES=['peers','billing','quotas','abuse','bandwidth','identity'];
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
    return {put:put,get:get,getAll:getAll};
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 69A  ABUSE PROTECTION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var AbuseProtectionSystem = (function () {
    var _peerWindows  = new Map(); // peerId → [timestamps]
    var _suspicion    = new Map(); // peerId → { score, events }
    var WINDOW_MS     = 60000;     // 1 minute sliding window
    var MAX_REQUESTS  = 100;       // per window
    var TASK_QUOTA    = 50;        // max tasks per peer per hour
    var SPAM_THRESHOLD = 0.7;

    var ABUSE_PATTERNS = [
      { pattern:/execute|eval|import\(|require\(/i, weight:0.5 },
      { pattern:/process\.env|__dirname|require\(/i, weight:0.4 },
      { pattern:/localhost|127\.0\.0|192\.168\./i, weight:0.3 }
    ];

    function _rateLimitOk(peerId) {
      var win=_peerWindows.get(peerId)||[];
      var now_=now();
      win=win.filter(function(t){return now_-t<WINDOW_MS;});
      win.push(now_);
      _peerWindows.set(peerId,win);
      return win.length<=MAX_REQUESTS;
    }

    function _detectSuspicion(peerId, payload) {
      var rec=_suspicion.get(peerId)||{score:0,events:[],quarantined:false};
      var payloadStr=typeof payload==='string'?payload:JSON.stringify(payload||'');
      var hit=0;
      ABUSE_PATTERNS.forEach(function(ap){if(ap.pattern.test(payloadStr)){hit+=ap.weight;rec.events.push({pattern:ap.pattern.source.slice(0,30),ts:now()});}});
      rec.score=Math.min(1,rec.score+hit);
      if(rec.score>=SPAM_THRESHOLD&&!rec.quarantined){
        rec.quarantined=true;
        warn('peer',peerId,'quarantined (abuse score:',rec.score.toFixed(2)+')');
        IdentityAndTrustLayer.quarantine(peerId,'abuse_pattern');
      }
      _suspicion.set(peerId,rec);
      return rec.score<SPAM_THRESHOLD;
    }

    function check(peerId, payload, taskCount) {
      if(!_requireEnabled('AbuseProtectionSystem.check')) return true; // offline = OK
      var rateOk  = _rateLimitOk(peerId);
      var taskOk  = (taskCount||0)<TASK_QUOTA;
      var noAbuse = _detectSuspicion(peerId, payload);
      var trusted = IdentityAndTrustLayer.isTrusted(peerId);
      return rateOk&&taskOk&&noAbuse&&trusted;
    }

    function reportSpam(peerId) {
      var rec=_suspicion.get(peerId)||{score:0,events:[],quarantined:false};
      rec.score=Math.min(1,rec.score+0.3);
      if(rec.score>=SPAM_THRESHOLD) IdentityAndTrustLayer.quarantine(peerId,'spam_report');
      _suspicion.set(peerId,rec);
    }

    function getSuspicionScore(peerId) { return (_suspicion.get(peerId)||{score:0}).score; }
    function stats() {
      return { tracked:_peerWindows.size, suspicious:Array.from(_suspicion.values()).filter(function(r){return r.score>0.3;}).length,
               quarantined:Array.from(_suspicion.values()).filter(function(r){return r.quarantined;}).length };
    }

    return { check:check, reportSpam:reportSpam, getSuspicionScore:getSuspicionScore, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 69B  QUOTA MANAGEMENT ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var QuotaManagementEngine = (function () {
    // Per-session limits (reset on page load)
    var _session = {
      cpuMs:    0, cpuMsMax:    60000,  // 60 s CPU per session
      gpuMs:    0, gpuMsMax:    30000,  // 30 s GPU per session
      memBytes: 0, memBytesMax: 512*MB, // 512 MB RAM
      bwBytes:  0, bwBytesMax:  50*MB,  // 50 MB bandwidth
      tasks:    0, tasksMax:    200     // 200 tasks
    };
    // Daily limits (IDB-persisted)
    var _daily = { cpuMs:0, gpuMs:0, bwBytes:0, tasks:0, date:'' };
    var DAILY_CPU_MS  = 10*60*1000;  // 10 min CPU/day
    var DAILY_GPU_MS  = 5*60*1000;   // 5 min GPU/day
    var DAILY_BW      = 500*MB;      // 500 MB/day
    var DAILY_TASKS   = 2000;

    // Mobile/battery adjustments
    function _adjustForDevice() {
      var nav=navigator||{};
      var mem=(nav.deviceMemory)||4;
      var mobile=/Mobi|Android/i.test(nav.userAgent||'');
      if(mem<2||mobile){
        _session.cpuMsMax=Math.min(_session.cpuMsMax,20000);
        _session.gpuMsMax=Math.min(_session.gpuMsMax,10000);
        _session.memBytesMax=Math.min(_session.memBytesMax,128*MB);
        _session.bwBytesMax=Math.min(_session.bwBytesMax,10*MB);
      }
    }
    _adjustForDevice();

    async function _loadDaily() {
      var stored=await PcmDb.get('quotas','daily');
      if(stored && stored.date===new Date().toDateString()){
        _daily=stored;
      } else {
        _daily={ cpuMs:0, gpuMs:0, bwBytes:0, tasks:0, date:new Date().toDateString() };
      }
    }
    _loadDaily().catch(function(){});

    async function _saveDaily() { await PcmDb.put('quotas', Object.assign({id:'daily'},_daily)); }

    function consumeCpu(ms) {
      _session.cpuMs+=ms; _daily.cpuMs+=ms;
      var ok=_session.cpuMs<=_session.cpuMsMax&&_daily.cpuMs<=DAILY_CPU_MS;
      if(!ok) warn('CPU quota exceeded');
      _saveDaily().catch(function(){});
      return ok;
    }
    function consumeGpu(ms) {
      _session.gpuMs+=ms; _daily.gpuMs+=ms;
      var ok=_session.gpuMs<=_session.gpuMsMax&&_daily.gpuMs<=DAILY_GPU_MS;
      if(!ok) warn('GPU quota exceeded');
      _saveDaily().catch(function(){});
      return ok;
    }
    function consumeBandwidth(bytes) {
      _session.bwBytes+=bytes; _daily.bwBytes+=bytes;
      var ok=_session.bwBytes<=_session.bwBytesMax&&_daily.bwBytes<=DAILY_BW;
      if(!ok) warn('Bandwidth quota exceeded');
      _saveDaily().catch(function(){});
      return ok;
    }
    function consumeTask() {
      _session.tasks++; _daily.tasks++;
      var ok=_session.tasks<=_session.tasksMax&&_daily.tasks<=DAILY_TASKS;
      if(!ok) warn('Task quota exceeded');
      _saveDaily().catch(function(){});
      return ok;
    }
    function canAcceptJob(jobBytes) {
      if(_session.memBytes+jobBytes>_session.memBytesMax) return false;
      if(_session.bwBytes+jobBytes>_session.bwBytesMax) return false;
      return _session.tasks<_session.tasksMax;
    }
    function stats() {
      return {
        session:{ cpu:Math.round(_session.cpuMs/1000)+'s/'+Math.round(_session.cpuMsMax/1000)+'s',
                  gpu:Math.round(_session.gpuMs/1000)+'s/'+Math.round(_session.gpuMsMax/1000)+'s',
                  bw:Math.round(_session.bwBytes/MB)+'MB/'+Math.round(_session.bwBytesMax/MB)+'MB',
                  tasks:_session.tasks+'/'+_session.tasksMax },
        daily:{ cpu:Math.round(_daily.cpuMs/1000)+'s/'+Math.round(DAILY_CPU_MS/1000)+'s',
                bw:Math.round(_daily.bwBytes/MB)+'MB/'+Math.round(DAILY_BW/MB)+'MB',
                tasks:_daily.tasks+'/'+DAILY_TASKS }
      };
    }
    return { consumeCpu:consumeCpu, consumeGpu:consumeGpu, consumeBandwidth:consumeBandwidth, consumeTask:consumeTask, canAcceptJob:canAcceptJob, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 69C  IDENTITY AND TRUST LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var IdentityAndTrustLayer = (function () {
    var _peers     = new Map(); // peerId → { score, calls, failures, firstSeen, lastSeen, quarantined, trustKey }
    var _quarantined = new Set();
    var _myId      = null;

    function _generateId() {
      if (_myId) return _myId;
      var arr=crypto.getRandomValues(new Uint8Array(16));
      _myId='pcm_'+Array.from(arr).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
      return _myId;
    }

    function _ensure(peerId) {
      if(!_peers.has(peerId)){
        _peers.set(peerId,{score:1.0,calls:0,failures:0,firstSeen:now(),lastSeen:now(),quarantined:false,trustKey:null});
      }
      return _peers.get(peerId);
    }

    function _applyDecay(peer) {
      var ageSec=(now()-peer.lastSeen)/1000;
      // Trust decays 1% per minute of inactivity (max 30% decay)
      var decay=Math.min(0.3, ageSec/6000 * 0.01);
      peer.score=Math.max(0.1, peer.score-decay);
    }

    function reward(peerId, amount){
      var p=_ensure(peerId); _applyDecay(p);
      p.score=Math.min(1.0,p.score+(amount||0.03));
      p.calls++; p.lastSeen=now();
    }

    function penalize(peerId, amount){
      var p=_ensure(peerId); _applyDecay(p);
      p.score=Math.max(0,p.score-(amount||0.1));
      p.failures++; p.lastSeen=now();
      if(p.score<0.2) quarantine(peerId,'low_trust');
      PcmDb.put('peers',Object.assign({id:peerId},p)).catch(function(){});
    }

    function quarantine(peerId, reason){
      var p=_ensure(peerId);
      p.quarantined=true; p.score=0;
      _quarantined.add(peerId);
      warn('quarantined peer:', peerId, 'reason:', reason);
      PcmDb.put('peers',Object.assign({id:peerId},p,{reason:reason})).catch(function(){});
    }

    function isTrusted(peerId){
      if(_quarantined.has(peerId)) return false;
      var p=_peers.get(peerId);
      if(!p) return true; // new peer: provisionally trusted (verify then punish)
      _applyDecay(p);
      return !p.quarantined && p.score>=0.15;
    }

    function getScore(peerId){ var p=_peers.get(peerId); return p?p.score:1.0; }

    function verifyIntegrity(shardHash, expectedHash){
      return shardHash===expectedHash;
    }

    function myId(){ return _generateId(); }
    function topPeers(n){ return Array.from(_peers.entries()).filter(function(e){return!e[1].quarantined;}).sort(function(a,b){return b[1].score-a[1].score;}).slice(0,n||10).map(function(e){return{id:e[0],score:e[1].score};}); }
    function stats(){ return{peers:_peers.size,quarantined:_quarantined.size,trusted:Array.from(_peers.values()).filter(function(p){return p.score>=0.5;}).length}; }

    return { reward:reward, penalize:penalize, quarantine:quarantine, isTrusted:isTrusted, getScore:getScore, verifyIntegrity:verifyIntegrity, myId:myId, topPeers:topPeers, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 69D  BILLING AND USAGE ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var BillingAndUsageEngine = (function () {
    var _pending = [];    // offline accumulation queue
    var _totals  = { cpuMs:0, gpuMs:0, bwBytes:0, tasks:0, contributed:0 };

    function record(type, amount, meta) {
      var entry={ type:type, amount:amount, meta:meta||{}, ts:now(), peerId:IdentityAndTrustLayer.myId() };
      _pending.push(entry);
      _totals[type] = (_totals[type]||0) + amount;
      if(type==='tasks') QuotaManagementEngine.consumeTask();
      if(type==='cpuMs') QuotaManagementEngine.consumeCpu(amount);
      if(type==='gpuMs') QuotaManagementEngine.consumeGpu(amount);
      if(type==='bwBytes') QuotaManagementEngine.consumeBandwidth(amount);
      // Flush every 50 records
      if(_pending.length>=50) _flush().catch(function(){});
    }

    function recordContribution(bytes, quality) {
      _totals.contributed += bytes;
      record('contribution', bytes, { quality:quality||1 });
    }

    async function _flush() {
      if(!_pending.length) return;
      var toFlush = _pending.splice(0, _pending.length);
      for(var i=0;i<toFlush.length;i++){
        await PcmDb.put('billing', Object.assign({id:uid()},toFlush[i]));
        if(i%10===0) await frame();
      }
    }

    async function report(opts) {
      await _flush();
      var all=await PcmDb.getAll('billing');
      var summary={ cpuMs:0, gpuMs:0, bwBytes:0, tasks:0, contributed:0 };
      all.forEach(function(e){summary[e.type]=(summary[e.type]||0)+e.amount;});
      return {
        summary:summary,
        totals:_totals,
        pending:_pending.length,
        peerId:IdentityAndTrustLayer.myId(),
        // Privacy: no PII, just aggregate metrics
        quota:QuotaManagementEngine.stats()
      };
    }

    return { record:record, recordContribution:recordContribution, report:report, flush:_flush };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 69E  BANDWIDTH ECONOMICS ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var BandwidthEconomicsEngine = (function () {
    var _BASE_CHUNK    = 256 * 1024;  // 256 KB base chunk
    var _chunkSize     = _BASE_CHUNK;
    var _congestion    = 0;           // 0 = clear, 1 = congested
    var _mobile        = /Mobi|Android/i.test((navigator&&navigator.userAgent)||'');
    var _slowConn      = false;
    var _history       = [];          // recent {bytes, ms} transfer records

    // Detect network quality
    (function(){
      var conn=(navigator&&navigator.connection)||{};
      var type=conn.effectiveType||'4g';
      _slowConn=(type==='2g'||type==='slow-2g');
      if(_slowConn||_mobile) _chunkSize=Math.floor(_BASE_CHUNK/4); // 64 KB for slow/mobile
    })();

    function _measureCongestion(bytes, ms) {
      _history.push({bytes:bytes,ms:ms});
      if(_history.length>10) _history.shift();
      var avgThroughput=_history.reduce(function(s,r){return s+r.bytes/r.ms;},0)/_history.length;
      // < 10 KB/ms = ~10 MB/s = congested
      _congestion = avgThroughput < 10 ? 1 : 0;
      // Adaptive chunk size
      if(_congestion>0.7) _chunkSize=Math.max(32*1024, _chunkSize/2);
      else if(_congestion<0.3) _chunkSize=Math.min(1024*1024, _chunkSize*1.5);
    }

    function getChunkSize() { return Math.floor(_chunkSize); }

    function shouldUseLowBandwidth() {
      return _slowConn || _mobile || _congestion > 0.7;
    }

    async function adaptiveTransfer(data, opts) {
      opts = opts||{};
      if(!_requireEnabled('BandwidthEconomicsEngine.adaptiveTransfer')) {
        return { local:true, data:data };
      }
      var chunkSize = getChunkSize();
      var dataBytes = typeof data==='string' ? data.length*2 : (data.byteLength||0);
      if(!QuotaManagementEngine.consumeBandwidth(dataBytes)){
        warn('bandwidth quota exceeded — local fallback');
        return { local:true, data:data };
      }
      BillingAndUsageEngine.record('bwBytes', dataBytes);
      var t0=now();
      await frame(); // simulate transfer
      _measureCongestion(dataBytes, Math.max(1, now()-t0));
      return { sent:true, bytes:dataBytes, chunkSize:chunkSize, congestion:_congestion };
    }

    // Shard reassignment: if peer fails, route to next peer
    async function reassignShard(shardId, failedPeerId, opts) {
      warn('reassigning shard', shardId, 'from', failedPeerId);
      IdentityAndTrustLayer.penalize(failedPeerId, 0.1);
      // For now, always fall back to local processing
      return { reassigned:true, localFallback:true, shardId:shardId };
    }

    function stats() {
      return { chunkSize:Math.round(_chunkSize/1024)+'KB', congestion:_congestion.toFixed(2),
               mobile:_mobile, slowConn:_slowConn, lowBW:shouldUseLowBandwidth() };
    }

    return { getChunkSize:getChunkSize, shouldUseLowBandwidth:shouldUseLowBandwidth, adaptiveTransfer:adaptiveTransfer, reassignShard:reassignShard, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.ProductionComputeMesh = {
    VERSION: VERSION,
    AbuseProtectionSystem:   AbuseProtectionSystem,
    QuotaManagementEngine:   QuotaManagementEngine,
    IdentityAndTrustLayer:   IdentityAndTrustLayer,
    BillingAndUsageEngine:   BillingAndUsageEngine,
    BandwidthEconomicsEngine: BandwidthEconomicsEngine,
    // P2P enable/disable (remains OFF by default)
    enable: function() {
      var nav=navigator||{};
      var mem=(nav.deviceMemory)||4;
      if(mem<2){ warn('device too low-end for compute mesh'); return false; }
      _enabled=true;
      log('Production Compute Mesh ENABLED');
      BillingAndUsageEngine.record('enable',1,{ts:now()});
      return true;
    },
    disable: function() {
      _enabled=false;
      BillingAndUsageEngine.flush().catch(function(){});
      log('Production Compute Mesh DISABLED');
    },
    isEnabled: function() { return _enabled; },
    stats: function() {
      return {
        enabled:_enabled,
        abuse:AbuseProtectionSystem.stats(),
        quota:QuotaManagementEngine.stats(),
        trust:IdentityAndTrustLayer.stats(),
        bandwidth:BandwidthEconomicsEngine.stats()
      };
    }
  };

  log('v'+VERSION+' ready (distributed compute OFF by default)');

  // Wire into BrowserComputeCloud's trust system if available
  setTimeout(function(){
    try {
      var BCC = sys('BrowserComputeCloud');
      if(BCC && BCC.ReputationAndTrustSystem && !BCC.__pcm_wired){
        BCC.__pcm_wired=true;
        var _origPenalize=BCC.ReputationAndTrustSystem.penalize.bind(BCC.ReputationAndTrustSystem);
        BCC.ReputationAndTrustSystem.penalize=function(peerId,amount){
          _origPenalize(peerId,amount);
          IdentityAndTrustLayer.penalize(peerId,amount);
        };
        log('BCC.ReputationAndTrustSystem wired to IdentityAndTrustLayer');
      }
    } catch(e){ warn('BCC wiring:', e.message); }
  }, 300);

})();
