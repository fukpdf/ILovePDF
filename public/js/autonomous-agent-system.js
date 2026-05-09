/**
 * PHASE 58 — AUTONOMOUS AI AGENT SYSTEM
 * window.AutonomousAgentSystem
 *
 * 58A SelfPlanningEngine      — NL goal parsing, dynamic workflow generation
 * 58B DynamicToolSelector     — automatic best-tool selection per file/context
 * 58C LongRunningAgentRuntime — resumable agents, checkpointing, crash recovery
 * 58D AgentMemorySystem       — short/long-term, workflow & conversation memory
 * 58E AgentCoordinationLayer  — multi-agent cooperation, result merging
 * 58F AiWorkerScheduler       — background/idle agents, throttle, priority queue
 *
 * Purely additive. Integrates through adapters. All existing tools intact.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[AAS2]';
  var DB_NAME = 'aas2_agents_v1';
  var MAX_RETRIES = 4;
  var STEP_TIMEOUT_MS = 120000;

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'aas2_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function sleep(ms) { return new Promise(function(r){setTimeout(r,ms);}); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § IDB STORE (shared by all subsystems)
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentDb = (function () {
    var _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req = indexedDB.open(DB_NAME,1);
        req.onupgradeneeded = function(e){
          var db=e.target.result;
          ['agents','steps','memory','queue','checkpoints'].forEach(function(s){
            if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'});
          });
        };
        req.onsuccess=function(e){_db=e.target.result;res(_db);};
        req.onerror=function(){rej(req.error);};
      });
    }
    function put(store,obj){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readwrite');tx.objectStore(store).put(obj);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    function get(store,id){return open().then(function(db){return new Promise(function(r){var req=db.transaction(store,'readonly').objectStore(store).get(id);req.onsuccess=function(){r(req.result||null);};req.onerror=function(){r(null);};});}).catch(function(){return null;});}
    function getAll(store){return open().then(function(db){return new Promise(function(r){var req=db.transaction(store,'readonly').objectStore(store).getAll();req.onsuccess=function(){r(req.result||[]);};req.onerror=function(){r([]);};});}).catch(function(){return[];});}
    function del(store,id){return open().then(function(db){return new Promise(function(r){var tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=r;tx.onerror=r;});}).catch(function(){});}
    return { put:put, get:get, getAll:getAll, del:del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58D  AGENT MEMORY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentMemorySystem = (function () {
    var _shortTerm   = new Map(); // agentId → [{ role, text, ts }]
    var _workflowMem = new Map(); // agentId → { plan, results, ctx }
    var _execHistory = new Map(); // agentId → [{ stepId, result, ts }]
    var SHORT_MAX    = 50;
    var HISTORY_MAX  = 200;

    function addShortTerm(agentId, role, text) {
      if (!_shortTerm.has(agentId)) _shortTerm.set(agentId, []);
      var arr = _shortTerm.get(agentId);
      arr.push({ role:role, text:text, ts:now() });
      if (arr.length > SHORT_MAX) arr.splice(0, arr.length - SHORT_MAX);
    }

    function getShortTerm(agentId, n) {
      return (_shortTerm.get(agentId) || []).slice(-(n||10));
    }

    function setWorkflowMem(agentId, data) {
      _workflowMem.set(agentId, Object.assign(_workflowMem.get(agentId)||{}, data));
      AgentDb.put('memory', { id: 'wf:'+agentId, agentId: agentId, data: data, ts: now() });
    }

    function getWorkflowMem(agentId) { return _workflowMem.get(agentId) || {}; }

    function addHistory(agentId, stepId, result) {
      if (!_execHistory.has(agentId)) _execHistory.set(agentId, []);
      var arr = _execHistory.get(agentId);
      arr.push({ stepId:stepId, result:result, ts:now() });
      if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    }

    function getHistory(agentId, n) {
      return (_execHistory.get(agentId) || []).slice(-(n||20));
    }

    // Long-term vector recall
    async function recall(agentId, query) {
      var PVD = sys('PersistentVectorDatabase') || sys('VectorMemoryEngine');
      if (!PVD || !PVD.search) return [];
      try { return await PVD.search(query, { docId: 'agent:'+agentId, topK: 5 }); } catch(_) { return []; }
    }

    // Summarize + compress long memory
    async function summarize(agentId) {
      var history = getHistory(agentId, 20);
      if (!history.length) return '';
      var text = history.map(function(h){return h.stepId+': '+JSON.stringify(h.result).slice(0,100);}).join('\n');
      var GAE  = sys('GenerativeAiEngine');
      if (GAE && GAE.generate) {
        try { return await GAE.generate(text, { intent:'summarize', docContext:text }); } catch(_){}
      }
      return 'History: ' + history.length + ' steps completed.';
    }

    function clear(agentId) { _shortTerm.delete(agentId); _workflowMem.delete(agentId); _execHistory.delete(agentId); }

    return { addShortTerm:addShortTerm, getShortTerm:getShortTerm,
             setWorkflowMem:setWorkflowMem, getWorkflowMem:getWorkflowMem,
             addHistory:addHistory, getHistory:getHistory,
             recall:recall, summarize:summarize, clear:clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58B  DYNAMIC TOOL SELECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var DynamicToolSelector = (function () {
    var TOOL_RULES = [
      { tool:'ocr',          test: function(f,c){ return /\.(jpg|jpeg|png|tiff?|bmp|webp)$/i.test(f)||c.isScanned; } },
      { tool:'translate',    test: function(f,c){ return !!(c.targetLang && c.targetLang!=='en')||(c.detectedLang&&c.detectedLang!=='en'); } },
      { tool:'compress-pdf', test: function(f,c){ return /\.pdf$/i.test(f)&&(c.sizeBytes||0)>2*1024*1024; } },
      { tool:'merge-pdf',    test: function(f,c){ return Array.isArray(c.files)&&c.files.length>1&&!c.files.find(function(x){return !/\.pdf$/i.test(x);}); } },
      { tool:'split-pdf',    test: function(f,c){ return /\.pdf$/i.test(f)&&(c.pageCount||0)>10; } },
      { tool:'pdf-to-word',  test: function(f,c){ return /\.pdf$/i.test(f)&&c.wantEditable; } },
      { tool:'pdf-to-excel', test: function(f,c){ return /\.pdf$/i.test(f)&&c.hasTables; } },
      { tool:'watermark',    test: function(f,c){ return c.wantWatermark; } },
      { tool:'protect-pdf',  test: function(f,c){ return c.wantPassword; } },
      { tool:'ai-summarize', test: function(f,c){ return c.wantSummary||c.longDoc; } },
    ];

    var OCR_MODES = [
      { mode:'webgpu-ai',  test: function(c){ return !!(sys('WebGpuAiExpansion')&&sys('WebGpuAiExpansion').isReady()&&!c.mobile); } },
      { mode:'onnx-multi', test: function(c){ return !!(sys('OnnxRuntimeManager')); } },
      { mode:'browser',    test: function(c){ return true; } },
    ];

    function selectTools(filename, context) {
      context = context || {};
      var matches = [];
      TOOL_RULES.forEach(function(rule) {
        try { if (rule.test(filename||'', context)) matches.push(rule.tool); } catch(_){}
      });
      if (!matches.length) matches.push('ai-summarize');
      return matches;
    }

    function selectOcrMode(context) {
      context = context || {};
      for (var i = 0; i < OCR_MODES.length; i++) {
        try { if (OCR_MODES[i].test(context)) return OCR_MODES[i].mode; } catch(_){}
      }
      return 'browser';
    }

    function selectTranslationBackend(lang) {
      var UTP = sys('UniversalTranslationPipeline');
      if (UTP && UTP.getBackend) return UTP.getBackend(lang) || 'browser';
      return 'browser';
    }

    function selectAiModel(opts) {
      opts = opts || {};
      var tier = (function(){
        var EMF = sys('EnterpriseMemoryFabric');
        return EMF ? EMF.TierDetector.tier() : 'normal';
      })();
      if (tier === 'critical' || tier === 'danger') return 'heuristic';
      var RLR = sys('RealLlmRouting');
      if (RLR) return RLR.ProviderRouter.select(opts);
      return 'heuristic';
    }

    function selectExecutionMode(fileSizeMb, pageCount) {
      var mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      if (mobile)                                   return { mode:'mobile-safe', workers:1, gpu:false };
      if (fileSizeMb > 200 || pageCount > 500)      return { mode:'giant',       workers:2, gpu:false, stream:true };
      if (fileSizeMb > 50  || pageCount > 100)      return { mode:'large',       workers:2, gpu:true };
      return                                               { mode:'standard',     workers:4, gpu:true };
    }

    return { selectTools:selectTools, selectOcrMode:selectOcrMode,
             selectTranslationBackend:selectTranslationBackend,
             selectAiModel:selectAiModel, selectExecutionMode:selectExecutionMode };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58A  SELF-PLANNING ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var SelfPlanningEngine = (function () {
    var INTENT_MAP = [
      { intent:'batch-analyze', patterns:[/analyz|process|scan/i, /\d+|multiple|batch|all|every/i] },
      { intent:'extract-data',  patterns:[/extract|pull|get|find/i, /invoice|data|table|number|amount/i] },
      { intent:'translate',     patterns:[/translat/i] },
      { intent:'summarize',     patterns:[/summar|brief|abstract|overview/i] },
      { intent:'compare',       patterns:[/compar|diff|versus|vs\b/i] },
      { intent:'export',        patterns:[/export|download|zip|package/i] },
      { intent:'legal',         patterns:[/legal|clause|contract|compliance/i] },
      { intent:'convert',       patterns:[/convert|turn.+into|make.+into/i] },
      { intent:'ocr',           patterns:[/ocr|scan|read text|extract text/i] },
    ];

    function _detectIntents(text) {
      var q = text.toLowerCase();
      return INTENT_MAP.filter(function(im){
        return im.patterns.every(function(p){ return p.test(q); });
      }).map(function(im){ return im.intent; });
    }

    function _extractQuantity(text) {
      var m = text.match(/(\d[\d,]*)\s*(pdf|file|document|page)/i);
      if (m) return parseInt(m[1].replace(/,/g,''));
      if (/all|every|batch|multiple/i.test(text)) return 999;
      return 1;
    }

    function _extractLanguages(text) {
      var langs = { french:'fr', spanish:'es', german:'de', arabic:'ar', urdu:'ur', chinese:'zh',
                    japanese:'ja', korean:'ko', russian:'ru', portuguese:'pt', italian:'it',
                    hindi:'hi', turkish:'tr', dutch:'nl' };
      var found = [];
      Object.keys(langs).forEach(function(name){
        if (new RegExp('\\b'+name+'\\b','i').test(text)) found.push(langs[name]);
      });
      return found;
    }

    function _buildDependencyGraph(steps) {
      // Simple linear dependencies + parallel opportunities
      return steps.map(function(s, i) {
        return Object.assign({}, s, {
          deps:    i === 0 ? [] : [steps[i-1].id],
          parallel: false, // future: detect safe-parallel steps
        });
      });
    }

    function parse(naturalLanguage) {
      var intents  = _detectIntents(naturalLanguage);
      var quantity = _extractQuantity(naturalLanguage);
      var langs    = _extractLanguages(naturalLanguage);
      var text     = naturalLanguage.toLowerCase();

      var steps = [];
      var addStep = function(tool, label, meta) {
        steps.push({ id:uid(), tool:tool, label:label, status:'pending',
                     retries:0, meta:meta||{}, result:null, error:null,
                     estimate: _estimateStep(tool, quantity) });
      };

      // Always start with analysis for batch jobs
      if (quantity > 1) addStep('analyze', 'Analyze ' + quantity + ' documents', { quantity:quantity });

      // OCR
      if (intents.includes('ocr') || /scanned|image pdf/i.test(text)) addStep('ocr', 'OCR Text Extraction', {});

      // Translate
      if (intents.includes('translate') || langs.length) {
        langs.forEach(function(l){ addStep('translate', 'Translate ('+l+')', { lang:l }); });
        if (!langs.length) addStep('translate', 'Translate', {});
      }

      // Extract
      if (intents.includes('extract-data')) addStep('extract', 'Extract Data', { type: /invoice/i.test(text)?'invoice':'general' });

      // Summarize
      if (intents.includes('summarize') || /summar/i.test(text)) addStep('summarize', 'AI Summarize', {});

      // Legal
      if (intents.includes('legal')) addStep('legal-analysis', 'Legal Analysis', {});

      // Compare
      if (intents.includes('compare')) addStep('compare', 'Document Comparison', {});

      // Convert
      if (intents.includes('convert')) {
        var target = /word|docx/i.test(text) ? 'pdf-to-word' : /excel|xlsx/i.test(text) ? 'pdf-to-excel' : 'convert';
        addStep(target, 'Convert', {});
      }

      // Export
      if (intents.includes('export') || /zip|package|download all/i.test(text)) addStep('export-zip', 'Export ZIP', {});

      if (!steps.length) addStep('analyze', 'Analyze Document', {});

      var deps = _buildDependencyGraph(steps);

      var agentId = uid();
      return {
        id:          agentId,
        query:       naturalLanguage,
        intents:     intents,
        steps:       deps,
        quantity:    quantity,
        langs:       langs,
        status:      'planned',
        createdAt:   now(),
        updatedAt:   now(),
        recoverable: true,
      };
    }

    function _estimateStep(tool, n) {
      var base = { analyze:2000, ocr:8000, translate:5000, extract:3000, summarize:4000,
                   'legal-analysis':4000, compare:5000, 'pdf-to-word':3000, 'pdf-to-excel':3000,
                   'export-zip':2000 };
      return (base[tool]||3000) * Math.max(1, Math.ceil(Math.log2(n||1)));
    }

    function addSubtask(plan, parentStepId, subSteps) {
      var parent = plan.steps.find(function(s){return s.id===parentStepId;});
      if (!parent) return;
      parent.subtasks = (parent.subtasks||[]).concat(subSteps.map(function(s){
        return Object.assign({ id:uid(), status:'pending', retries:0, result:null, error:null }, s);
      }));
    }

    return { parse:parse, addSubtask:addSubtask };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58C  LONG-RUNNING AGENT RUNTIME
  // ═══════════════════════════════════════════════════════════════════════════
  var LongRunningAgentRuntime = (function () {
    var _agents  = new Map(); // agentId → plan
    var _running = new Map(); // agentId → AbortController

    // ── Step executors ──────────────────────────────────────────────────────
    var _executors = {
      analyze: async function(step, ctx) {
        var LAF = sys('LabaAiFoundation');
        if (LAF && LAF.UnifiedDocumentContext && ctx.docId) {
          var doc = LAF.UnifiedDocumentContext.get(ctx.docId);
          if (doc) return { pageCount: doc.pages||0, textLen: (doc.ocrText||'').length, tables: (doc.tables||[]).length };
        }
        return { analyzed: true };
      },
      ocr: async function(step, ctx) {
        return { message: 'Use PDF OCR tool for full OCR processing. OCR engine ready.' };
      },
      translate: async function(step, ctx) {
        var UTP = sys('UniversalTranslationPipeline');
        if (UTP && UTP.translate && ctx.text && step.meta.lang) {
          try { var r=await UTP.translate(ctx.text,step.meta.lang); return { translated:r, lang:step.meta.lang }; }
          catch(e){ return { message:'Translation failed: '+e.message }; }
        }
        return { message:'Use Translate tool for full document translation. Target: '+(step.meta.lang||'auto') };
      },
      extract: async function(step, ctx) {
        var text = ctx.text||ctx.docText||'';
        var type = step.meta.type||'general';
        if (type==='invoice') {
          var amounts = text.match(/\$[\d,]+\.?\d*|\b\d+\.\d{2}\b/g)||[];
          var dates   = text.match(/\d{4}[-\/]\d{2}[-\/]\d{2}/g)||[];
          return { amounts:[...new Set(amounts)].slice(0,20), dates:[...new Set(dates)].slice(0,10) };
        }
        var kv = text.match(/([A-Z][a-z]+\w*):\s*([^\n]{1,80})/g)||[];
        return { fields: kv.slice(0,20) };
      },
      summarize: async function(step, ctx) {
        var RLR = sys('RealLlmRouting');
        if (RLR && ctx.text) {
          try {
            var r = await RLR.route(ctx.text.slice(0,2000), { task:'summarize', docContext:ctx.text });
            return { summary: r.text };
          } catch(e){}
        }
        var GAE = sys('GenerativeAiEngine');
        if (GAE && ctx.text) {
          try { return { summary: await GAE.generate(ctx.text, { intent:'summarize', docContext:ctx.text }) }; } catch(_){}
        }
        return { summary: 'Summarization queued. Use AI Summarizer tool.' };
      },
      'legal-analysis': async function(step, ctx) {
        var RLR = sys('RealLlmRouting');
        if (RLR && ctx.text) {
          try { var r=await RLR.route('Perform legal analysis', { task:'legal-analysis', docContext:ctx.text }); return { analysis:r.text }; } catch(_){}
        }
        return { message:'Use AI Summarizer for legal analysis.' };
      },
      compare: async function(step, ctx) {
        return { message:'Comparison requires two documents. Use Compare PDF tool.' };
      },
      'pdf-to-word': async function(step, ctx) {
        return { message:'Use PDF to Word tool for conversion.' };
      },
      'pdf-to-excel': async function(step, ctx) {
        return { message:'Use PDF to Excel tool for conversion.' };
      },
      'export-zip': async function(step, ctx) {
        return { exported:true, message:'Results ready. Use download button on tool page.' };
      },
    };

    async function _executeStep(step, ctx, onProgress, signal) {
      step.status   = 'running';
      step.startedAt = now();
      onProgress && onProgress({ type:'step-start', step:step });

      var timeoutP = new Promise(function(_,rej){ setTimeout(function(){rej(new Error('step-timeout'));}, STEP_TIMEOUT_MS); });

      try {
        // Try distributed first
        var DAO = sys('DistributedAiOrchestrator');
        var AAS1 = sys('AiAgentSystem'); // Phase 49 agent
        var executor = _executors[step.tool];
        var distResult = null;
        if (DAO && DAO.submit) {
          try { distResult = await Promise.race([DAO.submit(step.tool, ctx, {priority:2}), sleep(3000).then(function(){return null;})]); } catch(_){}
        }
        var result = distResult || await Promise.race([
          executor ? executor(step, ctx) : Promise.resolve({ message:'Step queued: '+step.label }),
          timeoutP,
        ]);

        step.result    = result;
        step.status    = 'done';
        step.completedAt = now();
        AgentMemorySystem.addHistory(ctx.agentId, step.id, result);
        onProgress && onProgress({ type:'step-done', step:step, result:result });

        // Pass output to next steps
        if (result) Object.assign(ctx, result);

        // Checkpoint
        await _checkpoint(ctx.agentId, step.id, ctx);
        return result;

      } catch(e) {
        if (step.retries < MAX_RETRIES && e.message !== 'cancelled') {
          step.retries++;
          step.status = 'retrying';
          warn('step', step.id, 'retry', step.retries, ':', e.message);
          await sleep(1000 * step.retries);
          return _executeStep(step, ctx, onProgress, signal);
        }
        step.status = 'failed'; step.error = e.message;
        onProgress && onProgress({ type:'step-error', step:step, error:e.message });
        return null;
      }
    }

    async function _checkpoint(agentId, stepId, ctx) {
      await AgentDb.put('checkpoints', { id: agentId, stepId: stepId, ctx: ctx, ts: now() });
    }

    async function run(plan, context, onProgress) {
      context = context || {};
      onProgress = onProgress || function(){};

      plan.status = 'running';
      plan.agentId = plan.id;
      context.agentId = plan.id;

      _agents.set(plan.id, plan);
      AgentDb.put('agents', plan);
      AgentMemorySystem.setWorkflowMem(plan.id, { plan:plan, startedAt:now() });

      // Check for existing checkpoint (resume)
      var checkpoint = await AgentDb.get('checkpoints', plan.id);
      var startStep  = 0;
      if (checkpoint) {
        log('resuming from checkpoint, step:', checkpoint.stepId);
        Object.assign(context, checkpoint.ctx);
        var cpIdx = plan.steps.findIndex(function(s){return s.id===checkpoint.stepId;});
        if (cpIdx >= 0) {
          for (var i = 0; i <= cpIdx; i++) plan.steps[i].status = 'done';
          startStep = cpIdx + 1;
        }
        onProgress({ type:'resumed', plan:plan, fromStep:startStep });
      }

      // Tool selection
      var toolOpts = DynamicToolSelector.selectTools(context.filename||'', context);
      var exMode   = DynamicToolSelector.selectExecutionMode((context.sizeBytes||0)/1048576, context.pageCount||0);
      context.executionMode = exMode;
      AgentMemorySystem.addShortTerm(plan.id, 'system', 'Execution mode: '+exMode.mode);

      onProgress({ type:'plan', plan:plan });

      // Execute steps
      for (var i = startStep; i < plan.steps.length; i++) {
        var step = plan.steps[i];
        if (step.status === 'done') continue;

        await _executeStep(step, context, onProgress, null);
        await sleep(50); // yield between steps
      }

      plan.status = plan.steps.every(function(s){return s.status==='done';}) ? 'complete' : 'partial';
      plan.updatedAt = now();
      AgentDb.put('agents', plan);
      _agents.delete(plan.id);

      // Index into vector DB
      var PVD = sys('PersistentVectorDatabase');
      if (PVD && context.text) PVD.index(plan.id, context.text, context.lang);

      // Clean checkpoint on success
      if (plan.status === 'complete') AgentDb.del('checkpoints', plan.id);

      onProgress({ type:'complete', plan:plan });
      return plan;
    }

    async function restore() {
      var rows = await AgentDb.getAll('agents');
      var checkpoints = await AgentDb.getAll('checkpoints');
      log('restored:', rows.length, 'agent records,', checkpoints.length, 'checkpoints');
      return { agents: rows, checkpoints: checkpoints };
    }

    function getActive() { return Array.from(_agents.values()); }

    return { run:run, restore:restore, getActive:getActive };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58E  AGENT COORDINATION LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentCoordinationLayer = (function () {
    var _agents = new Map(); // agentId → { plan, status, result }

    function spawn(naturalLanguage, context, onProgress) {
      var plan    = SelfPlanningEngine.parse(naturalLanguage);
      var promise = LongRunningAgentRuntime.run(plan, context||{}, onProgress);
      _agents.set(plan.id, { plan:plan, promise:promise });
      return { agentId: plan.id, plan: plan, promise: promise };
    }

    async function mergeResults(agentIds) {
      var results = await Promise.allSettled(
        agentIds.map(function(id){ var a=_agents.get(id); return a ? a.promise : Promise.resolve(null); })
      );
      var merged = { texts:[], summaries:[], errors:[] };
      results.forEach(function(r){
        if (r.status==='fulfilled'&&r.value) {
          var plan = r.value;
          plan.steps.forEach(function(s){
            if (s.status==='done'&&s.result) {
              if (s.result.summary)    merged.summaries.push(s.result.summary);
              if (s.result.translated) merged.texts.push(s.result.translated);
              if (s.result.text)       merged.texts.push(s.result.text);
            }
          });
        } else if (r.status==='rejected') {
          merged.errors.push(r.reason ? r.reason.message : 'unknown error');
        }
      });
      return merged;
    }

    async function delegate(agentId, subtask, targetAgentId) {
      var source = _agents.get(agentId);
      if (!source) return null;
      log('delegating subtask from', agentId, 'to', targetAgentId||'new agent');
      var target = spawn(subtask, AgentMemorySystem.getWorkflowMem(agentId));
      return target;
    }

    function resolveConflict(results) {
      // Vote by recurrence count
      var counts = {};
      (results||[]).forEach(function(r){
        var key = JSON.stringify(r).slice(0,100);
        counts[key] = (counts[key]||0)+1;
      });
      var winner = Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];})[0];
      return winner ? results[Object.keys(counts).indexOf(winner)] : (results&&results[0]);
    }

    function activeCount() { return _agents.size; }
    function list()        { return Array.from(_agents.values()).map(function(a){return a.plan;}); }

    return { spawn:spawn, mergeResults:mergeResults, delegate:delegate,
             resolveConflict:resolveConflict, activeCount:activeCount, list:list };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 58F  AI WORKER SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════
  var AiWorkerScheduler = (function () {
    var _queue    = []; // { id, fn, priority, ts, status }
    var _running  = 0;
    var _maxConcurrent = 2;
    var _paused   = false;
    var _idle     = false;
    var _thermalWarnings = 0;

    function enqueue(fn, opts) {
      opts = opts || {};
      var job = { id:uid(), fn:fn, priority:opts.priority||5, ts:now(), status:'queued',
                  background:opts.background||false, idleOnly:opts.idleOnly||false };
      _queue.push(job);
      _queue.sort(function(a,b){return a.priority-b.priority;});
      if (!_paused) _drain();
      return job.id;
    }

    async function _drain() {
      if (_paused || _running >= _maxConcurrent || !_queue.length) return;
      // Respect idle-only jobs
      var job = null;
      for (var i = 0; i < _queue.length; i++) {
        if (!_queue[i].idleOnly || _idle) { job = _queue.splice(i,1)[0]; break; }
      }
      if (!job) return;

      _running++;
      job.status = 'running';
      try {
        job.result = await job.fn();
        job.status = 'done';
      } catch(e) {
        job.status = 'failed'; job.error = e.message;
        warn('scheduler job failed:', job.id, e.message);
      }
      _running--;
      _drain();
    }

    function pause()  { _paused = true;  log('scheduler paused'); }
    function resume() { _paused = false; _drain(); log('scheduler resumed'); }

    function _updateConcurrency() {
      var EMF  = sys('EnterpriseMemoryFabric');
      var tier = EMF ? EMF.TierDetector.tier() : 'normal';
      _maxConcurrent = tier==='critical'?1 : tier==='danger'?1 : tier==='warning'?1 : 2;

      // Battery awareness
      if (navigator.getBattery) {
        navigator.getBattery().then(function(b){
          if (b.charging===false && b.level<0.2) { pause(); log('low battery, scheduler paused'); }
          else if (_paused && b.level>0.3)        { resume(); }
        }).catch(function(){});
      }

      // Thermal (heuristic: sustained high usage)
      if (window.performance && window.performance.now) {
        // No direct thermal API; use memory pressure as proxy
        if (tier==='danger'||tier==='critical') _thermalWarnings++;
        else _thermalWarnings = Math.max(0, _thermalWarnings-1);
        if (_thermalWarnings > 5) { _maxConcurrent = 1; }
      }
    }

    // Idle detection
    var _idleTimer = null;
    function _onActivity() {
      _idle = false;
      clearTimeout(_idleTimer);
      _idleTimer = setTimeout(function(){ _idle=true; _drain(); }, 10000);
    }
    ['click','keydown','touchstart','mousemove'].forEach(function(e){
      document.addEventListener(e, _onActivity, { passive:true });
    });
    _onActivity();

    setInterval(_updateConcurrency, 8000);

    function stats() {
      return { queued:_queue.length, running:_running, maxConcurrent:_maxConcurrent,
               paused:_paused, idle:_idle, thermalWarnings:_thermalWarnings };
    }

    return { enqueue:enqueue, pause:pause, resume:resume, stats:stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // RESTORE persisted agents on boot
  // ═══════════════════════════════════════════════════════════════════════════
  LongRunningAgentRuntime.restore().catch(function(){});

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.AutonomousAgentSystem = {
    version: VERSION,

    // Run an agent from natural language goal
    run: function(goal, context, onProgress) {
      return AgentCoordinationLayer.spawn(goal, context, onProgress);
    },

    // Queue as background job
    schedule: function(goal, context, opts) {
      return AiWorkerScheduler.enqueue(function(){ return AgentCoordinationLayer.spawn(goal, context).promise; }, opts);
    },

    // Plan without executing
    plan: function(goal) { return SelfPlanningEngine.parse(goal); },

    // Merge results from multiple agents
    merge: function(agentIds) { return AgentCoordinationLayer.mergeResults(agentIds); },

    // Active agents
    active:     function() { return LongRunningAgentRuntime.getActive(); },
    list:       function() { return AgentCoordinationLayer.list(); },
    count:      function() { return AgentCoordinationLayer.activeCount(); },

    // Tool selection
    selectTools: function(filename, ctx) { return DynamicToolSelector.selectTools(filename, ctx); },
    selectMode:  function(sizeMb, pages) { return DynamicToolSelector.selectExecutionMode(sizeMb, pages); },

    // Memory
    memory: {
      get:       function(id) { return AgentMemorySystem.getWorkflowMem(id); },
      recall:    function(id, q) { return AgentMemorySystem.recall(id, q); },
      summarize: function(id) { return AgentMemorySystem.summarize(id); },
      clear:     function(id) { AgentMemorySystem.clear(id); },
    },

    // Scheduler
    scheduler: AiWorkerScheduler,

    audit: function() {
      return {
        version:    VERSION,
        active:     LongRunningAgentRuntime.getActive().length,
        coordinated: AgentCoordinationLayer.activeCount(),
        scheduler:  AiWorkerScheduler.stats(),
      };
    },
    cleanup: function() { AiWorkerScheduler.pause(); log('AutonomousAgentSystem cleaned up'); },

    // Sub-systems
    Planner:     SelfPlanningEngine,
    ToolSelector: DynamicToolSelector,
    Runtime:     LongRunningAgentRuntime,
    Memory:      AgentMemorySystem,
    Coordinator: AgentCoordinationLayer,
    Scheduler:   AiWorkerScheduler,
  };

  log('AutonomousAgentSystem v' + VERSION + ' ready');
}());
