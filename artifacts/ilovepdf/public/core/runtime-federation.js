/**
 * RuntimeFederation — Phase 14
 *
 * Implements the Module Federation layer promised in runtime-core.js's
 * [FUTURE: ModuleFederation] comments. Provides:
 *
 *   ToolModuleRegistry  — maps every tool ID → required module groups
 *   RuntimeModuleLoader — checks module group health; reports missing deps
 *   RuntimeFederation   — top-level federation host + status surface
 *
 * Also upgrades CentralRuntime.getModuleRuntime(toolId) to return a RICH
 * scoped runtime view (tool-specific execution context, module info, AI,
 * GPU, stream, memory accessors) instead of the original minimal stub.
 *
 * MODULE GROUPS (logical clusters of window.* globals):
 *   CORE    — always required (CentralRuntime, EventBus, State, Telemetry)
 *   STREAM  — large-file streaming (OPFS, StreamBridge, ZeroCopy)
 *   MEMORY  — adaptive memory mgmt (RuntimeMemory, MemDefense, Pipeline)
 *   AI      — AI task routing (AIOrchestrator, LocalAI, GenerativeEngine)
 *   GPU     — GPU/WASM compute (GpuEngine, WasmEngine, Kernel)
 *   PDF     — PDF worker layer (BrowserTools, PdfRuntimeRegistry, WorkerPool)
 *   TELEM   — telemetry + dashboards (RuntimeTelemetry, Enterprise, Bench)
 *
 * BACKWARD COMPATIBLE: All existing window.* globals, CentralRuntime.execute(),
 * BrowserTools.process(), PdfRuntimeRegistry, tool-page.js — 100% unaffected.
 *
 * Exposed as: window.RuntimeFederation, window.ToolModuleRegistry,
 *             window.RuntimeModuleLoader
 */
