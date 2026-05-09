/**
 * PHASE 48 — TRUE GENERATIVE AI LAYER
 * window.GenerativeAiEngine
 *
 * Provider adapter architecture. ONNX local + external API providers.
 * Streaming inference, context windows, memory-aware routing.
 * Purely additive. No hardcoded APIs. Degrades gracefully.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[GAE]';

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  PROVIDER REGISTRY
  // ═══════════════════════════════════════════════════════════════════════════
  var ProviderRegistry = (function () {
    var _providers = new Map();

    function register(id, provider) {
      _providers.set(id, Object.assign({ id: id, priority: 5, available: false }, provider));
      log('provider registered:', id);
    }

    function get(id)  { return _providers.get(id) || null; }
    function list()   { return Array.from(_providers.values()).sort(function (a,b) { return a.priority - b.priority; }); }
    function active() { return list().filter(function (p) { return p.available; }); }
    function setAvailable(id, v) { var p = _providers.get(id); if (p) p.available = v; }

    // Probe all providers on init
    async function probe() {
      for (var p of _providers.values()) {
        try {
          if (p.probe) { var ok = await p.probe(); setAvailable(p.id, ok); }
        } catch (_) { setAvailable(p.id, false); }
      }
      log('providers available:', active().map(function (p) { return p.id; }).join(', ') || 'none (heuristic mode)');
    }

    return { register: register, get: get, list: list, active: active, probe: probe, setAvailable: setAvailable };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  BUILT-IN PROVIDERS
  // ═══════════════════════════════════════════════════════════════════════════

  // 2a — ONNX Local Provider (uses OnnxRuntimeManager)
  ProviderRegistry.register('onnx-local', {
    priority: 1,
    probe: async function () {
      var ORM = sys('OnnxRuntimeManager');
      return !!(ORM && ORM.getRuntime && await ORM.getRuntime());
    },
    generate: async function (prompt, opts) {
      // ONNX text generation requires a decoder model; return heuristic if unavailable
      warn('onnx-local: no decoder model loaded, routing to heuristic');
      return null;
    },
  });

  // 2b — OpenAI-compatible provider (configured via window.__GAE_OPENAI_ENDPOINT)
  ProviderRegistry.register('openai-compat', {
    priority: 2,
    probe: async function () {
      var cfg = window.__GAE_OPENAI_CONFIG || {};
      if (!cfg.endpoint && !cfg.apiKey) return false;
      try {
        var r = await fetch((cfg.endpoint || 'https://api.openai.com') + '/v1/models', {
          headers: { 'Authorization': 'Bearer ' + (cfg.apiKey || '') },
          signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
        });
        return r.ok;
      } catch (_) { return false; }
    },
    generate: async function (prompt, opts) {
      var cfg    = window.__GAE_OPENAI_CONFIG || {};
      var url    = (cfg.endpoint || 'https://api.openai.com') + '/v1/chat/completions';
      var body   = { model: cfg.model || 'gpt-3.5-turbo', stream: !!opts.stream,
        messages: [{ role: 'system', content: 'You are a helpful document AI assistant.' }, { role: 'user', content: prompt }],
        max_tokens: opts.maxTokens || 1024, temperature: opts.temperature || 0.3 };

      if (!opts.stream) {
        var r = await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+(cfg.apiKey||'') }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('openai ' + r.status);
        var j = await r.json();
        return j.choices?.[0]?.message?.content || '';
      }

      // Streaming SSE
      var r2 = await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json','Authorization':'Bearer '+(cfg.apiKey||'') }, body: JSON.stringify(body) });
      if (!r2.ok) throw new Error('openai-stream ' + r2.status);
      var reader = r2.body.getReader(); var dec = new TextDecoder(); var full = '';
      while (true) {
        var _r = await reader.read();
        if (_r.done) break;
        var lines = dec.decode(_r.value).split('\n');
        for (var line of lines) {
          if (!line.startsWith('data:')) continue;
          var data = line.slice(5).trim();
          if (data === '[DONE]') break;
          try {
            var chunk = JSON.parse(data).choices?.[0]?.delta?.content || '';
            if (chunk) { full += chunk; opts.onChunk && opts.onChunk(chunk); }
          } catch (_) {}
        }
      }
      return full;
    },
  });

  // 2c — Ollama-compatible provider (local LLM)
  ProviderRegistry.register('ollama-compat', {
    priority: 3,
    probe: async function () {
      var url = (window.__GAE_OLLAMA_URL || 'http://localhost:11434') + '/api/tags';
      try { var r = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined }); return r.ok; } catch (_) { return false; }
    },
    generate: async function (prompt, opts) {
      var url  = (window.__GAE_OLLAMA_URL || 'http://localhost:11434') + '/api/generate';
      var body = { model: window.__GAE_OLLAMA_MODEL || 'llama3.2:1b', prompt: prompt, stream: !!opts.stream };
      if (!opts.stream) {
        var r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (!r.ok) throw new Error('ollama ' + r.status);
        var j = await r.json(); return j.response || '';
      }
      var r2  = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      var reader = r2.body.getReader(); var dec = new TextDecoder(); var full = '';
      while (true) {
        var _r = await reader.read(); if (_r.done) break;
        dec.decode(_r.value).split('\n').filter(Boolean).forEach(function (line) {
          try { var d = JSON.parse(line); if (d.response) { full += d.response; opts.onChunk && opts.onChunk(d.response); } } catch (_) {}
        });
      }
      return full;
    },
  });

  // 2d — DeepSeek-compatible (same OpenAI schema)
  ProviderRegistry.register('deepseek-compat', {
    priority: 4,
    probe: async function () { return !!(window.__GAE_DEEPSEEK_CONFIG && window.__GAE_DEEPSEEK_CONFIG.apiKey); },
    generate: async function (prompt, opts) {
      var cfg = window.__GAE_DEEPSEEK_CONFIG || {};
      // Re-use openai-compat logic with deepseek endpoint
      var saved = window.__GAE_OPENAI_CONFIG;
      window.__GAE_OPENAI_CONFIG = { endpoint: 'https://api.deepseek.com', apiKey: cfg.apiKey, model: cfg.model || 'deepseek-chat' };
      var result = await ProviderRegistry.get('openai-compat').generate(prompt, opts);
      window.__GAE_OPENAI_CONFIG = saved;
      return result;
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  CONTEXT WINDOW MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var ContextWindowManager = (function () {
    var _limits = { 'onnx-local':4096, 'openai-compat':16000, 'ollama-compat':8192, 'deepseek-compat':32000, 'default':4096 };

    function getLimit(providerId) { return _limits[providerId] || _limits['default']; }

    function trim(prompt, providerId) {
      var limit  = getLimit(providerId) * 4; // chars ≈ tokens*4
      if (prompt.length <= limit) return prompt;
      // Keep system prefix + last portion of context
      var half = Math.floor(limit * 0.6);
      return prompt.slice(0, 500) + '\n\n[... context trimmed ...]\n\n' + prompt.slice(prompt.length - half);
    }

    return { getLimit: getLimit, trim: trim };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  ADAPTIVE MODEL SELECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var AdaptiveModelSelector = (function () {
    function select(opts) {
      opts = opts || {};
      var providers = ProviderRegistry.active();
      if (!providers.length) return null;

      // Choose by intent / RAM pressure
      var mp   = sys('MemPressure');
      var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      if (tier === 'danger' || tier === 'critical') {
        // Prefer local / smallest
        return providers.find(function (p) { return p.id === 'onnx-local'; }) || providers[0];
      }
      // Prefer by priority
      return providers[0];
    }
    return { select: select };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  PROMPT OPTIMIZER
  // ═══════════════════════════════════════════════════════════════════════════
  var PromptOptimizer = (function () {
    var _systemPrompts = {
      summarize:      'You are a document summarizer. Produce a clear, concise summary in bullet points.',
      translate:      'You are a professional translator. Translate accurately preserving tone and structure.',
      extract_entity: 'You are a data extractor. Extract all names, dates, amounts, and identifiers in a structured list.',
      legal_analysis: 'You are a legal analyst. Identify obligations, liabilities, risks, and key clauses.',
      explain:        'You are a clear explainer. Explain in plain language suitable for a non-expert.',
      compare:        'You are a document comparison expert. Highlight similarities and differences clearly.',
      rewrite:        'You are a professional editor. Rewrite for clarity and conciseness.',
      generate_email: 'You are a business writer. Draft a professional email based on the document content.',
      general:        'You are a helpful document AI assistant. Answer based on the provided context.',
    };

    function build(userPrompt, docContext, intent, history) {
      var sys = _systemPrompts[intent] || _systemPrompts['general'];
      var parts = [sys];
      if (docContext) parts.push('---\nDocument context:\n' + docContext + '\n---');
      if (history)   parts.push('Conversation history:\n' + history);
      parts.push('User: ' + userPrompt + '\nAssistant:');
      return parts.join('\n\n');
    }

    return { build: build };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  HALLUCINATION GUARD + SAFETY LAYER
  // ═══════════════════════════════════════════════════════════════════════════
  var SafetyLayer = (function () {
    var _blocked = [/ignore (previous|all|above|system)/i, /jailbreak/i, /pretend you are/i, /act as.*(unrestricted|evil|hacker)/i];

    function check(text) {
      if (!text) return { safe: true };
      for (var i = 0; i < _blocked.length; i++) {
        if (_blocked[i].test(text)) return { safe: false, reason: 'blocked-pattern' };
      }
      return { safe: true };
    }

    function grounded(response, context) {
      if (!context || !response) return true;
      var respWords = new Set(response.toLowerCase().split(/\W+/));
      var ctxWords  = new Set(context.toLowerCase().split(/\W+/));
      var overlap   = [...respWords].filter(function (w) { return ctxWords.has(w) && w.length > 3; }).length;
      return overlap > 5; // at least 5 meaningful words overlap
    }

    return { check: check, grounded: grounded };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  GENERATION CACHE
  // ═══════════════════════════════════════════════════════════════════════════
  var GenerationCache = (function () {
    var _cache = new Map();
    var MAX    = 50;

    function key(prompt)  { return prompt.slice(0, 120); }
    function get(prompt)  { return _cache.get(key(prompt)) || null; }
    function set(prompt, response) {
      if (_cache.size >= MAX) _cache.delete(_cache.keys().next().value);
      _cache.set(key(prompt), response);
    }
    function clear() { _cache.clear(); }
    return { get: get, set: set, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  INFERENCE SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════
  var InferenceScheduler = (function () {
    var _pending = 0;
    var MAX_CONCURRENT = 2;

    async function schedule(fn) {
      while (_pending >= MAX_CONCURRENT) await new Promise(function (r) { setTimeout(r, 100); });
      _pending++;
      try { return await fn(); } finally { _pending--; }
    }

    return { schedule: schedule, pending: function () { return _pending; } };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 9  RESPONSE REPAIR ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var ResponseRepairEngine = (function () {
    function repair(text) {
      if (!text) return '';
      // Remove truncated sentences at the end
      var last = text.lastIndexOf('.');
      if (last > text.length - 80 || last === -1) return text;
      // Remove clearly truncated mid-sentence endings
      if (text.length > 100 && !/[.!?]$/.test(text.trim())) {
        var idx = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'));
        if (idx > text.length * 0.6) return text.slice(0, idx + 1).trim();
      }
      return text;
    }
    return { repair: repair };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 10  PROVIDER FALLBACK CHAIN
  // ═══════════════════════════════════════════════════════════════════════════
  var ProviderFallbackChain = (function () {
    async function generate(prompt, opts) {
      opts = opts || {};
      var providers = ProviderRegistry.active();

      for (var i = 0; i < providers.length; i++) {
        var provider = providers[i];
        var trimmed  = ContextWindowManager.trim(prompt, provider.id);
        try {
          var result = await provider.generate(trimmed, opts);
          if (result) {
            var repaired = ResponseRepairEngine.repair(result);
            GenerationCache.set(prompt, repaired);
            return repaired;
          }
        } catch (e) {
          warn('provider', provider.id, 'failed:', e.message);
          ProviderRegistry.setAvailable(provider.id, false);
        }
      }
      return null; // all providers failed
    }
    return { generate: generate };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 11  CONVERSATION STATE MANAGER
  // ═══════════════════════════════════════════════════════════════════════════
  var ConversationStateManager = (function () {
    var _states = new Map(); // sessionId → { turnCount, lastIntent, summary }

    function get(sessionId) {
      if (!_states.has(sessionId)) _states.set(sessionId, { turnCount: 0, lastIntent: null, summary: '' });
      return _states.get(sessionId);
    }

    function advance(sessionId, intent) {
      var s = get(sessionId);
      s.turnCount++;
      s.lastIntent = intent;
    }

    function clear(sessionId) { _states.delete(sessionId); }
    return { get: get, advance: advance, clear: clear };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 12  TOKEN STREAMING ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  var TokenStreamingEngine = (function () {
    async function stream(text, onChunk, delayMs) {
      delayMs = delayMs || 10;
      var words = text.split(/(\s+)/);
      for (var i = 0; i < words.length; i++) {
        onChunk(words[i]);
        if (i % 4 === 0) await new Promise(function (r) { setTimeout(r, delayMs); });
      }
    }
    return { stream: stream };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 13  HEURISTIC FALLBACK (no provider available)
  // ═══════════════════════════════════════════════════════════════════════════
  var HeuristicFallback = (function () {
    function _extractSummary(context) {
      var sentences = context.split(/[.!?]\s+/).filter(function (s) { return s.length > 30; });
      return sentences.slice(0, 6).join('. ') + (sentences.length > 6 ? '.' : '') || 'No extractable content found.';
    }

    function generate(prompt, intent, docContext) {
      switch (intent) {
        case 'summarize':
          return 'Here is an extractive summary:\n\n' + _extractSummary(docContext || '').slice(0, 600) + '\n\n*Connect an AI provider (OpenAI, Ollama, DeepSeek) for generative summaries.*';
        case 'translate':
          return 'Translation requires a configured AI provider or the Translate tool. Please use the translate tool for full document translation.';
        case 'extract_entity':
          var found = (docContext || '').match(/\b([A-Z][a-z]+ [A-Z][a-z]+|\$[\d,]+\.?\d*|\d{4}[-\/]\d{2}[-\/]\d{2}|\b[A-Z]{2,}\d{4,})\b/g) || [];
          return found.length ? 'Extracted: ' + [...new Set(found)].slice(0,20).join(', ') : 'No entities detected. Connect an AI provider for deeper extraction.';
        case 'legal_analysis':
          var kw = (docContext || '').match(/\b(shall|must|obligation|liable|warranty|indemnif|terminat|breach|clause)\b/gi) || [];
          return kw.length ? 'Legal terms found: ' + [...new Set(kw)].join(', ') + '.\n\nConnect an AI provider for full analysis.' : 'No legal terms found with pattern analysis.';
        default:
          return docContext ? 'Document loaded (' + docContext.length + ' chars). Connect an AI provider for advanced reasoning.' : 'No document context available. Process a document first.';
      }
    }

    return { generate: generate };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  // Probe providers after a short delay (non-blocking)
  setTimeout(function () { ProviderRegistry.probe().catch(function () {}); }, 3000);

  window.GenerativeAiEngine = {
    version: VERSION,

    // Configure a provider at runtime
    configure: function (providerId, config) {
      var key = '__GAE_' + providerId.toUpperCase().replace(/-/g,'_') + '_CONFIG';
      window[key] = config;
      ProviderRegistry.probe().catch(function () {});
    },

    // Register a custom provider
    registerProvider: function (id, adapter) { ProviderRegistry.register(id, adapter); },

    // Main generate entry point
    generate: async function (prompt, opts) {
      opts = opts || {};

      // Safety check
      var safety = SafetyLayer.check(prompt);
      if (!safety.safe) { warn('blocked prompt:', safety.reason); return 'I cannot process that request.'; }

      // Check cache (non-streaming only)
      if (!opts.stream) {
        var cached = GenerationCache.get(prompt);
        if (cached) return cached;
      }

      // Build optimized prompt
      var optimized = PromptOptimizer.build(prompt, opts.docContext || '', opts.intent || 'general', opts.history || '');

      // Schedule inference
      var result = await InferenceScheduler.schedule(function () { return ProviderFallbackChain.generate(optimized, opts); });

      // Heuristic fallback
      if (!result) {
        var heuristic = HeuristicFallback.generate(prompt, opts.intent || 'general', opts.docContext || '');
        if (opts.stream && opts.onChunk) await TokenStreamingEngine.stream(heuristic, opts.onChunk, 8);
        return heuristic;
      }

      // Stream result if needed but provider didn't stream
      if (opts.stream && opts.onChunk && typeof result === 'string') {
        // Already streamed inline; return accumulated
      }

      if (opts.sessionId) ConversationStateManager.advance(opts.sessionId, opts.intent || 'general');
      return result;
    },

    // Providers management
    providers:       ProviderRegistry,
    getActiveProvider: function () { return AdaptiveModelSelector.select(); },

    // Stats / audit
    audit: function () {
      return {
        version:       VERSION,
        providers:     ProviderRegistry.list().map(function (p) { return { id: p.id, available: p.available }; }),
        pendingInfer:  InferenceScheduler.pending(),
        cacheSize:     GenerationCache._cache ? GenerationCache._cache.size : 0,
      };
    },
    cleanup: function () { GenerationCache.clear(); ConversationStateManager._states && ConversationStateManager._states.clear(); },

    // Sub-systems
    ContextWindowMgr:  ContextWindowManager,
    PromptOptimizer:   PromptOptimizer,
    StreamingEngine:   TokenStreamingEngine,
    SafetyLayer:       SafetyLayer,
    ResponseRepair:    ResponseRepairEngine,
  };

  log('GenerativeAiEngine v' + VERSION + ' ready');
}());
