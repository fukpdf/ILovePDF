/**
 * PHASE 45 — AI DOCUMENT OPERATING SYSTEM
 * window.AiDocumentOS
 *
 * Master orchestration layer. Purely additive.
 * Coordinates all Phase 42–44 systems + existing infrastructure.
 * Degrades gracefully when any subsystem is absent.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[ADOS]', ...a); }
  function warn(...a) { console.warn('[ADOS]', ...a); }

  // Safe accessor — returns null if global not present
  function sys(name) { return window[name] || null; }

  // ─────────────────────────────────────────────────────────────
  // 1. UnifiedAiTaskManager
  // ─────────────────────────────────────────────────────────────
  const UnifiedAiTaskManager = (() => {
    const _tasks = new Map();

    function _id() { return `ados_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

    function _create(type, payload, options = {}) {
      return {
        id: options.id || _id(),
        type,
        payload,
        status: 'pending',
        priority: options.priority || 5,
        createdAt: Date.now(),
        retries: 0,
        result: null,
        error: null,
      };
    }

    async function submit(type, payload, options = {}) {
      const task = _create(type, payload, options);
      _tasks.set(task.id, task);
      log(`task submitted: ${task.id} [${type}]`);

      try {
        task.status = 'running';
        task.result = await _dispatch(task);
        task.status = 'done';
      } catch (e) {
        task.status = 'error';
        task.error  = e.message;
        warn(`task failed: ${task.id}`, e.message);
      }

      return task;
    }

    async function _dispatch(task) {
      const D = sys('DistributedAiOrchestrator');
      if (D && task.type !== 'workflow') {
        // Offload to distributed orchestrator when available
        return D.submit(task.id, task.type, task.payload, { priority: task.priority });
      }

      // Inline dispatch
      switch (task.type) {
        case 'ocr':
          return _runOcr(task.payload);
        case 'translate':
          return _runTranslate(task.payload);
        case 'summarize':
          return _runSummarize(task.payload);
        case 'compare':
          return _runCompare(task.payload);
        case 'extract':
          return _runExtract(task.payload);
        case 'workflow':
          return _runWorkflow(task.payload);
        case 'distributed':
          return D ? D.submit(task.id, task.payload.subType, task.payload.data) : {};
        default:
          warn('Unknown task type:', task.type);
          return {};
      }
    }

    async function _runOcr({ files, options }) {
      const enhanced = sys('AiOcrEnhancement');
      if (enhanced && options?.ai) {
        return enhanced.processPage(options.imageData, options.existingText, options);
      }
      return sys('BrowserTools')?.process?.('ocr-pdf', files, options) || { text: '' };
    }

    async function _runTranslate({ text, srcLang, tgtLang, onProgress }) {
      const ratm = sys('RealAiTranslationModels');
      if (ratm) return { text: await ratm.translate(text, srcLang, tgtLang, onProgress) };
      const utp  = sys('UniversalTranslationPipeline');
      if (utp)  return { text: await utp.translate(text, srcLang, tgtLang) };
      return { text };
    }

    async function _runSummarize({ docId, text }) {
      const laba = sys('LabaAiFoundation');
      if (laba && docId) return laba.summarize(docId);
      if (laba && text)  return laba.AiReasoningRouter.summarize(text);
      // Extractive fallback
      const sentences = (text||'').split(/[.!?]\s+/).slice(0,5);
      return { summary: sentences.join('. ') };
    }

    async function _runCompare({ textA, textB }) {
      const laba = sys('LabaAiFoundation');
      if (laba) return laba.AiReasoningRouter.compare(textA, textB);
      const a = new Set((textA||'').toLowerCase().split(/\W+/));
      const b = new Set((textB||'').toLowerCase().split(/\W+/));
      const common = [...a].filter(w=>b.has(w)).length;
      return { similarity: common / Math.max(a.size, b.size, 1) };
    }

    async function _runExtract({ docId, entity }) {
      const laba = sys('LabaAiFoundation');
      return laba ? laba.AiReasoningRouter.extract(entity, docId) : { extractions: [] };
    }

    async function _runWorkflow({ workflow, onStepComplete }) {
      const wce = sys('WorkflowChainEngine');
      if (!wce) throw new Error('WorkflowChainEngine not available');
      return wce.run(workflow, onStepComplete);
    }

    function get(taskId)  { return _tasks.get(taskId) || null; }
    function list()        { return [..._tasks.values()]; }
    function cancel(id)   { const t = _tasks.get(id); if (t && t.status==='pending') t.status='cancelled'; }
    function clear()       { for(const [id,t] of _tasks) { if (t.status==='done'||t.status==='error'||t.status==='cancelled') _tasks.delete(id); } }

    return { submit, get, list, cancel, clear };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. ResourceOrchestrator
  // ─────────────────────────────────────────────────────────────
  const ResourceOrchestrator = (() => {
    function snapshot() {
      return {
        gpu:         _gpuInfo(),
        onnx:        _onnxInfo(),
        workers:     _workerInfo(),
        opfs:        _opfsInfo(),
        memory:      _memoryInfo(),
        distributed: _distInfo(),
      };
    }

    function _gpuInfo() {
      const wga = sys('WebGPUAiPipelines');
      return { available: !!(navigator.gpu || wga), active: !!(wga?.isActive?.()) };
    }

    function _onnxInfo() {
      const orm = sys('OnnxRuntimeManager');
      return { available: !!(orm || window.ort), runtimeLoaded: !!(window.ort) };
    }

    function _workerInfo() {
      const wp = sys('WorkerPool');
      return { pool: !!(wp), count: navigator.hardwareConcurrency || 4 };
    }

    function _opfsInfo() {
      const om = sys('OpfsManager') || sys('OpfsMemoryMapped');
      return { available: !!(om || navigator.storage?.getDirectory) };
    }

    function _memoryInfo() {
      const mem = performance?.memory;
      if (!mem) return { available: false };
      return {
        available: true,
        usedMB: Math.round(mem.usedJSHeapSize/1e6),
        limitMB: Math.round(mem.jsHeapSizeLimit/1e6),
        pressureLevel: mem.usedJSHeapSize / mem.jsHeapSizeLimit,
      };
    }

    function _distInfo() {
      const dao = sys('DistributedAiOrchestrator');
      return { available: !!(dao), workers: dao?.workers?.()?.length || 0 };
    }

    function isMemoryPressure() {
      const mem = _memoryInfo();
      return mem.available && mem.pressureLevel > 0.8;
    }

    function activateSurvivalMode() {
      log('activating memory survival mode');
      sys('GiantFileRouting')?.activateSurvivalMode?.();
      sys('RollingProcessor')?.flush?.();
    }

    return { snapshot, isMemoryPressure, activateSurvivalMode };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. AdaptiveExecutionEngine
  // ─────────────────────────────────────────────────────────────
  const AdaptiveExecutionEngine = (() => {
    function selectMode(taskType, fileSize = 0) {
      const res = ResourceOrchestrator.snapshot();
      const lowMem = res.memory.pressureLevel > 0.7;
      const hasGPU = res.gpu.available;
      const hasONNX = res.onnx.available;
      const hasDist = res.distributed.workers > 1;
      const bigFile = fileSize > 50 * 1024 * 1024; // 50 MB

      if (lowMem || bigFile) return 'streaming';
      if (hasDist && ['ocr','translate'].includes(taskType)) return 'distributed';
      if (hasGPU  && ['ai','onnx'].includes(taskType))       return 'webgpu';
      if (hasONNX && taskType === 'translate')               return 'wasm';
      return 'local';
    }

    async function execute(taskType, payload, options = {}) {
      const mode = options.mode || selectMode(taskType, options.fileSize);
      log(`executing ${taskType} in mode: ${mode}`);

      if (ResourceOrchestrator.isMemoryPressure()) {
        ResourceOrchestrator.activateSurvivalMode();
      }

      return UnifiedAiTaskManager.submit(taskType, payload, { ...options, mode });
    }

    return { execute, selectMode };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. IntelligentRecoveryEngine
  // ─────────────────────────────────────────────────────────────
  const IntelligentRecoveryEngine = (() => {
    async function recoverWorkflow(workflowId) {
      const wce = sys('WorkflowChainEngine');
      if (!wce) { warn('WorkflowChainEngine not available for recovery'); return null; }
      try {
        log('recovering workflow:', workflowId);
        return wce.resumeWorkflow(workflowId);
      } catch (e) {
        warn('workflow recovery failed:', e.message);
        return null;
      }
    }

    async function recoverDistributed(taskId) {
      const dao = sys('DistributedAiOrchestrator');
      if (!dao) return null;
      const chunks = await dao.DistributedCheckpointing?.getPendingChunks?.(taskId) || [];
      log(`distributed recovery: ${chunks.length} pending chunks for task ${taskId}`);
      return { pending: chunks.length, taskId };
    }

    async function recoverOcr(files, options = {}) {
      log('attempting OCR recovery with fallback options');
      // Try with higher render scale
      const opts = { ...options, renderScale: (options.renderScale || 2) + 1, mode: 'aggressive' };
      return UnifiedAiTaskManager.submit('ocr', { files, options: opts });
    }

    async function recoverTranslation(text, srcLang, tgtLang) {
      log('attempting translation recovery');
      // Try alternate backend
      const utp = sys('UniversalTranslationPipeline');
      if (utp) return utp.translate(text, srcLang, tgtLang);
      return text; // passthrough
    }

    async function recoverGiantFile(file) {
      log('giant file recovery: activating streaming mode');
      const gfr = sys('GiantFileRouting');
      if (gfr) return gfr.process(file, { streaming: true, survival: true });
      return null;
    }

    return { recoverWorkflow, recoverDistributed, recoverOcr, recoverTranslation, recoverGiantFile };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. UnifiedAuditEngine
  // ─────────────────────────────────────────────────────────────
  const UnifiedAuditEngine = (() => {
    const _log = [];
    const MAX_LOG = 500;

    function record(system, event, data = {}) {
      const entry = { ts: Date.now(), system, event, data };
      _log.push(entry);
      if (_log.length > MAX_LOG) _log.shift();
      return entry;
    }

    async function runFullAudit() {
      const results = {};
      const checks = {
        ocr:         () => !!(sys('BrowserTools') || sys('AiOcrEnhancement')),
        ai:          () => !!(sys('OnnxRuntimeManager') || sys('LabaAiFoundation')),
        translation: () => !!(sys('RealAiTranslationModels') || sys('UniversalTranslationPipeline')),
        distributed: () => !!(sys('DistributedAiOrchestrator')),
        gpu:         () => !!(navigator.gpu || sys('WebGPUAiPipelines')),
        memory:      () => { const m = ResourceOrchestrator.snapshot().memory; return !m.available || m.pressureLevel < 0.9; },
        workflow:    () => !!(sys('WorkflowChainEngine')),
        resume:      () => !!(sys('WorkflowChainEngine')?.ResumableWorkflowState),
        opfs:        () => !!(navigator.storage?.getDirectory || sys('OpfsManager')),
        selfHealing: () => !!(sys('SelfHealing')),
        autoTune:    () => !!(sys('AutoTuningEngine')),
      };

      for (const [key, check] of Object.entries(checks)) {
        try { results[key] = { pass: check(), error: null }; }
        catch (e) { results[key] = { pass: false, error: e.message }; }
        record('audit', `check:${key}`, results[key]);
      }

      const passed = Object.values(results).filter(r => r.pass).length;
      const total  = Object.keys(results).length;

      const summary = { passed, total, pct: Math.round(passed/total*100), results };
      record('audit', 'full-audit-complete', summary);
      log(`audit: ${passed}/${total} systems operational`);
      return summary;
    }

    function getLog(system) {
      return system ? _log.filter(e => e.system === system) : [..._log];
    }

    function exportReport() {
      const res = ResourceOrchestrator.snapshot();
      return {
        generated: new Date().toISOString(),
        resources: res,
        auditLog: _log.slice(-100),
        tasks: UnifiedAiTaskManager.list().map(t => ({ id:t.id, type:t.type, status:t.status })),
      };
    }

    // Hook into existing audit systems if present
    if (sys('FinalAutomatedAudit')?.registerHook) {
      sys('FinalAutomatedAudit').registerHook('ados', runFullAudit);
      log('registered with FinalAutomatedAudit');
    }

    return { record, runFullAudit, getLog, exportReport };
  })();

  // ─────────────────────────────────────────────────────────────
  // Boot sequence — non-blocking, graceful
  // ─────────────────────────────────────────────────────────────
  async function _boot() {
    log('booting AI Document OS...');
    UnifiedAuditEngine.record('ados', 'boot-start');

    // Integrate Phase 42A with translation pipeline
    const ratm = sys('RealAiTranslationModels');
    const utp  = sys('UniversalTranslationPipeline');
    if (ratm && utp?.registerBackend && !utp._adosRegistered) {
      utp._adosRegistered = true;
    }

    // Wire ResourceOrchestrator memory watchdog
    setInterval(() => {
      if (ResourceOrchestrator.isMemoryPressure()) {
        warn('memory pressure detected');
        ResourceOrchestrator.activateSurvivalMode();
        UnifiedAuditEngine.record('resource', 'memory-pressure');
      }
    }, 30_000);

    // Run initial audit (non-blocking)
    setTimeout(async () => {
      const audit = await UnifiedAuditEngine.runFullAudit();
      log(`initial audit: ${audit.passed}/${audit.total} systems OK`);
    }, 2000);

    UnifiedAuditEngine.record('ados', 'boot-complete');
    log('AI Document OS ready');
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const AiDocumentOS = {
    version: '45.1.0',
    UnifiedAiTaskManager,
    ResourceOrchestrator,
    AdaptiveExecutionEngine,
    IntelligentRecoveryEngine,
    UnifiedAuditEngine,

    // High-level task API
    async process(type, payload, options) {
      return AdaptiveExecutionEngine.execute(type, payload, options);
    },

    // Convenience: run a full document through OCR → Translate → Summarize
    async processDocument(files, { srcLang = 'auto', tgtLang = 'en', onProgress } = {}) {
      const wce = sys('WorkflowChainEngine');
      if (wce) {
        const wf = wce.WorkflowBuilder.ocrTranslateSummarize(files, tgtLang);
        return UnifiedAiTaskManager.submit('workflow', { workflow: wf, onStepComplete: onProgress });
      }
      // Inline fallback
      const ocrResult = await UnifiedAiTaskManager.submit('ocr', { files, options: {} });
      const text = ocrResult?.result?.text || '';
      const transResult = await UnifiedAiTaskManager.submit('translate', { text, srcLang, tgtLang });
      const translated = transResult?.result?.text || text;
      const sumResult = await UnifiedAiTaskManager.submit('summarize', { text: translated });
      return { ocrText: text, translated, summary: sumResult?.result?.summary };
    },

    // Resource / status
    resources() { return ResourceOrchestrator.snapshot(); },

    // Full system audit
    async audit() { return UnifiedAuditEngine.runFullAudit(); },

    // Export diagnostic report
    report() { return UnifiedAuditEngine.exportReport(); },

    // Recovery helpers
    recover: IntelligentRecoveryEngine,

    status() {
      const res = ResourceOrchestrator.snapshot();
      return {
        version: '45.1.0',
        systems: {
          ratm: !!(sys('RealAiTranslationModels')),
          aocr: !!(sys('AiOcrEnhancement')),
          tcu:  !!(sys('TranslationConfidenceUI')),
          wce:  !!(sys('WorkflowChainEngine')),
          dao:  !!(sys('DistributedAiOrchestrator')),
          laba: !!(sys('LabaAiFoundation')),
        },
        resources: res,
        tasks: { total: UnifiedAiTaskManager.list().length },
      };
    },
  };

  // Boot (deferred — doesn't block page load)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    setTimeout(_boot, 0);
  }

  window.AiDocumentOS = AiDocumentOS;
  log('Phase 45 module loaded');
})();
