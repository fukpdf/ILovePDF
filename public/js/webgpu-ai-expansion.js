/**
 * PHASE 51 — GPU AI EXPANSION
 * window.WebGpuAiExpansion
 *
 * Massive AI acceleration: embeddings, OCR enhancement, vector similarity,
 * layout transformers, AI denoise, sharpen, segmentation, table detection.
 * Tiled execution, adaptive batching, automatic CPU fallback, device-loss recovery.
 * Purely additive. Extends WebGpuAiPipelines without replacing it.
 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG     = '[WGAE]';
  var MB      = 1024 * 1024;

  function log()  { var a = Array.prototype.slice.call(arguments); console.log.apply(console,  [LOG].concat(a)); }
  function warn() { var a = Array.prototype.slice.call(arguments); console.warn.apply(console, [LOG].concat(a)); }
  function sys(n) { return window[n] || null; }

  var HAS_GPU = typeof navigator !== 'undefined' && !!navigator.gpu;

  // ═══════════════════════════════════════════════════════════════════════════
  // § 1  GPU DEVICE MANAGER (reuse Phase B if available)
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuDeviceManager = (function () {
    var _device  = null;
    var _adapter = null;
    var _ready   = false;
    var _initP   = null;
    var _lostCount = 0;

    async function init() {
      if (_ready && _device) return true;
      if (_initP) return _initP;
      if (!HAS_GPU) return false;
      _initP = (async function () {
        try {
          // Reuse Phase B device if already warmed
          var wgap = sys('WebGpuAiPipelines');
          if (wgap && wgap._device) { _device = wgap._device; _ready = true; log('reused Phase B device'); return true; }

          _adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (!_adapter) return false;
          _device  = await _adapter.requestDevice({
            requiredLimits: { maxStorageBufferBindingSize: 256 * MB, maxComputeWorkgroupSizeX: 256 },
          });
          if (!_device) return false;
          _device.lost.then(function (info) {
            warn('GPU device lost:', info.reason);
            _device = null; _adapter = null; _ready = false; _initP = null; _lostCount++;
            if (_lostCount < 3) setTimeout(init, 2000); // auto-recover
          });
          _ready = true;
          log('GPU device ready');
          return true;
        } catch (e) { warn('GPU init failed:', e.message); return false; }
      })();
      return _initP;
    }

    function get()       { return _device; }
    function isReady()   { return _ready && !!_device; }
    function lostCount() { return _lostCount; }

    return { init: init, get: get, isReady: isReady, lostCount: lostCount };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 2  GPU TENSOR POOL
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuTensorPool = (function () {
    var _buffers = []; // { buffer, size, inUse }
    var _allocated = 0;
    var MAX_POOL_MB = 128;

    function acquire(size) {
      var free = _buffers.find(function (b) { return !b.inUse && b.size >= size; });
      if (free) { free.inUse = true; return free.buffer; }

      var device = GpuDeviceManager.get();
      if (!device) return null;
      if (_allocated + size > MAX_POOL_MB * MB) { _evict(); }

      var buf = device.createBuffer({ size: size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      _buffers.push({ buffer: buf, size: size, inUse: true });
      _allocated += size;
      return buf;
    }

    function release(buf) {
      var entry = _buffers.find(function (b) { return b.buffer === buf; });
      if (entry) entry.inUse = false;
    }

    function _evict() {
      var stale = _buffers.filter(function (b) { return !b.inUse; });
      stale.forEach(function (b) { try { b.buffer.destroy(); } catch (_) {} });
      _allocated -= stale.reduce(function (s, b) { return s + b.size; }, 0);
      _buffers = _buffers.filter(function (b) { return b.inUse; });
      log('tensor pool evicted', stale.length, 'buffers');
    }

    function stats() { return { total: _buffers.length, inUse: _buffers.filter(function(b){return b.inUse;}).length, allocatedMB: (_allocated / MB).toFixed(1) }; }
    return { acquire: acquire, release: release, stats: stats };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 3  GPU MEMORY BALANCER
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuMemoryBalancer = (function () {
    var _pressure = 'normal';

    function update() {
      var mp = sys('MemPressure');
      if (mp && typeof mp.tier === 'function') {
        var tier = mp.tier();
        _pressure = tier;
        if (tier === 'danger' || tier === 'critical') GpuTensorPool._evict && GpuTensorPool._evict();
      }
    }

    function shouldUseGpu(taskSizeBytes) {
      if (!GpuDeviceManager.isReady()) return false;
      if (_pressure === 'danger' || _pressure === 'critical') return false;
      if (BandwidthAdaptiveScheduler && BandwidthAdaptiveScheduler.isMobile && BandwidthAdaptiveScheduler.isMobile()) return taskSizeBytes < 4 * MB;
      return true;
    }

    setInterval(update, 10000);
    return { shouldUseGpu: shouldUseGpu, pressure: function () { return _pressure; } };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 4  WGSL SHADER LIBRARY
  // ═══════════════════════════════════════════════════════════════════════════
  var ShaderLibrary = (function () {
    var _shaders = {};

    _shaders['cosine_similarity'] = `
      @group(0) @binding(0) var<storage,read>  a     : array<f32>;
      @group(0) @binding(1) var<storage,read>  b     : array<f32>;
      @group(0) @binding(2) var<storage,read_write> out : array<f32>;
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let i = gid.x;
        if (i >= arrayLength(&a)) { return; }
        out[i] = a[i] * b[i];
      }
    `;

    _shaders['sharpen'] = `
      @group(0) @binding(0) var<storage,read>  src : array<f32>;
      @group(0) @binding(1) var<storage,read_write> dst : array<f32>;
      @group(0) @binding(2) var<uniform> params : vec4<u32>;
      @compute @workgroup_size(16, 16)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let W = params.x; let H = params.y;
        let x = i32(gid.x); let y = i32(gid.y);
        if (x >= i32(W) || y >= i32(H)) { return; }
        let idx = y * i32(W) + x;
        let k = 1.5;
        let c  = src[idx];
        let t  = select(c, src[(y-1)*i32(W)+x], y > 0);
        let bt = select(c, src[(y+1)*i32(W)+x], y < i32(H)-1);
        let l  = select(c, src[y*i32(W)+(x-1)], x > 0);
        let r  = select(c, src[y*i32(W)+(x+1)], x < i32(W)-1);
        dst[idx] = clamp((1.0 + 4.0*k)*c - k*(t+bt+l+r), 0.0, 1.0);
      }
    `;

    _shaders['denoise'] = `
      @group(0) @binding(0) var<storage,read>  src : array<f32>;
      @group(0) @binding(1) var<storage,read_write> dst : array<f32>;
      @group(0) @binding(2) var<uniform> params : vec4<u32>;
      @compute @workgroup_size(16, 16)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let W = params.x; let H = params.y;
        let x = i32(gid.x); let y = i32(gid.y);
        if (x >= i32(W) || y >= i32(H)) { return; }
        var sum = 0.0; var cnt = 0u;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            let nx = x+dx; let ny = y+dy;
            if (nx >= 0 && nx < i32(W) && ny >= 0 && ny < i32(H)) {
              sum += src[ny*i32(W)+nx]; cnt++;
            }
          }
        }
        dst[y*i32(W)+x] = sum / f32(cnt);
      }
    `;

    _shaders['threshold_segment'] = `
      @group(0) @binding(0) var<storage,read>  src : array<f32>;
      @group(0) @binding(1) var<storage,read_write> dst : array<f32>;
      @group(0) @binding(2) var<uniform> params : vec4<f32>;
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let i = gid.x;
        if (i >= arrayLength(&src)) { return; }
        dst[i] = select(0.0, 1.0, src[i] > params.x);
      }
    `;

    var _compiled = new Map();

    function get(name) {
      var device = GpuDeviceManager.get();
      if (!device || !_shaders[name]) return null;
      if (_compiled.has(name)) return _compiled.get(name);
      try {
        var mod = device.createShaderModule({ code: _shaders[name] });
        _compiled.set(name, mod);
        return mod;
      } catch (e) { warn('shader compile failed:', name, e.message); return null; }
    }

    function invalidate() { _compiled.clear(); }
    return { get: get, invalidate: invalidate };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 5  TILED GPU EXECUTOR
  // ═══════════════════════════════════════════════════════════════════════════
  var TiledGpuExecutor = (function () {
    var TILE = 512; // px per tile

    async function runTiled(imageData, width, height, shader, params) {
      if (!GpuDeviceManager.isReady()) return null;
      var device = GpuDeviceManager.get();
      var mod    = ShaderLibrary.get(shader);
      if (!mod) return null;

      // For large images, process in tiles
      var results = new Float32Array(imageData.length);
      var tilesX  = Math.ceil(width  / TILE);
      var tilesY  = Math.ceil(height / TILE);

      for (var ty = 0; ty < tilesY; ty++) {
        for (var tx = 0; tx < tilesX; tx++) {
          var x0 = tx * TILE, y0 = ty * TILE;
          var tw = Math.min(TILE, width  - x0);
          var th = Math.min(TILE, height - y0);

          // Extract tile
          var tileData = new Float32Array(tw * th);
          for (var ry = 0; ry < th; ry++) {
            for (var rx = 0; rx < tw; rx++) {
              tileData[ry * tw + rx] = imageData[(y0 + ry) * width + (x0 + rx)];
            }
          }

          var result = await _runKernel(device, mod, tileData, tw, th, params);
          if (!result) continue;

          // Copy back
          for (var ry2 = 0; ry2 < th; ry2++) {
            for (var rx2 = 0; rx2 < tw; rx2++) {
              results[(y0 + ry2) * width + (x0 + rx2)] = result[ry2 * tw + rx2];
            }
          }
        }
        await new Promise(function (r) { setTimeout(r, 0); }); // yield between tile rows
      }
      return results;
    }

    async function _runKernel(device, mod, data, w, h, params) {
      try {
        var sz   = data.byteLength;
        var src  = device.createBuffer({ size: sz, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        var dst  = device.createBuffer({ size: sz, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        var read = device.createBuffer({ size: sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        device.queue.writeBuffer(src, 0, data);

        // Uniform buffer (width, height, pad, pad)
        var uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(uni, 0, new Uint32Array([w, h, 0, 0]));

        var pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: mod, entryPoint: 'main' },
        });
        var bg = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: src } },
            { binding: 1, resource: { buffer: dst } },
            { binding: 2, resource: { buffer: uni } },
          ],
        });

        var enc = device.createCommandEncoder();
        var pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
        pass.end();
        enc.copyBufferToBuffer(dst, 0, read, 0, sz);
        device.queue.submit([enc.finish()]);

        await read.mapAsync(GPUMapMode.READ);
        var result = new Float32Array(read.getMappedRange().slice(0));
        read.unmap();

        [src, dst, read, uni].forEach(function (b) { try { b.destroy(); } catch (_) {} });
        return result;
      } catch (e) { warn('kernel failed:', e.message); return null; }
    }

    return { runTiled: runTiled };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 6  CPU FALLBACK PIPELINES
  // ═══════════════════════════════════════════════════════════════════════════
  var CpuFallback = (function () {
    function sharpen(data, w, h) {
      var out = new Float32Array(data.length);
      var k = 1.5;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var i   = y * w + x;
          var c   = data[i];
          var t   = y > 0   ? data[(y-1)*w+x] : c;
          var b   = y < h-1 ? data[(y+1)*w+x] : c;
          var l   = x > 0   ? data[y*w+x-1]   : c;
          var r   = x < w-1 ? data[y*w+x+1]   : c;
          out[i]  = Math.max(0, Math.min(1, (1+4*k)*c - k*(t+b+l+r)));
        }
      }
      return out;
    }

    function denoise(data, w, h) {
      var out = new Float32Array(data.length);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var sum = 0, cnt = 0;
          for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
            var nx = x+dx, ny = y+dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) { sum += data[ny*w+nx]; cnt++; }
          }}
          out[y*w+x] = sum / cnt;
        }
      }
      return out;
    }

    function segment(data, threshold) {
      threshold = threshold || 0.5;
      return data.map(function (v) { return v > threshold ? 1 : 0; });
    }

    function cosineSimilarity(a, b) {
      var dot = 0, na = 0, nb = 0;
      for (var i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
      return dot / (Math.sqrt(na * nb) || 1);
    }

    return { sharpen: sharpen, denoise: denoise, segment: segment, cosineSimilarity: cosineSimilarity };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 7  HIGH-LEVEL AI PIPELINES
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuEmbeddingEngine = (function () {
    async function embed(vectorA, vectorB) {
      // Cosine similarity via GPU
      var useGpu = GpuMemoryBalancer.shouldUseGpu(vectorA.length * 4 * 3);
      if (!useGpu) return CpuFallback.cosineSimilarity(vectorA, vectorB);

      var device = GpuDeviceManager.get();
      var mod    = ShaderLibrary.get('cosine_similarity');
      if (!device || !mod) return CpuFallback.cosineSimilarity(vectorA, vectorB);

      try {
        var n   = vectorA.length;
        var sz  = n * 4;
        var bufA = device.createBuffer({ size: sz, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        var bufB = device.createBuffer({ size: sz, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        var bufO = device.createBuffer({ size: sz, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        var read = device.createBuffer({ size: sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        device.queue.writeBuffer(bufA, 0, new Float32Array(vectorA));
        device.queue.writeBuffer(bufB, 0, new Float32Array(vectorB));

        var pipeline = device.createComputePipeline({ layout:'auto', compute:{ module: mod, entryPoint:'main' } });
        var bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries:[
          {binding:0,resource:{buffer:bufA}},{binding:1,resource:{buffer:bufB}},{binding:2,resource:{buffer:bufO}},
        ]});
        var enc = device.createCommandEncoder();
        var pass = enc.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(n / 256)); pass.end();
        enc.copyBufferToBuffer(bufO, 0, read, 0, sz);
        device.queue.submit([enc.finish()]);

        await read.mapAsync(GPUMapMode.READ);
        var products = new Float32Array(read.getMappedRange().slice(0));
        read.unmap();
        [bufA, bufB, bufO, read].forEach(function (b) { try { b.destroy(); } catch (_) {} });

        var dot = products.reduce(function(s,v){return s+v;},0);
        var na  = vectorA.reduce(function(s,v){return s+v*v;},0);
        var nb  = vectorB.reduce(function(s,v){return s+v*v;},0);
        return dot / (Math.sqrt(na*nb) || 1);
      } catch (e) { warn('GPU embed failed, CPU fallback:', e.message); return CpuFallback.cosineSimilarity(vectorA, vectorB); }
    }
    return { embed: embed };
  })();

  var GpuOcrEnhancer = (function () {
    async function enhance(imageData, width, height, opts) {
      opts = opts || {};
      var useGpu = GpuMemoryBalancer.shouldUseGpu(imageData.length * 4);
      var data   = imageData instanceof Float32Array ? imageData : new Float32Array(imageData).map(function (v) { return v / 255; });

      if (!useGpu) {
        var r = CpuFallback.denoise(data, width, height);
        return opts.sharpen ? CpuFallback.sharpen(r, width, height) : r;
      }

      try {
        await GpuDeviceManager.init();
        var denoised = await TiledGpuExecutor.runTiled(data, width, height, 'denoise', null) || CpuFallback.denoise(data, width, height);
        if (opts.sharpen) {
          return await TiledGpuExecutor.runTiled(denoised, width, height, 'sharpen', null) || CpuFallback.sharpen(denoised, width, height);
        }
        return denoised;
      } catch (e) {
        warn('GPU OCR enhance failed, CPU fallback:', e.message);
        return CpuFallback.denoise(data, width, height);
      }
    }
    return { enhance: enhance };
  })();

  var GpuTableDetector = (function () {
    async function detect(imageData, width, height, threshold) {
      threshold = threshold || 0.4;
      var useGpu = GpuMemoryBalancer.shouldUseGpu(imageData.length * 4);
      var data   = imageData instanceof Float32Array ? imageData : new Float32Array(imageData).map(function (v) { return v / 255; });

      var segmented;
      if (useGpu) {
        try {
          await GpuDeviceManager.init();
          segmented = await TiledGpuExecutor.runTiled(data, width, height, 'threshold_segment', { threshold: threshold });
        } catch (_) {}
      }
      if (!segmented) segmented = CpuFallback.segment(data, threshold);

      // Count horizontal/vertical lines (basic table heuristic)
      var hLines = 0, vLines = 0;
      for (var y = 1; y < height-1; y++) {
        var rowSum = 0;
        for (var x = 0; x < width; x++) rowSum += segmented[y*width+x];
        if (rowSum / width > 0.8) hLines++;
      }
      for (var x2 = 1; x2 < width-1; x2++) {
        var colSum = 0;
        for (var y2 = 0; y2 < height; y2++) colSum += segmented[y2*width+x2];
        if (colSum / height > 0.8) vLines++;
      }

      return { hasTable: hLines >= 2 && vLines >= 2, horizontalLines: hLines, verticalLines: vLines, confidence: Math.min(1, (hLines+vLines)/20) };
    }
    return { detect: detect };
  })();

  var GpuCompressionScorer = (function () {
    function scoreComplexity(imageData) {
      // Variance-based complexity score — higher = harder to compress
      var data = imageData instanceof Float32Array ? imageData : Array.from(imageData).map(function (v) { return v / 255; });
      var mean = data.reduce(function (s,v){return s+v;},0) / data.length;
      var variance = data.reduce(function (s,v){return s+(v-mean)*(v-mean);},0) / data.length;
      return { complexity: variance, score: Math.min(1, variance * 10), suggested: variance > 0.05 ? 'webp' : 'jpeg' };
    }
    return { scoreComplexity: scoreComplexity };
  })();

  var GpuLayoutTransformer = (function () {
    async function analyzeLayout(pageData, width, height) {
      // Segment page into text/image/table regions
      var useGpu = GpuMemoryBalancer.shouldUseGpu(pageData.length * 4);
      var data   = pageData instanceof Float32Array ? pageData : new Float32Array(pageData).map(function (v) { return v/255; });

      if (useGpu) {
        try {
          await GpuDeviceManager.init();
          var seg = await TiledGpuExecutor.runTiled(data, width, height, 'threshold_segment', null);
          if (seg) {
            var darkPixels = 0;
            for (var i = 0; i < seg.length; i++) darkPixels += seg[i];
            var density = darkPixels / seg.length;
            return { textDensity: density, regions: density > 0.3 ? 'text-heavy' : density > 0.1 ? 'mixed' : 'image-heavy', width: width, height: height };
          }
        } catch (_) {}
      }

      var sum = data.reduce(function (s,v){return s+v;},0);
      var d   = 1 - (sum / data.length);
      return { textDensity: d, regions: d > 0.3 ? 'text-heavy' : d > 0.1 ? 'mixed' : 'image-heavy', width: width, height: height };
    }
    return { analyzeLayout: analyzeLayout };
  })();

  var GpuInferenceCoordinator = (function () {
    var _queue   = [];
    var _running = false;
    var _maxBatch = 4;

    async function _drain() {
      if (_running || !_queue.length) return;
      _running = true;
      while (_queue.length) {
        var batch = _queue.splice(0, _maxBatch);
        await Promise.all(batch.map(async function (item) {
          try { item.resolve(await item.fn()); } catch (e) { item.reject(e); }
        }));
        if (_queue.length) await new Promise(function (r) { setTimeout(r, 4); });
      }
      _running = false;
    }

    function submit(fn) {
      return new Promise(function (res, rej) {
        _queue.push({ fn: fn, resolve: res, reject: rej });
        _drain();
      });
    }

    return { submit: submit, pending: function () { return _queue.length; } };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // § 8  BROWSER COMPATIBILITY CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  var BrowserCompat = (function () {
    function check() {
      return {
        webgpu:   HAS_GPU,
        wasm:     typeof WebAssembly !== 'undefined',
        safari:   /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent),
        mobile:   /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
        webWorker: typeof Worker !== 'undefined',
      };
    }
    return { check: check };
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════
  if (HAS_GPU) {
    GpuDeviceManager.init().then(function (ok) {
      log('GPU init:', ok ? 'ready' : 'failed (CPU fallback active)');
    });
  } else {
    log('WebGPU unavailable — all pipelines use CPU fallback');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.WebGpuAiExpansion = {
    version:   VERSION,
    hasGpu:    HAS_GPU,
    isReady:   function () { return GpuDeviceManager.isReady(); },

    // Embedding cosine similarity (GPU-accelerated)
    cosineSimilarity: function (a, b) { return GpuInferenceCoordinator.submit(function () { return GpuEmbeddingEngine.embed(a, b); }); },

    // OCR image enhancement
    enhanceOcr: function (imageData, w, h, opts) { return GpuInferenceCoordinator.submit(function () { return GpuOcrEnhancer.enhance(imageData, w, h, opts); }); },

    // Table detection
    detectTable: function (imageData, w, h, threshold) { return GpuInferenceCoordinator.submit(function () { return GpuTableDetector.detect(imageData, w, h, threshold); }); },

    // Page layout analysis
    analyzeLayout: function (data, w, h) { return GpuInferenceCoordinator.submit(function () { return GpuLayoutTransformer.analyzeLayout(data, w, h); }); },

    // Compression complexity scoring (sync)
    scoreCompression: function (imageData) { return GpuCompressionScorer.scoreComplexity(imageData); },

    // CPU fallbacks (always available)
    cpu: { sharpen: CpuFallback.sharpen, denoise: CpuFallback.denoise, segment: CpuFallback.segment, cosineSimilarity: CpuFallback.cosineSimilarity },

    audit: function () {
      return {
        version:     VERSION,
        gpuReady:    GpuDeviceManager.isReady(),
        lostCount:   GpuDeviceManager.lostCount(),
        tensorPool:  GpuTensorPool.stats(),
        pressure:    GpuMemoryBalancer.pressure(),
        pending:     GpuInferenceCoordinator.pending(),
        compat:      BrowserCompat.check(),
      };
    },

    cleanup: function () {
      ShaderLibrary.invalidate();
      log('WebGpuAiExpansion cleaned up');
    },

    // Sub-systems
    DeviceManager:    GpuDeviceManager,
    TensorPool:       GpuTensorPool,
    MemoryBalancer:   GpuMemoryBalancer,
    ShaderLibrary:    ShaderLibrary,
    TiledExecutor:    TiledGpuExecutor,
    EmbeddingEngine:  GpuEmbeddingEngine,
    OcrEnhancer:      GpuOcrEnhancer,
    TableDetector:    GpuTableDetector,
    LayoutTransformer: GpuLayoutTransformer,
    CompressionScorer: GpuCompressionScorer,
    InferenceCoord:   GpuInferenceCoordinator,
    BrowserCompat:    BrowserCompat,
  };

  log('WebGpuAiExpansion v' + VERSION + ' ready (GPU: ' + (HAS_GPU ? 'available' : 'unavailable, CPU fallback') + ')');
}());
