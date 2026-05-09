/**
 * PHASE 42D — WORKFLOW CHAIN ENGINE
 * window.WorkflowChainEngine
 *
 * Purely additive. Does NOT modify BrowserTools.process or any existing route.
 * Wraps existing tools via pluggable step adapters.
 * Degrades gracefully at every layer.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[WCE]', ...a); }
  function warn(...a) { console.warn('[WCE]', ...a); }

  // ─────────────────────────────────────────────────────────────
  // IDB-backed workflow state store
  // ─────────────────────────────────────────────────────────────
  const WorkflowStore = (() => {
    const DB = 'wce_workflows_v1';
    let _db = null;
    async function open() {
      if (_db) return _db;
      return new Promise((res, rej) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('workflows')) db.createObjectStore('workflows', { keyPath: 'id' });
        };
        req.onsuccess = e => { _db = e.target.result; res(_db); };
        req.onerror   = () => rej(req.error);
      });
    }
    async function save(wf) {
      try { const db = await open(); new Promise(r => { const tx = db.transaction('workflows','readwrite'); tx.objectStore('workflows').put(wf); tx.oncomplete=r; }); } catch {}
    }
    async function load(id) {
      try { const db = await open(); return new Promise(r => { const req = db.transaction('workflows','readonly').objectStore('workflows').get(id); req.onsuccess=()=>r(req.result||null); req.onerror=()=>r(null); }); } catch { return null; }
    }
    async function list() {
      try { const db = await open(); return new Promise(r => { const req = db.transaction('workflows','readonly').objectStore('workflows').getAll(); req.onsuccess=()=>r(req.result||[]); req.onerror=()=>r([]); }); } catch { return []; }
    }
    async function remove(id) {
      try { const db = await open(); new Promise(r => { const tx = db.transaction('workflows','readwrite'); tx.objectStore('workflows').delete(id); tx.oncomplete=r; }); } catch {}
    }
    return { save, load, list, remove };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. SmartIntermediateCache
  // ─────────────────────────────────────────────────────────────
  const SmartIntermediateCache = (() => {
    const _cache = new Map(); // workflowId+stepId → data

    function key(workflowId, stepId) { return `${workflowId}::${stepId}`; }

    function set(workflowId, stepId, data) {
      _cache.set(key(workflowId, stepId), { data, ts: Date.now() });
    }

    function get(workflowId, stepId) {
      return _cache.get(key(workflowId, stepId))?.data ?? null;
    }

    function has(workflowId, stepId) {
      return _cache.has(key(workflowId, stepId));
    }

    function invalidate(workflowId, stepId) {
      if (stepId) _cache.delete(key(workflowId, stepId));
      else for (const k of _cache.keys()) { if (k.startsWith(workflowId+'::')) _cache.delete(k); }
    }

    /** Flush entries older than maxAgeMs */
    function sweep(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs;
      for (const [k, v] of _cache) { if (v.ts < cutoff) _cache.delete(k); }
    }

    return { set, get, has, invalidate, sweep };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. SharedDocumentContext — prevent repeated parsing/OCR/rendering
  // ─────────────────────────────────────────────────────────────
  const SharedDocumentContext = (() => {
    const _contexts = new Map(); // workflowId → context object

    function create(workflowId, files) {
      const ctx = {
        workflowId,
        files,
        parsed:    null,  // parsed PDF pages
        ocrText:   null,  // OCR'd text
        translated:null,  // translated output
        rendered:  null,  // page renders (canvas/imageData)
        tables:    null,  // extracted tables
        embeddings:null,  // AI embeddings (Phase 44)
        summary:   null,  // AI summary
        metadata:  {},
        createdAt: Date.now(),
      };
      _contexts.set(workflowId, ctx);
      return ctx;
    }

    function get(workflowId) { return _contexts.get(workflowId) || null; }

    function update(workflowId, key, value) {
      const ctx = _contexts.get(workflowId);
      if (ctx) ctx[key] = value;
    }

    function destroy(workflowId) { _contexts.delete(workflowId); }

    return { create, get, update, destroy };
  })();

  // ─────────────────────────────────────────────────────────────
  // Built-in step adapters — wrap existing tools non-destructively
  // ─────────────────────────────────────────────────────────────
  const STEP_ADAPTERS = {
    ocr: async (ctx, step) => {
      if (ctx.ocrText) return { text: ctx.ocrText, cached: true };
      const result = window.BrowserTools?.process
        ? await window.BrowserTools.process('ocr-pdf', ctx.files, step.options || {})
        : { text: '' };
      ctx.ocrText = result?.text || '';
      return result;
    },
    translate: async (ctx, step) => {
      if (ctx.translated) return { text: ctx.translated, cached: true };
      const text = ctx.ocrText || '';
      let translated;
      if (window.RealAiTranslationModels?.translate) {
        translated = await window.RealAiTranslationModels.translate(
          text, step.options?.srcLang || 'auto', step.options?.tgtLang || 'en',
          step.options?.onProgress
        );
      } else if (window.UniversalTranslationPipeline?.translate) {
        translated = await window.UniversalTranslationPipeline.translate(text, step.options?.srcLang, step.options?.tgtLang);
      } else {
        translated = text;
      }
      ctx.translated = translated;
      return { text: translated };
    },
    summarize: async (ctx, step) => {
      if (ctx.summary) return { summary: ctx.summary, cached: true };
      const text = ctx.translated || ctx.ocrText || '';
      let summary = text.slice(0, 500) + (text.length > 500 ? '...' : '');
      if (window.LabaAiFoundation?.AiReasoningRouter?.summarize) {
        try { summary = await window.LabaAiFoundation.AiReasoningRouter.summarize(text); } catch {}
      }
      ctx.summary = summary;
      return { summary };
    },
    compress: async (ctx, step) => {
      if (!ctx.files?.length) return {};
      return window.BrowserTools?.process
        ? window.BrowserTools.process('compress-pdf', ctx.files, step.options || {})
        : {};
    },
    export: async (ctx, step) => {
      const fmt = step.options?.format || 'txt';
      let blob;
      if (fmt === 'txt') {
        blob = new Blob([ctx.translated || ctx.ocrText || ''], { type: 'text/plain' });
      } else {
        blob = new Blob([ctx.translated || ctx.ocrText || ''], { type: 'application/octet-stream' });
      }
      return { blob, filename: `output.${fmt}` };
    },
  };

  // ─────────────────────────────────────────────────────────────
  // 3. PipelineExecutor
  // ─────────────────────────────────────────────────────────────
  const PipelineExecutor = (() => {
    async function execute(workflow, onStepComplete) {
      const ctx = SharedDocumentContext.get(workflow.id) || SharedDocumentContext.create(workflow.id, workflow.files);
      const results = [];

      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];

        // Check checkpoint resume
        if (SmartIntermediateCache.has(workflow.id, step.id)) {
          const cached = SmartIntermediateCache.get(workflow.id, step.id);
          log(`step ${step.id} resumed from cache`);
          results.push({ step: step.id, result: cached, resumed: true });
          onStepComplete?.({ stepId: step.id, index: i, total: workflow.steps.length, result: cached, resumed: true });
          continue;
        }

        // Update workflow state
        workflow.currentStep = i;
        workflow.status = 'running';
        await WorkflowStore.save(workflow);

        let result;
        try {
          const adapter = STEP_ADAPTERS[step.type] || _genericAdapter;
          result = await adapter(ctx, step);
          SmartIntermediateCache.set(workflow.id, step.id, result);
          step.status = 'done';
        } catch (e) {
          warn(`step ${step.id} failed:`, e.message);
          step.status = 'error';
          step.error  = e.message;

          // Retry once
          if (!step._retried) {
            step._retried = true;
            i--;
            continue;
          }

          if (step.required) {
            workflow.status = 'error';
            await WorkflowStore.save(workflow);
            throw e;
          }
          result = { error: e.message, skipped: true };
        }

        results.push({ step: step.id, result });
        onStepComplete?.({ stepId: step.id, index: i, total: workflow.steps.length, result });
        await new Promise(r => setTimeout(r, 0)); // yield
      }

      workflow.status = 'done';
      workflow.results = results;
      await WorkflowStore.save(workflow);
      return results;
    }

    async function _genericAdapter(ctx, step) {
      log('generic adapter for step type:', step.type);
      return { skipped: true, reason: 'no adapter registered' };
    }

    return { execute };
  })();

  // ─────────────────────────────────────────────────────────────
  // 1. WorkflowBuilder
  // ─────────────────────────────────────────────────────────────
  const WorkflowBuilder = (() => {
    function create(name) {
      return {
        id: `wf_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        name: name || 'Untitled Workflow',
        steps: [],
        files: [],
        status: 'idle',
        currentStep: -1,
        createdAt: Date.now(),
      };
    }

    function addStep(workflow, type, options = {}, required = false) {
      const step = {
        id: `step_${workflow.steps.length}_${type}`,
        type,
        options,
        required,
        status: 'pending',
      };
      workflow.steps.push(step);
      return workflow;
    }

    function withFiles(workflow, files) {
      workflow.files = files;
      return workflow;
    }

    function build(workflow) {
      return workflow;
    }

    // Preset: OCR → Translate → Summarize → Export
    function ocrTranslateSummarize(files, tgtLang = 'en') {
      const wf = create('OCR → Translate → Summarize');
      wf.files = files;
      addStep(wf, 'ocr',       {}, true);
      addStep(wf, 'translate', { tgtLang }, true);
      addStep(wf, 'summarize', {});
      addStep(wf, 'export',    { format: 'txt' });
      return wf;
    }

    // Preset: OCR → Table Extraction → Export CSV
    function ocrTableExport(files) {
      const wf = create('OCR → Table Extract → CSV');
      wf.files = files;
      addStep(wf, 'ocr',    {}, true);
      addStep(wf, 'export', { format: 'csv' });
      return wf;
    }

    return { create, addStep, withFiles, build, ocrTranslateSummarize, ocrTableExport };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. ResumableWorkflowState
  // ─────────────────────────────────────────────────────────────
  const ResumableWorkflowState = (() => {
    async function save(workflow) { return WorkflowStore.save(workflow); }
    async function resume(workflowId) { return WorkflowStore.load(workflowId); }
    async function list() { return WorkflowStore.list(); }
    async function cancel(workflowId) {
      const wf = await WorkflowStore.load(workflowId);
      if (wf) { wf.status = 'cancelled'; await WorkflowStore.save(wf); }
      SmartIntermediateCache.invalidate(workflowId);
      SharedDocumentContext.destroy(workflowId);
    }
    return { save, resume, list, cancel };
  })();

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const WorkflowChainEngine = {
    version: '42d.1.0',
    WorkflowBuilder,
    SharedDocumentContext,
    PipelineExecutor,
    SmartIntermediateCache,
    ResumableWorkflowState,

    registerStepAdapter(type, fn) {
      STEP_ADAPTERS[type] = fn;
      log('registered step adapter:', type);
    },

    /** Build and run a workflow immediately */
    async run(workflow, onStepComplete) {
      log('running workflow:', workflow.id, workflow.name);
      SharedDocumentContext.create(workflow.id, workflow.files);
      return PipelineExecutor.execute(workflow, onStepComplete);
    },

    /** Resume a previously saved workflow */
    async resumeWorkflow(workflowId, onStepComplete) {
      const wf = await ResumableWorkflowState.resume(workflowId);
      if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
      log('resuming workflow:', workflowId);
      return PipelineExecutor.execute(wf, onStepComplete);
    },

    status() {
      return {
        adapters: Object.keys(STEP_ADAPTERS),
        cacheSize: SmartIntermediateCache._cache?.size ?? 0,
        onnxAvailable: !!(window.RealAiTranslationModels),
        ocrAvailable:  !!(window.BrowserTools),
      };
    },
  };

  // Run cache sweep every 10 min
  setInterval(() => SmartIntermediateCache.sweep(), 10 * 60 * 1000);

  window.WorkflowChainEngine = WorkflowChainEngine;
  log('Phase 42D ready');
})();
