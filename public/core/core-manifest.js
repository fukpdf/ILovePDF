/**
 * ILovePDF Core Manifest — Phase 12A
 *
 * Central architecture registry for the ILovePDF platform.
 * Exposes window.ILovePDFCore — a unified registry and introspection surface
 * for all subsystems, apps, and runtime layers.
 *
 * LOAD ORDER: Must load after DOMContentLoaded (defer). All subsystems
 * already exist on window.* by then and are discovered automatically.
 *
 * USAGE:
 *   window.ILovePDFCore.status()        — full platform snapshot
 *   window.ILovePDFCore.get('runtime')  — get a subsystem by category
 *   window.ILovePDFCore.ready           — true once manifest is built
 *
 * This file is PURELY ADDITIVE. Nothing in the existing platform imports it.
 * It is the foundation for Phase 14+ module federation and micro-frontend work.
 */
(function (G) {
  'use strict';

  if (G.ILovePDFCore) return;

  var VERSION  = '1.0.0';
  var BUILT_AT = Date.now();

  /* ─────────────────────────────────────────────────────────────────────────
   * ARCHITECTURE CLASSIFICATION
   * Maps every public window.* runtime global to a semantic category.
   * Used by status(), lazy loaders, and future module federation.
   * ───────────────────────────────────────────────────────────────────────── */
  var REGISTRY = {

    /* ── MARKETING APP ───────────────────────────────────────────────────── */
    marketing: {
      label: 'Marketing App',
      description: 'Homepage-only code: hero, tools grid, calculators, SEO sections, blog.',
      globals: [
        'HOMEPAGE_BANDS', 'TOOL_PRIORITY_BANDS', 'TOOL_GROUPS',
        'toolBadgeHtml', 'TOOL_PRIO_LABEL',
        'convertNumberToWords',       // n2w-converter.js
      ],
    },

    /* ── SHARED CHROME ───────────────────────────────────────────────────── */
    chrome: {
      label: 'Shared Chrome',
      description: 'Header, nav, footer, auth modal, language selector — loaded on every page.',
      globals: [
        'RuntimeI18n', 'AuthUI',
        'SLUG_MAP', 'resolveToolIdFromUrl',
        'API_BASE', 'QUEUE_API_BASE', 'apiUrl', 'queueUrl', 'apiFetch',
      ],
    },

    /* ── TOOL APP ────────────────────────────────────────────────────────── */
    tools: {
      label: 'Tool App',
      description: 'Tool shell (tool.html), tool router, browser-side processors, live preview.',
      globals: [
        'BrowserTools', 'AdvancedEngine', 'LivePreview',
        'TOOLS', 'loadToolPage',
        'PageOrganizer', 'BgRemoverPro', 'EditPdfPro',
        'QueueClient',
      ],
    },

    /* ── RUNTIME CORE (Phase 1-9) ────────────────────────────────────────── */
    runtime: {
      label: 'Runtime Core',
      description: 'Browser OS: streams, workers, memory, OPFS, scheduler, GPU/WASM, IDB. Tool-page only.',
      globals: [
        'CentralRuntime', 'RT',
        'RuntimeEventBus', 'RuntimeState', 'RuntimeTelemetry',
        'RuntimeCancellation', 'RuntimeMemory', 'RuntimeProgress',
        'RuntimeScheduler', 'RuntimeWorkers', 'RuntimeQueue',
        'RuntimeCleanup', 'RuntimeHealth', 'RuntimeAdapters',
        'RuntimeStreaming', 'RuntimeDiagnostics',
        'RuntimeIDB', 'RuntimeCrossTab', 'RuntimeAIOrchestrator',
        'RuntimeSecurity', 'RuntimeMemoryDefense', 'RuntimeBenchmark',
        'RuntimeDistributedScheduler', 'RuntimeResultCache',
        'RuntimeAIUpgrade', 'RuntimeTelemetryEnterprise',
        'RuntimeWasmEngine', 'RuntimeGpuEngine', 'RuntimeKernel',
        'RuntimeSharedCluster', 'RuntimeSandbox', 'RuntimeIncrementalPdf',
        'RuntimeZeroCopy', 'RuntimeWorkspace', 'RuntimeLocalAI',
        'WorkerPool', 'TaskScheduler', 'LifecycleManager',
        'ObjectURLRegistry', 'TimerRegistry', 'MemPressure',
        'AdaptiveRuntime', 'AdaptiveDegradation',
        'DownloadManager', 'RetryOrchestrator', 'NavCancel',
        'CleanupContracts', 'WorkerLifecycle',
        'P1', 'IDBCache',
      ],
    },

    /* ── AI LAYER ────────────────────────────────────────────────────────── */
    ai: {
      label: 'AI Layer',
      description: 'Laba assistant, vector memory, generative engine, local LLM, AI agents.',
      globals: [
        'LabaWidget', 'LabaAiChat', 'LabaMemory',
        'VectorMemoryEngine', 'GenerativeAiEngine', 'AiAgentSystem',
        'WebGpuAiExpansion', 'EnterpriseMemoryFabric',
        'HyperscaleVectorMemory', 'HyperscaleVectorFabric',
        'PersistentVectorDatabase',
        'AutonomousAgentSystem', 'AutonomousAiWorkers',
        'LocalAiRuntime', 'RealLocalLlmEngine',
        'AdvancedAgentIntelligence',
        'LabaAiEvolutionOs', 'LabaAiOperatingSystem',
      ],
    },

    /* ── CERTIFICATIONS / DEVTOOLS ───────────────────────────────────────── */
    devtools: {
      label: 'DevTools & Certifications',
      description: 'Diagnostics, stress tests, certification audits, DevTools overlay. Console-only.',
      globals: [
        'RuntimeDashboard', 'RuntimeDiagnostics',
        'RuntimeProtection', 'RuntimeHealthMonitor',
        'FinalAiOsAudit', 'FinalSuperAiAudit', 'FinalAiEvolutionAudit',
        'RuntimeBrowserOSCertification', 'RuntimeGlobalCertification',
        'RuntimeEnterpriseCertification', 'RuntimeProductionCertification',
        'runAiOsAudit', 'runFinalSuperAiAudit', 'runFinalAiEvolutionAudit',
      ],
    },
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * LAZY-LOAD GROUPS
   * Declarative lists of JS paths by load priority.
   * Used by homepage-lazy-loader.js and future module federation.
   * ───────────────────────────────────────────────────────────────────────── */
  var LAZY_GROUPS = {

    /**
     * HOMEPAGE_AI — heavy AI/Laba stack NOT needed for initial render.
     * Lazy-loaded by homepage-lazy-loader.js after idle or first Laba interaction.
     * Order must be preserved (each file may depend on the previous one).
     */
    HOMEPAGE_AI: [
      '/js/vector-memory-engine.js',
      '/js/generative-ai-engine.js',
      '/js/ai-agent-system.js',
      '/js/p2p-distributed-mesh-v2.js',
      '/js/webgpu-ai-expansion.js',
      '/js/enterprise-memory-fabric.js',
      '/js/ai-document-os-ui.js',
      '/js/laba-ai-chat.js',
      '/js/laba-tool-orchestrator.js',
      '/js/laba-conversational-intelligence.js',
      '/js/laba-memory-system.js',
      '/js/laba-semantic-memory.js',
      '/js/laba-agent-system.js',
      '/js/laba-workflow-engine.js',
      '/js/laba-session-recovery.js',
      '/js/laba-smart-suggestions.js',
      '/js/laba-cognitive-brain.js',
      '/js/laba-personality-engine.js',
      '/js/laba-admin-core.js',
      '/js/laba-dev-copilot.js',
      '/js/laba-safe-executor.js',
      '/js/laba-autonomous-agents.js',
      '/js/laba-context-engine.js',
      '/js/laba-task-queue.js',
      '/js/laba-tool-healing.js',
      '/js/laba-humanizer.js',
      '/js/laba-deep-memory-ext.js',
      '/js/laba-workflow-planner.js',
      '/js/laba-predictive-engine.js',
      '/js/laba-tool-learning.js',
      '/js/final-ai-os-audit.js',
      '/js/real-llm-routing.js',
      '/js/persistent-vector-database.js',
      '/js/autonomous-agent-system.js',
      '/js/stable-p2p-network.js',
      '/js/ai-os-integration.js',
      '/js/real-generative-intelligence.js',
      '/js/autonomous-ai-workers.js',
      '/js/local-ai-runtime.js',
      '/js/browser-compute-cloud.js',
      '/js/hyperscale-vector-memory.js',
      '/js/laba-ai-operating-system.js',
      '/js/final-super-ai-audit.js',
      '/js/real-local-llm-engine.js',
      '/js/advanced-agent-intelligence.js',
      '/js/hyperscale-vector-fabric.js',
      '/js/production-compute-mesh.js',
      '/js/laba-ai-evolution-os.js',
      '/js/final-ai-evolution-audit.js',
      '/js/runtime-global-certification.js',
    ],
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * PUBLIC API
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * get(category) → { label, description, globals, loaded: {name→boolean} }
   * Returns registry entry + live presence check for each global.
   */
  function get(category) {
    var cat = REGISTRY[category];
    if (!cat) return null;
    var loaded = {};
    (cat.globals || []).forEach(function (g) { loaded[g] = !!G[g]; });
    return Object.assign({}, cat, { loaded: loaded });
  }

  /**
   * status() → full platform snapshot.
   * Safe to call from DevTools at any time.
   */
  function status() {
    var snap = { version: VERSION, builtAt: BUILT_AT, categories: {} };
    Object.keys(REGISTRY).forEach(function (cat) {
      var info      = get(cat);
      var total     = info.globals.length;
      var present   = Object.values(info.loaded).filter(Boolean).length;
      snap.categories[cat] = {
        label:       info.label,
        description: info.description,
        total:       total,
        present:     present,
        missing:     info.globals.filter(function (g) { return !G[g]; }),
      };
    });
    return snap;
  }

  /**
   * print() — pretty-prints status() to the console.
   */
  function print() {
    var s = status();
    console.group('[ILovePDFCore] v' + s.version + ' — Platform Status');
    Object.keys(s.categories).forEach(function (cat) {
      var c = s.categories[cat];
      var pct = c.total ? Math.round((c.present / c.total) * 100) : 0;
      console.log('  ' + c.label + ': ' + c.present + '/' + c.total + ' (' + pct + '%)');
      if (c.missing.length) {
        console.log('    Missing:', c.missing.join(', '));
      }
    });
    console.groupEnd();
  }

  /**
   * getLazyGroup(name) → array of script paths in load order.
   * Used by homepage-lazy-loader.js.
   */
  function getLazyGroup(name) {
    return LAZY_GROUPS[name] ? LAZY_GROUPS[name].slice() : [];
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * BOOT
   * ───────────────────────────────────────────────────────────────────────── */
  G.ILovePDFCore = {
    VERSION:      VERSION,
    ready:        true,
    get:          get,
    status:       status,
    print:        print,
    getLazyGroup: getLazyGroup,
    REGISTRY:     REGISTRY,
    LAZY_GROUPS:  LAZY_GROUPS,
  };

  console.debug('[ILovePDFCore] v' + VERSION + ' manifest ready — ' + Object.keys(REGISTRY).length + ' categories');

}(window));
