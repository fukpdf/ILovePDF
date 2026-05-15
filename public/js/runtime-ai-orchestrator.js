// ILovePDF — RuntimeAIOrchestrator v1.0 — Phase 6E
// =====================================================================
// Wires CentralRuntime.runAiTask() to real AI inference providers.
//
// Provider chain (in priority order):
//   1. GenerativeAiEngine   (window.GenerativeAiEngine.generate)
//   2. LocalAIRuntime       (window.LocalAIRuntime.generate)
//   3. RealLocalLlmEngine   (window.RealLocalLlmEngine.generate)
//   4. HeuristicFallback    (built-in extractive summarizer — always available)
//
// Task types:
//   summarize    → intent 'summarize', used by ai-summarize tool
//   translate    → intent 'translate', used by translate tool
//   ocr-cleanup  → intent 'cleanup',  used by OCR post-processing
//   smart-redact → intent 'redact',   used by smart redact tool
//   general      → intent 'general',  generic text generation
//
// Queue:
//   - Max 3 concurrent AI tasks (configurable)
//   - Background-priority tasks yield to high/normal
//   - Per-task cancellation via RuntimeCancellation tokens
//   - Each task emits telemetry: ai:task:started / completed / failed
//
// Integrates: CentralRuntime, RuntimeTelemetry, RuntimeEventBus,
//             RuntimeCancellation, RuntimeState, GenerativeAiEngine
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeAIOrchestrator) return;

  var LOG          = '[AIORCH]';
  var MAX_CONCURRENT = 3;

  // ── Active task counter ───────────────────────────────────────────────────
  var _active  = 0;
  var _queue   = [];  // { taskType, payload, resolve, reject, token, ts }
  var _history = [];  // last 20 completed tasks (no PII)
  var _MAX_HIST = 20;

  function _safe(fn, def) { try { return fn(); } catch (_) { return def; } }

  // ── Intent mapping ────────────────────────────────────────────────────────
  var INTENT_MAP = {
    'summarize':     'summarize',
    'translate':     'translate',
    'ocr-cleanup':   'cleanup',
    'smart-redact':  'redact',
    'general':       'general',
  };

  // ── Provider chain ────────────────────────────────────────────────────────
  // Each provider must expose: generate(prompt, opts) → Promise<string|{result}>
  function _buildProviderChain() {
    var chain = [];

    // 1. GenerativeAiEngine (primary — multi-provider with its own fallback)
    var GAE = global.GenerativeAiEngine;
    if (GAE && typeof GAE.generate === 'function') {
      chain.push({ name: 'GenerativeAiEngine', fn: function (prompt, opts) { return GAE.generate(prompt, opts); } });
    }

    // 2. LocalAIRuntime (ONNX / WebGPU local models)
    var LAR = global.LocalAIRuntime;
    if (LAR && typeof LAR.generate === 'function') {
      chain.push({ name: 'LocalAIRuntime', fn: function (prompt, opts) { return LAR.generate(prompt, opts); } });
    }

    // 3. RealLocalLlmEngine (GGUF / llama.cpp bridge)
    var RLLE = global.RealLocalLlmEngine;
    if (RLLE && typeof RLLE.generate === 'function') {
      chain.push({ name: 'RealLocalLlmEngine', fn: function (prompt, opts) { return RLLE.generate(prompt, opts); } });
    }

    // 4. AiAgentSystem document processing
    var AAS = global.AiAgentSystem;
    if (AAS && typeof AAS.dispatch === 'function') {
      chain.push({ name: 'AiAgentSystem', fn: function (prompt, opts) {
        return AAS.dispatch(opts.intent || 'summarize', { text: prompt, opts: opts })
          .then(function (r) { return (r && r.result) ? r.result : String(r); });
      }});
    }

    // 5. Heuristic fallback (always available — extractive, no network)
    chain.push({ name: 'HeuristicFallback', fn: _heuristicGenerate });

    return chain;
  }

  // ── Heuristic fallback ────────────────────────────────────────────────────
  // Pure extractive summarizer. Works 100% locally, no worker needed.
  function _heuristicGenerate(prompt, opts) {
    var intent = (opts && opts.intent) || 'general';
    var text   = (opts && opts.docContext) || prompt || '';

    if (!text || text.length < 20) {
      return Promise.resolve('[No text available for processing]');
    }

    // Extractive: score sentences by keyword frequency
    var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    var words     = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    var freq      = {};
    words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });

    var scored = sentences.map(function (s) {
      var sw = s.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      var score = sw.reduce(function (acc, w) { return acc + (freq[w] || 0); }, 0);
      return { s: s.trim(), score: sw.length ? score / sw.length : 0 };
    });

    var maxSent = intent === 'summarize' ? 3 : 2;
    var top = scored.slice()
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, maxSent)
      .map(function (x) { return x.s; });

    var prefix = intent === 'summarize' ? 'Summary: ' :
                 intent === 'translate' ? '[Translation unavailable — local only] ' : '';

    return Promise.resolve(prefix + top.join(' '));
  }

  // ── Core runner ───────────────────────────────────────────────────────────
  function _runTask(taskType, payload) {
    var intent  = INTENT_MAP[taskType] || 'general';
    var text    = payload.text || payload.prompt || '';
    var opts    = Object.assign({ intent: intent, docContext: text }, payload);
    var token   = payload.token || null;
    var startTs = Date.now();

    // Build prompt from task type
    var prompt = _buildPrompt(taskType, text, opts);

    // Telemetry: started
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('ai:task:started', { taskType: taskType, textLen: text.length }); } catch (_) {}
    }
    if (global.RuntimeEventBus) {
      try { global.RuntimeEventBus.emit('ai:task:started', { taskType: taskType }); } catch (_) {}
    }
    if (global.RuntimeState) {
      try { global.RuntimeState.inc('activeTasks'); } catch (_) {}
    }

    var chain = _buildProviderChain();
    var providerUsed = 'none';

    // Try each provider in order
    var attempt = Promise.reject(new Error('no-provider'));
    chain.forEach(function (provider) {
      attempt = attempt.catch(function () {
        // Check cancellation before each provider attempt
        if (token && token.cancelled) return Promise.reject(new Error('cancelled'));
        providerUsed = provider.name;
        return Promise.resolve(provider.fn(prompt, opts)).then(function (raw) {
          // Normalise result
          if (raw && typeof raw === 'object' && raw.result) return raw.result;
          if (typeof raw === 'string') return raw;
          return String(raw || '');
        });
      });
    });

    return attempt.then(function (result) {
      var durationMs = Date.now() - startTs;

      // Telemetry: completed
      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('ai:task:completed', {
          taskType: taskType, provider: providerUsed, durationMs: durationMs,
        }); } catch (_) {}
      }
      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('ai:task:completed', { taskType: taskType, provider: providerUsed }); } catch (_) {}
      }

      var hist = { taskType: taskType, provider: providerUsed, durationMs: durationMs, ts: Date.now() };
      _history.push(hist);
      if (_history.length > _MAX_HIST) _history.shift();

      return { result: result, provider: providerUsed, durationMs: durationMs };

    }).catch(function (err) {
      var durationMs = Date.now() - startTs;
      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('ai:task:failed', { taskType: taskType, error: err.message }); } catch (_) {}
      }
      if (global.RuntimeEventBus) {
        try { global.RuntimeEventBus.emit('ai:task:failed', { taskType: taskType, error: err.message }); } catch (_) {}
      }
      throw err;

    }).finally(function () {
      if (global.RuntimeState) {
        try { global.RuntimeState.dec('activeTasks'); } catch (_) {}
      }
    });
  }

  // ── Prompt builder ────────────────────────────────────────────────────────
  function _buildPrompt(taskType, text, opts) {
    var trunc = text.slice(0, 6000); // stay within typical context limits
    switch (taskType) {
      case 'summarize':
        return 'Summarize the following document in 3–5 sentences:\n\n' + trunc;
      case 'translate':
        var lang = opts.language || opts.targetLanguage || 'English';
        return 'Translate the following text to ' + lang + ':\n\n' + trunc;
      case 'ocr-cleanup':
        return 'Clean up the following OCR-extracted text, fixing obvious errors and formatting:\n\n' + trunc;
      case 'smart-redact':
        return 'Identify all personally identifiable information (PII) in the following text and list each occurrence:\n\n' + trunc;
      default:
        return (opts.prompt || trunc);
    }
  }

  // ── Queue-aware public entry point ────────────────────────────────────────
  function runAiTask(taskType, payload) {
    payload = payload || {};

    // Validate
    if (!taskType) return Promise.reject(new Error('taskType required'));
    if (!INTENT_MAP[taskType]) {
      // Allow unknown task types through as 'general'
      taskType = 'general';
    }

    // If under concurrent limit, run immediately
    if (_active < MAX_CONCURRENT) {
      _active++;
      return _runTask(taskType, payload).finally(function () {
        _active--;
        _drainQueue();
      });
    }

    // Queue it
    return new Promise(function (resolve, reject) {
      _queue.push({ taskType: taskType, payload: payload, resolve: resolve, reject: reject, ts: Date.now() });
      if (global.RuntimeTelemetry) {
        try { global.RuntimeTelemetry.record('ai:task:queued', { taskType: taskType, queueDepth: _queue.length }); } catch (_) {}
      }
    });
  }

  function _drainQueue() {
    if (_active >= MAX_CONCURRENT || _queue.length === 0) return;
    var item = _queue.shift();
    _active++;
    _runTask(item.taskType, item.payload)
      .then(item.resolve)
      .catch(item.reject)
      .finally(function () {
        _active--;
        _drainQueue();
      });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  function getStats() {
    var chain = _buildProviderChain();
    return {
      activeTasks:   _active,
      queuedTasks:   _queue.length,
      maxConcurrent: MAX_CONCURRENT,
      providers:     chain.map(function (p) { return p.name; }),
      history:       _history.slice(-5),
    };
  }

  // ── Wire into CentralRuntime ───────────────────────────────────────────────
  function _wireCentralRuntime() {
    var RT = global.CentralRuntime || global.RT;
    if (!RT) return;

    // Replace the stub with the real implementation
    RT.runAiTask = runAiTask;
    if (global.RT && global.RT !== RT) global.RT.runAiTask = runAiTask;

    if (RT.register) {
      try { RT.register('aiOrchestrator', global.RuntimeAIOrchestrator); } catch (_) {}
    }

    // Check how many providers we have
    var chain = _buildProviderChain();
    var realProviders = chain.filter(function (p) { return p.name !== 'HeuristicFallback'; });
    console.info(LOG, 'wired into CentralRuntime.runAiTask() — providers:', chain.map(function (p) { return p.name; }).join(', '));
    if (realProviders.length === 0) {
      console.warn(LOG, 'No real AI providers available — HeuristicFallback only. For full AI: ensure GenerativeAiEngine is loaded.');
    }
  }

  function _boot() {
    _wireCentralRuntime();
    if (global.RuntimeEventBus) {
      global.RuntimeEventBus.once('runtime:ready', function () { setTimeout(_wireCentralRuntime, 50); });
    }
    global.addEventListener('rt:runtime:ready', function () { setTimeout(_wireCentralRuntime, 50); }, { once: true });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 150);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 150); }, { once: true });
  }

  global.RuntimeAIOrchestrator = {
    runAiTask:   runAiTask,
    getStats:    getStats,
    taskTypes:   Object.keys(INTENT_MAP),
  };

  console.info(LOG, 'RuntimeAIOrchestrator v1.0 ready — Phase 6E AI orchestration active');
}(window));
