/**
 * PHASE 44 — LABA AI FOUNDATION
 * window.LabaAiFoundation
 *
 * AI-native document assistant foundation.
 * Purely additive. Integrates with ONNX, OCR, Translation, WorkflowChain.
 * Degrades gracefully at every layer.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[LAB]', ...a); }
  function warn(...a) { console.warn('[LAB]', ...a); }

  const EMBEDDING_DIM = 384;  // MiniLM-L6 output dimension
  const MAX_CONTEXT_TOKENS = 2048;
  const CHUNK_WORDS = 200;

  // ─────────────────────────────────────────────────────────────
  // 1. UnifiedDocumentContext
  // ─────────────────────────────────────────────────────────────
  const UnifiedDocumentContext = (() => {
    const _docs = new Map(); // docId → context

    function create(docId) {
      const ctx = {
        docId,
        ocrText:    '',
        translated: '',
        tables:     [],
        layout:     [],
        metadata:   {},
        embeddings: null,
        summary:    '',
        pageEmbeddings: [],
        createdAt:  Date.now(),
        updatedAt:  Date.now(),
      };
      _docs.set(docId, ctx);
      return ctx;
    }

    function get(docId) { return _docs.get(docId) || null; }

    function update(docId, patch) {
      const ctx = _docs.get(docId);
      if (!ctx) return;
      Object.assign(ctx, patch);
      ctx.updatedAt = Date.now();
    }

    function merge(docId, source) {
      // Pull from WorkflowChainEngine SharedDocumentContext if available
      const wceCtx = window.WorkflowChainEngine?.SharedDocumentContext?.get?.(docId);
      if (wceCtx) {
        update(docId, {
          ocrText:    wceCtx.ocrText    || '',
          translated: wceCtx.translated || '',
          tables:     wceCtx.tables     || [],
          summary:    wceCtx.summary    || '',
        });
      }
      if (source) update(docId, source);
      return get(docId);
    }

    function destroy(docId) { _docs.delete(docId); }

    function list() { return [..._docs.keys()]; }

    return { create, get, update, merge, destroy, list };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. EmbeddingEngine — ONNX or heuristic fallback
  // ─────────────────────────────────────────────────────────────
  const EmbeddingEngine = (() => {
    const MINILM_URL = 'https://huggingface.co/onnx-community/all-MiniLM-L6-v2-ONNX/resolve/main/model.onnx';
    let _session = null;
    let _loadPromise = null;

    async function _loadModel() {
      if (_session) return _session;
      if (_loadPromise) return _loadPromise;
      _loadPromise = (async () => {
        const ort = window.OnnxRuntimeManager?.getRuntime?.() || window.ort;
        if (!ort) { warn('ONNX runtime unavailable, using heuristic embeddings'); return null; }
        try {
          const resp = await fetch(MINILM_URL);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = await resp.arrayBuffer();
          _session = await ort.InferenceSession.create(buf, { executionProviders: ['webgl','wasm'] });
          log('MiniLM embedding model loaded');
          return _session;
        } catch (e) {
          warn('embedding model load failed:', e.message);
          return null;
        }
      })();
      return _loadPromise;
    }

    /** Heuristic embedding: TF-IDF-like bag-of-words vector */
    function _heuristicEmbed(text) {
      const words = text.toLowerCase().split(/\W+/).filter(Boolean);
      const vec = new Float32Array(EMBEDDING_DIM).fill(0);
      for (const word of words) {
        let h = 5381;
        for (let i = 0; i < word.length; i++) h = ((h << 5) + h) ^ word.charCodeAt(i);
        vec[Math.abs(h) % EMBEDDING_DIM] += 1;
      }
      // L2 normalize
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      return vec.map(v => v / norm);
    }

    async function embed(text) {
      const session = await _loadModel();
      if (!session) return _heuristicEmbed(text);

      try {
        const ort = window.OnnxRuntimeManager?.getRuntime?.() || window.ort;
        const words = text.split(/\s+/).slice(0, 128);
        const ids = new BigInt64Array(words.map((_,i) => BigInt(i)));
        const mask = new BigInt64Array(words.map(() => 1n));
        const out = await session.run({
          input_ids:      new ort.Tensor('int64', ids,  [1, words.length]),
          attention_mask: new ort.Tensor('int64', mask, [1, words.length]),
        });
        const key = Object.keys(out)[0];
        return out[key].data;
      } catch (e) {
        warn('ONNX embed failed:', e.message);
        return _heuristicEmbed(text);
      }
    }

    function _chunkText(text) {
      const words = text.split(/\s+/);
      const chunks = [];
      for (let i = 0; i < words.length; i += CHUNK_WORDS) {
        chunks.push(words.slice(i, i + CHUNK_WORDS).join(' '));
      }
      return chunks;
    }

    async function embedChunks(text, onProgress) {
      const chunks = _chunkText(text);
      const embeddings = [];
      for (let i = 0; i < chunks.length; i++) {
        embeddings.push({ chunk: chunks[i], index: i, vector: await embed(chunks[i]) });
        onProgress?.({ done: i+1, total: chunks.length });
        await new Promise(r => setTimeout(r, 0));
      }
      return embeddings;
    }

    return { embed, embedChunks, isOnnxAvailable: () => !!_session };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. SemanticSearchEngine
  // ─────────────────────────────────────────────────────────────
  const SemanticSearchEngine = (() => {
    function _cosineSim(a, b) {
      if (!a || !b || a.length !== b.length) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
    }

    async function search(queryText, docId, topK = 5) {
      const ctx = UnifiedDocumentContext.get(docId);
      if (!ctx) return [];

      const queryVec = await EmbeddingEngine.embed(queryText);

      // Search over page embeddings
      const results = [];
      for (const pe of (ctx.pageEmbeddings || [])) {
        const sim = _cosineSim(queryVec, pe.vector);
        results.push({ ...pe, similarity: sim });
      }

      // Also do keyword search as fallback
      const queryWords = new Set(queryText.toLowerCase().split(/\W+/).filter(Boolean));
      const text = ctx.ocrText || ctx.translated || '';
      const sentences = text.split(/[.!?]\s+/);
      for (const sent of sentences) {
        const words = new Set(sent.toLowerCase().split(/\W+/));
        const overlap = [...queryWords].filter(w => words.has(w)).length;
        if (overlap) results.push({ chunk: sent, similarity: overlap / queryWords.size * 0.5, source: 'keyword' });
      }

      results.sort((a,b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    }

    async function searchTables(queryText, docId) {
      const ctx = UnifiedDocumentContext.get(docId);
      if (!ctx?.tables) return [];
      const lower = queryText.toLowerCase();
      return ctx.tables.filter(t => {
        const allText = [t.headers,...t.rows].flat().join(' ').toLowerCase();
        return allText.includes(lower);
      });
    }

    return { search, searchTables };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. PromptContextBuilder
  // ─────────────────────────────────────────────────────────────
  const PromptContextBuilder = (() => {
    function _countTokens(text) {
      // Approximation: 1 token ≈ 4 chars
      return Math.ceil((text || '').length / 4);
    }

    function _truncate(text, maxTokens) {
      const maxChars = maxTokens * 4;
      if (text.length <= maxChars) return text;
      return text.slice(0, maxChars) + '\n[... truncated for context window ...]';
    }

    function build({ docId, query, searchResults, taskType, maxTokens = MAX_CONTEXT_TOKENS }) {
      const ctx = UnifiedDocumentContext.get(docId);
      const parts = [];

      // System framing
      parts.push(`You are Laba, an AI document assistant. Task: ${taskType || 'answer'}.`);

      // Document context from search results
      if (searchResults?.length) {
        const snippets = searchResults.map(r => r.chunk || '').join('\n---\n');
        parts.push(`\nDocument excerpts:\n${snippets}`);
      } else if (ctx) {
        const src = ctx.translated || ctx.ocrText || '';
        parts.push(`\nDocument text:\n${_truncate(src, maxTokens - 200)}`);
      }

      // Tables
      if (ctx?.tables?.length) {
        const tableText = ctx.tables.map(t => `TABLE: ${t.headers.join('|')}\n${t.rows.slice(0,5).map(r=>r.join('|')).join('\n')}`).join('\n');
        parts.push(`\nTables:\n${_truncate(tableText, 200)}`);
      }

      // Query
      if (query) parts.push(`\nUser query: ${query}`);

      const prompt = parts.join('\n');
      const tokenCount = _countTokens(prompt);

      return { prompt, tokenCount, truncated: tokenCount >= maxTokens };
    }

    function buildMultilingual(params) {
      const base = build(params);
      if (params.targetLanguage) {
        base.prompt += `\nRespond in: ${params.targetLanguage}`;
      }
      return base;
    }

    return { build, buildMultilingual };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. AiReasoningRouter
  // ─────────────────────────────────────────────────────────────
  const AiReasoningRouter = (() => {
    const _handlers = {};

    function register(taskType, fn) {
      _handlers[taskType] = fn;
      log('registered handler:', taskType);
    }

    async function _defaultSummarize(text) {
      if (!text) return '';
      const sentences = text.split(/[.!?]\s+/);
      // Extractive: pick first, last, and highest-density middle sentences
      const pick = new Set([0, sentences.length - 1]);
      for (let i = 1; i < sentences.length - 1; i++) {
        if (sentences[i].split(' ').length > 10) { pick.add(i); if (pick.size >= 5) break; }
      }
      return [...pick].sort((a,b)=>a-b).map(i => sentences[i]).join('. ') + '.';
    }

    async function _defaultExtract(text, entity) {
      const pattern = new RegExp(`\\b${entity}\\b[^.]*`, 'gi');
      return (text.match(pattern) || []).slice(0, 10);
    }

    async function route(taskType, { docId, query, text, options = {} }) {
      // Prefer registered handler
      if (_handlers[taskType]) {
        return _handlers[taskType]({ docId, query, text, options });
      }

      const ctx = UnifiedDocumentContext.get(docId);
      const src = text || ctx?.translated || ctx?.ocrText || '';

      switch (taskType) {
        case 'summarize': {
          const summary = await _defaultSummarize(src);
          if (ctx) UnifiedDocumentContext.update(docId, { summary });
          return { summary, confidence: 0.7 };
        }
        case 'answer': {
          const results = docId ? await SemanticSearchEngine.search(query, docId, 3) : [];
          const snippet = results.map(r => r.chunk).join(' ');
          return { answer: snippet || 'No relevant information found.', sources: results };
        }
        case 'compare': {
          const a = options.textA || '';
          const b = options.textB || '';
          const aWords = new Set(a.toLowerCase().split(/\W+/));
          const bWords = new Set(b.toLowerCase().split(/\W+/));
          const common = [...aWords].filter(w => bWords.has(w)).length;
          const similarity = common / Math.max(aWords.size, bWords.size, 1);
          return { similarity, commonTerms: common };
        }
        case 'extract': {
          const entity = options.entity || query;
          return { extractions: await _defaultExtract(src, entity) };
        }
        case 'explain': {
          const results = docId ? await SemanticSearchEngine.search(query, docId, 2) : [];
          return { explanation: results.map(r=>r.chunk).join(' ') || src.slice(0,300) };
        }
        case 'rewrite': {
          // Passthrough — real rewrite needs LLM; return original with note
          return { rewritten: src, note: 'LLM not connected; original returned.' };
        }
        default:
          return { error: `Unknown task: ${taskType}` };
      }
    }

    // Convenience wrappers
    const summarize = (text, opts) => route('summarize', { text, ...opts });
    const answer    = (query, docId, opts) => route('answer', { query, docId, ...opts });
    const compare   = (textA, textB, opts) => route('compare', { options: { textA, textB }, ...opts });
    const extract   = (entity, docId, opts) => route('extract', { query: entity, docId, options: { entity }, ...opts });

    return { route, register, summarize, answer, compare, extract };
  })();

  // ─────────────────────────────────────────────────────────────
  // High-level document indexing
  // ─────────────────────────────────────────────────────────────
  async function indexDocument(docId, { ocrText, translated, tables, layout, metadata } = {}, onProgress) {
    const ctx = UnifiedDocumentContext.create(docId);
    UnifiedDocumentContext.update(docId, { ocrText: ocrText||'', translated: translated||'', tables: tables||[], layout: layout||[], metadata: metadata||{} });

    // Generate embeddings for semantic search
    const textToEmbed = translated || ocrText || '';
    if (textToEmbed) {
      const embeddings = await EmbeddingEngine.embedChunks(textToEmbed, onProgress);
      UnifiedDocumentContext.update(docId, { pageEmbeddings: embeddings });
    }

    // Auto-summarize
    if (textToEmbed.length > 100) {
      const { summary } = await AiReasoningRouter.summarize(textToEmbed);
      UnifiedDocumentContext.update(docId, { summary });
    }

    return UnifiedDocumentContext.get(docId);
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const LabaAiFoundation = {
    version: '44.1.0',
    UnifiedDocumentContext,
    EmbeddingEngine,
    SemanticSearchEngine,
    AiReasoningRouter,
    PromptContextBuilder,

    indexDocument,

    async ask(docId, question) {
      return AiReasoningRouter.answer(question, docId);
    },

    async summarize(docId) {
      const ctx = UnifiedDocumentContext.get(docId);
      if (!ctx) return { error: 'Document not indexed' };
      return AiReasoningRouter.summarize(ctx.translated || ctx.ocrText);
    },

    buildPrompt(docId, query, taskType) {
      return PromptContextBuilder.build({ docId, query, taskType });
    },

    status() {
      return {
        indexedDocuments: UnifiedDocumentContext.list().length,
        onnxEmbeddings: EmbeddingEngine.isOnnxAvailable(),
        workflowIntegration: !!(window.WorkflowChainEngine),
      };
    },
  };

  // Register as WorkflowChainEngine summarize step handler if available
  if (window.WorkflowChainEngine?.registerStepAdapter) {
    window.WorkflowChainEngine.registerStepAdapter('ai-summarize', async (ctx, step) => {
      const text = ctx.translated || ctx.ocrText || '';
      const { summary } = await AiReasoningRouter.summarize(text);
      ctx.summary = summary;
      return { summary };
    });
    window.WorkflowChainEngine.registerStepAdapter('ai-answer', async (ctx, step) => {
      const result = await AiReasoningRouter.answer(step.options?.query, null, { text: ctx.ocrText });
      return result;
    });
    log('registered WorkflowChainEngine step adapters');
  }

  window.LabaAiFoundation = LabaAiFoundation;
  log('Phase 44 ready');
})();
