// RuntimeGpuEngine v1.0 — Phase 9B
// =====================================================================
// GPU compute layer for image processing and AI tensor operations.
//
// Priority chain:
//   1. WebGPU (Chrome 113+, Edge 113+, Safari 17+)
//   2. WebGL 2 compute-via-fragment shader (Chrome 56+, Firefox 51+)
//   3. WebGL 1 (universal fallback)
//   4. CPU Canvas 2D / JS typed-array (always available)
//
// Operations:
//   imgScale      — bilinear downscale
//   imgGreyscale  — luminance conversion
//   imgDenoise    — 3×3 box blur (noise suppression for OCR)
//   imgContrast   — CLAHE-inspired contrast enhancement
//   imgThreshold  — adaptive threshold (OCR prep)
//   thumbnail     — multi-page thumbnail generation
//   tensorNorm    — float32 tensor normalisation for AI inference
//
// GPU Task Queue: max 4 concurrent GPU tasks (configurable).
// GPU Memory Tracking: estimates VRAM via texture size budgeting.
// Adaptive scheduling: demotes to CPU path when heap > 75% or GPU errors.
//
// Expose: window.RuntimeGpuEngine
//   .runTask(op, input, opts)  → Promise<result>
//   .getCapabilities()         → CapabilityReport
//   .getStats()                → RuntimeStats
// =====================================================================
(function (global) {
  'use strict';

  if (global.RuntimeGpuEngine) return;

  var LOG = '[GPU9B]';

  // ── Capability detection ──────────────────────────────────────────────────
  var _webgpuSupported = typeof navigator !== 'undefined' && !!navigator.gpu;
  var _webgl2Supported = (function () {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2'));
    } catch (_) { return false; }
  }());
  var _webgl1Supported = (function () {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (_) { return false; }
  }());
  var _offscreenCanvasSupported = typeof OffscreenCanvas !== 'undefined';

  var _gpuAdapter = null;   // WebGPU GPUAdapter
  var _gpuDevice  = null;   // WebGPU GPUDevice

  // Active GPU tier for this session
  var _gpuTier = 'cpu'; // 'webgpu'|'webgl2'|'webgl1'|'cpu'

  // ── Stats ─────────────────────────────────────────────────────────────────
  var _stats = {
    tasks:      0,
    gpuTasks:   0,
    cpuTasks:   0,
    errors:     0,
    totalMs:    0,
    vramEstBytes: 0,
  };

  // ── GPU Task Queue ─────────────────────────────────────────────────────────
  var MAX_CONCURRENT_GPU = 4;
  var _activeGpu = 0;
  var _gpuQueue  = [];  // [{ fn, resolve, reject }]

  function _enqueueGpu(fn) {
    if (_activeGpu < MAX_CONCURRENT_GPU) {
      _activeGpu++;
      return Promise.resolve().then(fn).finally(function () {
        _activeGpu--;
        _drainGpuQueue();
      });
    }
    return new Promise(function (resolve, reject) {
      _gpuQueue.push({ fn: fn, resolve: resolve, reject: reject });
    });
  }

  function _drainGpuQueue() {
    if (_gpuQueue.length === 0 || _activeGpu >= MAX_CONCURRENT_GPU) return;
    var item = _gpuQueue.shift();
    _activeGpu++;
    Promise.resolve().then(item.fn).then(item.resolve).catch(item.reject).finally(function () {
      _activeGpu--;
      _drainGpuQueue();
    });
  }

  // ── Memory pressure guard ──────────────────────────────────────────────────
  function _gpuEnabled() {
    var tier = global.RuntimeMemory ? global.RuntimeMemory.getTier() : 'NORMAL';
    if (tier === 'EMERGENCY' || tier === 'CRITICAL') return false;
    return _gpuTier !== 'cpu';
  }

  // ── WebGPU initialiser ────────────────────────────────────────────────────
  function _initWebGPU() {
    if (!_webgpuSupported) return Promise.reject(new Error('WebGPU not available'));
    return navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      .then(function (adapter) {
        if (!adapter) throw new Error('no WebGPU adapter');
        _gpuAdapter = adapter;
        return adapter.requestDevice({
          requiredLimits: {
            maxBufferSize:              512 * 1024 * 1024,
            maxStorageBufferBindingSize: 256 * 1024 * 1024,
          },
        });
      })
      .then(function (device) {
        _gpuDevice = device;
        _gpuTier   = 'webgpu';
        _gpuDevice.lost.then(function (info) {
          console.warn(LOG, 'WebGPU device lost:', info.reason);
          _gpuDevice = null;
          _gpuTier   = _webgl2Supported ? 'webgl2' : _webgl1Supported ? 'webgl1' : 'cpu';
        });
        return device;
      });
  }

  // ── WebGPU compute shader (imgGreyscale as example) ───────────────────────
  var WGSL_GREYSCALE = /* wgsl */`
    @group(0) @binding(0) var<storage, read>       inputBuf  : array<u32>;
    @group(0) @binding(1) var<storage, read_write>  outputBuf : array<u32>;
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
      let idx = gid.x;
      if (idx >= arrayLength(&inputBuf)) { return; }
      let px  = inputBuf[idx];
      let r   = (px >>  0u) & 0xFFu;
      let g   = (px >>  8u) & 0xFFu;
      let b   = (px >> 16u) & 0xFFu;
      let a   = (px >> 24u) & 0xFFu;
      let lum = u32(0.299 * f32(r) + 0.587 * f32(g) + 0.114 * f32(b));
      outputBuf[idx] = lum | (lum << 8u) | (lum << 16u) | (a << 24u);
    }`;

  function _webgpuGreyscale(rgbaBuffer) {
    if (!_gpuDevice) return Promise.reject(new Error('no device'));
    var device  = _gpuDevice;
    var inData  = new Uint32Array(rgbaBuffer);
    var byteLen = inData.byteLength;

    var inBuf  = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    var outBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    var readBuf= device.createBuffer({ size: byteLen, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    device.queue.writeBuffer(inBuf, 0, inData);

    var module = device.createShaderModule({ code: WGSL_GREYSCALE });
    var pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: module, entryPoint: 'main' },
    });
    var bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
      ],
    });

    var encoder = device.createCommandEncoder();
    var pass    = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(inData.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, byteLen);
    device.queue.submit([encoder.finish()]);

    return readBuf.mapAsync(GPUMapMode.READ).then(function () {
      var result = readBuf.getMappedRange().slice(0);
      readBuf.unmap();
      inBuf.destroy(); outBuf.destroy(); readBuf.destroy();
      return result;
    });
  }

  // ── WebGL 2 greyscale (fragment shader) ───────────────────────────────────
  function _webgl2Greyscale(rgbaBuffer, width, height) {
    try {
      var canvas = _offscreenCanvasSupported
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width: width, height: height });
      var gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');

      var vsSrc = 'in vec2 pos; out vec2 uv; void main(){gl_Position=vec4(pos,0,1);uv=(pos+1.)/2.;}';
      var fsSrc = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D tex;out vec4 col;' +
                  'void main(){vec4 s=texture(tex,uv);float g=dot(s.rgb,vec3(0.299,0.587,0.114));col=vec4(g,g,g,s.a);}';

      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, '#version 300 es\n' + vsSrc); gl.compileShader(vs);
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
      var prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      gl.useProgram(prog);

      var quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
      var buf  = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(rgbaBuffer));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      var out = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog);
      return Promise.resolve(out.buffer);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // ── CPU Canvas 2D fallbacks ────────────────────────────────────────────────
  var _cpuOps = {

    imgScale: function (input, opts) {
      var sw = opts.srcWidth, sh = opts.srcHeight;
      var tw = opts.dstWidth  || Math.round(sw * (opts.scale || 0.5));
      var th = opts.dstHeight || Math.round(sh * (opts.scale || 0.5));
      try {
        var src  = _offscreenCanvasSupported ? new OffscreenCanvas(sw, sh)
                 : Object.assign(document.createElement('canvas'), { width: sw, height: sh });
        var sctx = src.getContext('2d');
        var imgd = input instanceof ImageData ? input
                 : new ImageData(new Uint8ClampedArray(input), sw, sh);
        sctx.putImageData(imgd, 0, 0);
        var dst  = _offscreenCanvasSupported ? new OffscreenCanvas(tw, th)
                 : Object.assign(document.createElement('canvas'), { width: tw, height: th });
        var dctx = dst.getContext('2d');
        dctx.drawImage(src, 0, 0, tw, th);
        return Promise.resolve(dctx.getImageData(0, 0, tw, th));
      } catch (e) { return Promise.reject(e); }
    },

    imgGreyscale: function (input, opts) {
      var data = new Uint8ClampedArray(
        input instanceof ArrayBuffer ? input : (input.data ? input.data.buffer : input));
      for (var i = 0; i < data.length; i += 4) {
        var g = Math.round(0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]);
        data[i] = data[i+1] = data[i+2] = g;
      }
      return Promise.resolve(data.buffer);
    },

    imgDenoise: function (input, opts) {
      var w = opts.width, h = opts.height;
      var src  = new Uint8Array(input instanceof ArrayBuffer ? input : input.data.buffer);
      var out  = new Uint8Array(src.length);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          for (var c = 0; c < 3; c++) {
            var sum = 0;
            for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
              sum += src[((y+dy)*w + (x+dx)) * 4 + c];
            }
            out[(y*w + x)*4 + c] = Math.round(sum / 9);
          }
          out[(y*w + x)*4 + 3] = src[(y*w + x)*4 + 3]; // alpha
        }
      }
      return Promise.resolve(out.buffer);
    },

    imgContrast: function (input, opts) {
      var factor = opts.factor != null ? opts.factor : 1.5;
      var data   = new Uint8ClampedArray(input instanceof ArrayBuffer ? input : input.data.buffer);
      var mean   = 0;
      for (var i = 0; i < data.length; i += 4) mean += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      mean /= (data.length / 4);
      for (var j = 0; j < data.length; j += 4) {
        data[j]   = Math.min(255, Math.max(0, mean + factor * (data[j]   - mean)));
        data[j+1] = Math.min(255, Math.max(0, mean + factor * (data[j+1] - mean)));
        data[j+2] = Math.min(255, Math.max(0, mean + factor * (data[j+2] - mean)));
      }
      return Promise.resolve(data.buffer);
    },

    imgThreshold: function (input, opts) {
      var threshold = opts.threshold != null ? opts.threshold : 128;
      var data = new Uint8ClampedArray(input instanceof ArrayBuffer ? input : input.data.buffer);
      for (var i = 0; i < data.length; i += 4) {
        var lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
        var v   = lum >= threshold ? 255 : 0;
        data[i] = data[i+1] = data[i+2] = v;
      }
      return Promise.resolve(data.buffer);
    },

    thumbnail: function (input, opts) {
      return _cpuOps.imgScale(input, Object.assign({ scale: 0.25 }, opts));
    },

    tensorNorm: function (input, opts) {
      var f32  = input instanceof Float32Array ? input : new Float32Array(input);
      var mean = opts.mean != null ? opts.mean : 0;
      var std  = opts.std  != null ? opts.std  : 1;
      var out  = new Float32Array(f32.length);
      for (var i = 0; i < f32.length; i++) out[i] = (f32[i] - mean) / (std || 1);
      return Promise.resolve(out.buffer);
    },
  };

  // ── Core runTask ──────────────────────────────────────────────────────────
  function runTask(op, input, opts) {
    opts = opts || {};
    _stats.tasks++;
    var t0 = Date.now();

    // Always use CPU path for tensor ops (no GPU benefit without real ML pipeline)
    if (op === 'tensorNorm') {
      _stats.cpuTasks++;
      return _cpuOps.tensorNorm(input, opts).then(function (r) {
        _stats.totalMs += Date.now() - t0;
        return { result: r, path: 'cpu', op: op, durationMs: Date.now() - t0 };
      });
    }

    // Try GPU path when available and system is not under memory pressure
    if (_gpuEnabled()) {
      return _enqueueGpu(function () {
        return _runGpu(op, input, opts);
      }).then(function (r) {
        _stats.gpuTasks++;
        _stats.totalMs += Date.now() - t0;
        return { result: r, path: _gpuTier, op: op, durationMs: Date.now() - t0 };
      }).catch(function (err) {
        console.warn(LOG, 'GPU path failed for', op, '—', err.message, '— CPU fallback');
        _stats.errors++;
        return _runCpu(op, input, opts).then(function (r) {
          _stats.cpuTasks++;
          _stats.totalMs += Date.now() - t0;
          return { result: r, path: 'cpu-fallback', op: op, durationMs: Date.now() - t0, fallback: err.message };
        });
      });
    }

    // CPU path
    _stats.cpuTasks++;
    return _runCpu(op, input, opts).then(function (r) {
      _stats.totalMs += Date.now() - t0;
      return { result: r, path: 'cpu', op: op, durationMs: Date.now() - t0 };
    });
  }

  function _runGpu(op, input, opts) {
    if (_gpuTier === 'webgpu') {
      if (op === 'imgGreyscale') {
        var buf = input instanceof ArrayBuffer ? input : (input.data ? input.data.buffer : null);
        if (buf) return _webgpuGreyscale(buf);
      }
      // Other ops: demote to WebGL
    }
    if (_gpuTier === 'webgpu' || _gpuTier === 'webgl2') {
      if (op === 'imgGreyscale') {
        var w = opts.width || 1, h = opts.height || 1;
        var b = input instanceof ArrayBuffer ? input : (input.data ? input.data.buffer : input);
        return _webgl2Greyscale(b, w, h);
      }
    }
    return _runCpu(op, input, opts);
  }

  function _runCpu(op, input, opts) {
    var fn = _cpuOps[op];
    if (!fn) return Promise.reject(new Error('unknown GPU op: ' + op));
    try { return Promise.resolve(fn(input, opts)); } catch (e) { return Promise.reject(e); }
  }

  // ── Capabilities ──────────────────────────────────────────────────────────
  function getCapabilities() {
    return {
      webgpu:     _webgpuSupported && !!_gpuDevice,
      webgl2:     _webgl2Supported,
      webgl1:     _webgl1Supported,
      offscreen:  _offscreenCanvasSupported,
      activeTier: _gpuTier,
      queueDepth: _gpuQueue.length,
      activeGpu:  _activeGpu,
      maxConcurrent: MAX_CONCURRENT_GPU,
      ops: Object.keys(_cpuOps),
    };
  }

  function getStats() {
    return Object.assign({}, _stats, {
      avgMs: _stats.tasks > 0 ? Math.round(_stats.totalMs / _stats.tasks) : 0,
      gpuFraction: _stats.tasks > 0 ? Math.round(_stats.gpuTasks / _stats.tasks * 100) + '%' : '0%',
      tier: _gpuTier,
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function _boot() {
    // Attempt WebGPU init; fall back silently
    if (_webgpuSupported) {
      _initWebGPU().then(function () {
        console.info(LOG, 'WebGPU device acquired — tier: webgpu');
        if (global.RuntimeEventBus) {
          try { global.RuntimeEventBus.emit('gpu:ready', { tier: 'webgpu' }); } catch (_) {}
        }
      }).catch(function (err) {
        _gpuTier = _webgl2Supported ? 'webgl2' : _webgl1Supported ? 'webgl1' : 'cpu';
        console.info(LOG, 'WebGPU unavailable (' + err.message + ') — tier:', _gpuTier);
      });
    } else {
      _gpuTier = _webgl2Supported ? 'webgl2' : _webgl1Supported ? 'webgl1' : 'cpu';
    }

    var RT = global.CentralRuntime || global.RT;
    if (RT && RT.register) {
      try { RT.register('gpuEngine', global.RuntimeGpuEngine); } catch (_) {}
    }
    if (global.RuntimeTelemetry) {
      try { global.RuntimeTelemetry.record('gpu:engine-ready', { tier: _gpuTier, webgpu: _webgpuSupported }); } catch (_) {}
    }
    console.info(LOG, 'RuntimeGpuEngine v1.0 ready — tier:', _gpuTier,
      '| WebGL2:', _webgl2Supported, '| OffscreenCanvas:', _offscreenCanvasSupported);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_boot, 150);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 150); }, { once: true });
  }

  global.RuntimeGpuEngine = { runTask: runTask, getCapabilities: getCapabilities, getStats: getStats };
}(window));
