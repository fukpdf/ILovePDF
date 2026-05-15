/**
 * ILovePDF Runtime Contracts — Phase 12C
 *
 * Standardised API surface contracts for all runtime-boundary interfaces.
 * Provides:
 *   1. Type documentation (JSDoc-style) for all cross-module APIs
 *   2. Contract validators — window.ILovePDFContracts.validate(name, obj)
 *   3. Stub factories — window.ILovePDFContracts.stub(name) for testing
 *
 * ADDITIVE ONLY. Does not rewrite any existing logic.
 * Safe to load on any page at any time.
 */
(function (G) {
  'use strict';

  if (G.ILovePDFContracts) return;

  /* ─────────────────────────────────────────────────────────────────────────
   * CONTRACT DEFINITIONS
   *
   * Each contract defines the required methods / properties of a runtime
   * interface. Used to validate that a subsystem fully implements the expected
   * surface before being registered or used.
   * ───────────────────────────────────────────────────────────────────────── */
  var CONTRACTS = {

    /**
     * TOOL CONTRACT
     * The shape every tool runtime (merge-runtime.js, split-runtime.js, etc.)
     * must expose when registered in the PdfRuntimeRegistry.
     */
    Tool: {
      required: ['process'],        // process(file, opts) → Promise<{blob, filename}>
      optional: ['abort', 'reset', 'progress'],
      description: 'Browser-side tool processor. process() must return {blob, filename}.',
    },

    /**
     * WORKER CONTRACT
     * Shape any SharedWorker / Worker entry registered with RuntimeWorkers.
     */
    Worker: {
      required: ['dispatch'],       // dispatch(msg, transferables?) → Promise
      optional: ['terminate', 'status'],
      description: 'Worker proxy. dispatch() posts a message and resolves with the response.',
    },

    /**
     * AI TASK CONTRACT
     * Shape expected by RuntimeAIOrchestrator.runAiTask().
     */
    AiTask: {
      required: ['type', 'payload'],
      optional: ['priority', 'timeout', 'retries'],
      description: 'AI task descriptor. type is the task name; payload is the data object.',
    },

    /**
     * AI PROVIDER CONTRACT
     * Shape any GenerativeAiEngine provider must implement.
     */
    AiProvider: {
      required: ['name', 'generate'],  // generate(prompt, opts) → Promise<string>
      optional: ['embed', 'rank', 'health'],
      description: 'AI inference provider. generate() must resolve to a string result.',
    },

    /**
     * STREAM CONTRACT
     * Shape OPFS/IDB-backed streaming handles (RuntimeStreaming).
     */
    Stream: {
      required: ['read', 'write', 'close'],
      optional: ['seek', 'stat', 'flush'],
      description: 'Byte-range stream handle. read(offset, length) → Uint8Array.',
    },

    /**
     * TELEMETRY CONTRACT
     * Shape any telemetry sink (RuntimeTelemetry / RuntimeTelemetryEnterprise).
     */
    Telemetry: {
      required: ['record'],          // record(event, data?) → void
      optional: ['flush', 'export', 'reset'],
      description: 'Telemetry sink. record(event, data) is fire-and-forget.',
    },

    /**
     * MEMORY CONTROLLER CONTRACT
     * Shape RuntimeMemory (and its subsystem clients).
     */
    Memory: {
      required: ['getTier', 'pressure'],  // getTier() → 'low'|'medium'|'high'
      optional: ['gc', 'snapshot', 'subscribe'],
      description: 'Memory controller. getTier() returns current pressure tier.',
    },

    /**
     * PROGRESS REPORTER CONTRACT
     * Shape the progress callback passed to every tool execution.
     */
    Progress: {
      required: ['report'],          // report(pct: 0-100, msg?: string) → void
      optional: ['stage', 'reset'],
      description: 'Progress reporter. report(pct, msg) where pct is 0–100.',
    },

    /**
     * UI ADAPTOR CONTRACT
     * Shape the uiAdaptor passed to QueueClient / CentralRuntime.executeQueued().
     */
    UiAdaptor: {
      required: ['onProgress', 'onSuccess', 'onError'],
      optional: ['onCancel', 'onStart', 'label'],
      description: 'UI binding passed to queued tool execution.',
    },
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * VALIDATOR
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * validate(contractName, obj) → { ok: boolean, missing: string[], extra: string[] }
   * Checks that obj satisfies the named contract.
   */
  function validate(contractName, obj) {
    var contract = CONTRACTS[contractName];
    if (!contract) {
      return { ok: false, missing: [], extra: [], error: 'Unknown contract: ' + contractName };
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, missing: contract.required.slice(), extra: [], error: 'obj must be an object' };
    }
    var missing = (contract.required || []).filter(function (k) {
      return !(k in obj) && typeof obj[k] === 'undefined';
    });
    return {
      ok:          missing.length === 0,
      missing:     missing,
      description: contract.description,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * STUB FACTORY
   * Creates a minimal compliant stub for testing / graceful degradation.
   * ───────────────────────────────────────────────────────────────────────── */

  var _noop  = function () {};
  var _prom  = function () { return Promise.resolve(null); };
  var _prom0 = function () { return Promise.resolve({ blob: null, filename: 'stub.pdf' }); };

  var STUBS = {
    Tool:      { process: _prom0, abort: _noop, reset: _noop, progress: _noop },
    Worker:    { dispatch: _prom, terminate: _noop, status: function () { return 'idle'; } },
    AiTask:    { type: 'noop', payload: {} },
    AiProvider:{ name: 'stub', generate: function () { return Promise.resolve(''); }, health: function () { return true; } },
    Stream:    { read: _prom, write: _prom, close: _noop, seek: _noop, stat: _prom, flush: _noop },
    Telemetry: { record: _noop, flush: _noop, export: function () { return []; }, reset: _noop },
    Memory:    { getTier: function () { return 'medium'; }, pressure: function () { return 0.5; }, gc: _noop },
    Progress:  { report: _noop, stage: _noop, reset: _noop },
    UiAdaptor: { onProgress: _noop, onSuccess: _noop, onError: _noop, onCancel: _noop, onStart: _noop },
  };

  /**
   * stub(contractName) → a minimal compliant stub object.
   * Useful for graceful degradation when a subsystem hasn't loaded yet.
   */
  function stub(contractName) {
    var s = STUBS[contractName];
    if (!s) return null;
    return Object.assign({}, s);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * EXPORT
   * ───────────────────────────────────────────────────────────────────────── */
  G.ILovePDFContracts = {
    CONTRACTS:  CONTRACTS,
    validate:   validate,
    stub:       stub,
  };

  console.debug('[ILovePDFContracts] runtime contracts loaded — ' + Object.keys(CONTRACTS).length + ' contracts');

}(window));
