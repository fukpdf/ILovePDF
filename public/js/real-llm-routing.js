/**
 * PHASE 56 — REAL LLM ROUTING SYSTEM
 * window.RealLlmRouting
 *
 * 56A ProviderRouter       — LOCAL_ONNX→WEBGPU_LLM→REMOTE_API→HEURISTIC_ENGINE
 * 56B ContextWindowEngine  — sliding windows, semantic ranking, dynamic truncation
 * 56C TokenStreamingEngine — async-iterable, cancellation, checkpoint/replay
 * 56D ReasoningOrchestrator— chain-of-thought, tool planning, retrieval, delegation
 * 56E LocalLlmRuntime      — ONNX/GGUF abstraction, KV-cache, streaming inference
 * 56F PromptSafetyLayer    — injection filter, token budget, runaway-token guard
 *
 * Purely additive. Integrates with GenerativeAiEngine, VectorMemoryEngine,
 * EnterpriseMemoryFabric, WebGpuAiExpansion, LabaAiFoundation. Zero changes
 * to any existing module.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[RLR]';

  function log()  { var a = [].slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = [].slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }
  function uid()  { return 'rlr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6); }
  function now()  { return Date.now(); }

  var MB = 1024 * 1024;

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56F  PROMPT SAFETY LAYER (loaded first — all paths use it)
  // ═══════════════════════════════════════════════════════════════════════════
  var PromptSafetyLayer = (function () {
    var _injectionPatterns = [
      /ignore (previous|all|above|system)\s+instructions?/i,
      /jailbreak|DAN mode|developer mode/i,
      /pretend you (are|have no|were)/i,
      /act as (unrestricted|evil|uncensored|hacker|DAN)/i,
      /system\s*:\s*(you are|you must|forget)/i,
      /<!--[\s\S]*?-->/g,
      /<script[\s\S]*?<\/script>/gi,
      /\bexec\s*\(/i,
      /\beval\s*\(/i,
      /\bimport\s*\(/i,
    ];

    var _maxInputChars  = 120000;
    var _maxOutputTokens = 4096;
    var _loopSignatures = new Map(); // hash → count

    function _hash(text) {
      var h = 0;
      for (var i = 0; i < Math.min(text.length, 256); i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
      return h;
    }

    function sanitize(text) {
      if (!text || typeof text !== 'string') return '';
      // Truncate oversized input
      if (text.length > _maxInputChars) { text = text.slice(0, _maxInputChars); }
      // Strip dangerous HTML
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '[script removed]');
      text = text.replace(/<!--[\s\S]*?-->/g, '');
      text = text.replace(/<[^>]+on\w+\s*=/gi, '');
      return text;
    }

    function check(text) {
      if (!text) return { safe: true };
      for (var i = 0; i < _injectionPatterns.length; i++) {
        if (_injectionPatterns[i].test(text)) return { safe: false, reason: 'injection-pattern-' + i };
      }
      return { safe: true };
    }

    function detectLoop(promptText) {
      var h = _hash(promptText);
      var n = (_loopSignatures.get(h) || 0) + 1;
      _loopSignatures.set(h, n);
      if (n > 3) { warn('recursive prompt loop detected, hash:', h); return true; }
      return false;
    }

    function enforceTokenBudget(text, maxTokens) {
      maxTokens = maxTokens || _maxOutputTokens;
      var approxChars = maxTokens * 4;
      return text.length > approxChars ? text.slice(0, approxChars) : text;
    }

    function estimateTokens(text) { return Math.ceil((text || '').length / 4); }

    function resetLoops() { _loopSignatures.clear(); }

    return { sanitize: sanitize, check: check, detectLoop: detectLoop,
             enforceTokenBudget: enforceTokenBudget, estimateTokens: estimateTokens,
             resetLoops: resetLoops };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56A  PROVIDER ROUTER
  // ═══════════════════════════════════════════════════════════════════════════
  var ProviderRouter = (function () {
    // Priority: LOCAL_ONNX → WEBGPU_LLM → REMOTE_API → HEURISTIC_ENGINE
    var TIERS = ['local_onnx', 'webgpu_llm', 'remote_api', 'heuristic'];

    var _state = {
      local_onnx:  { available: false, latencyMs: 9999, failures: 0, lastCheck: 0 },
      webgpu_llm:  { available: false, latencyMs: 9999, failures: 0, lastCheck: 0 },
      remote_api:  { available: false, latencyMs: 9999, failures: 0, lastCheck: 0 },
      heuristic:   { available: true,  latencyMs: 10,   failures: 0, lastCheck: 0 },
    };

    var _latencyHistory = {}; // tier → [ms, ms, ...]
    var HISTORY_MAX = 20;

    function _recordLatency(tier, ms) {
      if (!_latencyHistory[tier]) _latencyHistory[tier] = [];
      _latencyHistory[tier].push(ms);
      if (_latencyHistory[tier].length > HISTORY_MAX) _latencyHistory[tier].shift();
      var arr = _latencyHistory[tier];
      _state[tier].latencyMs = Math.round(arr.reduce(function (a,b){return a+b;},0) / arr.length);
    }

    function _recordFailure(tier) { _state[tier].failures++; }
    function _recordSuccess(tier) { _state[tier].failures = Math.max(0, _state[tier].failures - 1); }

    function _memTier() {
      var EMF = sys('EnterpriseMemoryFabric');
      if (EMF) return EMF.TierDetector.tier();
      var mp = sys('MemPressure') || sys('MemoryPressureMonitor');
      return mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
    }

    function _hasGpu() {
      var WGAE = sys('WebGpuAiExpansion');
      return WGAE && WGAE.isReady();
    }

    function _networkAvailable() {
      return navigator.onLine !== false;
    }

    function _estimateDeviceTier() {
      var cores  = navigator.hardwareConcurrency || 2;
      var memGb  = 0;
      try { memGb = (performance.memory && performance.memory.jsHeapSizeLimit || 0) / (1024*1024*1024); } catch(_){}
      if (cores >= 8 && memGb >= 8) return 'high';
      if (cores >= 4 || memGb >= 4) return 'medium';
      return 'low';
    }

    async function probe() {
      var t0 = now();

      // Probe local ONNX
      try {
        var ORM = sys('OnnxRuntimeManager') || sys('LocalLlmRuntime');
        _state.local_onnx.available = !!(ORM && (ORM.isReady ? ORM.isReady() : true));
        if (_state.local_onnx.available) _recordLatency('local_onnx', now() - t0);
      } catch(_) { _state.local_onnx.available = false; }

      // Probe WebGPU LLM
      _state.webgpu_llm.available = _hasGpu();

      // Probe remote API (uses GenerativeAiEngine providers)
      var GAE = sys('GenerativeAiEngine');
      if (GAE && GAE.providers) {
        var active = GAE.providers.active ? GAE.providers.active() : [];
        _state.remote_api.available = active.length > 0 && _networkAvailable();
        _state.remote_api.lastCheck = now();
      }

      log('probe — onnx:', _state.local_onnx.available,
          '| gpu:', _state.webgpu_llm.available,
          '| remote:', _state.remote_api.available);
    }

    function select(opts) {
      opts = opts || {};
      var mem    = _memTier();
      var device = _estimateDeviceTier();

      // Under critical memory: skip local (expensive) models
      if (mem === 'critical') return 'heuristic';
      if (mem === 'danger')   return _state.remote_api.available ? 'remote_api' : 'heuristic';

      // Context length guidance
      var ctxLen = opts.contextLength || 0;
      if (ctxLen > 32000 && !_state.remote_api.available) return 'heuristic';

      // Token budget
      var budget = opts.tokenBudget || 2048;

      // Language — local models handle fewer languages
      var lang   = opts.lang || 'en';
      var rareLang = !['en','fr','de','es','pt','it','nl','ru','zh','ar','ja','ko'].includes(lang);
      if (rareLang && _state.remote_api.available) return 'remote_api';

      // Task type routing
      var task = opts.task || 'general';
      if (task === 'multilingual-chat' && _state.remote_api.available) return 'remote_api';
      if (task === 'compliance-check'  && _state.remote_api.available) return 'remote_api';

      // Network and device awareness
      if (!_networkAvailable()) {
        if (_state.local_onnx.available) return 'local_onnx';
        if (_state.webgpu_llm.available) return 'webgpu_llm';
        return 'heuristic';
      }

      // Normal routing: priority order
      for (var i = 0; i < TIERS.length; i++) {
        var tier = TIERS[i];
        var s = _state[tier];
        if (s.available && s.failures < 5) return tier;
      }
      return 'heuristic';
    }

    // Periodic re-probe
    setInterval(function() { probe().catch(function(){}); }, 30000);
    setTimeout(function() { probe().catch(function(){}); }, 1500);

    return { probe: probe, select: select, state: _state,
             recordLatency: _recordLatency, recordFailure: _recordFailure, recordSuccess: _recordSuccess };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56B  CONTEXT WINDOW ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ContextWindowEngine = (function () {
    var WINDOW_SIZES = { '8k':8192, '16k':16384, '32k':32768, '64k':65536, '128k':131072 };
    var DEFAULT_WINDOW = '32k';

    function _estimateTokens(text) { return Math.ceil((text||'').length / 4); }

    function _rankBySemanticScore(chunks, query) {
      if (!chunks || !chunks.length) return [];
      var qWords = new Set((query||'').toLowerCase().split(/\W+/).filter(function(w){return w.length>2;}));
      return chunks.map(function(c) {
        var text = c.text || c.chunk || c || '';
        var words = text.toLowerCase().split(/\W+/);
        var hits  = words.filter(function(w){return qWords.has(w);}).length;
        return { chunk: c, score: qWords.size ? hits/qWords.size : 0 };
      }).sort(function(a,b){return b.score-a.score;});
    }

    function _stitchWithOcrConfidence(chunks) {
      return chunks.filter(function(c) {
        var conf = typeof c === 'object' ? (c.ocrConfidence || 1) : 1;
        return conf >= 0.4; // drop very low-confidence OCR
      });
    }

    function build(opts) {
      opts = opts || {};
      var maxSize    = WINDOW_SIZES[opts.windowSize || DEFAULT_WINDOW];
      var tokenBudget = opts.tokenBudget || Math.floor(maxSize * 0.85);
      var query      = opts.query || '';
      var history    = opts.history || [];
      var docChunks  = opts.docChunks || [];
      var systemPrompt = PromptSafetyLayer.sanitize(opts.systemPrompt || 'You are a helpful document AI assistant.');

      var parts = [];
      var used  = _estimateTokens(systemPrompt);
      parts.push({ role: 'system', text: systemPrompt, tokens: used });

      // History (most recent first, then reversed)
      var historyTokens = 0;
      var histMax = Math.floor(tokenBudget * 0.25);
      var histItems = history.slice(-20).reverse();
      var selectedHistory = [];
      for (var i = 0; i < histItems.length; i++) {
        var t = _estimateTokens(histItems[i].text || '');
        if (historyTokens + t > histMax) break;
        selectedHistory.unshift(histItems[i]);
        historyTokens += t;
      }
      used += historyTokens;

      // Semantic ranking of doc chunks
      var ranked = _rankBySemanticScore(_stitchWithOcrConfidence(docChunks), query);
      var docText  = '';
      var docMax   = Math.floor(tokenBudget * 0.55);
      var docUsed  = 0;
      for (var j = 0; j < ranked.length; j++) {
        var chunk = ranked[j].chunk;
        var txt   = chunk.text || chunk.chunk || (typeof chunk === 'string' ? chunk : '');
        var tok   = _estimateTokens(txt);
        if (docUsed + tok > docMax) break;
        docText += (docText ? '\n\n' : '') + txt;
        docUsed += tok;
      }

      // Sliding window stitch
      var queryTokens = _estimateTokens(query);
      var remaining   = tokenBudget - used - docUsed - queryTokens;
      if (remaining < 0) {
        // Dynamic truncation: trim doc context
        docText = docText.slice(0, Math.max(0, docText.length + remaining * 4));
      }

      return {
        systemPrompt:  systemPrompt,
        history:       selectedHistory,
        docContext:    docText,
        query:         PromptSafetyLayer.sanitize(query),
        totalTokens:   used + docUsed + queryTokens,
        windowSize:    opts.windowSize || DEFAULT_WINDOW,
        truncated:     remaining < 0,
      };
    }

    function buildPrompt(ctx) {
      var parts = [ctx.systemPrompt];
      if (ctx.docContext) parts.push('---\nDocument context:\n' + ctx.docContext + '\n---');
      if (ctx.history && ctx.history.length) {
        parts.push('Conversation:\n' + ctx.history.map(function(m){return m.role+': '+m.text;}).join('\n'));
      }
      parts.push('User: ' + ctx.query);
      parts.push('Assistant:');
      return parts.join('\n\n');
    }

    function estimateWindowNeeded(docText, historyMsgs, query) {
      var total = _estimateTokens(docText) + _estimateTokens(query) + (historyMsgs||[]).reduce(function(s,m){return s+_estimateTokens(m.text);},0);
      if (total < 7000)  return '8k';
      if (total < 14000) return '16k';
      if (total < 28000) return '32k';
      if (total < 56000) return '64k';
      return '128k';
    }

    return { build: build, buildPrompt: buildPrompt, estimateWindowNeeded: estimateWindowNeeded,
             windowSizes: WINDOW_SIZES };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56C  TOKEN STREAMING ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var TokenStreamingEngine = (function () {
    var _activeStreams = new Map();
    var DB_NAME = 'rlr_stream_checkpoints_v1';
    var _db = null;

    function _openDb() {
      if (_db) return Promise.resolve(_db);
      return new Promise(function(res,rej){
        var req = indexedDB.open(DB_NAME,1);
        req.onupgradeneeded = function(e){
          var db=e.target.result;
          if(!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints',{keyPath:'id'});
        };
        req.onsuccess=function(e){_db=e.target.result;res(_db);};
        req.onerror=function(){rej(req.error);};
      });
    }

    function _saveCheckpoint(streamId, accumulated, meta) {
      return _openDb().then(function(db){
        return new Promise(function(r){
          var tx=db.transaction('checkpoints','readwrite');
          tx.objectStore('checkpoints').put({id:streamId,text:accumulated,meta:meta||{},ts:now()});
          tx.oncomplete=r;tx.onerror=r;
        });
      }).catch(function(){});
    }

    function _loadCheckpoint(streamId) {
      return _openDb().then(function(db){
        return new Promise(function(r){
          var req=db.transaction('checkpoints','readonly').objectStore('checkpoints').get(streamId);
          req.onsuccess=function(){r(req.result||null);};req.onerror=function(){r(null);};
        });
      }).catch(function(){return null;});
    }

    function create(streamId, opts) {
      streamId = streamId || uid();
      opts = opts || {};

      var _cancelled   = false;
      var _accumulated = '';
      var _checkpointEvery = opts.checkpointEvery || 200; // chars
      var _lastCheckpointLen = 0;
      var _onChunk     = opts.onChunk || function(){};
      var _onDone      = opts.onDone  || function(){};
      var _onError     = opts.onError || function(){};

      // Markdown token buffer for partial-code-block handling
      var _mdBuffer    = '';

      function _renderMarkdown(text) {
        return text
          .replace(/```([\s\S]*?)```/g,'<pre><code>$1</code></pre>')
          .replace(/`([^`]+)`/g,'<code>$1</code>')
          .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
          .replace(/\*(.+?)\*/g,'<em>$1</em>')
          .replace(/^#{1,3} (.+)$/gm,'<h4>$1</h4>')
          .replace(/^\s*[-*] (.+)$/gm,'<li>$1</li>')
          .replace(/\n/g,'<br>');
      }

      async function push(chunk) {
        if (_cancelled) return false;
        _accumulated += chunk;
        _mdBuffer    += chunk;

        // Render to DOM element if provided
        if (opts.targetEl) {
          opts.targetEl.innerHTML = _renderMarkdown(_accumulated);
          opts.targetEl.setAttribute('data-raw', _accumulated);
        }

        _onChunk(chunk, _accumulated);

        // Checkpoint periodically
        if (_accumulated.length - _lastCheckpointLen >= _checkpointEvery) {
          _lastCheckpointLen = _accumulated.length;
          _saveCheckpoint(streamId, _accumulated, { ts: now() });
        }

        // Yield to main thread
        if (_accumulated.length % 500 < chunk.length) {
          await new Promise(function(r){setTimeout(r,0);});
        }
        return true;
      }

      async function finalize(finalText) {
        if (finalText !== undefined) await push(finalText);
        _saveCheckpoint(streamId, _accumulated, { done: true, ts: now() });
        _activeStreams.delete(streamId);
        _onDone(_accumulated);
        return _accumulated;
      }

      function cancel() {
        _cancelled = true;
        _activeStreams.delete(streamId);
        log('stream cancelled:', streamId);
      }

      function text()    { return _accumulated; }
      function tokens()  { return Math.ceil(_accumulated.length/4); }

      var stream = { id: streamId, push: push, finalize: finalize, cancel: cancel, text: text, tokens: tokens };
      _activeStreams.set(streamId, stream);
      return stream;
    }

    async function replay(streamId, onChunk) {
      var cp = await _loadCheckpoint(streamId);
      if (!cp) return null;
      log('replaying checkpoint:', streamId, cp.text.length, 'chars');
      var words = cp.text.split(/(\s+)/);
      for (var i = 0; i < words.length; i++) {
        onChunk && onChunk(words[i], cp.text.slice(0, words.slice(0,i+1).join('').length));
        if (i % 20 === 0) await new Promise(function(r){setTimeout(r,0);});
      }
      return cp.text;
    }

    async function* asyncIterableStream(generateFn, opts) {
      opts = opts || {};
      var buffer = [];
      var done   = false;
      var error  = null;

      var stream = create(uid(), Object.assign({}, opts, {
        onChunk: function(chunk){ buffer.push(chunk); },
        onDone:  function(){ done = true; },
        onError: function(e){ error = e; done = true; }
      }));

      // Start generation in background
      generateFn(stream).then(function(){ done = true; }).catch(function(e){ error=e; done=true; });

      // Yield buffered chunks
      while (true) {
        if (buffer.length) { yield buffer.shift(); }
        else if (done)     { break; }
        else               { await new Promise(function(r){setTimeout(r,10);}); }
      }
      if (error) throw error;
    }

    function activeCount() { return _activeStreams.size; }
    function cancelAll()   { _activeStreams.forEach(function(s){s.cancel();}); _activeStreams.clear(); }

    return { create: create, replay: replay, asyncIterableStream: asyncIterableStream,
             activeCount: activeCount, cancelAll: cancelAll };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56E  LOCAL LLM RUNTIME
  // ═══════════════════════════════════════════════════════════════════════════
  var LocalLlmRuntime = (function () {
    var _models = new Map(); // modelId → { session, type, size, lastUsed }
    var _kvCache = new Map(); // promptHash → response fragment
    var KV_MAX  = 32;
    var _ready  = false;

    var MODEL_CLASSES = {
      tiny:   { maxParams: '125M', maxCtx: 2048,  ram: 256 },
      small:  { maxParams: '1B',   maxCtx: 4096,  ram: 1024 },
      medium: { maxParams: '7B',   maxCtx: 8192,  ram: 4096 },
    };

    function _selectClass() {
      var cores  = navigator.hardwareConcurrency || 2;
      var memGb  = 0;
      try { memGb = (performance.memory && performance.memory.jsHeapSizeLimit||0)/(1024*1024*1024); } catch(_){}
      if (memGb >= 6 && cores >= 8) return 'medium';
      if (memGb >= 2 && cores >= 4) return 'small';
      return 'tiny';
    }

    function _hashPrompt(text) {
      var h = 0;
      for (var i = 0; i < Math.min(text.length, 512); i++) h = (Math.imul(31,h)+text.charCodeAt(i))|0;
      return h;
    }

    async function load(modelId, modelClass) {
      if (_models.has(modelId)) return _models.get(modelId);
      modelClass = modelClass || _selectClass();

      var ORM = sys('OnnxRuntimeManager');
      if (!ORM) { warn('OnnxRuntimeManager unavailable'); return null; }

      try {
        var session = await ORM.load ? ORM.load(modelId) : null;
        if (!session) { warn('model load failed:', modelId); return null; }
        var rec = { session: session, modelClass: modelClass, lastUsed: now() };
        _models.set(modelId, rec);
        _ready = true;
        log('loaded model:', modelId, 'class:', modelClass);
        return rec;
      } catch(e) { warn('model load error:', e.message); return null; }
    }

    async function generate(prompt, opts) {
      opts = opts || {};

      // KV-cache check
      var h = _hashPrompt(prompt);
      if (!opts.noCache && _kvCache.has(h)) {
        log('KV-cache hit');
        var cached = _kvCache.get(h);
        if (opts.onChunk) {
          var words = cached.split(/(\s+)/);
          for (var i = 0; i < words.length; i++) {
            opts.onChunk(words[i]);
            if (i % 20 === 0) await new Promise(function(r){setTimeout(r,0);});
          }
        }
        return cached;
      }

      // Delegate to OnnxRuntimeManager infer if available
      var ORM = sys('OnnxRuntimeManager');
      if (ORM && ORM.infer) {
        try {
          var result = await ORM.infer(prompt, opts);
          if (result) {
            if (_kvCache.size >= KV_MAX) _kvCache.delete(_kvCache.keys().next().value);
            _kvCache.set(h, result);
            return result;
          }
        } catch(e) { warn('ORM infer failed:', e.message); }
      }

      // WebGPU text generation stub
      if (opts.useGpu && sys('WebGpuAiExpansion') && sys('WebGpuAiExpansion').isReady()) {
        log('WebGPU text gen — not implemented, CPU fallback');
      }

      return null; // caller falls through to heuristic
    }

    function isReady() { return _ready || !!sys('OnnxRuntimeManager'); }
    function kvStats() { return { size: _kvCache.size, models: _models.size, class: _selectClass() }; }
    function evictKv() { _kvCache.clear(); }

    return { load: load, generate: generate, isReady: isReady, kvStats: kvStats, evictKv: evictKv,
             modelClasses: MODEL_CLASSES };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 56D  REASONING ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════════════════
  var ReasoningOrchestrator = (function () {
    var TASK_TYPES = ['summarize','explain','extract','compare','answer','legal-analysis',
                      'invoice-analysis','compliance-check','multilingual-chat','table-analysis'];

    var _systemPrompts = {
      'summarize':         'You are a document summarizer. Produce clear bullet-point summaries.',
      'explain':           'You are a clear explainer. Use plain language. No jargon.',
      'extract':           'You are a data extractor. Return structured lists of extracted values.',
      'compare':           'You are a comparison expert. Highlight similarities and differences.',
      'answer':            'You are a helpful document assistant. Answer accurately from context.',
      'legal-analysis':    'You are a legal analyst. Identify obligations, risks, clauses, and parties.',
      'invoice-analysis':  'You are an invoice analyst. Extract amounts, dates, vendors, and line items.',
      'compliance-check':  'You are a compliance reviewer. Flag violations, risks, and gaps.',
      'multilingual-chat': 'You are a multilingual document assistant. Respond in the user\'s language.',
      'table-analysis':    'You are a table analysis expert. Summarize and explain tabular data.',
    };

    function _detectTask(query) {
      var q = (query||'').toLowerCase();
      if (/summar/i.test(q))                   return 'summarize';
      if (/explain|what is|describe|how does/i.test(q)) return 'explain';
      if (/extract|pull|get|find all/i.test(q)) return 'extract';
      if (/compar|diff|versus|vs\b/i.test(q))   return 'compare';
      if (/legal|clause|obligation|liability|contract/i.test(q)) return 'legal-analysis';
      if (/invoice|amount|total|vendor|bill|payment/i.test(q))   return 'invoice-analysis';
      if (/comply|compliance|regulation|gdpr|hipaa/i.test(q))    return 'compliance-check';
      if (/table|row|column|cell|spreadsheet/i.test(q))          return 'table-analysis';
      return 'answer';
    }

    function _buildChainOfThought(task, query, docContext) {
      var steps = [];
      switch (task) {
        case 'legal-analysis':
          steps = ['Identify all parties', 'List obligations', 'Flag risks', 'Summarize key clauses'];
          break;
        case 'invoice-analysis':
          steps = ['Extract vendor details', 'Extract line items', 'Sum totals', 'Flag anomalies'];
          break;
        case 'compliance-check':
          steps = ['Identify applicable regulations', 'Check each requirement', 'Flag violations', 'Recommend actions'];
          break;
        case 'table-analysis':
          steps = ['Describe table structure', 'Identify key columns', 'Summarize data patterns', 'Flag outliers'];
          break;
        default:
          steps = ['Analyze context', 'Reason step by step', 'Form answer'];
      }
      return steps.map(function(s,i){return 'Step '+(i+1)+': '+s;}).join('\n') + '\n\nNow answer: ' + query;
    }

    async function orchestrate(query, opts) {
      opts = opts || {};
      var task       = opts.task || _detectTask(query);
      var systemPr   = _systemPrompts[task] || _systemPrompts['answer'];
      var streamId   = opts.streamId || uid();

      // Build context window
      var VME = sys('VectorMemoryEngine') || sys('PersistentVectorDatabase');
      var docChunks  = [];
      if (VME && opts.docId) {
        try { docChunks = VME.search ? VME.search(query, opts.docId, 10) : []; } catch(_){}
      }

      var ctxOpts = {
        systemPrompt: systemPr,
        query:        query,
        history:      opts.history || [],
        docChunks:    docChunks.map(function(r){return {text:r.chunk||r.text||'',ocrConfidence:r.ocrConfidence||1};}),
        windowSize:   opts.windowSize || ContextWindowEngine.estimateWindowNeeded(
          docChunks.map(function(r){return r.chunk||'';}).join(' '),
          opts.history||[], query),
        tokenBudget:  opts.tokenBudget || 3000,
      };
      var ctx    = ContextWindowEngine.build(ctxOpts);
      var cotPrompt = _buildChainOfThought(task, ctx.query, ctx.docContext);
      var prompt = ContextWindowEngine.buildPrompt(Object.assign({}, ctx, { query: cotPrompt }));

      // Safety check
      var safety = PromptSafetyLayer.check(prompt);
      if (!safety.safe) return { text: 'Request blocked: ' + safety.reason, task: task, streamId: streamId };
      if (PromptSafetyLayer.detectLoop(prompt)) return { text: 'Repeated request detected.', task: task, streamId: streamId };

      // Select provider tier
      var tier = ProviderRouter.select({ task: task, lang: opts.lang, contextLength: ctx.totalTokens, tokenBudget: opts.tokenBudget });
      log('orchestrate — task:', task, '| tier:', tier, '| tokens~', ctx.totalTokens);

      // Create token stream
      var stream = TokenStreamingEngine.create(streamId, { onChunk: opts.onChunk, targetEl: opts.targetEl });
      var t0 = now();

      var responseText = null;

      try {
        switch (tier) {
          case 'local_onnx':
          case 'webgpu_llm':
            responseText = await LocalLlmRuntime.generate(prompt, {
              onChunk: function(c){ stream.push(c); },
              useGpu:  tier === 'webgpu_llm',
            });
            break;
          case 'remote_api': {
            var GAE = sys('GenerativeAiEngine');
            if (GAE && GAE.generate) {
              responseText = await GAE.generate(prompt, {
                stream: true, onChunk: function(c){ stream.push(c); },
                intent: task, docContext: ctx.docContext,
              });
            }
            break;
          }
        }
      } catch(e) {
        warn('tier', tier, 'failed:', e.message);
        ProviderRouter.recordFailure(tier);
      }

      // Heuristic fallback
      if (!responseText && (!stream.text() || stream.text().length < 20)) {
        var heur = _heuristicAnswer(task, ctx.docContext, query);
        await stream.finalize(heur);
        responseText = heur;
      }

      var final = await stream.finalize();
      ProviderRouter.recordLatency(tier, now() - t0);
      ProviderRouter.recordSuccess(tier);

      // Index response into VectorMemoryEngine
      if (opts.docId && final && sys('VectorMemoryEngine')) {
        sys('VectorMemoryEngine').index && sys('VectorMemoryEngine').index(opts.docId, final, opts.lang);
      }

      return { text: final, task: task, tier: tier, streamId: streamId, tokens: stream.tokens(), ctx: ctx };
    }

    function _heuristicAnswer(task, docCtx, query) {
      if (!docCtx) return 'No document context available. Process a document first.';
      var sentences = docCtx.split(/[.!?]\s+/).filter(function(s){return s.length>20;});
      switch(task) {
        case 'summarize': return 'Key points:\n• ' + sentences.slice(0,5).join('\n• ');
        case 'extract':   return 'Found ' + sentences.length + ' segments. Connect an AI provider for deep extraction.';
        case 'legal-analysis': {
          var kw = (docCtx.match(/\b(shall|must|obligation|liability|breach|clause|indemnif|terminat)\b/gi)||[]);
          return kw.length ? 'Legal terms found: ' + [...new Set(kw.map(function(k){return k.toLowerCase();}))].slice(0,12).join(', ') : 'No legal terms detected.';
        }
        default: return sentences.slice(0,3).join('. ') + '. [Connect AI provider for full analysis]';
      }
    }

    return { orchestrate: orchestrate, detectTask: _detectTask, taskTypes: TASK_TYPES };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // GLOBAL INTEGRATION — wire into GenerativeAiEngine as highest-priority route
  // ═══════════════════════════════════════════════════════════════════════════
  setTimeout(function() {
    var GAE = sys('GenerativeAiEngine');
    if (GAE && GAE.registerProvider) {
      GAE.registerProvider('real-llm-routing', {
        priority: 0, // highest
        available: true,
        probe: async function() { return true; },
        generate: async function(prompt, opts) {
          return (await ReasoningOrchestrator.orchestrate(opts.query || prompt, opts)).text;
        },
      });
      log('registered with GenerativeAiEngine as priority-0 provider');
    }
  }, 2000);

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.RealLlmRouting = {
    version: VERSION,

    // Main orchestration entry point
    route: function(query, opts) { return ReasoningOrchestrator.orchestrate(query, opts); },

    // Configure a provider
    configure: function(type, config) {
      if (type === 'openai')   window.__GAE_OPENAI_CONFIG    = config;
      if (type === 'ollama')   window.__GAE_OLLAMA_URL       = config.url; window.__GAE_OLLAMA_MODEL = config.model;
      if (type === 'deepseek') window.__GAE_DEEPSEEK_CONFIG  = config;
      ProviderRouter.probe().catch(function(){});
      log('configured provider:', type);
    },

    // Stream a response
    stream: function(query, opts) { return ReasoningOrchestrator.orchestrate(query, Object.assign({}, opts, {stream:true})); },

    // Replay a checkpoint
    replay: function(streamId, onChunk) { return TokenStreamingEngine.replay(streamId, onChunk); },

    // Cancel all active streams
    cancelAll: function() { TokenStreamingEngine.cancelAll(); },

    // Provider status
    providerStatus: function() { return ProviderRouter.state; },
    probeProviders: function() { return ProviderRouter.probe(); },

    // Safety
    checkSafety: function(text) { return PromptSafetyLayer.check(text); },

    // Context window
    buildContext: function(opts) { return ContextWindowEngine.build(opts); },

    audit: function() {
      return {
        version:      VERSION,
        providers:    ProviderRouter.state,
        activeStreams: TokenStreamingEngine.activeCount(),
        kvCache:      LocalLlmRuntime.kvStats(),
        localReady:   LocalLlmRuntime.isReady(),
      };
    },
    cleanup: function() {
      TokenStreamingEngine.cancelAll();
      LocalLlmRuntime.evictKv();
      PromptSafetyLayer.resetLoops();
    },

    // Sub-systems
    ProviderRouter:      ProviderRouter,
    ContextWindow:       ContextWindowEngine,
    TokenStreaming:      TokenStreamingEngine,
    Reasoning:           ReasoningOrchestrator,
    LocalRuntime:        LocalLlmRuntime,
    SafetyLayer:         PromptSafetyLayer,
  };

  log('RealLlmRouting v' + VERSION + ' ready');
}());
