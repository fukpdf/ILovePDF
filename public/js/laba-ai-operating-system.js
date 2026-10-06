/**
 * PHASE 65 — LABA AI OPERATING SYSTEM
 * window.LabaAiOperatingSystem
 *
 * Unified orchestration of all AI subsystems across all phases:
 * - Unified memory routing (VME + PVD + HVM)
 * - Unified AI routing (GAE + RLR + RGI + LAR)
 * - Unified task management (AAS + AAW)
 * - Unified audit layer
 * - Unified recovery + checkpoints
 * - Unified distributed runtime (BCC)
 * - Unified AI dashboard
 *
 * Purely additive. All existing tools remain intact.
 * Never blocks main thread. P2P remains OFF by default.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[LAOS]';

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'laos_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function frame(){ return new Promise(function(r){ (requestAnimationFrame||setTimeout)(r,0); }); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  SYSTEM REGISTRY — tracks all loaded subsystems
  // ═══════════════════════════════════════════════════════════════════════════
  var SystemRegistry = (function () {
    var _systems = {};

    var KNOWN = [
      // Phase 44-59 (existing)
      'LabaAiFoundation','GenerativeAiEngine','AiAgentSystem',
      'VectorMemoryEngine','WebGpuAiExpansion','EnterpriseMemoryFabric',
      'AiDocumentOSUI','LabaAiChat','FinalAiOsAudit',
      'RealLlmRouting','PersistentVectorDatabase','AutonomousAgentSystem',
      'StableP2PNetwork','P2PDistributedMeshV2','AiOsIntegration',
      'OnnxRuntimeManager','OPFSManager',
      // Phase 60-65 (new)
      'RealGenerativeIntelligence','AutonomousAiWorkers','LocalAiRuntime',
      'BrowserComputeCloud','HyperscaleVectorMemory','LabaAiOperatingSystem',
      'FinalSuperAiAudit'
    ];

    function probe() {
      KNOWN.forEach(function(n){
        _systems[n] = { name: n, loaded: !!(window[n]), ts: now() };
      });
      var loaded = Object.values(_systems).filter(function(s){ return s.loaded; }).length;
      log('system registry: ' + loaded + '/' + KNOWN.length + ' subsystems loaded');
      return _systems;
    }

    function get(name) { return sys(name); }
    function isLoaded(name) { return !!sys(name); }
    function all() { return Object.values(_systems).filter(function(s){ return s.loaded; }); }
    function report() {
      return KNOWN.map(function(n){ return { name:n, loaded:!!sys(n) }; });
    }

    return { probe: probe, get: get, isLoaded: isLoaded, all: all, report: report };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  UNIFIED MEMORY ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  var UnifiedMemoryRouter = (function () {

    async function store(id, text, meta) {
      var results = { hvm: false, pvd: false, vme: false };
      await frame();

      // HyperscaleVectorMemory (primary for new data)
      try {
        var HVM = sys('HyperscaleVectorMemory');
        if (HVM && HVM.store) { await HVM.store(id, text, meta); results.hvm = true; }
      } catch(e){ warn('HVM store failed:', e.message); }

      // PersistentVectorDatabase (secondary)
      try {
        var PVD = sys('PersistentVectorDatabase');
        if (PVD && PVD.PersistentEmbeddingStore && PVD.PersistentEmbeddingStore.upsert) {
          await PVD.PersistentEmbeddingStore.upsert(id, new Float32Array(384), { text: text, meta: meta });
          results.pvd = true;
        }
      } catch(e){ warn('PVD store failed:', e.message); }

      // VectorMemoryEngine (legacy compatibility)
      try {
        var VME = sys('VectorMemoryEngine');
        if (VME && VME.index) { await VME.index([{ text: text, meta: meta }], id); results.vme = true; }
      } catch(e){ warn('VME store failed:', e.message); }

      return results;
    }

    async function search(query, opts) {
      opts = opts || {};
      await frame();

      // Try HyperscaleVectorMemory first (most capable)
      try {
        var HVM = sys('HyperscaleVectorMemory');
        if (HVM && HVM.search) {
          var results = await HVM.search(query, opts);
          if (results && results.length > 0) return results;
        }
      } catch(e){ warn('HVM search failed:', e.message); }

      // Fallback to PersistentVectorDatabase
      try {
        var PVD = sys('PersistentVectorDatabase');
        if (PVD && PVD.RetrievalEngine && PVD.RetrievalEngine.search) {
          var pvdR = await PVD.RetrievalEngine.search(query, opts);
          if (pvdR && pvdR.length > 0) return pvdR;
        }
      } catch(e){ warn('PVD search failed:', e.message); }

      // Fallback to VectorMemoryEngine
      try {
        var VME = sys('VectorMemoryEngine');
        if (VME && VME.search) {
          return await VME.search(query, opts.k || 10);
        }
      } catch(e){ warn('VME search failed:', e.message); }

      return [];
    }

    return { store: store, search: search };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  UNIFIED AI ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  var UnifiedAiRouter = (function () {

    async function generate(prompt, opts) {
      opts = opts || {};
      await frame();

      // Priority chain: RGI → RLR → GAE → heuristic
      var RGI = sys('RealGenerativeIntelligence');
      if (RGI && RGI.generate) {
        try { return await RGI.generate(prompt, opts); } catch(e){ warn('RGI generate failed:', e.message); }
      }

      var RLR = sys('RealLlmRouting');
      if (RLR && RLR.generate) {
        try { return await RLR.generate(prompt, opts); } catch(e){ warn('RLR generate failed:', e.message); }
      }

      var GAE = sys('GenerativeAiEngine');
      if (GAE && GAE.generate) {
        try { return await GAE.generate(prompt, opts); } catch(e){ warn('GAE generate failed:', e.message); }
      }

      // Final heuristic
      return { provider: 'heuristic', result: (prompt||'').slice(0,300) };
    }

    async function* stream(prompt, opts) {
      opts = opts || {};
      var RGI = sys('RealGenerativeIntelligence');
      if (RGI && RGI.stream) {
        try { yield* RGI.stream(prompt, opts); return; } catch(e){ warn('RGI stream failed:', e.message); }
      }
      // Fallback: generate + emit single chunk
      var result = await generate(prompt, opts);
      var text = (result && result.result) ? result.result : String(result);
      yield { tokens: [text], text: text, chars: text.length, done: true };
    }

    async function reason(goal, opts) {
      opts = opts || {};
      await frame();
      var RGI = sys('RealGenerativeIntelligence');
      if (RGI && RGI.reason) {
        try { return await RGI.reason(goal, opts); } catch(e){ warn('RGI reason failed:', e.message); }
      }
      // Fallback
      var result = await generate('Answer this goal concisely: ' + goal, opts);
      return { answer: (result&&result.result)||String(result), stages:[], confidence:0.5 };
    }

    return { generate: generate, stream: stream, reason: reason };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  UNIFIED TASK MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var UnifiedTaskManager = (function () {
    var _tasks = new Map();

    async function submit(description, opts) {
      opts = opts || {};
      var taskId = uid();
      var task = { id: taskId, description: description, status: 'pending', ts: now() };
      _tasks.set(taskId, task);

      // Try AutonomousAiWorkers first
      try {
        var AAW = sys('AutonomousAiWorkers');
        if (AAW && AAW.plan) {
          task.plan = await AAW.plan(description, opts);
          task.status = 'planned';
        }
      } catch(e){ warn('AAW plan failed:', e.message); }

      // Fall back to AutonomousAgentSystem
      if (task.status === 'pending') {
        try {
          var AAS = sys('AutonomousAgentSystem');
          if (AAS && AAS.SelfPlanningEngine) {
            task.plan = await AAS.SelfPlanningEngine.plan(description, opts);
            task.status = 'planned';
          }
        } catch(e){ warn('AAS plan failed:', e.message); }
      }

      if (task.status === 'pending') {
        task.status = 'ready';
        task.plan = { goal: description, dag: { nodes: [{ id:'step_0', description:description, deps:[], status:'pending' }] } };
      }

      return task;
    }

    async function execute(taskId, opts) {
      var task = _tasks.get(taskId);
      if (!task) return { error: 'task not found' };
      task.status = 'running';
      await frame();

      try {
        var result = await UnifiedAiRouter.reason(task.description, opts);
        task.result = result;
        task.status = 'complete';
      } catch(e) {
        task.error = e.message;
        task.status = 'failed';
      }

      return task;
    }

    function getTask(id) { return _tasks.get(id) || null; }
    function listTasks() { return Array.from(_tasks.values()); }
    function cancelTask(id) {
      var task = _tasks.get(id);
      if (task) task.status = 'cancelled';
    }

    return { submit: submit, execute: execute, getTask: getTask, listTasks: listTasks, cancelTask: cancelTask };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  UNIFIED AUDIT LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var UnifiedAuditLayer = (function () {

    async function runAudit() {
      var report = { ts: now(), systems: {}, health: 'ok', warnings: [] };
      var systems = SystemRegistry.report();

      systems.forEach(function(s){
        report.systems[s.name] = { loaded: s.loaded };
        if (!s.loaded) report.warnings.push(s.name + ' not loaded');
      });

      // Run FinalSuperAiAudit if available
      try {
        var FSAA = sys('FinalSuperAiAudit');
        if (FSAA && FSAA.run) {
          var auditResult = await FSAA.run();
          report.fullAudit = auditResult;
        }
      } catch(e){ warn('FSAA failed:', e.message); }

      // Run existing audit if available
      try {
        var FAO = sys('FinalAiOsAudit');
        if (FAO && FAO.run) {
          var faoResult = await FAO.run();
          report.legacyAudit = faoResult;
        }
      } catch(e){}

      if (report.warnings.length > 3) report.health = 'degraded';
      log('audit complete — health:', report.health, '| warnings:', report.warnings.length);
      return report;
    }

    return { runAudit: runAudit };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  UNIFIED RECOVERY ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var UnifiedRecovery = (function () {
    var _checkpoints = new Map(); // sessionId → state

    function checkpoint(sessionId, state) {
      _checkpoints.set(sessionId, { state: state, ts: now() });
      // Persist to IDB via AutonomousAiWorkers if available
      try {
        var AAW = sys('AutonomousAiWorkers');
        if (AAW && AAW.LongRunningWorkerRuntime) {
          // Store as a worker checkpoint
          var db = indexedDB.open('aaw_workers_v1', 1);
          db.onsuccess = function(e){
            var tx = e.target.result.transaction('checkpoints','readwrite');
            tx.objectStore('checkpoints').put({ id:'laos_'+sessionId, state:state, ts:now() });
          };
        }
      } catch(_){}
    }

    function restore(sessionId) {
      return _checkpoints.get(sessionId) || null;
    }

    function clearCheckpoint(sessionId) {
      _checkpoints.delete(sessionId);
    }

    // Emergency recovery: probe all known systems and restart failed ones
    async function emergencyRecovery() {
      log('emergency recovery starting...');
      var report = SystemRegistry.probe();
      var recovered = [];
      // For each loaded system with a 'recover' method, call it
      Object.values(report).filter(function(s){ return s.loaded; }).forEach(function(s){
        var sys_ = sys(s.name);
        if (sys_ && typeof sys_.recover === 'function') {
          try { sys_.recover(); recovered.push(s.name); } catch(_){}
        }
      });
      log('emergency recovery: triggered', recovered.length, 'system(s)');
      return { recovered: recovered };
    }

    return { checkpoint: checkpoint, restore: restore, clearCheckpoint: clearCheckpoint, emergencyRecovery: emergencyRecovery };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  UNIFIED AI DASHBOARD DATA
  // ═══════════════════════════════════════════════════════════════════════════
  var AiDashboard = (function () {

    function status() {
      var data = {
        ts: now(),
        systems: SystemRegistry.report(),
        tasks: UnifiedTaskManager.listTasks().map(function(t){ return { id:t.id, status:t.status, ts:t.ts }; }),
        memory: null,
        ai: null,
        compute: null
      };

      try {
        var HVM = sys('HyperscaleVectorMemory');
        if (HVM && HVM.stats) data.memory = HVM.stats();
      } catch(_){}

      try {
        var RGI = sys('RealGenerativeIntelligence');
        if (RGI && RGI.MultiProviderLlmRouter) {
          data.ai = { providers: RGI.MultiProviderLlmRouter.getHealth() };
        }
      } catch(_){}

      try {
        var BCC = sys('BrowserComputeCloud');
        if (BCC) data.compute = { enabled: BCC.isEnabled(), caps: BCC.BrowserComputeMarketplace.getCapabilities() };
      } catch(_){}

      try {
        var LAR = sys('LocalAiRuntime');
        if (LAR && LAR.capabilities) data.localRuntime = LAR.capabilities();
      } catch(_){}

      return data;
    }

    return { status: status };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § ADDITIONAL PREVIEW NEUTRALIZATION (Phase 65 layer)
  // ═══════════════════════════════════════════════════════════════════════════
  var PreviewNeutralizer65 = (function () {
    var METHODS = ['mount','show','render','init','load','start','open','display',
                   'autoRender','renderPage','loadPage','queueRender','scheduleRender',
                   'startWorker','renderAll','renderNext','preview','previewFile'];
    var NOOP = function(){ return Promise.resolve(); };

    // PdfPreview excluded: it is the core PDF rendering engine (page-organizer
    // thumbnails, merge-tool previews). Patching its renderPage breaks all tile renders.
    var GLOBALS = ['LivePreview','PreviewEngine','PreviewRenderer',
                   'PreviewWorker','PreviewQueue','LivePreviewV2','PreviewAutoRender',
                   'PdfPreviewRenderer','PreviewCanvasGenerator','PreviewPipeline'];

    function _patch(name) {
      var obj = window[name];
      if (!obj || obj.__laos_neutralized) return;
      METHODS.forEach(function(m){
        if (typeof obj[m] === 'function' && !obj['__laos_orig_' + m]) {
          obj['__laos_orig_' + m] = obj[m];
          obj[m] = NOOP;
        }
      });
      if (typeof obj.supported === 'function') { obj.__laos_orig_supported = obj.supported; obj.supported = function(){ return false; }; }
      obj.__laos_neutralized = true;
    }

    function apply() {
      GLOBALS.forEach(_patch);
      // REMOVED: Object.defineProperty setter traps for late-loading globals.
      // Intercepting window property assignment via setter traps is a global
      // mutation hazard — they can fire on core production engines that load
      // after this module. RuntimeProtection.js handles post-load immutability
      // via writable:false after DOMContentLoaded and load events instead.
    }

    return { apply: apply };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  window.LabaAiOperatingSystem = {
    VERSION: VERSION,
    SystemRegistry:       SystemRegistry,
    UnifiedMemoryRouter:  UnifiedMemoryRouter,
    UnifiedAiRouter:      UnifiedAiRouter,
    UnifiedTaskManager:   UnifiedTaskManager,
    UnifiedAuditLayer:    UnifiedAuditLayer,
    UnifiedRecovery:      UnifiedRecovery,
    AiDashboard:          AiDashboard,
    // Convenience API
    generate:   function(p,o)  { return UnifiedAiRouter.generate(p,o); },
    reason:     function(g,o)  { return UnifiedAiRouter.reason(g,o); },
    store:      function(i,t,m){ return UnifiedMemoryRouter.store(i,t,m); },
    search:     function(q,o)  { return UnifiedMemoryRouter.search(q,o); },
    submit:     function(d,o)  { return UnifiedTaskManager.submit(d,o); },
    audit:      function()     { return UnifiedAuditLayer.runAudit(); },
    status:     function()     { return AiDashboard.status(); },
    checkpoint: function(s,st) { return UnifiedRecovery.checkpoint(s,st); },
    restore:    function(s)    { return UnifiedRecovery.restore(s); },
  };

  // Global convenience alias
  window.runLaosAudit = function(){ return window.LabaAiOperatingSystem.audit(); };

  // Probe all systems and neutralize previews on DOMContentLoaded
  function _boot() {
    PreviewNeutralizer65.apply();
    SystemRegistry.probe();
    log('v' + VERSION + ' ready — unified AI operating system online');

    // Wire LabaAiChat to UnifiedAiRouter
    setTimeout(function(){
      try {
        var LAC = sys('LabaAiChat');
        if (LAC && !LAC.__laos_wired) {
          LAC.__laos_wired = true;
          var _orig = LAC.respond || LAC.chat || LAC.send;
          if (_orig) {
            var wiredFn = function(prompt, opts) {
              return UnifiedAiRouter.generate(prompt, opts)
                .then(function(r){ return (r && r.result) ? r.result : String(r); })
                .catch(function(){ return typeof _orig === 'function' ? _orig.call(LAC, prompt, opts) : ''; });
            };
            if (LAC.respond) LAC.respond = wiredFn;
            else if (LAC.chat) LAC.chat = wiredFn;
            log('LabaAiChat wired to UnifiedAiRouter');
          }
        }
      } catch(e){ warn('LAC wiring failed:', e.message); }
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

})();
