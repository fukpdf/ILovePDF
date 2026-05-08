// Phase A — ONNX Runtime Manager v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § A1  ModelRegistry         — lazy model loading, eviction, quantized support
// § A2  TensorPool            — reusable typed-array tensor allocation
// § A3  InferenceScheduler    — async batch queue, memory-aware, cancellable
// § A4  TokenizerCache        — tokenizer registry for NLP models
// § A5  StreamingInference    — chunk-by-chunk inference for giant documents
//
// Backends tried in order: WebGPU → WASM → CPU
// Exposes: window.OnnxRuntimeManager

(function () {
  'use strict';

  var VERSION = '1.0';
  var MB      = 1024 * 1024;
  var LOG_PFX = '[ORM]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  var HAS_WASM   = typeof WebAssembly !== 'undefined';
  var HAS_WEBGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  var _ort       = null;   // ort namespace once loaded
  var _ortReady  = false;
  var _ortError  = null;

  // ── Load ort dynamically (CDN or local) ────────────────────────────────────
  var ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js';

  function _ensureOrt() {
    if (_ort && _ortReady) return Promise.resolve(_ort);
    if (_ortError) return Promise.reject(_ortError);
    return new Promise(function (res, rej) {
      if (typeof ort !== 'undefined') { _ort = ort; _ortReady = true; return res(_ort); }
      var s = document.createElement('script');
      s.src = ORT_CDN;
      s.onload = function () {
        if (typeof ort !== 'undefined') { _ort = ort; _ortReady = true; res(_ort); }
        else { _ortError = new Error('ort_not_found'); rej(_ortError); }
      };
      s.onerror = function () { _ortError = new Error('ort_load_failed'); rej(_ortError); };
      document.head.appendChild(s);
    });
  }

  // ── Detect best backend ────────────────────────────────────────────────────
  function _bestBackend() {
    var mp = window.MemPressure;
    var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
    if (tier === 'critical' || tier === 'danger') return 'cpu';
    if (HAS_WEBGPU) return 'webgpu';
    if (HAS_WASM)   return 'wasm';
    return 'cpu';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § A1  MODEL REGISTRY
  // ═══════════════════════════════════════════════════════════════════════════
  var ModelRegistry = (function () {
    var _sessions = {};   // modelId → { session, backend, loadedAt, useCount, sizeBytes }
    var _loading  = {};   // modelId → Promise
    var MAX_LOADED = 3;   // max simultaneous sessions in memory
    var MODEL_DEFS = {
      'ocr-corrector':       { url: null, quantized: true,  inputName: 'input', outputName: 'output', desc: 'OCR post-correction' },
      'table-detector':      { url: null, quantized: true,  inputName: 'input', outputName: 'output', desc: 'Table structure detection' },
      'doc-classifier':      { url: null, quantized: false, inputName: 'input_ids', outputName: 'logits', desc: 'Semantic doc classification' },
      'compress-scorer':     { url: null, quantized: true,  inputName: 'input', outputName: 'score', desc: 'Intelligent compression scoring' },
      'layout-analyser':     { url: null, quantized: true,  inputName: 'pixel_values', outputName: 'logits', desc: 'Document layout analysis' },
      'summarize-ranker':    { url: null, quantized: false, inputName: 'input_ids', outputName: 'logits', desc: 'AI summarize chunk ranking' },
      'translate-ranker':    { url: null, quantized: false, inputName: 'input_ids', outputName: 'logits', desc: 'AI translate chunk ranking' },
      'compare-similarity':  { url: null, quantized: false, inputName: 'input_ids', outputName: 'logits', desc: 'Smart compare similarity' },
    };

    function register(modelId, def) {
      MODEL_DEFS[modelId] = def;
    }

    function isAvailable(modelId) {
      var def = MODEL_DEFS[modelId];
      return !!(def && def.url);
    }

    async function load(modelId, opts) {
      if (!HAS_WASM) throw new Error('wasm_unsupported');
      if (_sessions[modelId]) {
        _sessions[modelId].useCount++;
        _sessions[modelId].loadedAt = Date.now();
        return _sessions[modelId].session;
      }
      if (_loading[modelId]) return _loading[modelId];

      var def = MODEL_DEFS[modelId];
      if (!def || !def.url) throw new Error('model_not_registered: ' + modelId);

      _loading[modelId] = (async function () {
        try {
          var backend  = (opts && opts.backend) || _bestBackend();
          var ort_ns   = await _ensureOrt();

          // Evict LRU if over limit
          var keys = Object.keys(_sessions);
          if (keys.length >= MAX_LOADED) _evictLRU();

          var sessionOpts = {
            executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
            graphOptimizationLevel: 'all',
          };
          var session = await ort_ns.InferenceSession.create(def.url, sessionOpts);
          _sessions[modelId] = { session: session, backend: backend, loadedAt: Date.now(), useCount: 1, sizeBytes: 0 };
          _log('model-loaded', { modelId: modelId, backend: backend });
          return session;
        } finally {
          delete _loading[modelId];
        }
      }());

      return _loading[modelId];
    }

    function unload(modelId) {
      var entry = _sessions[modelId];
      if (!entry) return;
      try { if (entry.session && entry.session.release) entry.session.release(); } catch (_) {}
      delete _sessions[modelId];
      _log('model-unloaded', { modelId: modelId });
    }

    function _evictLRU() {
      var keys   = Object.keys(_sessions);
      var oldest = keys.sort(function (a, b) { return (_sessions[a].loadedAt || 0) - (_sessions[b].loadedAt || 0); })[0];
      if (oldest) unload(oldest);
    }

    function getStats() {
      var out = {};
      Object.keys(_sessions).forEach(function (k) {
        out[k] = { backend: _sessions[k].backend, useCount: _sessions[k].useCount };
      });
      return out;
    }

    return { register: register, load: load, unload: unload, isAvailable: isAvailable, getStats: getStats, MODEL_DEFS: MODEL_DEFS };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A2  TENSOR POOL
  // ═══════════════════════════════════════════════════════════════════════════
  var TensorPool = (function () {
    var _pool = {};   // typeKey → Float32Array[]

    function _key(type, length) { return type + ':' + length; }

    function acquire(type, length) {
      var k   = _key(type, length);
      var arr = _pool[k];
      if (arr && arr.length > 0) return arr.pop();
      return type === 'float32' ? new Float32Array(length)
           : type === 'int64'   ? new BigInt64Array(length)
           : type === 'int32'   ? new Int32Array(length)
           : new Float32Array(length);
    }

    function release(type, buf) {
      if (!buf) return;
      var k   = _key(type, buf.length);
      if (!_pool[k]) _pool[k] = [];
      if (_pool[k].length < 8) { _pool[k].push(buf); }
    }

    function flush() {
      var count = 0;
      Object.keys(_pool).forEach(function (k) { count += _pool[k].length; _pool[k] = []; });
      _log('tensor-pool-flush', { released: count });
    }

    // Flush on memory pressure
    window.addEventListener('p32:survival-mode', function () { flush(); });

    return { acquire: acquire, release: release, flush: flush };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A3  INFERENCE SCHEDULER
  // ═══════════════════════════════════════════════════════════════════════════
  var InferenceScheduler = (function () {
    var _queue       = [];
    var _running     = 0;
    var MAX_PARALLEL = 2;
    var _controllers = {};   // taskId → { cancelled: bool }
    var _nextTaskId  = 1;

    // Schedule an inference task
    // fn: async function returning result
    // opts: { priority, taskId }
    function schedule(fn, opts) {
      var taskId = (opts && opts.taskId) || (_nextTaskId++);
      var ctrl   = { cancelled: false };
      _controllers[taskId] = ctrl;

      return new Promise(function (res, rej) {
        var item = {
          taskId:   taskId,
          fn:       fn,
          ctrl:     ctrl,
          priority: (opts && opts.priority) || 5,
          resolve:  res,
          reject:   rej,
        };
        _queue.push(item);
        _queue.sort(function (a, b) { return a.priority - b.priority; });
        _drain();
      });
    }

    function cancel(taskId) {
      if (_controllers[taskId]) _controllers[taskId].cancelled = true;
      _queue = _queue.filter(function (i) {
        if (i.taskId === taskId) { i.reject(new Error('cancelled')); return false; }
        return true;
      });
    }

    async function _drain() {
      var mp   = window.MemPressure;
      var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      var max  = tier === 'critical' ? 1 : tier === 'danger' ? 1 : MAX_PARALLEL;

      if (_running >= max || _queue.length === 0) return;
      var item = _queue.shift();
      if (!item) return;

      _running++;
      try {
        if (item.ctrl.cancelled) { item.reject(new Error('cancelled')); return; }
        var result = await item.fn(item.ctrl);
        if (!item.ctrl.cancelled) item.resolve(result);
        else item.reject(new Error('cancelled'));
      } catch (ex) {
        item.reject(ex);
        _err('infer-err', ex);
      } finally {
        _running--;
        delete _controllers[item.taskId];
        setTimeout(_drain, 0);
      }
    }

    function getStats() {
      return { queued: _queue.length, running: _running, maxParallel: MAX_PARALLEL };
    }

    return { schedule: schedule, cancel: cancel, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A4  TOKENIZER CACHE
  // ═══════════════════════════════════════════════════════════════════════════
  var TokenizerCache = (function () {
    var _cache = {};
    var MAX    = 4;

    function register(name, tokenizerObj) {
      if (Object.keys(_cache).length >= MAX) {
        var oldest = Object.keys(_cache)[0];
        delete _cache[oldest];
      }
      _cache[name] = { tok: tokenizerObj, ts: Date.now() };
    }

    function get(name) {
      var entry = _cache[name];
      if (entry) { entry.ts = Date.now(); return entry.tok; }
      return null;
    }

    function flush() { _cache = {}; }

    return { register: register, get: get, flush: flush };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § A5  STREAMING INFERENCE
  // Chunk-by-chunk inference pipeline for large documents
  // ═══════════════════════════════════════════════════════════════════════════
  var StreamingInference = (function () {

    // Run inference on text chunks, returning results as they complete
    // onChunkResult(chunkIdx, result) — called for each completed chunk
    async function run(modelId, chunks, inputBuilder, onChunkResult, ctrl) {
      var session;
      try { session = await ModelRegistry.load(modelId); } catch (ex) {
        _err('streaming-load', ex);
        return { success: false, error: ex.message };
      }

      var results = [];
      for (var i = 0; i < chunks.length; i++) {
        if (ctrl && ctrl.cancelled) break;
        try {
          var feeds   = inputBuilder(chunks[i], i);
          var output  = await InferenceScheduler.schedule(async function () {
            return session.run(feeds);
          }, { priority: 8 });
          results.push(output);
          if (onChunkResult) onChunkResult(i, output);
          await new Promise(function (r) { setTimeout(r, 0); });   // yield
        } catch (ex) {
          _err('streaming-chunk', { chunk: i, err: ex.message });
          results.push(null);
        }
      }
      return { success: true, results: results };
    }

    // Memory-aware batching: chunk the input array based on current mem tier
    function adaptiveBatch(items, targetBatchSize) {
      var mp   = window.MemPressure;
      var tier = mp && typeof mp.tier === 'function' ? mp.tier() : 'normal';
      var size = tier === 'critical' ? 1
               : tier === 'danger'   ? 2
               : tier === 'high'     ? Math.max(1, Math.floor(targetBatchSize * 0.5))
               : targetBatchSize;
      var batches = [];
      for (var i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
      }
      return batches;
    }

    return { run: run, adaptiveBatch: adaptiveBatch };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.OnnxRuntimeManager = {
    version:            VERSION,
    ModelRegistry:      ModelRegistry,
    TensorPool:         TensorPool,
    InferenceScheduler: InferenceScheduler,
    TokenizerCache:     TokenizerCache,
    StreamingInference: StreamingInference,

    // Convenience: run single inference if model is available
    infer: async function (modelId, feeds, opts) {
      if (!ModelRegistry.isAvailable(modelId)) return null;
      var session = await ModelRegistry.load(modelId, opts);
      return InferenceScheduler.schedule(async function () {
        return session.run(feeds);
      }, opts);
    },

    // Cleanup everything
    flush: function () {
      TensorPool.flush();
      TokenizerCache.flush();
      Object.keys(ModelRegistry.MODEL_DEFS).forEach(function (k) {
        ModelRegistry.unload(k);
      });
      _log('flush', {});
    },

    audit: function () {
      var report = {
        version:   VERSION,
        hasWasm:   HAS_WASM,
        hasWebGpu: HAS_WEBGPU,
        ortReady:  _ortReady,
        backend:   _bestBackend(),
        models:    ModelRegistry.getStats(),
        scheduler: InferenceScheduler.getStats(),
      };
      console.group('OnnxRuntimeManager v' + VERSION);
      console.table(report);
      console.groupEnd();
      return report;
    },
  };

  _log('loaded', { hasWasm: HAS_WASM, hasWebGpu: HAS_WEBGPU });
}());
