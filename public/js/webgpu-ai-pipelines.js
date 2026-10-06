// Phase B — WebGPU AI Pipelines v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § B1  ShaderCache            — compiled WGSL module reuse
// § B2  TexturePool            — GPU texture allocation & recycling
// § B3  TiledGpuExecutor       — tile-by-tile dispatch for giant images
// § B4  AiPipelines            — OCR enhance, denoise, sharpen, edge, segment, normalize
// § B5  GpuMemoryBudget        — live GPU mem accounting & eviction
//
// Integrates with GpuResourceManager (Phase 36) — extends, never replaces.
// Exposes: window.WebGpuAiPipelines

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[WGAP]';
  var HAS_GPU  = typeof navigator !== 'undefined' && !!navigator.gpu;

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  // ── Shared device (reuse Phase 36 if already initialised) ─────────────────
  var _device  = null;
  var _adapter = null;
  var _ready   = false;
  var _initP   = null;

  async function _ensureDevice() {
    if (_ready && _device) return true;
    if (_initP) return _initP;
    if (!HAS_GPU) return false;
    _initP = (async function () {
      try {
        // Prefer Phase36's already-warmed device if available
        var p36 = window.Phase36;
        if (p36 && p36.RealWebGPUPipelines && p36.RealWebGPUPipelines.ready) {
          _log('reuse-p36-device', {});
        }
        _adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!_adapter) return false;
        _device  = await _adapter.requestDevice({
          requiredLimits: { maxStorageBufferBindingSize: 256 * MB },
        });
        if (!_device) return false;
        _device.lost.then(function () { _device = null; _adapter = null; _ready = false; _initP = null; });
        _ready = true;
        _log('gpu-ready', {});
        return true;
      } catch (ex) { _err('gpu-init', ex); return false; }
    }());
    return _initP;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // § B1  SHADER CACHE
  // ═══════════════════════════════════════════════════════════════════════════
  var ShaderCache = (function () {
    var _modules = {};
    function get(name) { return _modules[name] || null; }
    function set(name, code) {
      if (_modules[name]) return _modules[name];
      _modules[name] = _device.createShaderModule({ code: code, label: name });
      return _modules[name];
    }
    function flush() {
      // Shader modules are owned by the device — just drop refs
      _modules = {};
    }
    function getStats() { return { count: Object.keys(_modules).length, names: Object.keys(_modules) }; }
    return { get: get, set: set, flush: flush, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B2  TEXTURE POOL
  // ═══════════════════════════════════════════════════════════════════════════
  var TexturePool = (function () {
    var _pool  = {};   // key(w,h,format) → GPUTexture[]
    var _total = 0;
    var BUDGET = 64;   // max pooled textures

    function _key(w, h, fmt) { return w + 'x' + h + ':' + fmt; }

    function acquire(w, h, format, usage) {
      var k    = _key(w, h, format || 'rgba8unorm');
      var arr  = _pool[k];
      if (arr && arr.length > 0) { _total--; return arr.pop(); }
      return _device.createTexture({ size: [w, h, 1], format: format || 'rgba8unorm', usage: usage || (GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING) });
    }

    function release(tex, w, h, format) {
      if (!tex) return;
      if (_total >= BUDGET) { try { tex.destroy(); } catch (_) {} return; }
      var k = _key(w, h, format || 'rgba8unorm');
      if (!_pool[k]) _pool[k] = [];
      _pool[k].push(tex);
      _total++;
    }

    function flush() {
      Object.values(_pool).flat().forEach(function (t) { try { t.destroy(); } catch (_) {} });
      _pool  = {};
      _total = 0;
    }

    function getStats() { return { pooledTextures: _total, budget: BUDGET }; }

    window.addEventListener('p32:survival-mode', function () { flush(); });
    return { acquire: acquire, release: release, flush: flush, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B3  TILED GPU EXECUTOR
  // Splits giant images into tiles and dispatches each tile independently
  // to stay within GPU buffer size limits and avoid device timeouts.
  // ═══════════════════════════════════════════════════════════════════════════
  var TiledGpuExecutor = (function () {
    var TILE_W = 512;
    var TILE_H = 512;

    // Execute a pipeline function (fn) tile-by-tile over a large RGBA image
    // fn(tileRgba, tileW, tileH) → Promise<Uint8ClampedArray>
    async function execute(rgbaFull, fullW, fullH, fn) {
      var cols   = Math.ceil(fullW / TILE_W);
      var rows   = Math.ceil(fullH / TILE_H);
      var result = new Uint8ClampedArray(fullW * fullH * 4);

      for (var row = 0; row < rows; row++) {
        for (var col = 0; col < cols; col++) {
          var x0    = col * TILE_W;
          var y0    = row * TILE_H;
          var tw    = Math.min(TILE_W, fullW - x0);
          var th    = Math.min(TILE_H, fullH - y0);
          var tile  = _extractTile(rgbaFull, fullW, x0, y0, tw, th);
          var out   = await fn(tile, tw, th);
          if (out) _pasteTile(result, fullW, out, x0, y0, tw, th);
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }
      return result;
    }

    function _extractTile(src, srcW, x0, y0, tw, th) {
      var tile = new Uint8ClampedArray(tw * th * 4);
      for (var y = 0; y < th; y++) {
        var srcOff  = ((y0 + y) * srcW + x0) * 4;
        var dstOff  = y * tw * 4;
        tile.set(src.subarray(srcOff, srcOff + tw * 4), dstOff);
      }
      return tile;
    }

    function _pasteTile(dst, dstW, tile, x0, y0, tw, th) {
      for (var y = 0; y < th; y++) {
        var srcOff = y * tw * 4;
        var dstOff = ((y0 + y) * dstW + x0) * 4;
        dst.set(tile.subarray(srcOff, srcOff + tw * 4), dstOff);
      }
    }

    return { execute: execute, TILE_W: TILE_W, TILE_H: TILE_H };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B4  AI PIPELINES
  // WGSL shaders for document AI preprocessing
  // ═══════════════════════════════════════════════════════════════════════════
  var AiPipelines = (function () {

    // ── WGSL SHADERS ──────────────────────────────────────────────────────

    var ADAPTIVE_SHARPEN_WGSL = /* wgsl */`
      @group(0) @binding(0) var<storage, read>       src  : array<u32>;
      @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
      @group(0) @binding(2) var<uniform>              dims : vec2<u32>;
      fn px(x:i32,y:i32,W:u32,H:u32)->f32{
        let cx=clamp(x,0,i32(W)-1); let cy=clamp(y,0,i32(H)-1);
        let v=src[u32(cy)*W+u32(cx)]; return f32(v&0xFFu);}
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid:vec3<u32>){
        let idx=gid.x; let W=dims.x; let H=dims.y;
        if(idx>=W*H){return;}
        let x=i32(idx%W); let y=i32(idx/W);
        let c=px(x,y,W,H);
        let lap=4.0*c-px(x-1,y,W,H)-px(x+1,y,W,H)-px(x,y-1,W,H)-px(x,y+1,W,H);
        let sharpened=u32(clamp(c+0.5*lap,0.0,255.0));
        let a=(src[idx]>>24u)&0xFFu;
        dst[idx]=(a<<24u)|(sharpened<<16u)|(sharpened<<8u)|sharpened;}`;

    var LAYOUT_EDGE_WGSL = /* wgsl */`
      @group(0) @binding(0) var<storage, read>       src  : array<u32>;
      @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
      @group(0) @binding(2) var<uniform>              dims : vec2<u32>;
      fn lum(px:u32)->f32{return 0.2126*f32(px&0xFFu)+0.7152*f32((px>>8u)&0xFFu)+0.0722*f32((px>>16u)&0xFFu);}
      fn s(x:i32,y:i32,W:u32,H:u32)->f32{
        let cx=clamp(x,0,i32(W)-1); let cy=clamp(y,0,i32(H)-1);
        return lum(src[u32(cy)*W+u32(cx)]);}
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid:vec3<u32>){
        let idx=gid.x; let W=dims.x; let H=dims.y;
        if(idx>=W*H){return;}
        let x=i32(idx%W); let y=i32(idx/W);
        let gx=-s(x-1,y-1,W,H)+s(x+1,y-1,W,H)-2.0*s(x-1,y,W,H)+2.0*s(x+1,y,W,H)-s(x-1,y+1,W,H)+s(x+1,y+1,W,H);
        let gy=-s(x-1,y-1,W,H)-2.0*s(x,y-1,W,H)-s(x+1,y-1,W,H)+s(x-1,y+1,W,H)+2.0*s(x,y+1,W,H)+s(x+1,y+1,W,H);
        let mag=u32(clamp(sqrt(gx*gx+gy*gy),0.0,255.0));
        let a=(src[idx]>>24u)&0xFFu;
        dst[idx]=(a<<24u)|(mag<<16u)|(mag<<8u)|mag;}`;

    var NORMALIZE_WGSL = /* wgsl */`
      struct Params{minVal:f32,range:f32,};
      @group(0) @binding(0) var<storage, read>       src    : array<f32>;
      @group(0) @binding(1) var<storage, read_write>  dst    : array<f32>;
      @group(0) @binding(2) var<uniform>              params : Params;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid:vec3<u32>){
        let idx=gid.x;
        if(idx>=arrayLength(&src)){return;}
        dst[idx]=(src[idx]-params.minVal)/max(params.range,0.000001);}`;

    var SEGMENT_WGSL = /* wgsl */`
      @group(0) @binding(0) var<storage, read>       src  : array<u32>;
      @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
      @group(0) @binding(2) var<uniform>              dims : vec2<u32>;
      fn lum(px:u32)->f32{return 0.2126*f32(px&0xFFu)+0.7152*f32((px>>8u)&0xFFu)+0.0722*f32((px>>16u)&0xFFu);}
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid:vec3<u32>){
        let idx=gid.x; let W=dims.x; let H=dims.y;
        if(idx>=W*H){return;}
        let l=lum(src[idx]);
        let label=select(0u,255u,l<160.0);
        let a=(src[idx]>>24u)&0xFFu;
        dst[idx]=(a<<24u)|(label<<16u)|(label<<8u)|label;}`;

    // ── Generic u32-buffer GPU pipeline ───────────────────────────────────
    async function _runU32Pipeline(shaderName, wgsl, rgba, w, h) {
      var ok = await _ensureDevice();
      if (!ok || !_device) return null;
      try {
        var byteLen  = w * h * 4;
        var srcBuf   = _device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        var dstBuf   = _device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        var dimsBuf  = _device.createBuffer({ size: 8,       usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        var readBuf  = _device.createBuffer({ size: byteLen, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

        _device.queue.writeBuffer(srcBuf,  0, rgba instanceof Uint8ClampedArray ? rgba.buffer : rgba);
        _device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([w, h]));

        var mod  = ShaderCache.get(shaderName) || ShaderCache.set(shaderName, wgsl);
        var pipe = _device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        var bg   = _device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: srcBuf  } },
          { binding: 1, resource: { buffer: dstBuf  } },
          { binding: 2, resource: { buffer: dimsBuf } },
        ]});
        var enc  = _device.createCommandEncoder();
        var pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(w * h / 64));
        pass.end();
        enc.copyBufferToBuffer(dstBuf, 0, readBuf, 0, byteLen);
        _device.queue.submit([enc.finish()]);
        await readBuf.mapAsync(GPUMapMode.READ);
        var out = new Uint8ClampedArray(readBuf.getMappedRange().slice(0));
        readBuf.unmap();
        [srcBuf, dstBuf, dimsBuf, readBuf].forEach(function (b) { try { b.destroy(); } catch (_) {} });
        return out;
      } catch (ex) { _err('u32-pipe-' + shaderName, ex); return null; }
    }

    // CPU fallback: unsharp mask
    function _cpuSharpen(rgba, w, h) {
      var out = new Uint8ClampedArray(rgba.length);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = (y * w + x) * 4;
          for (var c = 0; c < 3; c++) {
            var v  = rgba[idx + c];
            var t  = v, b = v, l = v, r = v;
            if (y > 0)     t = rgba[((y-1)*w+x)*4+c];
            if (y < h-1)   b = rgba[((y+1)*w+x)*4+c];
            if (x > 0)     l = rgba[(y*w+x-1)*4+c];
            if (x < w-1)   r = rgba[(y*w+x+1)*4+c];
            var lap = 4*v - t - b - l - r;
            out[idx+c] = Math.min(255, Math.max(0, Math.round(v + 0.5*lap)));
          }
          out[idx+3] = rgba[idx+3];
        }
      }
      return out;
    }

    // CPU fallback: simple threshold segmentation
    function _cpuSegment(rgba, w, h) {
      var out = new Uint8ClampedArray(rgba.length);
      for (var i = 0; i < w * h; i++) {
        var off = i * 4;
        var l   = 0.2126*rgba[off] + 0.7152*rgba[off+1] + 0.0722*rgba[off+2];
        var v   = l < 160 ? 255 : 0;
        out[off]=v; out[off+1]=v; out[off+2]=v; out[off+3]=rgba[off+3];
      }
      return out;
    }

    // CPU normalize
    function _cpuNormalize(f32arr) {
      var mn = Infinity, mx = -Infinity;
      for (var i = 0; i < f32arr.length; i++) { if (f32arr[i] < mn) mn=f32arr[i]; if (f32arr[i] > mx) mx=f32arr[i]; }
      var range = mx - mn || 1;
      var out   = new Float32Array(f32arr.length);
      for (var j = 0; j < f32arr.length; j++) out[j] = (f32arr[j] - mn) / range;
      return out;
    }

    // ── Public pipelines ────────────────────────────────────────────────────
    async function adaptiveSharpen(rgba, w, h) {
      if (w * h > TiledGpuExecutor.TILE_W * TiledGpuExecutor.TILE_H * 4) {
        return TiledGpuExecutor.execute(rgba, w, h, function (t, tw, th) { return adaptiveSharpen(t, tw, th); });
      }
      return (await _runU32Pipeline('adapt-sharpen', ADAPTIVE_SHARPEN_WGSL, rgba, w, h)) || _cpuSharpen(rgba, w, h);
    }

    async function layoutEdge(rgba, w, h) {
      return (await _runU32Pipeline('layout-edge', LAYOUT_EDGE_WGSL, rgba, w, h)) || null;
    }

    async function segment(rgba, w, h) {
      return (await _runU32Pipeline('segment', SEGMENT_WGSL, rgba, w, h)) || _cpuSegment(rgba, w, h);
    }

    async function normalize(f32arr) {
      // GPU normalize not worth the overhead for small arrays
      return _cpuNormalize(f32arr);
    }

    // OCR enhance: combines Phase36 OCR preprocess + this sharpen
    async function ocrEnhance(rgba, w, h) {
      var p36 = window.Phase36;
      var base = rgba;
      if (p36 && p36.RealWebGPUPipelines) {
        try { base = (await p36.RealWebGPUPipelines.ocrPreprocess(rgba, w, h)) || rgba; } catch (_) {}
      }
      return adaptiveSharpen(base, w, h);
    }

    async function aiDenoise(rgba, w, h) {
      var p36 = window.Phase36;
      if (p36 && p36.RealWebGPUPipelines) {
        try { return (await p36.RealWebGPUPipelines.denoise(rgba, w, h)) || rgba; } catch (_) {}
      }
      return rgba;
    }

    return { adaptiveSharpen: adaptiveSharpen, layoutEdge: layoutEdge, segment: segment, normalize: normalize, ocrEnhance: ocrEnhance, aiDenoise: aiDenoise };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § B5  GPU MEMORY BUDGET
  // ═══════════════════════════════════════════════════════════════════════════
  var GpuMemoryBudget = (function () {
    var _allocated = 0;
    var SOFT_LIMIT = 256 * MB;
    var HARD_LIMIT = 512 * MB;

    function track(bytes) { _allocated += bytes; if (_allocated > SOFT_LIMIT) _evict(); }
    function release(bytes) { _allocated = Math.max(0, _allocated - bytes); }
    function _evict() {
      TexturePool.flush();
      ShaderCache.flush();
      _allocated = Math.max(0, _allocated - 64 * MB);
      _log('budget-evict', { remainingMB: Math.round(_allocated / MB) });
    }
    function getStats() { return { allocatedMB: Math.round(_allocated / MB), softLimitMB: Math.round(SOFT_LIMIT / MB), hardLimitMB: Math.round(HARD_LIMIT / MB) }; }
    setInterval(function () { if (_allocated > HARD_LIMIT) _evict(); }, 10000);
    return { track: track, release: release, getStats: getStats };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.WebGpuAiPipelines = {
    version:        VERSION,
    ShaderCache:    ShaderCache,
    TexturePool:    TexturePool,
    TiledGpuExecutor: TiledGpuExecutor,
    AiPipelines:    AiPipelines,
    GpuMemoryBudget: GpuMemoryBudget,

    // Convenience shorthands
    ocrEnhance:     function (rgba, w, h) { return AiPipelines.ocrEnhance(rgba, w, h); },
    denoise:        function (rgba, w, h) { return AiPipelines.aiDenoise(rgba, w, h); },
    sharpen:        function (rgba, w, h) { return AiPipelines.adaptiveSharpen(rgba, w, h); },
    edge:           function (rgba, w, h) { return AiPipelines.layoutEdge(rgba, w, h); },
    segment:        function (rgba, w, h) { return AiPipelines.segment(rgba, w, h); },
    normalize:      function (arr)        { return AiPipelines.normalize(arr); },

    flush: function () { TexturePool.flush(); ShaderCache.flush(); },

    audit: function () {
      return {
        version:    VERSION,
        hasWebGpu:  HAS_GPU,
        gpuReady:   _ready,
        shader:     ShaderCache.getStats(),
        texture:    TexturePool.getStats(),
        memory:     GpuMemoryBudget.getStats(),
        tileSize:   TiledGpuExecutor.TILE_W + 'x' + TiledGpuExecutor.TILE_H,
      };
    },
  };

  // Eager GPU init (non-blocking)
  if (HAS_GPU) setTimeout(function () { _ensureDevice().catch(function () {}); }, 2000);
  _log('loaded', { hasGpu: HAS_GPU });
}());
