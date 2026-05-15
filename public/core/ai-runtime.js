/**
 * AIRuntime — Phase 15
 *
 * Unified AI Layer: discovers, registers, and routes all AI inference
 * providers into a single, smart, device-aware execution surface.
 *
 * Architecture:
 *   AIProviderRegistry  — discovers all available AI providers on window.*
 *                         and ranks them by capability + device fit
 *   AIInferenceRouter   — selects the best provider for a given task type
 *                         based on device tier, memory pressure, availability
 *   AIExecutionLayer    — wraps RuntimeAIOrchestrator with richer scheduling,
 *                         retries, and per-task telemetry
 *   AIRuntime           — public facade: AIRuntime.run(taskType, payload, opts)
 *
 * Provider chain (priority order for each task type):
 *   AI task routing (summarize/translate/ocr-cleanup/redact/general):
 *     1. RuntimeAIOrchestrator  — Phase 6E, uses its own provider chain
 *     2. GenerativeAiEngine     — Phase 48, multi-provider LLM adapter
 *     3. RuntimeLocalAI         — Phase 9E, ONNX on-device inference
 *     4. RealLocalLlmEngine     — Phase 66, GGUF local LLM
 *     5. HeuristicFallback      — built-in, always available
 *
 *   Image/GPU tasks (background-remove, denoise, threshold):
 *     1. RuntimeGpuEngine       — WebGPU/WebGL/CPU
 *     2. RuntimeWasmEngine      — SIMD WASM / JS fallback
 *
 * BACKWARD COMPATIBLE: All existing AI modules (RuntimeAIOrchestrator,
 * GenerativeAiEngine, RuntimeLocalAI, etc.) are unmodified. AIRuntime
 * only adds a unified facade on top of them.
 *
 * Exposed as: window.AIRuntime, window.AIProviderRegistry,
 *             window.AIInferenceRouter, window.AIExecutionLayer
 */