(function (G) {
  'use strict';

  if (G.RuntimeFederation) return;

  var VERSION = '1.0.0';
  var LOG     = '[FED14]';

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 1  MODULE GROUPS
   * Each group defines the REQUIRED globals (all must be present for the group
   * to be considered loaded) and OPTIONAL globals (enhancements).
   * ═══════════════════════════════════════════════════════════════════════════ */
  var GROUPS = {

    CORE: {
      label:    'Core Runtime',
      desc:     'CentralRuntime + EventBus + State + Telemetry. Required on all pages.',
      globals:  ['CentralRuntime', 'RuntimeEventBus', 'RuntimeState', 'RuntimeTelemetry'],
      optional: ['RuntimeHealth', 'RuntimeCancellation', 'RuntimeProgress', 'TimerRegistry', 'P1'],
    },

    STREAM: {
      label:    'Streaming',
      desc:     'OPFS byte-range streaming, zero-copy pipeline, stream bridge.',
      globals:  ['RuntimeStreamBridge'],
      optional: ['RuntimeStreaming', 'RuntimeZeroCopy', 'RuntimeIncrementalPdf', 'RuntimeAdaptivePipeline'],
    },

    MEMORY: {
      label:    'Memory Management',
      desc:     'Adaptive memory controller, pressure monitor, memory defense.',
      globals:  ['RuntimeMemory'],
      optional: ['RuntimeMemoryDefense', 'RuntimeAdaptivePipeline', 'MemPressure', 'AdaptiveDegradation'],
    },

    AI: {
      label:    'AI Runtime',
      desc:     'AI task orchestration, local inference, LLM routing.',
      globals:  ['RuntimeAIOrchestrator'],
      optional: ['RuntimeLocalAI', 'GenerativeAiEngine', 'RealLocalLlmEngine',
                 'RuntimeAIUpgrade', 'VectorMemoryEngine'],
    },

    GPU: {
      label:    'GPU/WASM Compute',
      desc:     'WebGPU/WebGL image ops, WASM SIMD, microkernel routing.',
      globals:  ['RuntimeGpuEngine', 'RuntimeWasmEngine'],
      optional: ['RuntimeKernel', 'RuntimeSandbox'],
    },

    PDF: {
      label:    'PDF Engine',
      desc:     'Browser-side PDF workers, runtime registry, WorkerPool.',
      globals:  ['BrowserTools', 'PdfRuntimeRegistry', 'WorkerPool'],
      optional: ['PdfWorkerRuntimeFactory', 'MergeRuntime', 'RuntimeWorkers'],
    },

    TELEM: {
      label:    'Telemetry',
      desc:     'Runtime telemetry, enterprise metrics, benchmark engine.',
      globals:  ['RuntimeTelemetry'],
      optional: ['RuntimeTelemetryEnterprise', 'RuntimeBenchmark', 'RuntimeDiagnostics'],
    },
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 2  TOOL → MODULE GROUP MAPPING
   * Every tool ID maps to the groups it requires to run at full capability.
   * CORE is always implied even if not listed.
   * ═══════════════════════════════════════════════════════════════════════════ */
  var TOOL_MODULES = {
    // ── Instant browser tools (pdf-lib, main-thread) ─────────────────────────
    'merge':          ['CORE', 'STREAM', 'MEMORY', 'PDF'],
    'split':          ['CORE', 'PDF'],
    'rotate':         ['CORE', 'PDF'],
    'crop':           ['CORE', 'PDF'],
    'organize':       ['CORE', 'PDF'],
    'page-numbers':   ['CORE', 'PDF'],
    'watermark':      ['CORE', 'PDF'],
    'protect':        ['CORE', 'PDF'],
    'unlock':         ['CORE', 'PDF'],
    'jpg-to-pdf':     ['CORE', 'PDF'],

    // ── Server-side conversion tools ─────────────────────────────────────────
    'compress':          ['CORE', 'STREAM', 'MEMORY', 'PDF'],
    'repair':            ['CORE', 'PDF'],
    'pdf-to-word':       ['CORE', 'STREAM', 'MEMORY'],
    'pdf-to-powerpoint': ['CORE', 'STREAM', 'MEMORY'],
    'pdf-to-excel':      ['CORE', 'STREAM', 'MEMORY'],
    'pdf-to-jpg':        ['CORE', 'STREAM', 'MEMORY'],
    'word-to-pdf':       ['CORE', 'STREAM', 'MEMORY'],
    'powerpoint-to-pdf': ['CORE', 'STREAM', 'MEMORY'],
    'excel-to-pdf':      ['CORE', 'STREAM', 'MEMORY'],
    'html-to-pdf':       ['CORE', 'STREAM', 'MEMORY'],
    'word-to-excel':     ['CORE', 'STREAM', 'MEMORY'],

    // ── Edit tools ────────────────────────────────────────────────────────────
    'edit':    ['CORE', 'STREAM', 'MEMORY', 'PDF'],
    'sign':    ['CORE', 'PDF'],
    'redact':  ['CORE', 'PDF'],
    'compare': ['CORE', 'STREAM', 'MEMORY', 'PDF'],

    // ── AI / OCR tools ────────────────────────────────────────────────────────
    'ocr':         ['CORE', 'STREAM', 'MEMORY', 'AI', 'PDF'],
    'ai-summarize':['CORE', 'STREAM', 'MEMORY', 'AI'],
    'translate':   ['CORE', 'STREAM', 'MEMORY', 'AI'],
    'scan-to-pdf': ['CORE', 'PDF'],
    'workflow':    ['CORE', 'STREAM', 'MEMORY', 'AI', 'PDF'],

    // ── Image tools ───────────────────────────────────────────────────────────
    'background-remover': ['CORE', 'AI', 'GPU'],
    'crop-image':         ['CORE', 'GPU'],
    'resize-image':       ['CORE', 'GPU'],
    'image-filters':      ['CORE', 'GPU'],

    // ── Utility tools (homepage-only) ─────────────────────────────────────────
    'numbers-to-words':  ['CORE'],
    'currency-converter':['CORE'],
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 3  RUNTIME MODULE LOADER
   * ═══════════════════════════════════════════════════════════════════════════ */

  var RuntimeModuleLoader = (function () {

    /** Check if ALL required globals for a group are present. */
    function isGroupLoaded(groupName) {
      var g = GROUPS[groupName];
      if (!g) return false;
      return g.globals.every(function (name) { return !!G[name]; });
    }

    /** Rich status for a single group. */
    function getGroupStatus(groupName) {
      var g = GROUPS[groupName];
      if (!g) return null;
      var required = g.globals.map(function (name) {
        return { name: name, loaded: !!G[name] };
      });
      var optional = (g.optional || []).map(function (name) {
        return { name: name, loaded: !!G[name] };
      });
      var loaded  = required.every(function (r) { return r.loaded; });
      var missing = required.filter(function (r) { return !r.loaded; }).map(function (r) { return r.name; });
      return {
        groupName:   groupName,
        label:       g.label,
        desc:        g.desc,
        loaded:      loaded,
        required:    required,
        optional:    optional,
        missing:     missing,
        optionalPct: optional.length
          ? Math.round(optional.filter(function (o) { return o.loaded; }).length / optional.length * 100)
          : 100,
      };
    }

    /** Status for all groups. */
    function getAllGroupStatuses() {
      var out = {};
      Object.keys(GROUPS).forEach(function (g) { out[g] = getGroupStatus(g); });
      return out;
    }

    return { isGroupLoaded: isGroupLoaded, getGroupStatus: getGroupStatus, getAllGroupStatuses: getAllGroupStatuses };
  }());

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 4  TOOL MODULE REGISTRY
   * ═══════════════════════════════════════════════════════════════════════════ */

  var ToolModuleRegistry = (function () {

    /** Returns array of group names required by toolId. Falls back to CORE. */
    function getGroupsForTool(toolId) {
      return (TOOL_MODULES[toolId] || ['CORE']).slice();
    }

    /** True if all required groups for toolId are loaded. */
    function isToolReady(toolId) {
      return getGroupsForTool(toolId).every(function (g) {
        return RuntimeModuleLoader.isGroupLoaded(g);
      });
    }

    /** Full readiness report for toolId. */
    function getToolStatus(toolId) {
      var groups      = getGroupsForTool(toolId);
      var groupStatus = groups.map(function (g) { return RuntimeModuleLoader.getGroupStatus(g); });
      var ready       = groupStatus.every(function (gs) { return gs && gs.loaded; });
      var missing     = groupStatus.reduce(function (acc, gs) {
        return gs ? acc.concat(gs.missing) : acc;
      }, []);
      return {
        toolId:       toolId,
        groups:       groups,
        ready:        ready,
        missing:      missing,
        groupStatus:  groupStatus,
      };
    }

    /** Audit all registered tools. */
    function auditAll() {
      return Object.keys(TOOL_MODULES).map(function (id) { return getToolStatus(id); });
    }

    /** List tools that require a specific module group. */
    function toolsRequiring(groupName) {
      return Object.keys(TOOL_MODULES).filter(function (id) {
        return TOOL_MODULES[id].indexOf(groupName) !== -1;
      });
    }

    return {
      TOOL_MODULES:    TOOL_MODULES,
      getGroupsForTool: getGroupsForTool,
      isToolReady:     isToolReady,
      getToolStatus:   getToolStatus,
      auditAll:        auditAll,
      toolsRequiring:  toolsRequiring,
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 5  SCOPED RUNTIME FACTORY
   * Creates a tool-scoped runtime view. Upgrades CentralRuntime.getModuleRuntime().
   * ═══════════════════════════════════════════════════════════════════════════ */

  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }
  function _prom(err) { return Promise.reject(new Error(err)); }

  function createScopedRuntime(toolId) {
    var groups = ToolModuleRegistry.getGroupsForTool(toolId);

    var scoped = {
      toolId:  toolId,
      groups:  groups,
      VERSION: VERSION,

      /* ── Execution ─────────────────────────────────────────────────────── */
      execute: function (fn, opts) {
        var rt = G.CentralRuntime;
        return rt ? rt.execute(toolId, fn, opts || {}) : _prom('CentralRuntime not loaded');
      },

      /* ── Cancellation ──────────────────────────────────────────────────── */
      cancel: function (reason) {
        return _safe(function () {
          return G.CentralRuntime ? G.CentralRuntime.cancelTool(toolId) : 0;
        }, 0);
      },

      /* ── EventBus ──────────────────────────────────────────────────────── */
      on: function (type, fn) {
        return G.RuntimeEventBus ? G.RuntimeEventBus.on(type, fn) : function () {};
      },
      emit: function (type, data) {
        return G.RuntimeEventBus ? G.RuntimeEventBus.emit(type, data) : null;
      },

      /* ── Memory ────────────────────────────────────────────────────────── */
      memory: function () { return G.RuntimeMemory || null; },
      memoryTier: function () {
        return _safe(function () {
          return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'UNKNOWN';
        }, 'UNKNOWN');
      },

      /* ── Workers ───────────────────────────────────────────────────────── */
      workers: function () { return G.RuntimeWorkers || G.WorkerPool || null; },
      dispatchWorker: function (workerUrl, msg, transferables, opts) {
        var rt = G.CentralRuntime;
        return rt ? rt.dispatchWorker(workerUrl, msg, transferables, opts)
          : _prom('CentralRuntime not loaded');
      },

      /* ── AI ────────────────────────────────────────────────────────────── */
      ai: function (taskType, payload) {
        var orch = G.RuntimeAIOrchestrator;
        if (orch && orch.runAiTask) return orch.runAiTask(taskType, payload || {});
        var rt = G.CentralRuntime;
        return rt ? rt.runAiTask(taskType, payload) : _prom('AI not available');
      },

      /* ── GPU ───────────────────────────────────────────────────────────── */
      gpu: function (op, input, opts) {
        return G.RuntimeGpuEngine
          ? G.RuntimeGpuEngine.runTask(op, input, opts || {})
          : _prom('GPU not available');
      },

      /* ── WASM ──────────────────────────────────────────────────────────── */
      wasm: function (op, input, opts) {
        return G.RuntimeWasmEngine
          ? G.RuntimeWasmEngine.execute(op, input, opts || {})
          : _prom('WASM not available');
      },

      /* ── Streaming ─────────────────────────────────────────────────────── */
      streamToWorker: function (workerUrl, file, msg, opts) {
        var sb = G.RuntimeStreamBridge;
        return sb ? sb.streamToWorkerReadable(workerUrl, file, msg, opts)
          : _prom('StreamBridge not available');
      },

      /* ── Kernel ────────────────────────────────────────────────────────── */
      kernel: function () { return G.RuntimeKernel || null; },
      schedule: function (task) {
        var k = G.RuntimeKernel;
        return k ? k.schedule(task) : _prom('Kernel not available');
      },

      /* ── Module status ─────────────────────────────────────────────────── */
      status: function () {
        return ToolModuleRegistry.getToolStatus(toolId);
      },
      isReady: function () {
        return ToolModuleRegistry.isToolReady(toolId);
      },
    };

    return scoped;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 6  UPGRADE CentralRuntime.getModuleRuntime
   * Replaces the minimal stub in runtime-core.js with the full scoped runtime.
   * Safe: falls back to original if CentralRuntime not loaded yet.
   * ═══════════════════════════════════════════════════════════════════════════ */

  function _upgradeGetModuleRuntime() {
    if (!G.CentralRuntime) return;
    var _orig = G.CentralRuntime.getModuleRuntime;
    G.CentralRuntime.getModuleRuntime = function (moduleId) {
      return createScopedRuntime(moduleId || 'unknown');
    };
    // Also patch window.RT (alias)
    if (G.RT && G.RT !== G.CentralRuntime) {
      G.RT.getModuleRuntime = G.CentralRuntime.getModuleRuntime;
    }
    console.debug(LOG, 'CentralRuntime.getModuleRuntime upgraded to federation scoped runtime');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 7  RUNTIME FEDERATION (top-level host)
   * ═══════════════════════════════════════════════════════════════════════════ */

  var RuntimeFederation = {
    VERSION:    VERSION,

    GROUPS:     GROUPS,
    TOOL_MODULES: TOOL_MODULES,

    /* ── Module Loader ───────────────────────────────────────────────────── */
    isGroupLoaded:     RuntimeModuleLoader.isGroupLoaded.bind(RuntimeModuleLoader),
    getGroupStatus:    RuntimeModuleLoader.getGroupStatus.bind(RuntimeModuleLoader),
    getAllGroupStatuses:RuntimeModuleLoader.getAllGroupStatuses.bind(RuntimeModuleLoader),

    /* ── Tool Registry ───────────────────────────────────────────────────── */
    getGroupsForTool:  ToolModuleRegistry.getGroupsForTool.bind(ToolModuleRegistry),
    isToolReady:       ToolModuleRegistry.isToolReady.bind(ToolModuleRegistry),
    getToolStatus:     ToolModuleRegistry.getToolStatus.bind(ToolModuleRegistry),
    toolsRequiring:    ToolModuleRegistry.toolsRequiring.bind(ToolModuleRegistry),

    /* ── Scoped Runtime Factory ──────────────────────────────────────────── */
    getScopedRuntime:  createScopedRuntime,

    /* ── Full platform status ────────────────────────────────────────────── */
    status: function () {
      var groups = RuntimeModuleLoader.getAllGroupStatuses();
      var tools  = ToolModuleRegistry.auditAll();
      var readyGroups = Object.values(groups).filter(function (g) { return g.loaded; }).length;
      var readyTools  = tools.filter(function (t) { return t.ready; }).length;
      return {
        version:     VERSION,
        groups:      groups,
        groupsReady: readyGroups + '/' + Object.keys(GROUPS).length,
        tools:       tools,
        toolsReady:  readyTools + '/' + tools.length,
      };
    },

    /* ── Console print helper ────────────────────────────────────────────── */
    print: function () {
      var s = RuntimeFederation.status();
      console.group('[RuntimeFederation] v' + VERSION + ' — Module Status');
      console.log('  Groups:', s.groupsReady);
      Object.values(s.groups).forEach(function (g) {
        var icon = g.loaded ? '✓' : '✗';
        console.log('  ' + icon + ' ' + g.groupName + ': ' + g.label + (g.missing.length ? ' [missing: ' + g.missing.join(', ') + ']' : ''));
      });
      console.log('  Tools ready:', s.toolsReady);
      console.groupEnd();
    },
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 8  BOOT
   * ═══════════════════════════════════════════════════════════════════════════ */

  G.RuntimeFederation   = RuntimeFederation;
  G.ToolModuleRegistry  = ToolModuleRegistry;
  G.RuntimeModuleLoader = RuntimeModuleLoader;

  // Upgrade CentralRuntime if already loaded; retry after DOMContentLoaded
  _upgradeGetModuleRuntime();
  if (!G.CentralRuntime) {
    document.addEventListener('DOMContentLoaded', _upgradeGetModuleRuntime, { once: true });
  }

  console.debug(LOG, 'RuntimeFederation v' + VERSION + ' ready — '
    + Object.keys(GROUPS).length + ' groups, '
    + Object.keys(TOOL_MODULES).length + ' tools registered');

}(window));
