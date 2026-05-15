// RuntimeAIUpgrade v1.0 — Phase 8F
// =====================================================================
// Advanced AI Orchestration upgrade. Patches RuntimeAIOrchestrator
// with provider scoring, latency tracking, adaptive routing,
// batching, structured retry, and analytics.
//
// Does NOT replace RuntimeAIOrchestrator — patches it in-place and
// adds window.RuntimeAIUpgrade for analytics access.
//
// Features:
//   • Provider EMA latency tracking (α = 0.3)
//   • Per-provider success rate tracking
//   • Adaptive routing: prefer lowest p50 latency provider
//   • Offline-first: local providers preferred when navigator.onLine=false
//   • Priority queue: critical > high > normal > background
//   • Task batching: collect text chunks, process as one prompt
//   • Retry strategy: 3 attempts per provider, exponential backoff
//   • Fallback trees: GenerativeAiEngine → LocalAIRuntime → HeuristicFallback
//
// Expose: window.RuntimeAIUpgrade
//   .analytics()    → full provider + queue analytics
//   .resetStats()   → reset provider tracking
//   .getProviders() → current provider list with scores
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeAIUpgrade) return;

  var LOG = '[AIU8F]';

  // ── Provider scoring ───────────────────────────────────────────────────────
  // Map<providerName, { emaLatency, successRate, calls, errors, totalLatency }>
  var _providerStats = new Map();

  function _getProviderStat(name) {
    if (!_providerStats.has(name)) {
      _providerStats.set(name, {
        name:       name,
        emaLatency: 1000,   // initial estimate
        successRate: 1.0,
        calls:      0,
        errors:     0,
        totalLatency: 0,
        lastCallTs:  0,
      });
    }
    return _providerStats.get(name);
  }

  var EMA_ALPHA = 0.3;

  function _recordProviderSuccess(name, latencyMs) {
    var s = _getProviderStat(name);
    s.emaLatency    = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * s.emaLatency;
    s.totalLatency += latencyMs;
    s.calls++;
    s.successRate   = 1 - (s.errors / s.calls);
    s.lastCallTs    = Date.now();
  }

  function _recordProviderError(name) {
    var s = _getProviderStat(name);
    s.errors++;
    s.calls++;
    s.successRate = 1 - (s.errors / s.calls);
    s.lastCallTs  = Date.now();
    // Penalise latency estimate on error
    s.emaLatency = Math.min(s.emaLatency * 1.5, 10000);
  }

  // ── Provider scoring function ─────────────────────────────────────────────
  // Lower score = better. Combines latency + error rate.
  function _providerScore(name) {
    var s = _getProviderStat(name);
    var latencyScore = s.emaLatency;
    var errorPenalty = s.successRate < 0.9 ? (1 - s.successRate) * 5000 : 0;
    return latencyScore + errorPenalty;
  }

  // ── Offline-first provider preference ────────────────────────────────────
  var LOCAL_PROVIDERS = ['LocalAIRuntime', 'RealLocalLlmEngine', 'HeuristicFallback'];

  function _isLocal(providerName) {
    return LOCAL_PROVIDERS.indexOf(providerName) !== -1;
  }

  // ── Sorted provider chain ─────────────────────────────────────────────────
  // Reorders the chain based on scores + online status.
  function _sortedProviderChain(chain) {
    if (!chain || chain.length === 0) return chain;

    var isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    var scored = chain.map(function (p) {
      var score  = _providerScore(p.name);
      // Offline: strongly prefer local providers
      if (!isOnline && !_isLocal(p.name)) score += 50000;
      // Online: HeuristicFallback is always last (unless others are all failing)
      if (isOnline && p.name === 'HeuristicFallback') score += 20000;
      return { p: p, score: score };
    });

    scored.sort(function (a, b) { return a.score - b.score; });
    return scored.map(function (x) { return x.p; });
  }

  // ── Priority queue ────────────────────────────────────────────────────────
  var PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, background: 3 };

  function _insertByPriority(queue, item) {
    var pri = PRIORITY_ORDER[item.priority] !== undefined ? PRIORITY_ORDER[item.priority] : 2;
    item._pri = pri;
    var i = 0;
    while (i < queue.length && queue[i]._pri <= pri) i++;
    queue.splice(i, 0, item);
  }

  // ── Retry with exponential backoff ────────────────────────────────────────
  var MAX_RETRIES = 3;
  var RETRY_BASE_MS = 300;

  function _retryRun(fn, attempt) {
    attempt = attempt || 1;
    return Promise.resolve().then(fn).catch(function (err) {
      if (err && err.message === 'cancelled') throw err;
      if (attempt >= MAX_RETRIES) throw err;
      var delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      return new Promise(function (res) { setTimeout(res, delay); })
        .then(function () { return _retryRun(fn, attempt + 1); });
    });
  }

  // ── Task batcher ──────────────────────────────────────────────────────────
  // For multiple summarize/translate tasks queued within BATCH_WINDOW_MS,
  // combine them into a single prompt to reduce provider round-trips.
  var BATCH_WINDOW_MS = 150;
  var BATCH_MAX_CHARS = 10000;
  var _batchBuffer    = [];  // [{ text, intent, resolve, reject, token }]
  var _batchTimer     = null;

  function _flushBatch(batchItems) {
    if (batchItems.length === 1) {
      // Single item — run normally without batch overhead
      var item = batchItems[0];
      _runScoredTask(item.taskType, item.payload, item.token)
        .then(item.resolve).catch(item.reject);
      return;
    }

    // Multi-item batch: combine texts
    var texts = batchItems.map(function (it, i) {
      return '[ITEM ' + (i + 1) + ']\n' + (it.payload.text || '').slice(0, BATCH_MAX_CHARS / batchItems.length);
    });
    var combinedPayload = { text: texts.join('\n---\n'), batched: true, batchSize: batchItems.length };

    _runScoredTask(batchItems[0].taskType, combinedPayload, null).then(function (res) {
      // Return the same result to all waiting callers
      batchItems.forEach(function (it) { it.resolve(res); });
    }).catch(function (err) {
      batchItems.forEach(function (it) { it.reject(err); });
    });
  }

  function _queueBatch(taskType, payload, token) {
    return new Promise(function (resolve, reject) {
      _batchBuffer.push({ taskType: taskType, payload: payload, token: token, resolve: resolve, reject: reject });

      if (!_batchTimer) {
        _batchTimer = setTimeout(function () {
          _batchTimer = null;
          var batch = _batchBuffer.splice(0);
          _flushBatch(batch);
        }, BATCH_WINDOW_MS);
      }
    });
  }

  // ── Core scored task runner ────────────────────────────────────────────────
  function _runScoredTask(taskType, payload, token) {
    var aorc = global.RuntimeAIOrchestrator;
    if (!aorc) return Promise.reject(new Error('RuntimeAIOrchestrator not loaded'));

    // Get provider chain (we reconstruct it from the orchestrator internals
    // by building a fresh chain with our knowledge of the providers)
    var providerChain = _buildChain();
    var sortedChain   = _sortedProviderChain(providerChain);

    var intent  = taskType;
    var text    = payload.text || payload.prompt || '';
    var opts    = Object.assign({ intent: intent, docContext: text }, payload);
    var prompt  = _buildPrompt(taskType, text, opts);

    // Try providers in scored order
    var attempt = Promise.reject(new Error('no-provider'));
    sortedChain.forEach(function (provider) {
      attempt = attempt.catch(function () {
        if (token && token.cancelled) return Promise.reject(new Error('cancelled'));
        var t0 = Date.now();
        return _retryRun(function () {
          return Promise.resolve(provider.fn(prompt, opts)).then(function (raw) {
            var result = (raw && typeof raw === 'object' && raw.result) ? raw.result
                       : (typeof raw === 'string') ? raw : String(raw || '');
            _recordProviderSuccess(provider.name, Date.now() - t0);
            return { result: result, provider: provider.name, durationMs: Date.now() - t0 };
          });
        }).catch(function (err) {
          _recordProviderError(provider.name);
          throw err;
        });
      });
    });

    return attempt;
  }

  // ── Prompt builder (mirrors orchestrator's) ────────────────────────────────
  function _buildPrompt(taskType, text, opts) {
    var trunc = text.slice(0, 6000);
    switch (taskType) {
      case 'summarize':  return 'Summarize the following document in 3–5 sentences:\n\n' + trunc;
      case 'translate':  return 'Translate to ' + (opts.language || 'English') + ':\n\n' + trunc;
      case 'ocr-cleanup': return 'Clean up OCR text:\n\n' + trunc;
      case 'smart-redact': return 'List all PII in:\n\n' + trunc;
      default: return opts.prompt || trunc;
    }
  }

  // ── Build provider chain from known providers ─────────────────────────────
  function _buildChain() {
    var chain = [];
    var providers = [
      { name: 'GenerativeAiEngine', key: 'GenerativeAiEngine' },
      { name: 'LocalAIRuntime',     key: 'LocalAIRuntime'     },
      { name: 'RealLocalLlmEngine', key: 'RealLocalLlmEngine' },
      { name: 'AiAgentSystem',      key: 'AiAgentSystem'      },
    ];
    providers.forEach(function (p) {
      var eng = global[p.key];
      if (eng && typeof eng.generate === 'function') {
        chain.push({ name: p.name, fn: function (prompt, opts) { return eng.generate(prompt, opts); } });
      }
    });
    // Heuristic fallback always available
    chain.push({
      name: 'HeuristicFallback',
      fn: function (prompt, opts) {
        var text = (opts && opts.docContext) || prompt || '';
        var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        var freq = {};
        (text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
        var scored = sentences.map(function (s) {
          var sw = s.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
          return { s: s.trim(), score: sw.reduce(function (a, w) { return a + (freq[w] || 0); }, 0) / (sw.length || 1) };
        });
        var top = scored.sort(function (a, b) { return b.score - a.score; }).slice(0, 3).map(function (x) { return x.s; });
        return Promise.resolve('Summary: ' + top.join(' '));
      }
    });
    return chain;
  }

  // ── Priority-aware runAiTask replacement ──────────────────────────────────
  var _queue   = [];   // priority-sorted pending tasks
  var _active  = 0;
  var MAX_CONCURRENT = 3;

  function runAiTask(taskType, payload) {
    payload = payload || {};
    var priority = payload.priority || 'normal';
    var token    = payload.token    || null;
    var batchable = (taskType === 'summarize' || taskType === 'translate') &&
                    !payload.batched &&
                    _active === 0;  // only batch when nothing is running

    if (_active < MAX_CONCURRENT) {
      _active++;
      var runner = batchable
        ? _queueBatch(taskType, payload, token)
        : _runScoredTask(taskType, payload, token);
      return runner.finally(function () { _active--; _drainQ(); });
    }

    // Enqueue with priority
    return new Promise(function (resolve, reject) {
      _insertByPriority(_queue, {
        taskType: taskType, payload: payload, priority: priority,
        resolve: resolve, reject: reject, ts: Date.now(),
      });
    });
  }

  function _drainQ() {
    if (_active >= MAX_CONCURRENT || _queue.length === 0) return;
    var item = _queue.shift();
    _active++;
    _runScoredTask(item.taskType, item.payload, item.payload && item.payload.token)
      .then(item.resolve).catch(item.reject)
      .finally(function () { _active--; _drainQ(); });
  }

  // ── Patch RuntimeAIOrchestrator ────────────────────────────────────────────
  function _patch() {
    var aorc = global.RuntimeAIOrchestrator;
    if (!aorc || aorc._upgradePatched) return;

    aorc.runAiTask      = runAiTask;
    aorc._upgradePatched = true;

    // Also patch RT if it has a ref
    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.runAiTask) RT.runAiTask = runAiTask;
    if (RT && RT.register) {
      try { RT.register('aiUpgrade', global.RuntimeAIUpgrade); } catch (_) {}
    }

    console.info(LOG, 'patched RuntimeAIOrchestrator with Phase 8F scored routing + priority queue');
  }

  // ── Analytics ─────────────────────────────────────────────────────────────
  function analytics() {
    var providers = [];
    _providerStats.forEach(function (s) {
      providers.push({
        name:       s.name,
        emaLatencyMs: Math.round(s.emaLatency),
        successRate:  Math.round(s.successRate * 100) + '%',
        calls:      s.calls,
        errors:     s.errors,
        avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatency / s.calls) : null,
        score:      Math.round(_providerScore(s.name)),
        lastCallAgoMs: s.lastCallTs ? Date.now() - s.lastCallTs : null,
      });
    });
    providers.sort(function (a, b) { return a.score - b.score; });
    return {
      providers:      providers,
      activeTasks:    _active,
      queuedTasks:    _queue.length,
      maxConcurrent:  MAX_CONCURRENT,
      batchBuffered:  _batchBuffer.length,
      online:         typeof navigator !== 'undefined' ? navigator.onLine : true,
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    _patch();
    if (global.RuntimeEventBus) {
      global.RuntimeEventBus.once('runtime:ready', function () { setTimeout(_patch, 100); });
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 500);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 500); }, { once: true });
  }

  global.RuntimeAIUpgrade = {
    analytics:    analytics,
    resetStats:   function () { _providerStats.clear(); },
    getProviders: function () { return _buildChain().map(function (p) { return { name: p.name, score: _providerScore(p.name) }; }); },
    runAiTask:    runAiTask,
  };

  console.info(LOG, 'RuntimeAIUpgrade v1.0 ready — scored routing + priority queue + batching active');
}(window));
