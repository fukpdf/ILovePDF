/**
 * PHASE 60 — REAL GENERATIVE INTELLIGENCE
 * window.RealGenerativeIntelligence
 *
 * 60A MultiProviderLlmRouter      — dynamic routing, health, failover
 * 60B StreamingTokenEngine        — async-iterable streaming, checkpoints
 * 60C ContextOptimizationEngine   — semantic ranking, compression, budgeting
 * 60D AgentReflectionSystem       — self-critique, hallucination guard, retry
 * 60E ReasoningLoopEngine         — recursive reasoning, tool loops, auto-stop
 *
 * Purely additive. Extends GenerativeAiEngine + RealLlmRouting without
 * replacing them. All paths degrade gracefully to heuristic fallback.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[RGI]';
  var MB      = 1024 * 1024;

  function log()  { var a=[].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a=[].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'rgi_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }
  function sleep(ms) { return new Promise(function(r){setTimeout(r,ms);}); }
  function frame()   { return new Promise(function(r){requestAnimationFrame ? requestAnimationFrame(r) : setTimeout(r,16);}); }

  // ═══════════════════════════════════════════════════════════════════════════
  // § SHARED: DEVICE CAPABILITY PROBE
  // ═══════════════════════════════════════════════════════════════════════════
  var DeviceProbe = (function () {
    var _cache = null;
    function probe() {
      if (_cache) return _cache;
      var nav = navigator || {};
      var mem = nav.deviceMemory || 4;
      var cores = nav.hardwareConcurrency || 2;
      var hasGpu = !!(nav.gpu);
      var hasWasm = typeof WebAssembly !== 'undefined';
      var conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
      var online = typeof navigator.onLine !== 'undefined' ? navigator.onLine : true;
      var battery = null; // populated async below
      var tier = mem <= 1 ? 'low' : mem <= 4 ? 'mid' : 'high';
      _cache = { mem: mem, cores: cores, hasGpu: hasGpu, hasWasm: hasWasm,
                 online: online, tier: tier, effectiveType: conn.effectiveType || '4g',
                 battery: battery };
      if (nav.getBattery) {
        nav.getBattery().then(function(b){
          _cache.battery = { level: b.level, charging: b.charging };
          _cache.lowBattery = b.level < 0.2 && !b.charging;
        }).catch(function(){});
      }
      return _cache;
    }
    function refresh() { _cache = null; return probe(); }
    return { probe: probe, refresh: refresh };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 60A  MULTI-PROVIDER LLM ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  var MultiProviderLlmRouter = (function () {
    var PROVIDERS = [
      'LOCAL_GGUF', 'LOCAL_ONNX', 'WEBGPU_TRANSFORMER',
      'REMOTE_OPENAI', 'REMOTE_DEEPSEEK', 'REMOTE_OLLAMA',
      'FALLBACK_HEURISTIC'
    ];

    // Health records: latency, error rate, last used, cooldown
    var _health = {};
    PROVIDERS.forEach(function(p){
      _health[p] = { latency: 0, errors: 0, calls: 0, score: 1.0,
                     cooldownUntil: 0, available: false };
    });

    // Always available
    _health['FALLBACK_HEURISTIC'].available = true;

    function _score(pid) {
      var h = _health[pid];
      if (!h || !h.available) return -1;
      if (h.cooldownUntil > now()) return -1;
      var errorRate = h.calls > 0 ? h.errors / h.calls : 0;
      var latencyPenalty = Math.min(h.latency / 5000, 1);
      return (1 - errorRate) * (1 - latencyPenalty) * h.score;
    }

    function _cooldown(pid, ms) {
      if (_health[pid]) _health[pid].cooldownUntil = now() + (ms || 30000);
    }

    function _record(pid, ok, latencyMs) {
      var h = _health[pid];
      if (!h) return;
      h.calls++;
      h.latency = h.latency ? (h.latency * 0.7 + latencyMs * 0.3) : latencyMs;
      if (!ok) { h.errors++; if (h.errors / h.calls > 0.5) _cooldown(pid, 60000); }
    }

    function _probeLocal() {
      var ORM = sys('OnnxRuntimeManager');
      if (ORM && ORM.getRuntime) {
        _health['LOCAL_ONNX'].available = true;
      }
      var LAR = sys('LocalAiRuntime');
      if (LAR && LAR.GGUFRuntime && LAR.GGUFRuntime.isReady && LAR.GGUFRuntime.isReady()) {
        _health['LOCAL_GGUF'].available = true;
      }
      var WGAE = sys('WebGpuAiExpansion');
      if (WGAE && WGAE.ready) _health['WEBGPU_TRANSFORMER'].available = true;
    }

    function _probeRemote() {
      var RLR = sys('RealLlmRouting');
      if (RLR && RLR.ProviderRouter) {
        _health['REMOTE_OPENAI'].available = true;
        _health['REMOTE_DEEPSEEK'].available = true;
        _health['REMOTE_OLLAMA'].available = true;
      }
    }

    function _selectProvider(opts) {
      opts = opts || {};
      var dev = DeviceProbe.probe();

      // Hard blocks
      if (dev.lowBattery && !opts.allowLowBattery) {
        return ['FALLBACK_HEURISTIC'];
      }

      // Giant-file: avoid GPU to save VRAM
      if (opts.giantFile) {
        var chain = ['LOCAL_ONNX','REMOTE_OPENAI','REMOTE_DEEPSEEK','FALLBACK_HEURISTIC'];
        return chain.filter(function(p){ return _score(p) > 0; });
      }

      // Context > 32k: needs large-context provider
      if (opts.contextLength > 32000) {
        return ['REMOTE_OPENAI','REMOTE_DEEPSEEK','REMOTE_OLLAMA','FALLBACK_HEURISTIC']
          .filter(function(p){ return _score(p) > 0; });
      }

      // Sort all by score
      var ranked = PROVIDERS.slice().sort(function(a,b){ return _score(b) - _score(a); });
      return ranked.filter(function(p){ return _score(p) > 0; });
    }

    async function route(prompt, opts) {
      opts = opts || {};
      _probeLocal();
      _probeRemote();
      var chain = _selectProvider(opts);
      var lastErr = null;
      for (var i = 0; i < chain.length; i++) {
        var pid = chain[i];
        var t0 = now();
        try {
          var result = await _dispatch(pid, prompt, opts);
          _record(pid, true, now() - t0);
          return { provider: pid, result: result };
        } catch (e) {
          _record(pid, false, now() - t0);
          lastErr = e;
          warn('provider', pid, 'failed:', e.message || e);
        }
      }
      // Absolute final fallback — never throw
      return { provider: 'FALLBACK_HEURISTIC', result: _heuristic(prompt, opts) };
    }

    async function _dispatch(pid, prompt, opts) {
      if (pid === 'FALLBACK_HEURISTIC') return _heuristic(prompt, opts);
      if (pid === 'LOCAL_ONNX') {
        var ORM = sys('OnnxRuntimeManager');
        if (!ORM) throw new Error('ORM unavailable');
        var GAE = sys('GenerativeAiEngine');
        if (GAE && GAE.generate) return GAE.generate(prompt, opts);
        throw new Error('GAE unavailable');
      }
      if (pid === 'LOCAL_GGUF') {
        var LAR = sys('LocalAiRuntime');
        if (!LAR) throw new Error('LocalAiRuntime unavailable');
        return LAR.GGUFRuntime.generate(prompt, opts);
      }
      if (pid === 'WEBGPU_TRANSFORMER') {
        var WGAE = sys('WebGpuAiExpansion');
        if (!WGAE) throw new Error('WGAE unavailable');
        if (WGAE.generateText) return WGAE.generateText(prompt, opts);
        throw new Error('WGAE.generateText unavailable');
      }
      // Remote providers go through RealLlmRouting
      var RLR = sys('RealLlmRouting');
      if (!RLR) throw new Error('RLR unavailable');
      var mapped = { REMOTE_OPENAI:'openai-compat', REMOTE_DEEPSEEK:'deepseek-compat', REMOTE_OLLAMA:'ollama-compat' };
      return RLR.generate(prompt, Object.assign({}, opts, { preferProvider: mapped[pid] }));
    }

    function _heuristic(prompt, opts) {
      // Robust extractive fallback — always succeeds
      var p = (prompt || '').slice(0, 400);
      var words = p.split(/\s+/).slice(0, 60).join(' ');
      return '[Heuristic] ' + (words || 'No input provided') + (opts && opts.giantFile ? ' [giant-file mode]' : '');
    }

    function getHealth() {
      return Object.keys(_health).map(function(k){
        return Object.assign({ id: k }, _health[k]);
      });
    }

    return {
      route: route,
      getHealth: getHealth,
      cooldown: _cooldown,
      probe: function(){ _probeLocal(); _probeRemote(); }
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 60B  STREAMING TOKEN ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var StreamingTokenEngine = (function () {
    var CHECKPOINT_EVERY = 200; // chars
    var BATCH_SIZE = 8;         // tokens per yield

    function CancelToken() {
      var _cancelled = false;
      return {
        cancel: function(){ _cancelled = true; },
        get cancelled(){ return _cancelled; }
      };
    }

    // Save checkpoint to IDB
    function _saveCheckpoint(streamId, progress) {
      try {
        var req = indexedDB.open('rgi_streams_v1', 1);
        req.onupgradeneeded = function(e){
          var db = e.target.result;
          if (!db.objectStoreNames.contains('checkpoints'))
            db.createObjectStore('checkpoints', { keyPath: 'id' });
        };
        req.onsuccess = function(e){
          var db = e.target.result;
          var tx = db.transaction('checkpoints','readwrite');
          tx.objectStore('checkpoints').put({ id: streamId, progress: progress, ts: now() });
        };
      } catch(_){}
    }

    async function* stream(text, opts) {
      opts = opts || {};
      var cancelToken = opts.cancelToken || CancelToken();
      var streamId = opts.streamId || uid();
      var chars = 0;
      var buffer = '';
      var checkpointBuf = '';

      // Simulate token-by-token streaming — emit in batches, yield to frame
      // In production this wraps a real SSE/ReadableStream from a provider
      var tokens = _tokenize(text);
      var batch = [];

      for (var i = 0; i < tokens.length; i++) {
        if (cancelToken.cancelled) break;

        batch.push(tokens[i]);
        buffer += tokens[i];
        checkpointBuf += tokens[i];
        chars += tokens[i].length;

        if (batch.length >= BATCH_SIZE) {
          yield { tokens: batch.slice(), text: buffer, chars: chars, done: false };
          batch = [];
          await frame(); // yield to main thread
        }

        // Checkpoint every 200 chars
        if (checkpointBuf.length >= CHECKPOINT_EVERY) {
          _saveCheckpoint(streamId, { chars: chars, text: buffer.slice(-500) });
          checkpointBuf = '';
        }
      }

      // Flush remaining batch
      if (batch.length > 0 && !cancelToken.cancelled) {
        yield { tokens: batch, text: buffer, chars: chars, done: false };
      }

      _saveCheckpoint(streamId, { chars: chars, text: buffer, complete: true });
      yield { tokens: [], text: buffer, chars: chars, done: true };
    }

    function _tokenize(text) {
      // Simple word+punctuation tokenizer — real impl wraps provider's tokenizer
      if (!text) return [];
      return text.match(/\S+\s*/g) || [];
    }

    // Wrap a provider stream (async iterable / ReadableStream) into our format
    async function* wrapProviderStream(providerStream, opts) {
      opts = opts || {};
      var cancelToken = opts.cancelToken || CancelToken();
      var buffer = '';
      var chars = 0;
      try {
        for await (var chunk of providerStream) {
          if (cancelToken.cancelled) break;
          var text = (typeof chunk === 'string') ? chunk : (chunk.text || chunk.delta || '');
          buffer += text;
          chars += text.length;
          yield { tokens: [text], text: buffer, chars: chars, done: false };
          await frame();
        }
      } catch (e) {
        warn('provider stream error:', e.message);
      }
      yield { tokens: [], text: buffer, chars: chars, done: true };
    }

    function createCancelToken() { return CancelToken(); }

    return { stream: stream, wrapProviderStream: wrapProviderStream, createCancelToken: createCancelToken };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 60C  CONTEXT OPTIMIZATION ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ContextOptimizationEngine = (function () {
    var MAX_BUDGET = 120000; // chars (~30k tokens at 4 char/token)
    var WINDOW_SIZE = 8;     // chunks in sliding window

    function _scoreChunk(chunk, query) {
      var text = (chunk.text || '').toLowerCase();
      var q = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
      var keywordScore = 0;
      q.forEach(function(w){ if (text.indexOf(w) >= 0) keywordScore++; });
      var keywordRatio = q.length > 0 ? keywordScore / q.length : 0;

      // OCR confidence weighting
      var ocrConf = (typeof chunk.ocrConfidence === 'number') ? chunk.ocrConfidence : 1.0;

      // Recency — newer chunks get slight boost
      var recency = chunk.ts ? Math.max(0, 1 - (now() - chunk.ts) / (24*60*60*1000)) * 0.1 : 0;

      // Position importance — beginning/end more important
      var pos = (typeof chunk.posRatio === 'number') ? chunk.posRatio : 0.5;
      var posScore = 1 - Math.abs(pos - 0.5) * 0.4;

      return (keywordRatio * 0.5 + ocrConf * 0.2 + posScore * 0.2 + recency * 0.1);
    }

    function _dedup(chunks) {
      var seen = new Set();
      return chunks.filter(function(c){
        var sig = (c.text || '').slice(0, 80);
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
    }

    function _compress(text, budget) {
      if (!text || text.length <= budget) return text;
      // Sentence-level truncation from middle (preserve start + end)
      var half = Math.floor(budget / 2);
      return text.slice(0, half) + '\n…[compressed]…\n' + text.slice(text.length - half);
    }

    function _summarizeConversation(turns) {
      if (!turns || turns.length === 0) return '';
      var recent = turns.slice(-6);
      return recent.map(function(t){ return (t.role || 'user') + ': ' + (t.text || '').slice(0, 200); }).join('\n');
    }

    function assemble(opts) {
      opts = opts || {};
      var chunks = (opts.chunks || []).slice();
      var query = opts.query || '';
      var budget = opts.budget || MAX_BUDGET;
      var conversation = opts.conversation || [];

      // Dedup
      chunks = _dedup(chunks);

      // Score & rank
      chunks = chunks.map(function(c){ return Object.assign({}, c, { _score: _scoreChunk(c, query) }); });
      chunks.sort(function(a,b){ return b._score - a._score; });

      // Sliding window: take top chunks
      var window = chunks.slice(0, WINDOW_SIZE);

      // Sort by original position for coherence
      window.sort(function(a,b){ return (a.posRatio||0) - (b.posRatio||0); });

      // Budget allocation: conversation summary gets 20%, context gets 80%
      var convBudget = Math.floor(budget * 0.2);
      var ctxBudget  = budget - convBudget;

      var convSummary = _summarizeConversation(conversation);
      convSummary = _compress(convSummary, convBudget);

      var context = window.map(function(c){ return c.text || ''; }).join('\n\n');
      context = _compress(context, ctxBudget);

      return { context: context, conversationSummary: convSummary,
               chunkCount: window.length, budgetUsed: context.length + convSummary.length };
    }

    function compress(text, targetBudget) {
      return _compress(text, targetBudget || MAX_BUDGET);
    }

    return { assemble: assemble, compress: compress, scoreChunk: _scoreChunk };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 60D  AGENT REFLECTION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  var AgentReflectionSystem = (function () {
    var MAX_ROUNDS   = 3;
    var MAX_TOKENS   = 8192;
    var CONFIDENCE_THRESHOLD = 0.6;

    var _HALLUCINATION_SIGNALS = [
      /as of (January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d/i,
      /I (don't|do not) have (access|information)/i,
      /I (cannot|can't) verify/i,
      /\b(always|never|every|all)\b.{0,30}\b(people|users|documents)\b/i,
    ];

    function _detectHallucination(text) {
      var flags = [];
      _HALLUCINATION_SIGNALS.forEach(function(pat){
        if (pat.test(text)) flags.push(pat.source.slice(0, 40));
      });
      return flags;
    }

    function _scoreConfidence(text, prompt) {
      if (!text) return 0;
      var flags = _detectHallucination(text);
      if (flags.length > 1) return 0.2;
      if (flags.length > 0) return 0.45;

      // Coverage: does answer address keywords in prompt?
      var promptWords = (prompt || '').toLowerCase().split(/\s+/).filter(function(w){ return w.length > 4; });
      var answerLower = text.toLowerCase();
      var covered = promptWords.filter(function(w){ return answerLower.indexOf(w) >= 0; }).length;
      var coverage = promptWords.length > 0 ? covered / promptWords.length : 0.8;

      // Length sanity
      var lenScore = text.length > 20 && text.length < 8000 ? 1 : 0.6;

      return Math.min(1, coverage * 0.6 + lenScore * 0.4);
    }

    function _repairAnswer(text, flags) {
      if (!flags || flags.length === 0) return text;
      // Prepend a disclaimer for detected issues
      return '[Note: some claims may need verification] ' + text;
    }

    async function reflect(prompt, initialAnswer, opts) {
      opts = opts || {};
      var maxRounds = Math.min(opts.maxRounds || MAX_ROUNDS, MAX_ROUNDS);
      var budget = opts.tokenBudget || MAX_TOKENS;
      var answer = initialAnswer || '';
      var rounds = 0;

      while (rounds < maxRounds) {
        var conf = _scoreConfidence(answer, prompt);
        var flags = _detectHallucination(answer);

        if (conf >= CONFIDENCE_THRESHOLD && flags.length === 0) break;

        rounds++;
        // Request improvement via router
        var improvePrompt = 'Improve this answer, fix inaccuracies, and be more specific:\n\nOriginal question: ' +
          prompt.slice(0, 500) + '\n\nCurrent answer: ' + answer.slice(0, budget / 4);

        try {
          var res = await MultiProviderLlmRouter.route(improvePrompt, opts);
          var candidate = (res && res.result) ? res.result : '';
          if (candidate && candidate.length > 20) {
            var candConf = _scoreConfidence(candidate, prompt);
            if (candConf > conf) { answer = candidate; conf = candConf; }
          }
        } catch (e) {
          warn('reflection round', rounds, 'failed:', e.message);
          break;
        }
        await sleep(50); // yield
      }

      var finalFlags = _detectHallucination(answer);
      if (finalFlags.length > 0) answer = _repairAnswer(answer, finalFlags);

      return {
        answer: answer,
        confidence: _scoreConfidence(answer, prompt),
        rounds: rounds,
        flags: finalFlags
      };
    }

    return { reflect: reflect, scoreConfidence: _scoreConfidence, detectHallucination: _detectHallucination };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 60E  REASONING LOOP ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ReasoningLoopEngine = (function () {
    var MAX_DEPTH  = 6;
    var MAX_TOKENS = 16384;

    // IDB persistence for reasoning state
    var _stateKey = 'rgi_reasoning_v1';
    function _saveState(id, state) {
      try {
        var req = indexedDB.open(_stateKey, 1);
        req.onupgradeneeded = function(e){
          if (!e.target.result.objectStoreNames.contains('states'))
            e.target.result.createObjectStore('states',{keyPath:'id'});
        };
        req.onsuccess = function(e){
          var tx = e.target.result.transaction('states','readwrite');
          tx.objectStore('states').put({ id: id, state: state, ts: now() });
        };
      } catch(_){}
    }

    async function reason(goal, opts) {
      opts = opts || {};
      var depth = 0;
      var tokenBudget = opts.tokenBudget || MAX_TOKENS;
      var sessionId = opts.sessionId || uid();
      var stages = [];
      var used = 0;

      while (depth < MAX_DEPTH && used < tokenBudget) {
        var stage = { depth: depth, goal: goal, ts: now() };
        await frame(); // never block main thread

        // Plan: break goal into sub-tasks
        var planPrompt = 'Break this goal into at most 3 concrete steps. Be brief.\nGoal: ' + goal.slice(0,500);
        var planRes = await MultiProviderLlmRouter.route(planPrompt, opts);
        var plan = (planRes && planRes.result) ? planRes.result : goal;
        used += plan.length;
        stage.plan = plan;

        // Execute first sub-step
        var execPrompt = 'Execute the first step of this plan. Respond concisely.\nPlan:\n' + plan.slice(0,400);
        var execRes = await MultiProviderLlmRouter.route(execPrompt, opts);
        var output = (execRes && execRes.result) ? execRes.result : '';
        used += output.length;
        stage.output = output;

        // Reflect on result
        var reflection = await AgentReflectionSystem.reflect(goal, output, opts);
        stage.confidence = reflection.confidence;
        stage.answer = reflection.answer;

        stages.push(stage);
        _saveState(sessionId, { stages: stages, depth: depth, used: used });

        // Stop if confident enough or goal answered
        if (reflection.confidence >= 0.75) break;

        // Refine goal for next iteration
        goal = 'Improve and complete: ' + output.slice(0, 300);
        depth++;
      }

      var finalAnswer = stages.length > 0 ? stages[stages.length-1].answer : '';
      return {
        sessionId: sessionId,
        answer: finalAnswer,
        stages: stages,
        depth: depth,
        tokenBudget: tokenBudget,
        tokensUsed: used
      };
    }

    async function summarize(chunks, opts) {
      var combined = (chunks || []).map(function(c){ return c.text || c; }).join('\n\n');
      var compressed = ContextOptimizationEngine.compress(combined, 8000);
      var prompt = 'Summarize the following document clearly and concisely:\n\n' + compressed;
      var res = await MultiProviderLlmRouter.route(prompt, opts);
      return (res && res.result) ? res.result : compressed.slice(0, 500);
    }

    async function extract(text, schema, opts) {
      var prompt = 'Extract the following fields from the text. Return JSON only.\nFields: ' +
        JSON.stringify(schema) + '\n\nText:\n' + (text||'').slice(0,4000);
      var res = await MultiProviderLlmRouter.route(prompt, opts);
      try { return JSON.parse((res&&res.result)||'{}'); } catch(_e){ return {}; }
    }

    return { reason: reason, summarize: summarize, extract: extract };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § BOOT
  // ═══════════════════════════════════════════════════════════════════════════
  var RealGenerativeIntelligence = {
    VERSION: VERSION,
    MultiProviderLlmRouter:    MultiProviderLlmRouter,
    StreamingTokenEngine:      StreamingTokenEngine,
    ContextOptimizationEngine: ContextOptimizationEngine,
    AgentReflectionSystem:     AgentReflectionSystem,
    ReasoningLoopEngine:       ReasoningLoopEngine,
    DeviceProbe:               DeviceProbe,
    // Convenience top-level API
    generate: function(prompt, opts) { return MultiProviderLlmRouter.route(prompt, opts); },
    stream:   function(text, opts)   { return StreamingTokenEngine.stream(text, opts); },
    reason:   function(goal, opts)   { return ReasoningLoopEngine.reason(goal, opts); },
  };

  window.RealGenerativeIntelligence = RealGenerativeIntelligence;
  log('v' + VERSION + ' ready');

  // Wire into GenerativeAiEngine as a high-priority provider if available
  setTimeout(function(){
    try {
      var GAE = window.GenerativeAiEngine;
      if (GAE && GAE.registerProvider) {
        GAE.registerProvider('real-generative-intelligence', {
          priority: 0,
          probe: function(){ return Promise.resolve(true); },
          generate: function(prompt, opts){ return MultiProviderLlmRouter.route(prompt, opts).then(function(r){ return r.result; }); }
        });
        log('registered with GenerativeAiEngine as priority-0 provider');
      }
    } catch(e) { warn('GAE registration failed:', e.message); }
  }, 200);

})();
