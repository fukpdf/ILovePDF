/**
 * PHASE 67 — ADVANCED AGENT INTELLIGENCE
 * window.AdvancedAgentIntelligence
 *
 * 67A SelfImprovementEngine         — learn from success/failure, adaptive strategy
 * 67B IntelligentPlanningSystem     — hierarchical planning, cost/memory estimation
 * 67C ExecutionReflectionEngine     — output validation, retry reasoning, fallback escalation
 * 67D MemoryDrivenOptimization      — vector memory lookup, semantic workflow recall
 * 67E LongRunningPersistenceEngine  — multi-hour workflows, restart recovery, distributed cont.
 *
 * Purely additive. Extends AutonomousAiWorkers + AutonomousAgentSystem.
 * Never blocks main thread. Degrades gracefully. Retry budgets enforced.
 */
(function () {
  'use strict';

  var VERSION  = '1.0';
  var LOG      = '[AAI]';
  var DB_NAME  = 'aai_intelligence_v1';
  var MAX_RETRIES_PER_STEP = 3;
  var CKPT_MS  = 20000; // checkpoint every 20 s
  var MAX_WORKFLOW_MS = 4 * 60 * 60 * 1000; // 4 hours max

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'aai_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }

  // ── IDB Store ─────────────────────────────────────────────────────────────
  var AaiDb = (function () {
    var _db=null;
    var STORES=['workflows','history','optimization','checkpoints','reflection','planning'];
    function open() {
      if(_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=function(e){ var db=e.target.result; STORES.forEach(function(s){ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'}); }); };
        req.onsuccess=function(e){_db=e.target.result;res(_db);}; req.onerror=function(){rej(req.error);};
      });
    }
    function put(store,obj){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readwrite');tx.objectStore(store).put(obj);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    function get(store,id){return open().then(function(db){return new Promise(function(r){var req=db.transaction(store,'readonly').objectStore(store).get(id);req.onsuccess=function(){r(req.result||null);};req.onerror=function(){r(null);};});}).catch(function(){return null;});}
    function getAll(store){return open().then(function(db){return new Promise(function(r){var req=db.transaction(store,'readonly').objectStore(store).getAll();req.onsuccess=function(){r(req.result||[]);};req.onerror=function(){r([]);};});}).catch(function(){return[];});}
    function del(store,id){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    return {put:put,get:get,getAll:getAll,del:del};
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 67A  SELF-IMPROVEMENT ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var SelfImprovementEngine = (function () {
    var _history = new Map();  // taskType → [{ success, provider, strategy, ms, ts }]
    var _strategies = {};      // taskType → ranked strategies

    var STRATEGIES = ['local_gguf','local_onnx','webgpu','wasm','remote_api','heuristic'];

    function _loadHistory() {
      return AaiDb.getAll('history').then(function(rows){
        rows.forEach(function(r){ _history.set(r.id, r.entries||[]); });
      });
    }

    function _scoreStrategy(entries, strategy) {
      var relevant = entries.filter(function(e){return e.strategy===strategy;});
      if (!relevant.length) return 0.5; // neutral prior
      var successes = relevant.filter(function(e){return e.success;}).length;
      var avgMs = relevant.reduce(function(s,e){return s+e.ms;},0)/relevant.length;
      var successRate = successes/relevant.length;
      var speedScore = Math.max(0, 1 - avgMs/30000); // 30 s = zero speed score
      return successRate*0.7 + speedScore*0.3;
    }

    async function record(taskType, success, provider, strategy, ms, opts) {
      opts = opts || {};
      var key = taskType || 'generic';
      var entries = _history.get(key) || [];
      entries.push({ success:success, provider:provider, strategy:strategy, ms:ms, ts:now(), opts:opts });
      // Keep last 200 records per type
      if (entries.length > 200) entries = entries.slice(-200);
      _history.set(key, entries);
      // Re-rank strategies
      var ranked = STRATEGIES.slice().sort(function(a,b){
        return _scoreStrategy(entries,b) - _scoreStrategy(entries,a);
      });
      _strategies[key] = ranked;
      // Persist
      await AaiDb.put('history', { id:key, entries:entries, rankedStrategies:ranked, ts:now() });
    }

    async function getBestStrategy(taskType) {
      var key = taskType || 'generic';
      if (_strategies[key] && _strategies[key].length > 0) return _strategies[key][0];
      // Load from IDB
      var stored = await AaiDb.get('history', key);
      if (stored && stored.rankedStrategies && stored.rankedStrategies.length > 0) return stored.rankedStrategies[0];
      return 'heuristic';
    }

    async function getOptimalSettings(taskType, fileSize) {
      var key = taskType || 'generic';
      var entries = _history.get(key) || [];
      var strategy = await getBestStrategy(taskType);
      var giantFile = (fileSize||0) > 50*1024*1024;
      if (giantFile) strategy = 'wasm'; // giant files: safe WASM path
      var avgMs = entries.length > 0
        ? entries.slice(-20).reduce(function(s,e){return s+e.ms;},0)/Math.min(20,entries.length)
        : 5000;
      return { strategy:strategy, estimatedMs:Math.round(avgMs), giantFile:giantFile };
    }

    _loadHistory().catch(function(){});

    return { record:record, getBestStrategy:getBestStrategy, getOptimalSettings:getOptimalSettings };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 67B  INTELLIGENT PLANNING SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var IntelligentPlanningSystem = (function () {

    function _estimateMemory(fileSizeBytes, numSteps) {
      var base = (fileSizeBytes||0) * 2; // 2× for processing headroom
      var perStep = 32 * 1024 * 1024;    // 32 MB per step overhead
      return base + numSteps * perStep;
    }

    function _estimateTime(fileSizeBytes, numSteps, strategy) {
      var mbPerSec = strategy==='webgpu' ? 200 : strategy==='wasm' ? 50 : 20;
      var fileMb = (fileSizeBytes||0)/(1024*1024);
      return Math.round(fileMb/mbPerSec*1000 + numSteps*2000);
    }

    function _buildDag(goal, steps, deps) {
      deps = deps || {};
      return {
        goal: goal,
        nodes: steps.map(function(s,i){
          return { id:'step_'+i, description:s, deps:deps[i]||[], status:'pending', retries:0 };
        }),
        createdAt: now()
      };
    }

    async function plan(goal, opts) {
      opts = opts || {};
      var planId = uid();
      var fileSize = opts.fileSizeBytes || 0;
      var giantFile = fileSize > 50*1024*1024;
      var multiAgent = opts.multiAgent || fileSize > 200*1024*1024;

      // Get best strategy from SIE
      var settings = await SelfImprovementEngine.getOptimalSettings(opts.taskType, fileSize);

      // Generate steps via RGI or fallback
      var steps = [];
      try {
        var RGI = sys('RealGenerativeIntelligence') || sys('LabaAiEvolutionOS') && sys('LabaAiEvolutionOS').UnifiedAiRouter;
        if (RGI && RGI.reason) {
          var res = await RGI.reason(
            'Break this goal into 3-5 ordered steps. Return as numbered list.\nGoal: '+goal.slice(0,400),
            { giantFile:giantFile }
          );
          steps = (res.answer||'').split(/\n+/).filter(function(s){return /^\d/.test(s)||s.trim().length>10;}).map(function(s){return s.replace(/^\d+[.)]\s*/,'');}).slice(0,5);
        }
      } catch(e){ warn('plan generation:', e.message); }

      if (!steps.length) steps = ['Analyze input', giantFile?'Stream process chunks':'Process document', 'Generate output'];

      // For giant files, add streaming steps
      if (giantFile) steps.splice(1,0,'Partition into 4MB chunks');

      // For multi-agent, add parallel steps
      if (multiAgent && steps.length >= 2) {
        steps = steps.slice(0,1).concat(['[PARALLEL] '+steps[1]]).concat(steps.slice(2));
      }

      var memEst  = _estimateMemory(fileSize, steps.length);
      var timeEst = _estimateTime(fileSize, steps.length, settings.strategy);
      var dag     = _buildDag(goal, steps);

      var planObj = {
        id:planId, goal:goal, dag:dag, strategy:settings.strategy,
        estimatedMs:timeEst, estimatedMemBytes:memEst,
        giantFile:giantFile, multiAgent:multiAgent,
        fileSize:fileSize, status:'ready', ts:now()
      };
      await AaiDb.put('planning', planObj);
      return planObj;
    }

    async function estimateCost(goal, opts) {
      opts = opts || {};
      var fileSize = opts.fileSizeBytes || 0;
      var steps = opts.estimatedSteps || 3;
      return {
        memoryBytes: _estimateMemory(fileSize, steps),
        timeMs:      _estimateTime(fileSize, steps, opts.strategy||'wasm'),
        giantFile:   fileSize > 50*1024*1024,
        strategy:    opts.strategy || 'wasm'
      };
    }

    return { plan:plan, estimateCost:estimateCost };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 67C  EXECUTION REFLECTION ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ExecutionReflectionEngine = (function () {
    var MAX_RETRIES     = MAX_RETRIES_PER_STEP;
    var CONFIDENCE_MIN  = 0.55;
    var _reflections    = new Map(); // stepId → ReflectionRecord

    // Hallucination signals (fast scan)
    var HAL_SIGNALS = [
      /I (cannot|can't|don't) (know|access|verify)/i,
      /as an AI (language model|assistant)/i,
      /I (was|am) trained on data/i,
      /my (training|knowledge) cutoff/i,
    ];

    function _halScore(text) {
      var hits=0; HAL_SIGNALS.forEach(function(p){if(p.test(text))hits++;});
      return hits;
    }

    function _qualityScore(output, goal) {
      if (!output || output.length < 10) return 0;
      var hal = _halScore(output);
      if (hal>1) return 0.2;
      var goalWords = (goal||'').toLowerCase().split(/\s+/).filter(function(w){return w.length>4;});
      var outLower = output.toLowerCase();
      var coverage = goalWords.length>0
        ? goalWords.filter(function(w){return outLower.indexOf(w)>=0;}).length/goalWords.length
        : 0.7;
      var lenScore = output.length>50&&output.length<10000 ? 1 : 0.5;
      return Math.min(1, coverage*0.6+lenScore*0.3+(hal===0?0.1:0));
    }

    function _selectFallback(currentProvider, history) {
      var CHAIN = ['local_gguf','local_onnx','webgpu','wasm','heuristic'];
      var idx = CHAIN.indexOf(currentProvider);
      if (idx<0||idx>=CHAIN.length-1) return 'heuristic';
      return CHAIN[idx+1];
    }

    async function reflect(stepId, goal, output, opts) {
      opts = opts || {};
      var retryBudget = opts.retryBudget || MAX_RETRIES;
      var record = _reflections.get(stepId) || { retries:0, history:[], provider: opts.provider||'heuristic' };
      var score  = _qualityScore(output, goal);
      var halCnt = _halScore(output);

      record.history.push({ output:output.slice(0,200), score:score, ts:now(), provider:record.provider });

      // Persist reflection state checkpoint
      await AaiDb.put('reflection', { id:stepId, record:record, score:score, ts:now() });

      if (score >= CONFIDENCE_MIN && halCnt === 0) {
        _reflections.delete(stepId);
        return { action:'accept', score:score, output:output };
      }

      if (record.retries >= retryBudget) {
        _reflections.delete(stepId);
        warn('retry budget exhausted for step:', stepId, '— accepting best result');
        return { action:'accept_degraded', score:score, output:output };
      }

      // Escalate to next fallback provider
      var nextProvider = _selectFallback(record.provider, record.history);
      record.retries++;
      record.provider = nextProvider;
      _reflections.set(stepId, record);

      return { action:'retry', provider:nextProvider, retryNum:record.retries, score:score };
    }

    async function validateOutput(output, schema) {
      if (!schema) return { valid:true };
      var issues = [];
      (schema.required||[]).forEach(function(field){
        if (output.indexOf(field)<0) issues.push('missing field: '+field);
      });
      if (schema.minLength && output.length<schema.minLength) issues.push('too short');
      if (schema.maxLength && output.length>schema.maxLength) issues.push('too long');
      return { valid:issues.length===0, issues:issues };
    }

    return { reflect:reflect, validateOutput:validateOutput, qualityScore:_qualityScore };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 67D  MEMORY-DRIVEN OPTIMIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  var MemoryDrivenOptimization = (function () {
    var _localCache = new Map(); // semantic key → best settings

    function _semanticKey(goal) {
      var words = (goal||'').toLowerCase().split(/\s+/).slice(0,8);
      return words.join('_');
    }

    async function recall(goal, opts) {
      opts = opts || {};
      var key = _semanticKey(goal);
      // Local cache hit
      if (_localCache.has(key)) return _localCache.get(key);

      // Try vector memory search
      try {
        var HVF = sys('HyperscaleVectorFabric') || sys('HyperscaleVectorMemory');
        if (HVF && HVF.search) {
          var results = await HVF.search(goal, { k:3, filter:function(m){return m&&m.type==='workflow_optimization';} });
          if (results && results.length>0) {
            var best = results[0];
            return best.meta || null;
          }
        }
      } catch(e){ warn('vector recall:', e.message); }

      // Try SIE history
      var strategy = await SelfImprovementEngine.getBestStrategy(opts.taskType);
      return { strategy:strategy, fromMemory:'sie' };
    }

    async function store(goal, settings, performance) {
      var key = _semanticKey(goal);
      var entry = Object.assign({}, settings, { goal:goal.slice(0,200), performance:performance, ts:now(), type:'workflow_optimization' });
      _localCache.set(key, entry);
      if (_localCache.size>128) _localCache.delete(_localCache.keys().next().value);

      // Store in vector memory
      try {
        var HVF = sys('HyperscaleVectorFabric') || sys('HyperscaleVectorMemory');
        if (HVF && HVF.store) {
          await HVF.store('opt_'+uid(), goal+' '+JSON.stringify(settings), entry);
        }
      } catch(e){ warn('vector store opt:', e.message); }
    }

    async function getRecommendation(goal, opts) {
      var recalled = await recall(goal, opts);
      var strategy = recalled ? (recalled.strategy||'wasm') : await SelfImprovementEngine.getBestStrategy(opts&&opts.taskType);
      var cost = await IntelligentPlanningSystem.estimateCost(goal, Object.assign({},opts,{strategy:strategy}));
      return Object.assign({ strategy:strategy }, cost, { fromMemory:!!recalled });
    }

    return { recall:recall, store:store, getRecommendation:getRecommendation };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 67E  LONG-RUNNING PERSISTENCE ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var LongRunningPersistenceEngine = (function () {
    var _active = new Map();  // workflowId → state

    function _ckptKey(id){ return 'lrpe_'+id; }

    async function _saveCheckpoint(id, state) {
      await AaiDb.put('checkpoints', { id:_ckptKey(id), state:state, ts:now() });
    }

    async function _loadCheckpoint(id) {
      var r = await AaiDb.get('checkpoints', _ckptKey(id));
      return r ? r.state : null;
    }

    async function start(workflowId, steps, opts) {
      opts = opts || {};
      var deadline = now() + Math.min(opts.maxMs||MAX_WORKFLOW_MS, MAX_WORKFLOW_MS);

      // Attempt checkpoint resume
      var ckpt = await _loadCheckpoint(workflowId);
      var startStep = 0;
      var results   = [];
      if (ckpt && ckpt.nextStep) {
        startStep = ckpt.nextStep;
        results   = ckpt.results || [];
        log('resuming workflow:', workflowId, 'from step', startStep);
      }

      var state = { workflowId:workflowId, nextStep:startStep, results:results,
                    status:'running', startedAt:now(), deadline:deadline };
      _active.set(workflowId, state);

      // Checkpoint timer
      var timer = setInterval(function(){
        var s=_active.get(workflowId);
        if(s) _saveCheckpoint(workflowId,s).catch(function(){});
      }, CKPT_MS);

      try {
        for (var i=startStep; i<steps.length; i++) {
          if (now()>deadline) { warn('deadline reached, halting workflow:', workflowId); break; }
          var step = steps[i];
          state.nextStep = i;
          await frame();

          var result = null;
          try {
            result = await Promise.race([
              (typeof step==='function' ? step(state,i) : Promise.resolve(step)),
              new Promise(function(_,rej){setTimeout(function(){rej(new Error('step_timeout'));},120000);})
            ]);
          } catch(e) {
            warn('step', i, 'failed:', e.message);
            // Reflection + retry
            var reflection = await ExecutionReflectionEngine.reflect(workflowId+'_step_'+i, step&&step.goal||String(step), '', opts);
            if (reflection.action==='retry' && i>0) { i--; } // retry this step
            result = { error: e.message, step: i };
          }
          state.results.push(result);
          state.nextStep = i+1;
          await _saveCheckpoint(workflowId, state);
        }
        state.status='complete';
      } catch(e) {
        state.status='failed'; state.error=e.message;
        warn('workflow', workflowId, 'fatal:', e.message);
      } finally {
        clearInterval(timer);
        await _saveCheckpoint(workflowId, state);
        _active.delete(workflowId);
      }

      return state;
    }

    async function cancel(workflowId) {
      var s = _active.get(workflowId);
      if (s) { s.status='cancelled'; await _saveCheckpoint(workflowId,s); _active.delete(workflowId); }
    }

    async function resume(workflowId, steps, opts) {
      return start(workflowId, steps, opts);
    }

    async function cleanupOrphans() {
      var all = await AaiDb.getAll('checkpoints');
      var cutoff = now() - 6*60*60*1000; // 6 hours
      var orphans = all.filter(function(r){ return r.ts<cutoff && r.state && r.state.status==='running' && !_active.has(r.state.workflowId); });
      for (var i=0;i<orphans.length;i++){
        orphans[i].state.status='orphan';
        await AaiDb.put('checkpoints', orphans[i]);
      }
      log('orphan cleanup: marked', orphans.length, 'workflows');
      return orphans.length;
    }

    async function getInterrupted() {
      var all = await AaiDb.getAll('checkpoints');
      return all.filter(function(r){ return r.state && r.state.status==='running'; }).map(function(r){ return r.state; });
    }

    function activeCount() { return _active.size; }
    function status(id) { return _active.get(id)||null; }

    // Cleanup orphans on boot
    setTimeout(function(){ cleanupOrphans().catch(function(){}); }, 2000);

    return { start:start, cancel:cancel, resume:resume, cleanupOrphans:cleanupOrphans, getInterrupted:getInterrupted, activeCount:activeCount, status:status };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.AdvancedAgentIntelligence = {
    VERSION: VERSION,
    SelfImprovementEngine:       SelfImprovementEngine,
    IntelligentPlanningSystem:   IntelligentPlanningSystem,
    ExecutionReflectionEngine:   ExecutionReflectionEngine,
    MemoryDrivenOptimization:    MemoryDrivenOptimization,
    LongRunningPersistenceEngine: LongRunningPersistenceEngine,
    // Convenience API
    plan:    function(goal,opts)          { return IntelligentPlanningSystem.plan(goal,opts); },
    run:     function(id,steps,opts)      { return LongRunningPersistenceEngine.start(id,steps,opts); },
    reflect: function(id,goal,output,opts){ return ExecutionReflectionEngine.reflect(id,goal,output,opts); },
    recall:  function(goal,opts)          { return MemoryDrivenOptimization.recall(goal,opts); },
    record:  function(type,ok,prov,strat,ms){ return SelfImprovementEngine.record(type,ok,prov,strat,ms); },
  };

  log('v'+VERSION+' ready');

  // Wire into AutonomousAiWorkers if available
  setTimeout(function(){
    try {
      var AAW = sys('AutonomousAiWorkers');
      if (AAW && AAW.AutonomousPlanner && !AAW.__aai_wired){
        AAW.__aai_wired=true;
        var _origPlan = AAW.plan.bind(AAW);
        AAW.plan = async function(goal,opts){
          // Try AAI's intelligent planner first, fall back to original
          try { return await IntelligentPlanningSystem.plan(goal,opts); }
          catch(e){ return _origPlan(goal,opts); }
        };
        log('AAW.plan upgraded with IntelligentPlanningSystem');
      }
    } catch(e){ warn('AAW wiring:', e.message); }
  }, 300);

})();