(function (G) {
  'use strict';

  if (G.AIRuntime) return;

  var VERSION = '1.0.0';
  var LOG     = '[AIR15]';

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 1  DEVICE PROFILE
   * ═══════════════════════════════════════════════════════════════════════════ */
  var _ua        = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var _cores     = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  var _memGB     = (typeof navigator !== 'undefined' && navigator.deviceMemory)  || 4;
  var _isMobile  = /Mobile|Tablet|Android|iPhone|iPad/i.test(_ua);
  var _isIOS     = /iPhone|iPad|iPod/i.test(_ua);
  var _isIOSSafari = _isIOS && !/CriOS|FxiOS|OPiOS/i.test(_ua);

  var DEVICE_TIER = (function () {
    if (_isIOSSafari || _memGB <= 2 || _cores <= 2) return 'low';
    if (_isMobile || _memGB <= 4 || _cores <= 4)    return 'mid';
    return 'high';
  }());

  function _safe(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 2  AI PROVIDER REGISTRY
   * Discovers and ranks all available AI providers at runtime.
   * ═══════════════════════════════════════════════════════════════════════════ */

  var AIProviderRegistry = (function () {

    /* Provider descriptor:
     *   name      — human-readable
     *   global    — window.* key to check for presence
     *   tasks     — task types this provider handles
     *   tier      — 'cloud'|'local-onnx'|'local-llm'|'heuristic'
     *   priority  — lower = preferred (1 = primary)
     *   available — dynamic check function
     *   invoke    — async (taskType, payload, opts) → string|{result}
     */
    var _providers = [

      /* ── 1: RuntimeAIOrchestrator (Phase 6E) ─────────────────────────── */
      {
        name:     'RuntimeAIOrchestrator',
        global:   'RuntimeAIOrchestrator',
        tasks:    ['summarize', 'translate', 'ocr-cleanup', 'smart-redact', 'general'],
        tier:     'orchestrator',
        priority: 1,
        available: function () {
          return !!G.RuntimeAIOrchestrator && typeof G.RuntimeAIOrchestrator.runAiTask === 'function';
        },
        invoke: function (taskType, payload) {
          return G.RuntimeAIOrchestrator.runAiTask(taskType, payload || {});
        },
      },

      /* ── 2: GenerativeAiEngine (Phase 48) ────────────────────────────── */
      {
        name:     'GenerativeAiEngine',
        global:   'GenerativeAiEngine',
        tasks:    ['summarize', 'translate', 'general'],
        tier:     'cloud',
        priority: 2,
        available: function () {
          return !!G.GenerativeAiEngine && typeof G.GenerativeAiEngine.generate === 'function';
        },
        invoke: function (taskType, payload) {
          var text = (payload && (payload.text || payload.prompt)) || '';
          return G.GenerativeAiEngine.generate(text, { intent: taskType })
            .then(function (r) {
              return { result: typeof r === 'string' ? r : (r && r.result) || String(r), provider: 'GenerativeAiEngine' };
            });
        },
      },

      /* ── 3: RuntimeLocalAI (Phase 9E) ────────────────────────────────── */
      {
        name:     'RuntimeLocalAI',
        global:   'RuntimeLocalAI',
        tasks:    ['summarize', 'translate', 'ocr-cleanup'],
        tier:     'local-onnx',
        priority: 3,
        available: function () {
          return !!G.RuntimeLocalAI && typeof G.RuntimeLocalAI.run === 'function'
            && DEVICE_TIER !== 'low';   // skip on low-end devices
        },
        invoke: function (taskType, payload) {
          return G.RuntimeLocalAI.run(taskType, payload || {})
            .then(function (r) { return { result: String(r), provider: 'RuntimeLocalAI' }; });
        },
      },

      /* ── 4: RealLocalLlmEngine (Phase 66) ───────────────────────────── */
      {
        name:     'RealLocalLlmEngine',
        global:   'RealLocalLlmEngine',
        tasks:    ['summarize', 'general'],
        tier:     'local-llm',
        priority: 4,
        available: function () {
          return !!G.RealLocalLlmEngine && typeof G.RealLocalLlmEngine.generate === 'function'
            && DEVICE_TIER === 'high';  // only on high-end devices
        },
        invoke: function (taskType, payload) {
          var text = (payload && (payload.text || payload.prompt)) || '';
          return G.RealLocalLlmEngine.generate(text, { intent: taskType })
            .then(function (r) { return { result: String(r), provider: 'RealLocalLlmEngine' }; });
        },
      },

      /* ── 5: HeuristicFallback (always available) ────────────────────── */
      {
        name:     'HeuristicFallback',
        global:   null,           // always available, no global check
        tasks:    ['summarize', 'translate', 'ocr-cleanup', 'smart-redact', 'general'],
        tier:     'heuristic',
        priority: 99,
        available: function () { return true; },
        invoke: function (taskType, payload) {
          var text = (payload && (payload.text || payload.prompt || payload.content)) || '';
          var result = _heuristicFallback(taskType, text);
          return Promise.resolve({ result: result, provider: 'HeuristicFallback' });
        },
      },
    ];

    /* ── Provider discovery ──────────────────────────────────────────────── */
    function getAvailable() {
      return _providers.filter(function (p) { return _safe(p.available, false); });
    }

    function getForTask(taskType) {
      return getAvailable()
        .filter(function (p) { return p.tasks.indexOf(taskType) !== -1; })
        .sort(function (a, b) { return a.priority - b.priority; });
    }

    function status() {
      return _providers.map(function (p) {
        return {
          name:      p.name,
          tier:      p.tier,
          priority:  p.priority,
          available: _safe(p.available, false),
          tasks:     p.tasks,
        };
      });
    }

    return {
      getAvailable: getAvailable,
      getForTask:   getForTask,
      status:       status,
      DEVICE_TIER:  DEVICE_TIER,
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 3  HEURISTIC FALLBACK
   * Extractive text processing — zero dependencies, always works.
   * ═══════════════════════════════════════════════════════════════════════════ */
  function _heuristicFallback(taskType, text) {
    if (!text) return '';
    switch (taskType) {
      case 'summarize':
        // Extractive: take first 3 sentences
        var sents = text.match(/[^.!?]+[.!?]+/g) || [text];
        return sents.slice(0, 3).join(' ').trim();
      case 'ocr-cleanup':
        // Basic whitespace + hyphenation repair
        return text
          .replace(/(\w)-\n(\w)/g, '$1$2')   // de-hyphenate line breaks
          .replace(/\n{3,}/g, '\n\n')          // collapse excess blank lines
          .replace(/[ \t]{2,}/g, ' ')           // collapse excess spaces
          .trim();
      case 'translate':
        return '[Translation unavailable offline — ' + text.slice(0, 120) + '…]';
      case 'smart-redact':
        return text.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')
                   .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
                   .replace(/\b\d{9}\b|\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
      default:
        return text;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 4  AI INFERENCE ROUTER
   * Selects the best provider for a given task + device + pressure state.
   * ═══════════════════════════════════════════════════════════════════════════ */

  var AIInferenceRouter = (function () {

    /* Route a task through the best available provider chain. */
    function route(taskType, payload, opts) {
      opts = opts || {};
      var providers = AIProviderRegistry.getForTask(taskType);

      if (!providers.length) {
        return Promise.reject(new Error('[AIInferenceRouter] no provider for: ' + taskType));
      }

      // Memory pressure: prefer heuristic if EMERGENCY
      var memTier = _safe(function () {
        return G.RuntimeMemory ? G.RuntimeMemory.getTier() : 'NORMAL';
      }, 'NORMAL');

      if (memTier === 'EMERGENCY') {
        // Force heuristic
        var heuristic = providers.filter(function (p) { return p.tier === 'heuristic'; })[0];
        if (heuristic) {
          console.debug(LOG, 'EMERGENCY memory — forcing heuristic for', taskType);
          return heuristic.invoke(taskType, payload);
        }
      }

      // Walk the chain — first success wins
      return _chain(providers, 0, taskType, payload, opts);
    }

    function _chain(providers, idx, taskType, payload, opts) {
      if (idx >= providers.length) {
        return Promise.resolve({ result: '', provider: 'none', error: 'all providers exhausted' });
      }
      var p = providers[idx];
      return Promise.resolve()
        .then(function () { return p.invoke(taskType, payload, opts); })
        .catch(function (err) {
          console.warn(LOG, p.name, 'failed for', taskType, '—', err.message || err);
          return _chain(providers, idx + 1, taskType, payload, opts);
        });
    }

    /* Route GPU/image task: GpuEngine → WasmEngine → CPU fallback */
    function routeGpu(op, input, opts) {
      var gpu = G.RuntimeGpuEngine;
      if (gpu && typeof gpu.runTask === 'function') {
        return gpu.runTask(op, input, opts || {}).catch(function (err) {
          console.warn(LOG, 'GPU failed, trying WASM:', err.message || err);
          return _wasmOp(op, input, opts);
        });
      }
      return _wasmOp(op, input, opts);
    }

    function _wasmOp(op, input, opts) {
      var wasm = G.RuntimeWasmEngine;
      if (wasm && typeof wasm.execute === 'function') {
        return wasm.execute(op, input, opts || {});
      }
      return Promise.reject(new Error('GPU and WASM both unavailable for: ' + op));
    }

    return {
      route:    route,
      routeGpu: routeGpu,
    };
  }());

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 5  AI EXECUTION LAYER
   * Wraps routing with concurrency limits, telemetry, and cancellation.
   * ═══════════════════════════════════════════════════════════════════════════ */

  var AIExecutionLayer = (function () {

    var MAX_CONCURRENT = 3;
    var _active  = 0;
    var _queue   = [];    // { taskType, payload, opts, resolve, reject, ts }
    var _history = [];    // last 20 completed tasks
    var MAX_HIST = 20;

    function _record(entry) {
      _history.unshift(entry);
      if (_history.length > MAX_HIST) _history.length = MAX_HIST;
    }

    function _telemetry(event, data) {
      _safe(function () {
        if (G.RuntimeTelemetry) G.RuntimeTelemetry.record(event, data);
        if (G.RuntimeEventBus)  G.RuntimeEventBus.emit(event, data);
      });
    }

    function _runNext() {
      if (_active >= MAX_CONCURRENT || !_queue.length) return;
      var item = _queue.shift();
      _active++;
      var ts = Date.now();
      _telemetry('ai:task:started', { taskType: item.taskType, ts: ts });

      AIInferenceRouter.route(item.taskType, item.payload, item.opts)
        .then(function (result) {
          var dur = Date.now() - ts;
          _record({ taskType: item.taskType, provider: (result && result.provider) || 'unknown', durationMs: dur, ok: true, ts: ts });
          _telemetry('ai:task:completed', { taskType: item.taskType, durationMs: dur, provider: result && result.provider });
          item.resolve(result);
        })
        .catch(function (err) {
          var dur = Date.now() - ts;
          _record({ taskType: item.taskType, error: err.message, durationMs: dur, ok: false, ts: ts });
          _telemetry('ai:task:failed', { taskType: item.taskType, durationMs: dur, error: err.message });
          item.reject(err);
        })
        .finally(function () {
          _active--;
          _runNext();
        });
    }

    /**
     * run(taskType, payload, opts) → Promise<{ result, provider }>
     * The primary AI task entry point.
     */
    function run(taskType, payload, opts) {
      return new Promise(function (resolve, reject) {
        _queue.push({ taskType: taskType, payload: payload || {}, opts: opts || {}, resolve: resolve, reject: reject, ts: Date.now() });
        _runNext();
      });
    }

    /** Run a GPU/image operation directly (bypasses text AI queue). */
    function runGpu(op, input, opts) {
      return AIInferenceRouter.routeGpu(op, input, opts);
    }

    function status() {
      return {
        active:   _active,
        queued:   _queue.length,
        history:  _history.slice(0, 5),
        maxConcurrent: MAX_CONCURRENT,
        providers: AIProviderRegistry.status(),
        deviceTier: DEVICE_TIER,
      };
    }

    return { run: run, runGpu: runGpu, status: status };
  }());

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 6  AI RUNTIME (public facade)
   * ═══════════════════════════════════════════════════════════════════════════ */

  var AIRuntime = {
    VERSION:  VERSION,

    /**
     * run(taskType, payload, opts) → Promise<{ result: string, provider: string }>
     *
     * Primary entry point for all AI text tasks.
     * taskType: 'summarize' | 'translate' | 'ocr-cleanup' | 'smart-redact' | 'general'
     * payload:  { text?, prompt?, content?, ... }
     */
    run: function (taskType, payload, opts) {
      return AIExecutionLayer.run(taskType, payload, opts);
    },

    /**
     * runGpu(op, input, opts) → Promise<result>
     * GPU/image operations: 'imgScale' | 'imgGreyscale' | 'imgDenoise' | etc.
     */
    runGpu: function (op, input, opts) {
      return AIExecutionLayer.runGpu(op, input, opts);
    },

    /**
     * route(taskType, payload, opts) → Promise
     * Direct router access (bypasses concurrency queue).
     */
    route: function (taskType, payload, opts) {
      return AIInferenceRouter.route(taskType, payload, opts);
    },

    /** Checks which providers are available for a task type. */
    getProviders: function (taskType) {
      return AIProviderRegistry.getForTask(taskType);
    },

    /** Full AI layer status. */
    status: function () {
      return AIExecutionLayer.status();
    },

    /** DevTools print helper. */
    print: function () {
      var s = AIRuntime.status();
      console.group('[AIRuntime] v' + VERSION + ' — Status');
      console.log('  Device tier:', s.deviceTier);
      console.log('  Active tasks:', s.active, '/ Max:', s.maxConcurrent);
      console.log('  Queued:', s.queued);
      console.log('  Providers:');
      s.providers.forEach(function (p) {
        console.log('    ' + (p.available ? '✓' : '✗') + ' ' + p.name + ' [' + p.tier + '] priority=' + p.priority);
      });
      console.groupEnd();
    },

    /** Subsystem references */
    Registry:  AIProviderRegistry,
    Router:    AIInferenceRouter,
    Execution: AIExecutionLayer,
    DEVICE_TIER: DEVICE_TIER,
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * § 7  BOOT
   * ═══════════════════════════════════════════════════════════════════════════ */

  G.AIRuntime          = AIRuntime;
  G.AIProviderRegistry = AIProviderRegistry;
  G.AIInferenceRouter  = AIInferenceRouter;
  G.AIExecutionLayer   = AIExecutionLayer;

  // Register with RuntimeFederation if available
  _safe(function () {
    if (G.ILovePDFCore && G.ILovePDFCore.REGISTRY) {
      G.ILovePDFCore.REGISTRY.ai.globals.push('AIRuntime');
    }
  });

  console.debug(LOG, 'AIRuntime v' + VERSION + ' ready — device tier:', DEVICE_TIER,
    '— available providers:', AIProviderRegistry.getAvailable().length);

}(window));
