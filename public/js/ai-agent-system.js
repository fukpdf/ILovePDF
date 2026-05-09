/**
 * PHASE 49 — AI AGENT WORKFLOW SYSTEM
 * window.AiAgentSystem
 *
 * Autonomous document workflow agents.
 * Multi-step planning, adaptive execution, checkpoint recovery.
 * Purely additive. Integrates with WorkflowChainEngine, DistributedAiOrchestrator,
 * VectorMemoryEngine, LabaAiFoundation. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION   = '1.0';
  var LOG       = '[AAS]';
  var DB_NAME   = 'aas_workflows_v1';
  var MAX_RETRIES = 3;
  var STEP_TIMEOUT = 90000;

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'aas_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  IDB AGENT STORE
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentStore = (function () {
    var _db = null;
    function open() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function (res, rej) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          ['workflows','steps','logs'].forEach(function (s) {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
          });
        };
        req.onsuccess = function (e) { _db = e.target.result; res(_db); };
        req.onerror   = function ()  { rej(req.error); };
      });
    }
    function put(store, obj) {
      return open().then(function (db) {
        return new Promise(function (r) { var tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(obj); tx.oncomplete=r; tx.onerror=r; });
      }).catch(function(){});
    }
    function getAll(store) {
      return open().then(function (db) {
        return new Promise(function (r) { var req = db.transaction(store,'readonly').objectStore(store).getAll(); req.onsuccess=function(){r(req.result||[]);}; req.onerror=function(){r([]); }; });
      }).catch(function(){return [];});
    }
    function del(store, id) {
      return open().then(function (db) {
        return new Promise(function (r) { var tx = db.transaction(store,'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete=r; tx.onerror=r; });
      }).catch(function(){});
    }
    return { put: put, getAll: getAll, del: del };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  WORKFLOW PLANNER AGENT
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowPlannerAgent = (function () {
    var _toolKeywords = {
      'merge':       ['merge', 'combine', 'join'],
      'split':       ['split', 'divide', 'separate'],
      'compress':    ['compress', 'shrink', 'reduce'],
      'ocr':         ['ocr', 'text', 'scan', 'read'],
      'translate':   ['translat', 'language', 'french', 'spanish', 'german', 'arabic', 'urdu', 'chinese'],
      'summarize':   ['summar', 'brief', 'abstract'],
      'extract':     ['extract', 'pull', 'get', 'invoice', 'table', 'data'],
      'compare':     ['compar', 'diff', 'difference'],
      'protect':     ['protect', 'password', 'encrypt', 'secure'],
      'watermark':   ['watermark', 'stamp', 'brand'],
      'convert-pdf-word': ['word', 'docx', 'pdf to word'],
      'convert-pdf-excel':['excel', 'xlsx', 'spreadsheet'],
      'jpg-to-pdf':  ['image', 'jpg', 'jpeg', 'png', 'img to pdf'],
      'export-zip':  ['zip', 'export', 'download all'],
    };

    function parse(naturalLanguage) {
      var text  = naturalLanguage.toLowerCase();
      var steps = [];

      // Detect quantity hints
      var quantMatch = text.match(/(\d+)\s*(pdf|file|document)/i);
      var quantity   = quantMatch ? parseInt(quantMatch[1]) : 1;

      // Score each tool
      var scores = {};
      for (var tool in _toolKeywords) {
        var kws = _toolKeywords[tool];
        var score = 0;
        kws.forEach(function (kw) { if (text.includes(kw)) score++; });
        if (score) scores[tool] = score;
      }

      // Sort by order of appearance / score
      var tools = Object.keys(scores).sort(function (a,b) { return (scores[b] - scores[a]); });

      // Build step list
      tools.forEach(function (tool, i) {
        steps.push({
          id:       uid(),
          index:    i,
          tool:     tool,
          label:    tool.replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}),
          status:   'pending',
          retries:  0,
          estimate: _estimateMs(tool, quantity),
          result:   null,
          error:    null,
        });
      });

      if (!steps.length) {
        steps.push({ id: uid(), index: 0, tool: 'analyze', label: 'Analyze Documents', status: 'pending', retries: 0, estimate: 2000, result: null, error: null });
      }

      return {
        id:       uid(),
        query:    naturalLanguage,
        steps:    steps,
        quantity: quantity,
        status:   'planned',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    function _estimateMs(tool, n) {
      var base = { merge:3000, split:2000, compress:5000, ocr:8000, translate:6000, summarize:4000, extract:3000, compare:5000 };
      return (base[tool] || 3000) * Math.max(1, Math.log2(n || 1));
    }

    return { parse: parse };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  INDIVIDUAL AGENTS
  // ═══════════════════════════════════════════════════════════════════════════

  var DocumentAnalysisAgent = (function () {
    async function run(step, ctx) {
      var LAF = sys('LabaAiFoundation');
      if (LAF && LAF.UnifiedDocumentContext && ctx.docId) {
        var docCtx = LAF.UnifiedDocumentContext.get(ctx.docId);
        if (docCtx) return { analysis: { textLength: docCtx.ocrText.length, tables: docCtx.tables.length, hasTranslation: !!docCtx.translated }, docCtx: docCtx };
      }
      return { analysis: { textLength: 0, tables: 0, hasTranslation: false } };
    }
    return { run: run };
  })();

  var OCRDecisionAgent = (function () {
    async function run(step, ctx) {
      var text = ctx.docCtx ? (ctx.docCtx.ocrText || '') : '';
      var needsOcr = !text || text.trim().length < 50;
      if (needsOcr && sys('AdvancedEngine')) {
        log('OCR triggered for step', step.id);
        return { needsOcr: true, message: 'OCR queued — use OCR PDF tool for full processing.' };
      }
      return { needsOcr: false, existingText: text.slice(0, 200) };
    }
    return { run: run };
  })();

  var TranslationAgent = (function () {
    async function run(step, ctx) {
      var TP = sys('UniversalTranslationPipeline');
      if (TP && TP.translate && ctx.text) {
        try {
          var result = await TP.translate(ctx.text, ctx.targetLang || 'en');
          return { translated: result, lang: ctx.targetLang };
        } catch (e) { return { error: e.message, message: 'Translation via pipeline failed. Use the Translate tool.' }; }
      }
      return { message: 'Use the AI Translate tool for full document translation.' };
    }
    return { run: run };
  })();

  var SummarizationAgent = (function () {
    async function run(step, ctx) {
      var GAE = sys('GenerativeAiEngine');
      if (GAE && ctx.text) {
        try {
          var result = await GAE.generate(ctx.text, { intent: 'summarize', docContext: ctx.text });
          return { summary: result };
        } catch (e) {}
      }
      var LAF = sys('LabaAiFoundation');
      if (LAF && LAF.AiReasoningRouter && ctx.docId) {
        try { return { summary: await LAF.AiReasoningRouter.summarize(ctx.docId) }; } catch (_) {}
      }
      return { summary: 'Summary unavailable. Use the AI Summarizer tool for full summarization.' };
    }
    return { run: run };
  })();

  var ExportAgent = (function () {
    async function run(step, ctx) {
      log('ExportAgent: preparing output', ctx.format || 'default');
      return { exported: true, format: ctx.format || 'auto', message: 'Download via the tool download button.' };
    }
    return { run: run };
  })();

  var RetryRecoveryAgent = (function () {
    function shouldRetry(step)  { return step.retries < MAX_RETRIES; }
    function recordRetry(step)  { step.retries++; step.status = 'retrying'; }
    function abandon(step, msg) { step.status = 'failed'; step.error = msg; }
    return { shouldRetry: shouldRetry, recordRetry: recordRetry, abandon: abandon };
  })();

  var DistributedTaskAgent = (function () {
    async function run(step, ctx) {
      var DAO = sys('DistributedAiOrchestrator');
      if (DAO && DAO.submit) {
        try { return await DAO.submit(step.tool, ctx, { priority: 3 }); }
        catch (e) { warn('DAO failed for step', step.id, e.message); }
      }
      return null;
    }
    return { run: run };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  TASK EXECUTION AGENT
  // ═══════════════════════════════════════════════════════════════════════════
  var TaskExecutionAgent = (function () {
    var _agentMap = {
      analyze:            DocumentAnalysisAgent,
      ocr:                OCRDecisionAgent,
      translate:          TranslationAgent,
      summarize:          SummarizationAgent,
      'export-zip':       ExportAgent,
    };

    async function execute(step, ctx, onProgress) {
      step.status = 'running';
      onProgress && onProgress({ step: step, phase: 'start' });

      var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('step-timeout')); }, STEP_TIMEOUT); });

      try {
        var agent   = _agentMap[step.tool];
        var distResult = await DistributedTaskAgent.run(step, ctx);

        var result = await Promise.race([
          (agent ? agent.run(step, ctx) : Promise.resolve({ message: 'Tool step queued: ' + step.label })),
          timeout,
        ]);

        step.result = distResult || result;
        step.status = 'done';
        onProgress && onProgress({ step: step, phase: 'done', result: step.result });
        return step.result;

      } catch (e) {
        if (RetryRecoveryAgent.shouldRetry(step)) {
          warn('step', step.id, 'failed, retrying:', e.message);
          RetryRecoveryAgent.recordRetry(step);
          await new Promise(function (r) { setTimeout(r, 1000 * step.retries); });
          return execute(step, ctx, onProgress);
        }
        RetryRecoveryAgent.abandon(step, e.message);
        onProgress && onProgress({ step: step, phase: 'error', error: e.message });
        return null;
      }
    }

    return { execute: execute };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  WORKFLOW VISUALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  var WorkflowVisualization = (function () {
    function render(workflow) {
      if (!workflow || !workflow.steps) return '';
      var lines = ['Workflow: ' + workflow.query.slice(0, 60)];
      workflow.steps.forEach(function (s, i) {
        var icon = s.status === 'done' ? '✓' : s.status === 'running' ? '▶' : s.status === 'failed' ? '✗' : '○';
        lines.push('  ' + icon + ' Step ' + (i+1) + ': ' + s.label + (s.status === 'failed' ? ' [' + (s.error || 'error') + ']' : ''));
      });
      lines.push('Status: ' + workflow.status);
      return lines.join('\n');
    }

    function renderHtml(workflow) {
      if (!workflow || !workflow.steps) return '';
      var html = '<div class="aas-workflow">';
      html += '<div class="aas-wf-title">' + workflow.query.slice(0,80) + '</div>';
      html += '<div class="aas-wf-steps">';
      workflow.steps.forEach(function (s) {
        var cls  = 'aas-step aas-step-' + s.status;
        var icon = { pending:'○', running:'▶', done:'✓', failed:'✗', retrying:'↺' }[s.status] || '○';
        html += '<div class="' + cls + '"><span class="aas-step-icon">' + icon + '</span><span class="aas-step-label">' + s.label + '</span></div>';
      });
      html += '</div></div>';
      return html;
    }

    return { render: render, renderHtml: renderHtml };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  AGENT LOG
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentLog = (function () {
    var _entries = [];
    function add(workflowId, msg, data) {
      var entry = { id: uid(), workflowId: workflowId, msg: msg, data: data || null, ts: Date.now() };
      _entries.push(entry);
      if (_entries.length > 500) _entries.splice(0, 100);
      AgentStore.put('logs', entry);
    }
    function getForWorkflow(wfId) { return _entries.filter(function (e) { return e.workflowId === wfId; }); }
    function getRecent(n) { return _entries.slice(-n || -50); }
    return { add: add, getForWorkflow: getForWorkflow, getRecent: getRecent };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  MAIN RUNNER
  // ═══════════════════════════════════════════════════════════════════════════
  var _activeWorkflows = new Map();

  async function runWorkflow(naturalLanguage, context, onProgress) {
    context    = context || {};
    onProgress = onProgress || function () {};

    // Plan
    var workflow = WorkflowPlannerAgent.parse(naturalLanguage);
    _activeWorkflows.set(workflow.id, workflow);
    workflow.status = 'running';
    AgentStore.put('workflows', workflow);
    AgentLog.add(workflow.id, 'workflow started', { query: naturalLanguage });
    onProgress({ type: 'plan', workflow: workflow });

    // Checkpointing via WorkflowChainEngine if available
    var WCE = sys('WorkflowChainEngine');
    if (WCE && WCE.checkpoint) WCE.checkpoint(workflow.id, { workflow: workflow });

    // Execute steps sequentially (with WCE parallel option in future)
    var ctx = Object.assign({}, context);
    for (var i = 0; i < workflow.steps.length; i++) {
      var step = workflow.steps[i];
      AgentLog.add(workflow.id, 'step start', { step: step.id, tool: step.tool });
      onProgress({ type: 'step-start', step: step, workflow: workflow });

      var result = await TaskExecutionAgent.execute(step, ctx, function (evt) {
        onProgress(Object.assign({ type: 'step-progress' }, evt, { workflow: workflow }));
      });

      // Pass output as input to next step
      if (result) Object.assign(ctx, result);
      AgentLog.add(workflow.id, 'step complete', { step: step.id, status: step.status });

      // Checkpoint after each step
      if (WCE && WCE.checkpoint) WCE.checkpoint(workflow.id, { stepIndex: i, ctx: ctx });
    }

    workflow.status = workflow.steps.every(function (s) { return s.status === 'done'; }) ? 'complete' : 'partial';
    workflow.updatedAt = Date.now();
    AgentStore.put('workflows', workflow);
    _activeWorkflows.delete(workflow.id);

    // Index results into VectorMemoryEngine
    var VME = sys('VectorMemoryEngine');
    if (VME && ctx.text) VME.index(workflow.id, ctx.text);

    onProgress({ type: 'workflow-complete', workflow: workflow });
    return workflow;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.AiAgentSystem = {
    version: VERSION,

    // Run an autonomous workflow from natural language
    run: runWorkflow,

    // Parse a workflow plan without executing
    plan: function (query) { return WorkflowPlannerAgent.parse(query); },

    // Render workflow as text
    renderWorkflow: function (workflow) { return WorkflowVisualization.render(workflow); },
    renderWorkflowHtml: function (workflow) { return WorkflowVisualization.renderHtml(workflow); },

    // Active workflows
    active: function () { return Array.from(_activeWorkflows.values()); },

    // Log access
    getLogs: function (wfId) { return wfId ? AgentLog.getForWorkflow(wfId) : AgentLog.getRecent(50); },

    // Restore persisted workflows
    restore: async function () {
      var rows = await AgentStore.getAll('workflows');
      log('restored', rows.length, 'workflow records');
      return rows;
    },

    // Audit
    audit: function () {
      return { version: VERSION, activeWorkflows: _activeWorkflows.size };
    },
    cleanup: function () { _activeWorkflows.clear(); },

    // Sub-agents exposed
    Planner:        WorkflowPlannerAgent,
    Executor:       TaskExecutionAgent,
    DocAnalysis:    DocumentAnalysisAgent,
    OcrDecision:    OCRDecisionAgent,
    Translation:    TranslationAgent,
    Summarization:  SummarizationAgent,
    Export:         ExportAgent,
    Retry:          RetryRecoveryAgent,
    Distributed:    DistributedTaskAgent,
    Visualization:  WorkflowVisualization,
    Log:            AgentLog,
  };

  log('AiAgentSystem v' + VERSION + ' ready');
}());
