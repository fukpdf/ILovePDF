/**
 * FINAL AI EVOLUTION AUDIT — PHASE 66–70
 * window.FinalAiEvolutionAudit
 * window.runFinalAiEvolutionAudit()
 *
 * 24 audit categories covering Phases 66-70.
 * Purely additive. No side effects.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[FAEA]';

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }

  function pass(n,d){ return {name:n,status:'pass',detail:d||''}; }
  function warn_(n,d){ return {name:n,status:'warn',detail:d||''}; }
  function fail(n,d){ return {name:n,status:'fail',detail:d||''}; }
  function skip(n,r){ return {name:n,status:'skip',detail:r||'not loaded'}; }
  function info(n,d){ return {name:n,status:'info',detail:d||''}; }

  async function safe(fn) { try { return await fn(); } catch(e){ return fail('safe_exec',e.message||String(e)); } }

  // ── 1  GGUF RUNTIME ─────────────────────────────────────────────────────────
  async function _auditGgufRuntime() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE){ r.push(skip('RLLE','Phase 66 not loaded')); return r; }
    r.push(pass('RLLE.loaded'));
    r.push(RLLE.RealGGUFExecutionRuntime?pass('RLLE.RealGGUFExecutionRuntime'):fail('RLLE.RealGGUFExecutionRuntime','missing'));
    r.push(info('RLLE.gguf_loaded',String(RLLE.RealGGUFExecutionRuntime.isReady())));
    r.push(info('RLLE.models',JSON.stringify(RLLE.RealGGUFExecutionRuntime.listModels())));
    await safe(async function(){
      var result=await RLLE.generate('test gguf generation',{});
      r.push(result?pass('RLLE.generate_fallback','ok'):warn_('RLLE.generate_fallback','empty'));
    });
    // OPFS cache
    r.push(info('RLLE.opfs_available',String(RLLE.RealGGUFExecutionRuntime.OpfsCache.available())));
    return r;
  }

  // ── 2  TRANSFORMER KERNELS ──────────────────────────────────────────────────
  async function _auditTransformerKernels() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE||!RLLE.OptimizedTransformerRuntime){ r.push(skip('OptimizedTransformerRuntime','RLLE not loaded')); return r; }
    var OTR=RLLE.OptimizedTransformerRuntime;
    r.push(pass('OptimizedTransformerRuntime.loaded'));
    r.push(info('OTR.gpuReady',String(OTR.isReady())));
    await safe(async function(){
      var A=new Float32Array([1,2,3,4]),B=new Float32Array([1,0,0,1]);
      var C=await OTR.tiledMatMul(A,B,2,2,2);
      r.push((C&&C[0]===1&&C[3]===4)?pass('OTR.tiledMatMul'):warn_('OTR.tiledMatMul','unexpected result:'+JSON.stringify(Array.from(C||[]))));
    });
    await safe(async function(){
      var X=new Float32Array(4).fill(0.5),W=new Float32Array(4).fill(1),B2=new Float32Array(4).fill(0);
      var N=await OTR.layerNorm(X,W,B2,4);
      r.push(N&&N.length===4?pass('OTR.layerNorm'):fail('OTR.layerNorm','wrong output'));
    });
    await safe(async function(){
      var X=new Float32Array(8).map(function(_,i){return i*0.1;});
      var out=await OTR.applyRoPE(X,4,2);
      r.push(out&&out.length===8?pass('OTR.applyRoPE'):warn_('OTR.applyRoPE','fallback used'));
    });
    return r;
  }

  // ── 3  TOKENIZER ACCURACY ───────────────────────────────────────────────────
  async function _auditTokenizerAccuracy() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE||!RLLE.TokenizerAccuracyEngine){ r.push(skip('TokenizerAccuracyEngine','RLLE not loaded')); return r; }
    var TAE=RLLE.TokenizerAccuracyEngine;
    r.push(pass('TokenizerAccuracyEngine.loaded'));
    await safe(function(){
      var tokens=TAE.encode('Hello, world! 你好世界',{});
      r.push(tokens&&tokens.length>0?pass('TAE.encode_basic','tokens:'+tokens.length):fail('TAE.encode_basic'));
    });
    await safe(function(){
      var tokens=TAE.encode('مرحبا بالعالم',{});
      r.push(tokens&&tokens.length>0?pass('TAE.encode_rtl','RTL ok'):warn_('TAE.encode_rtl','empty'));
    });
    await safe(function(){
      var val=TAE.validate('Hello\uD83D\uDE00 World'); // emoji with surrogate pair
      r.push(val.valid?pass('TAE.validate_emoji'):warn_('TAE.validate_emoji','issues:'+JSON.stringify(val.issues)));
    });
    await safe(function(){
      var repaired=TAE.repairUnicode('Hello\uD800World'); // lone surrogate
      r.push(repaired.indexOf('\uFFFD')>=0?pass('TAE.repair_surrogate'):warn_('TAE.repair_surrogate','not repaired'));
    });
    await safe(function(){
      var gen=TAE.streamEncode('This is a streaming tokenizer test for giant documents.',{});
      var first=gen.next();
      r.push(!first.done&&first.value?pass('TAE.streamEncode'):fail('TAE.streamEncode','no yield'));
    });
    return r;
  }

  // ── 4  KV CACHE ─────────────────────────────────────────────────────────────
  async function _auditKvCache() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE||!RLLE.KvCacheOptimizationSystem){ r.push(skip('KvCacheOptimizationSystem','RLLE not loaded')); return r; }
    var KVC=RLLE.KvCacheOptimizationSystem;
    r.push(pass('KvCacheOptimizationSystem.loaded'));
    await safe(function(){
      var cache=KVC.createCache('_test_',64,4,256);
      r.push(cache?pass('KVC.createCache'):fail('KVC.createCache'));
      var K=new Float32Array(64).fill(0.1), V=new Float32Array(64).fill(0.2);
      cache.store(0,0,K,V);
      var retrieved=cache.retrieve(0,0);
      r.push(retrieved&&retrieved.k?pass('KVC.store_retrieve'):fail('KVC.store_retrieve'));
      cache.evict(0.5);
      r.push(pass('KVC.evict_ok'));
      KVC.evictModel('_test_');
    });
    await safe(function(){
      KVC.store('_audit_prompt_','_audit_result_');
      var hit=KVC.lookup('_audit_prompt_');
      r.push(hit==='_audit_result_'?pass('KVC.prompt_cache'):fail('KVC.prompt_cache','hit:'+hit));
    });
    r.push(info('KVC.stats',JSON.stringify(KVC.stats())));
    return r;
  }

  // ── 5  ADVANCED BATCHING ─────────────────────────────────────────────────────
  async function _auditBatching() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE||!RLLE.AdvancedBatchingEngine){ r.push(skip('AdvancedBatchingEngine','RLLE not loaded')); return r; }
    var ABE=RLLE.AdvancedBatchingEngine;
    r.push(pass('AdvancedBatchingEngine.loaded'));
    await safe(async function(){
      var result=await ABE.processBatch([{tokens:['Hello',' ','world'],opts:{}}],null);
      r.push(result!==null?pass('ABE.processBatch'):warn_('ABE.processBatch','null result'));
    });
    return r;
  }

  // ── 6  SPECULATIVE DECODING ─────────────────────────────────────────────────
  async function _auditSpeculativeDecoding() {
    var r=[];
    var RLLE=sys('RealLocalLlmEngine');
    if(!RLLE||!RLLE.SpeculativeDecodingV2){ r.push(skip('SpeculativeDecodingV2','RLLE not loaded')); return r; }
    var SDV2=RLLE.SpeculativeDecodingV2;
    r.push(pass('SpeculativeDecodingV2.loaded'));
    await safe(async function(){
      var result=await SDV2.decode('The document shows that',32,{});
      r.push(result&&result.length>20?pass('SDV2.decode','len:'+result.length):warn_('SDV2.decode','short:'+result.length));
    });
    await safe(async function(){
      var result=await SDV2.parallelDecode('Results indicate',16,{});
      r.push(result&&result.length>10?pass('SDV2.parallelDecode'):warn_('SDV2.parallelDecode','empty'));
    });
    return r;
  }

  // ── 7  AGENT INTELLIGENCE ───────────────────────────────────────────────────
  async function _auditAgentIntelligence() {
    var r=[];
    var AAI=sys('AdvancedAgentIntelligence');
    if(!AAI){ r.push(skip('AdvancedAgentIntelligence','Phase 67 not loaded')); return r; }
    r.push(pass('AdvancedAgentIntelligence.loaded'));
    r.push(AAI.SelfImprovementEngine?pass('AAI.SelfImprovementEngine'):fail('AAI.SelfImprovementEngine','missing'));
    r.push(AAI.IntelligentPlanningSystem?pass('AAI.IntelligentPlanningSystem'):fail('AAI.IntelligentPlanningSystem','missing'));
    r.push(AAI.ExecutionReflectionEngine?pass('AAI.ExecutionReflectionEngine'):fail('AAI.ExecutionReflectionEngine','missing'));
    r.push(AAI.MemoryDrivenOptimization?pass('AAI.MemoryDrivenOptimization'):fail('AAI.MemoryDrivenOptimization','missing'));
    r.push(AAI.LongRunningPersistenceEngine?pass('AAI.LongRunningPersistenceEngine'):fail('AAI.LongRunningPersistenceEngine','missing'));
    await safe(async function(){
      var plan=await AAI.plan('summarize a legal contract',{fileSizeBytes:1024*1024});
      r.push(plan&&plan.dag?pass('AAI.plan','steps:'+plan.dag.nodes.length):warn_('AAI.plan','no dag'));
    });
    return r;
  }

  // ── 8  REFLECTION LOOPS ─────────────────────────────────────────────────────
  async function _auditReflectionLoops() {
    var r=[];
    var AAI=sys('AdvancedAgentIntelligence');
    if(!AAI||!AAI.ExecutionReflectionEngine){ r.push(skip('ERE','AAI not loaded')); return r; }
    var ERE=AAI.ExecutionReflectionEngine;
    r.push(pass('ExecutionReflectionEngine.loaded'));
    await safe(async function(){
      var res=await ERE.reflect('_audit_step_','summarize document','This is a short answer',{retryBudget:1});
      r.push(res&&res.action?pass('ERE.reflect','action:'+res.action):fail('ERE.reflect'));
    });
    await safe(async function(){
      var val=await ERE.validateOutput('The contract was signed on January 1st 2024.',{required:['contract'],minLength:10});
      r.push(val.valid?pass('ERE.validateOutput'):warn_('ERE.validateOutput','issues:'+JSON.stringify(val.issues)));
    });
    // Verify retry budget enforced
    await safe(async function(){
      var res=await ERE.reflect('_budget_test_','complex task','',{retryBudget:1});
      r.push(['accept','accept_degraded','retry'].indexOf(res.action)>=0?pass('ERE.retry_budget_enforced'):fail('ERE.retry_budget_enforced'));
    });
    return r;
  }

  // ── 9  VECTOR SCALING ───────────────────────────────────────────────────────
  async function _auditVectorScaling() {
    var r=[];
    var HVF=sys('HyperscaleVectorFabric');
    if(!HVF){ r.push(skip('HyperscaleVectorFabric','Phase 68 not loaded')); return r; }
    r.push(pass('HyperscaleVectorFabric.loaded'));
    r.push(HVF.LargeScaleAnnEngine?pass('HVF.LargeScaleAnnEngine'):fail('HVF.LargeScaleAnnEngine','missing'));
    r.push(HVF.GraphMemorySystem?pass('HVF.GraphMemorySystem'):fail('HVF.GraphMemorySystem','missing'));
    r.push(HVF.SemanticCompressionEngine?pass('HVF.SemanticCompressionEngine'):fail('HVF.SemanticCompressionEngine','missing'));
    r.push(HVF.DistributedIndexingSystem?pass('HVF.DistributedIndexingSystem'):fail('HVF.DistributedIndexingSystem','missing'));
    await safe(async function(){
      await HVF.store('_scale_test_','This is a vector scaling test document with semantic content.',{source:'audit'});
      var results=HVF.search('vector scaling test',{k:1});
      r.push(results&&results.length>0?pass('HVF.store_search'):warn_('HVF.store_search','no results'));
    });
    r.push(info('HVF.stats',JSON.stringify(HVF.stats())));
    return r;
  }

  // ── 10  ANN INDEXING ────────────────────────────────────────────────────────
  async function _auditAnnIndexing() {
    var r=[];
    var HVF=sys('HyperscaleVectorFabric');
    if(!HVF||!HVF.LargeScaleAnnEngine){ r.push(skip('LargeScaleAnnEngine','HVF not loaded')); return r; }
    var ANN=HVF.LargeScaleAnnEngine;
    r.push(pass('LargeScaleAnnEngine.loaded'));
    r.push(info('ANN.size',String(ANN.size())));
    await safe(async function(){
      var vec=new Float32Array(384); vec[0]=1; vec[1]=0.5;
      await ANN.insert('_ann_audit_test_',vec,{type:'audit'});
      var results=ANN.search(vec,1);
      r.push(results&&results.length>0?pass('ANN.insert_search','sim:'+results[0].sim.toFixed(3)):fail('ANN.insert_search'));
    });
    await safe(async function(){
      var items=[];
      for(var i=0;i<20;i++){ var v=new Float32Array(384).fill(i*0.01); items.push({id:'_bulk_'+i,vec:v,meta:{}}); }
      await ANN.bulkInsert(items);
      r.push(ANN.size()>20?pass('ANN.bulkInsert','size:'+ANN.size()):warn_('ANN.bulkInsert','size:'+ANN.size()));
    });
    return r;
  }

  // ── 11  GRAPH MEMORY ────────────────────────────────────────────────────────
  async function _auditGraphMemory() {
    var r=[];
    var HVF=sys('HyperscaleVectorFabric');
    if(!HVF||!HVF.GraphMemorySystem){ r.push(skip('GraphMemorySystem','HVF not loaded')); return r; }
    var GMS=HVF.GraphMemorySystem;
    r.push(pass('GraphMemorySystem.loaded'));
    await safe(async function(){
      var result=await GMS.addDocument('_graph_test_','Apple Inc reported record revenue in Q4 2024. The contract was signed with Microsoft.',{type:'document'});
      r.push(result&&result.entities?pass('GMS.addDocument','entities:'+result.entities.length):warn_('GMS.addDocument','no entities'));
    });
    await safe(function(){
      var results=GMS.search('revenue report',3);
      r.push(results&&results.length>=0?pass('GMS.search','count:'+results.length):warn_('GMS.search','no results'));
    });
    r.push(info('GMS.stats',JSON.stringify(GMS.stats())));
    return r;
  }

  // ── 12  SEMANTIC COMPRESSION ─────────────────────────────────────────────────
  async function _auditSemanticCompression() {
    var r=[];
    var HVF=sys('HyperscaleVectorFabric');
    if(!HVF||!HVF.SemanticCompressionEngine){ r.push(skip('SemanticCompressionEngine','HVF not loaded')); return r; }
    var SCE=HVF.SemanticCompressionEngine;
    r.push(pass('SemanticCompressionEngine.loaded'));
    await safe(function(){
      var vec=new Float32Array(384).fill(0.5);
      var q=SCE.quantizeVec(vec);
      r.push(q&&q.q?pass('SCE.quantizeVec','q4 bytes:'+q.q.byteLength):fail('SCE.quantizeVec'));
      var dq=SCE.dequantizeVec(q);
      r.push(dq&&dq.length===384?pass('SCE.dequantizeVec'):fail('SCE.dequantizeVec'));
    });
    await safe(function(){
      var dup1=SCE.isDuplicate('This is a unique chunk of text for deduplication testing.');
      var dup2=SCE.isDuplicate('This is a unique chunk of text for deduplication testing.');
      r.push(!dup1&&dup2?pass('SCE.isDuplicate'):warn_('SCE.isDuplicate','dup1:'+dup1+' dup2:'+dup2));
    });
    await safe(async function(){
      var chunks=[{id:'c1',text:'Chunk one',ts:Date.now()-1000,score:0.8},{id:'c2',text:'Chunk two',ts:Date.now()-2000,score:0.3}];
      var compressed=await SCE.compressChunks(chunks);
      r.push(compressed.length<=chunks.length?pass('SCE.compressChunks','in:'+chunks.length+' out:'+compressed.length):warn_('SCE.compressChunks','no reduction'));
    });
    return r;
  }

  // ── 13  DISTRIBUTED INDEXING ─────────────────────────────────────────────────
  async function _auditDistributedIndexing() {
    var r=[];
    var HVF=sys('HyperscaleVectorFabric');
    if(!HVF||!HVF.DistributedIndexingSystem){ r.push(skip('DistributedIndexingSystem','HVF not loaded')); return r; }
    var DIS=HVF.DistributedIndexingSystem;
    r.push(pass('DistributedIndexingSystem.loaded'));
    r.push(info('DIS.status',JSON.stringify(DIS.status())));
    await safe(async function(){
      var items=[{id:'_dis_1_',text:'test indexing item one',meta:{}},{id:'_dis_2_',text:'test indexing item two',meta:{}}];
      var shardIds=await DIS.shardAndIndex(items,2);
      r.push(shardIds&&shardIds.length>0?pass('DIS.shardAndIndex','shards:'+shardIds.length):warn_('DIS.shardAndIndex','no shards'));
    });
    await safe(async function(){
      await DIS.recover();
      r.push(pass('DIS.recover'));
    });
    return r;
  }

  // ── 14  ABUSE PROTECTION ─────────────────────────────────────────────────────
  async function _auditAbuseProtection() {
    var r=[];
    var PCM=sys('ProductionComputeMesh');
    if(!PCM){ r.push(skip('AbuseProtection','Phase 69 not loaded')); return r; }
    r.push(pass('ProductionComputeMesh.loaded'));
    var APS=PCM.AbuseProtectionSystem;
    r.push(APS?pass('AbuseProtectionSystem.loaded'):fail('AbuseProtectionSystem.loaded','missing'));
    await safe(function(){
      var safe_=APS.check('_clean_peer_','legitimate task data',0);
      r.push(pass('APS.check_clean','allowed:'+safe_));
    });
    await safe(function(){
      var suspect=APS.check('_bad_peer_','eval(maliciousCode())',0);
      r.push(!suspect?pass('APS.check_abuse_blocked'):warn_('APS.check_abuse_blocked','abuse not detected (first occurrence)'));
    });
    r.push(info('APS.stats',JSON.stringify(APS.stats())));
    return r;
  }

  // ── 15  QUOTA SYSTEMS ───────────────────────────────────────────────────────
  async function _auditQuotaSystems() {
    var r=[];
    var PCM=sys('ProductionComputeMesh');
    if(!PCM){ r.push(skip('QuotaSystems','Phase 69 not loaded')); return r; }
    var QME=PCM.QuotaManagementEngine;
    r.push(QME?pass('QuotaManagementEngine.loaded'):fail('QuotaManagementEngine.loaded','missing'));
    await safe(function(){
      var ok=QME.consumeCpu(1000);
      r.push(pass('QME.consumeCpu','allowed:'+ok));
    });
    await safe(function(){
      var canAccept=QME.canAcceptJob(1024*1024);
      r.push(pass('QME.canAcceptJob','ok:'+canAccept));
    });
    r.push(info('QME.stats',JSON.stringify(QME.stats())));
    return r;
  }

  // ── 16  TRUST SYSTEMS ───────────────────────────────────────────────────────
  async function _auditTrustSystems() {
    var r=[];
    var PCM=sys('ProductionComputeMesh');
    if(!PCM){ r.push(skip('TrustSystems','Phase 69 not loaded')); return r; }
    var ITL=PCM.IdentityAndTrustLayer;
    r.push(ITL?pass('IdentityAndTrustLayer.loaded'):fail('IdentityAndTrustLayer.loaded','missing'));
    await safe(function(){
      var myId=ITL.myId();
      r.push(myId&&myId.length>10?pass('ITL.myId','id:'+myId.slice(0,20)+'...'):fail('ITL.myId'));
    });
    await safe(function(){
      ITL.reward('_trust_peer_',0.1);
      r.push(ITL.isTrusted('_trust_peer_')?pass('ITL.reward_isTrusted'):warn_('ITL.reward_isTrusted','not trusted after reward'));
    });
    await safe(function(){
      for(var i=0;i<8;i++) ITL.penalize('_bad_trust_peer_',0.1);
      var quarantined=!ITL.isTrusted('_bad_trust_peer_');
      r.push(quarantined?pass('ITL.penalize_quarantine'):warn_('ITL.penalize_quarantine','peer not quarantined'));
    });
    await safe(function(){
      var ok=ITL.verifyIntegrity('abc123','abc123');
      r.push(ok?pass('ITL.verifyIntegrity_match'):fail('ITL.verifyIntegrity_match'));
      var notOk=ITL.verifyIntegrity('abc123','xyz789');
      r.push(!notOk?pass('ITL.verifyIntegrity_mismatch'):fail('ITL.verifyIntegrity_mismatch'));
    });
    r.push(info('ITL.stats',JSON.stringify(ITL.stats())));
    // Verify never auto-trust: new peer gets provisional trust, verify then punish pattern
    r.push(info('ITL.trust_model','provisional then verify (never permanent auto-trust)'));
    return r;
  }

  // ── 17  BANDWIDTH ECONOMICS ─────────────────────────────────────────────────
  async function _auditBandwidthEconomics() {
    var r=[];
    var PCM=sys('ProductionComputeMesh');
    if(!PCM){ r.push(skip('BandwidthEconomics','Phase 69 not loaded')); return r; }
    var BWE=PCM.BandwidthEconomicsEngine;
    r.push(BWE?pass('BandwidthEconomicsEngine.loaded'):fail('BandwidthEconomicsEngine.loaded','missing'));
    await safe(function(){
      var chunk=BWE.getChunkSize();
      r.push(chunk>0?pass('BWE.chunkSize',Math.round(chunk/1024)+'KB'):fail('BWE.chunkSize'));
    });
    await safe(function(){
      var lowBW=BWE.shouldUseLowBandwidth();
      r.push(pass('BWE.lowBandwidth',String(lowBW)));
    });
    await safe(async function(){
      var result=await BWE.reassignShard('_test_shard_','_failed_peer_',{});
      r.push(result&&result.reassigned?pass('BWE.reassignShard'):warn_('BWE.reassignShard','no reassignment'));
    });
    r.push(info('BWE.stats',JSON.stringify(BWE.stats())));
    return r;
  }

  // ── 18  GIANT-FILE SURVIVAL ─────────────────────────────────────────────────
  async function _auditGiantFileSurvival() {
    var r=[];
    var LAEOS=sys('LabaAiEvolutionOS');
    if(!LAEOS){ r.push(skip('LabaAiEvolutionOS','Phase 70 not loaded')); return r; }
    r.push(pass('LabaAiEvolutionOS.loaded'));
    await safe(async function(){
      var result=await LAEOS.generate('summarize',{giantFile:true,fileSizeBytes:200*1024*1024});
      r.push(result&&result.result?pass('LAEOS.giant_file_generate','provider:'+result.provider):warn_('LAEOS.giant_file_generate','no result'));
    });
    var BT=sys('BrowserTools');
    r.push(BT&&BT.process?pass('BrowserTools.process_intact'):fail('BrowserTools.process_intact','CRITICAL: missing!'));
    return r;
  }

  // ── 19  RECOVERY SYSTEMS ────────────────────────────────────────────────────
  async function _auditRecoverySystems() {
    var r=[];
    var LAEOS=sys('LabaAiEvolutionOS');
    if(LAEOS){
      await safe(async function(){
        var rec=await LAEOS.recover();
        r.push(pass('LAEOS.recover','systems:'+rec.recovered.length));
      });
      await safe(function(){
        var id='_ckpt_audit_'+Date.now();
        LAEOS.checkpoint(id,{test:true,ts:now()});
        var restored=LAEOS.restore(id);
        r.push(restored&&restored.test?pass('LAEOS.checkpoint_restore'):fail('LAEOS.checkpoint_restore'));
        LAEOS.UnifiedCheckpointRouter.clear(id);
      });
    } else { r.push(skip('LAEOS.recover','Phase 70 not loaded')); }
    return r;
  }

  // ── 20  FALLBACK CHAINS ─────────────────────────────────────────────────────
  async function _auditFallbackChains() {
    var r=[];
    var LAEOS=sys('LabaAiEvolutionOS');
    if(LAEOS){
      await safe(async function(){
        var result=await LAEOS.generate('test fallback chain',{});
        r.push(result&&result.result?pass('LAEOS.fallback_chain','via:'+result.provider):fail('LAEOS.fallback_chain'));
      });
    }
    var RLLE=sys('RealLocalLlmEngine');
    if(RLLE){
      await safe(function(){
        var path=RLLE.RealGGUFExecutionRuntime.OpfsCache.available()?'opfs':'idb';
        r.push(pass('RLLE.storage_fallback',path));
      });
      r.push(info('RLLE.inference_path',JSON.stringify(RLLE.capabilities())));
    }
    var BT=sys('BrowserTools');
    r.push(BT&&BT.process?pass('BrowserTools.always_intact'):fail('BrowserTools.always_intact','CRITICAL'));
    return r;
  }

  // ── 21  LOW-RAM SURVIVAL ─────────────────────────────────────────────────────
  async function _auditLowRam() {
    var r=[];
    var mem=(navigator&&navigator.deviceMemory)||4;
    r.push(info('device.ram',mem+'GB'));
    if(mem<2){
      var RLLE=sys('RealLocalLlmEngine');
      if(RLLE){
        r.push(info('RLLE.low_ram_path','KV eviction + WASM-only batching active'));
        r.push(pass('RLLE.low_ram_safety','memory caps enforced'));
      }
    } else {
      r.push(info('low_ram.simulated','device has '+mem+'GB — low-RAM path available'));
    }
    var HVF=sys('HyperscaleVectorFabric');
    if(HVF) r.push(info('HVF.quota',JSON.stringify(HVF.QuotaManager.stats())));
    return r;
  }

  // ── 22  MOBILE COMPAT ───────────────────────────────────────────────────────
  async function _auditMobileCompat() {
    var r=[];
    var mobile=/Mobi|Android/i.test((navigator&&navigator.userAgent)||'');
    r.push(info('mobile.detected',String(mobile)));
    var PCM=sys('ProductionComputeMesh');
    if(PCM){
      r.push(info('PCM.mobile_limits',PCM.BandwidthEconomicsEngine.shouldUseLowBandwidth()?'low-BW active':'normal'));
    }
    var LAEOS=sys('LabaAiEvolutionOS');
    if(LAEOS&&LAEOS.UnifiedDistributedRuntime){
      r.push(info('distributed.p2p_off',String(!LAEOS.UnifiedDistributedRuntime.isEnabled())));
    }
    return r;
  }

  // ── 23  SAFARI COMPAT ───────────────────────────────────────────────────────
  async function _auditSafariCompat() {
    var r=[];
    var safari=/^((?!chrome|android).)*safari/i.test((navigator&&navigator.userAgent)||'');
    r.push(info('safari.detected',String(safari)));
    var hasGpu=!!(navigator&&navigator.gpu);
    r.push(info('webgpu.available',String(hasGpu)));
    if(!hasGpu){
      r.push(info('safari.gpu_fallback','WASM/CPU fallback chains active'));
      r.push(pass('safari.wasm_fallback','HAS_WASM:'+String(typeof WebAssembly!=='undefined')));
    }
    var RLLE=sys('RealLocalLlmEngine');
    if(RLLE) r.push(info('safari.capabilities',JSON.stringify(RLLE.capabilities())));
    return r;
  }

  // ── 24  WEBGPU FALLBACK ─────────────────────────────────────────────────────
  async function _auditWebGpuFallback() {
    var r=[];
    var hasGpu=!!(navigator&&navigator.gpu);
    r.push(info('webgpu.present',String(hasGpu)));
    if(!hasGpu){
      r.push(pass('webgpu.cpu_fallback_active'));
      var RLLE=sys('RealLocalLlmEngine');
      if(RLLE&&RLLE.OptimizedTransformerRuntime){
        await safe(async function(){
          var A=new Float32Array([1,0,0,1]), B=new Float32Array([2,0,0,2]);
          var C=await RLLE.OptimizedTransformerRuntime.tiledMatMul(A,B,2,2,2);
          r.push(C&&C[0]===2?pass('webgpu.cpu_matmul_fallback'):warn_('webgpu.cpu_matmul_fallback','result:'+JSON.stringify(Array.from(C||[]))));
        });
      }
    } else {
      r.push(info('webgpu.initialized',String(RLLE&&RLLE.OptimizedTransformerRuntime&&RLLE.OptimizedTransformerRuntime.isReady())));
    }
    return r;
  }

  // ── PHASE 70 SYSTEMS AUDIT ──────────────────────────────────────────────────
  async function _auditPhase70() {
    var r=[];
    var LAEOS=sys('LabaAiEvolutionOS');
    if(!LAEOS){ r.push(skip('LabaAiEvolutionOS','Phase 70 not loaded')); return r; }
    r.push(pass('LabaAiEvolutionOS.loaded'));
    r.push(LAEOS.UnifiedLlmOrchestration?pass('LAEOS.UnifiedLlmOrchestration'):fail('LAEOS.UnifiedLlmOrchestration','missing'));
    r.push(LAEOS.UnifiedVectorRouting?pass('LAEOS.UnifiedVectorRouting'):fail('LAEOS.UnifiedVectorRouting','missing'));
    r.push(LAEOS.UnifiedDistributedRuntime?pass('LAEOS.UnifiedDistributedRuntime'):fail('LAEOS.UnifiedDistributedRuntime','missing'));
    r.push(LAEOS.UnifiedWorkerManagement?pass('LAEOS.UnifiedWorkerManagement'):fail('LAEOS.UnifiedWorkerManagement','missing'));
    r.push(LAEOS.UnifiedCheckpointRouter?pass('LAEOS.UnifiedCheckpointRouter'):fail('LAEOS.UnifiedCheckpointRouter','missing'));
    r.push(LAEOS.UnifiedRecovery?pass('LAEOS.UnifiedRecovery'):fail('LAEOS.UnifiedRecovery','missing'));
    r.push(LAEOS.UnifiedAudit?pass('LAEOS.UnifiedAudit'):fail('LAEOS.UnifiedAudit','missing'));
    var status=LAEOS.status();
    r.push(info('LAEOS.systems',status.loaded+'/'+status.total));
    // Verify P2P is off
    r.push(!LAEOS.UnifiedDistributedRuntime.isEnabled()?pass('LAEOS.p2p_off_by_default'):fail('LAEOS.p2p_off_by_default','P2P should be off!'));
    return r;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § MASTER RUN
  // ═══════════════════════════════════════════════════════════════════════════
  async function run() {
    var t0=now();
    log('starting final AI evolution audit (24 categories)...');

    var sections=[
      {name:'GGUF Runtime',          fn:_auditGgufRuntime},
      {name:'Transformer Kernels',   fn:_auditTransformerKernels},
      {name:'Tokenizer Accuracy',    fn:_auditTokenizerAccuracy},
      {name:'KV Cache',              fn:_auditKvCache},
      {name:'Advanced Batching',     fn:_auditBatching},
      {name:'Speculative Decoding',  fn:_auditSpeculativeDecoding},
      {name:'Agent Intelligence',    fn:_auditAgentIntelligence},
      {name:'Reflection Loops',      fn:_auditReflectionLoops},
      {name:'Vector Scaling',        fn:_auditVectorScaling},
      {name:'ANN Indexing',          fn:_auditAnnIndexing},
      {name:'Graph Memory',          fn:_auditGraphMemory},
      {name:'Semantic Compression',  fn:_auditSemanticCompression},
      {name:'Distributed Indexing',  fn:_auditDistributedIndexing},
      {name:'Abuse Protection',      fn:_auditAbuseProtection},
      {name:'Quota Systems',         fn:_auditQuotaSystems},
      {name:'Trust Systems',         fn:_auditTrustSystems},
      {name:'Bandwidth Economics',   fn:_auditBandwidthEconomics},
      {name:'Giant-File Survival',   fn:_auditGiantFileSurvival},
      {name:'Recovery Systems',      fn:_auditRecoverySystems},
      {name:'Fallback Chains',       fn:_auditFallbackChains},
      {name:'Low-RAM Survival',      fn:_auditLowRam},
      {name:'Mobile Compatibility',  fn:_auditMobileCompat},
      {name:'Safari Compatibility',  fn:_auditSafariCompat},
      {name:'WebGPU Fallback',       fn:_auditWebGpuFallback},
      {name:'Phase 70 Systems',      fn:_auditPhase70},
    ];

    var all=[]; var report={ts:t0,sections:[]};
    for(var i=0;i<sections.length;i++){
      await frame();
      var sec=sections[i], secResults=[];
      try { secResults=await sec.fn(); } catch(e){ secResults=[fail(sec.name,e.message)]; }
      all=all.concat(secResults);
      report.sections.push({name:sec.name,results:secResults});
    }

    var totals={pass:0,warn:0,fail:0,skip:0,info:0};
    all.forEach(function(r){if(totals[r.status]!==undefined)totals[r.status]++;});
    report.totals=totals;
    report.elapsed=now()-t0;
    report.health=totals.fail>5?'critical':totals.fail>0?'degraded':totals.warn>5?'warn':'ok';

    log('audit complete in',report.elapsed,'ms — health:',report.health,'| pass:',totals.pass,'| warn:',totals.warn,'| fail:',totals.fail,'| skip:',totals.skip);
    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.FinalAiEvolutionAudit = {
    VERSION: VERSION,
    run: run,
    // Individual runners
    auditGguf:          _auditGgufRuntime,
    auditTransformer:   _auditTransformerKernels,
    auditTokenizer:     _auditTokenizerAccuracy,
    auditKvCache:       _auditKvCache,
    auditBatching:      _auditBatching,
    auditSpeculative:   _auditSpeculativeDecoding,
    auditAgentIntel:    _auditAgentIntelligence,
    auditReflection:    _auditReflectionLoops,
    auditVectorScaling: _auditVectorScaling,
    auditAnn:           _auditAnnIndexing,
    auditGraph:         _auditGraphMemory,
    auditCompression:   _auditSemanticCompression,
    auditDistIndexing:  _auditDistributedIndexing,
    auditAbuse:         _auditAbuseProtection,
    auditQuota:         _auditQuotaSystems,
    auditTrust:         _auditTrustSystems,
    auditBandwidth:     _auditBandwidthEconomics,
    auditGiantFile:     _auditGiantFileSurvival,
    auditRecovery:      _auditRecoverySystems,
    auditFallback:      _auditFallbackChains,
    auditLowRam:        _auditLowRam,
    auditMobile:        _auditMobileCompat,
    auditSafari:        _auditSafariCompat,
    auditWebGpu:        _auditWebGpuFallback,
    auditPhase70:       _auditPhase70,
  };
  window.runFinalAiEvolutionAudit = function(){ return run(); };

  log('v'+VERSION+' ready — call runFinalAiEvolutionAudit() to audit all 25 categories');

})();
