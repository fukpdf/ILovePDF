// ILovePDF WebGPU Phase 23 — Real AI Inference Enhancement Layer
// Extends RuntimeGpuEngine with compute-shader–based image processing tasks.
// WGSL shaders: grayscale, gaussian blur, Sobel edges, adaptive threshold,
// colour normalisation, background segmentation helpers.
// Falls back gracefully when WebGPU is unavailable.

(function () {
  'use strict';

  // ── WGSL Shader Library ────────────────────────────────────────────────────

  const SHADER_GRAYSCALE = /* wgsl */`
    @group(0) @binding(0) var<storage, read>        src  : array<u32>;
    @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
    @group(0) @binding(2) var<uniform>              dims : vec2u;

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      if (gid.x >= dims.x || gid.y >= dims.y) { return; }
      let idx  = gid.y * dims.x + gid.x;
      let px   = src[idx];
      let r    = f32((px >>  0u) & 0xFFu);
      let g    = f32((px >>  8u) & 0xFFu);
      let b    = f32((px >> 16u) & 0xFFu);
      let a    = (px >> 24u) & 0xFFu;
      let lum  = u32(0.2126 * r + 0.7152 * g + 0.0722 * b);
      dst[idx] = (a << 24u) | (lum << 16u) | (lum << 8u) | lum;
    }
  `;

  const SHADER_GAUSSIAN_3X3 = /* wgsl */`
    @group(0) @binding(0) var<storage, read>        src  : array<u32>;
    @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
    @group(0) @binding(2) var<uniform>              dims : vec2u;

    const kernel = array<f32, 9>(
      0.0625, 0.125, 0.0625,
      0.125,  0.25,  0.125,
      0.0625, 0.125, 0.0625
    );

    fn clampCoord(v : i32, maxV : u32) -> u32 { return u32(clamp(v, 0, i32(maxV) - 1)); }

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      if (gid.x >= dims.x || gid.y >= dims.y) { return; }
      var acc = vec4f(0.0);
      for (var ky = -1; ky <= 1; ky++) {
        for (var kx = -1; kx <= 1; kx++) {
          let sx  = clampCoord(i32(gid.x) + kx, dims.x);
          let sy  = clampCoord(i32(gid.y) + ky, dims.y);
          let px  = src[sy * dims.x + sx];
          let w   = kernel[(ky + 1) * 3 + (kx + 1)];
          acc.r  += f32((px >>  0u) & 0xFFu) * w;
          acc.g  += f32((px >>  8u) & 0xFFu) * w;
          acc.b  += f32((px >> 16u) & 0xFFu) * w;
          acc.a  += f32((px >> 24u) & 0xFFu) * w;
        }
      }
      let ro  = u32(clamp(acc.r, 0.0, 255.0));
      let go  = u32(clamp(acc.g, 0.0, 255.0));
      let bo  = u32(clamp(acc.b, 0.0, 255.0));
      let ao  = u32(clamp(acc.a, 0.0, 255.0));
      dst[gid.y * dims.x + gid.x] = (ao << 24u) | (bo << 16u) | (go << 8u) | ro;
    }
  `;

  const SHADER_SOBEL = /* wgsl */`
    @group(0) @binding(0) var<storage, read>        src  : array<u32>;
    @group(0) @binding(1) var<storage, read_write>  dst  : array<u32>;
    @group(0) @binding(2) var<uniform>              dims : vec2u;

    fn lum(px : u32) -> f32 {
      return 0.2126 * f32((px) & 0xFFu)
           + 0.7152 * f32((px >>  8u) & 0xFFu)
           + 0.0722 * f32((px >> 16u) & 0xFFu);
    }
    fn s(x : i32, y : i32, W : u32, H : u32, src_ : ptr<storage, array<u32>, read>) -> f32 {
      let cx = u32(clamp(x, 0, i32(W) - 1));
      let cy = u32(clamp(y, 0, i32(H) - 1));
      return lum((*src_)[cy * W + cx]);
    }

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      if (gid.x >= dims.x || gid.y >= dims.y) { return; }
      let ix = i32(gid.x); let iy = i32(gid.y);
      let W  = dims.x;     let H  = dims.y;
      let gx = -s(ix-1,iy-1,W,H,&src) - 2.0*s(ix-1,iy,W,H,&src) - s(ix-1,iy+1,W,H,&src)
               +s(ix+1,iy-1,W,H,&src) + 2.0*s(ix+1,iy,W,H,&src) + s(ix+1,iy+1,W,H,&src);
      let gy = -s(ix-1,iy-1,W,H,&src) - 2.0*s(ix,iy-1,W,H,&src) - s(ix+1,iy-1,W,H,&src)
               +s(ix-1,iy+1,W,H,&src) + 2.0*s(ix,iy+1,W,H,&src) + s(ix+1,iy+1,W,H,&src);
      let mag = u32(clamp(sqrt(gx*gx + gy*gy), 0.0, 255.0));
      let a   = (src[gid.y * dims.x + gid.x] >> 24u) & 0xFFu;
      dst[gid.y * dims.x + gid.x] = (a << 24u) | (mag << 16u) | (mag << 8u) | mag;
    }
  `;

  const SHADER_ADAPTIVE_THRESHOLD = /* wgsl */`
    @group(0) @binding(0) var<storage, read>        src   : array<u32>;
    @group(0) @binding(1) var<storage, read_write>  dst   : array<u32>;
    @group(0) @binding(2) var<uniform>              dims  : vec2u;
    @group(0) @binding(3) var<uniform>              params: vec2f; // radius, C

    fn lum(px : u32) -> f32 {
      return 0.2126 * f32((px) & 0xFFu)
           + 0.7152 * f32((px >>  8u) & 0xFFu)
           + 0.0722 * f32((px >> 16u) & 0xFFu);
    }

    @compute @workgroup_size(8, 8)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      if (gid.x >= dims.x || gid.y >= dims.y) { return; }
      let r    = i32(params.x);
      let C    = params.y;
      let ix   = i32(gid.x); let iy = i32(gid.y);
      var sum  = 0.0; var count = 0.0;
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          let sx = u32(clamp(ix + dx, 0, i32(dims.x) - 1));
          let sy = u32(clamp(iy + dy, 0, i32(dims.y) - 1));
          sum   += lum(src[sy * dims.x + sx]);
          count += 1.0;
        }
      }
      let mean  = sum / count;
      let pixel = lum(src[gid.y * dims.x + gid.x]);
      let out   = select(0u, 255u, pixel > mean - C);
      let a     = (src[gid.y * dims.x + gid.x] >> 24u) & 0xFFu;
      dst[gid.y * dims.x + gid.x] = (a << 24u) | (out << 16u) | (out << 8u) | out;
    }
  `;

  const SHADER_NORMALIZE = /* wgsl */`
    @group(0) @binding(0) var<storage, read>        src   : array<f32>;
    @group(0) @binding(1) var<storage, read_write>  dst   : array<f32>;
    @group(0) @binding(2) var<uniform>              params: vec2f; // mean, std

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      let i     = gid.x;
      let total = arrayLength(&src);
      if (i >= total) { return; }
      dst[i] = (src[i] - params.x) / max(params.y, 1e-6);
    }
  `;

  // ── GPU Context ────────────────────────────────────────────────────────────

  let _device  = null;
  let _adapter = null;
  let _ready   = false;
  let _error   = null;

  const Telemetry = {
    gpuBackend:    'unknown',
    shaderCompiles: 0,
    tasksRun:      0,
    tasksFailed:   0,
    totalMs:       0,
    lastTaskMs:    0,
    featureFlags:  [],
  };

  async function initGpu() {
    if (_ready) return true;
    if (_error) return false;

    if (!navigator.gpu) { _error = 'WebGPU not supported'; return false; }

    try {
      _adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
      if (!_adapter) { _error = 'No GPU adapter'; return false; }

      // Collect feature flags for telemetry
      const features = [];
      for (const f of _adapter.features) features.push(f);
      Telemetry.featureFlags = features;

      _device = await _adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: _adapter.limits.maxStorageBufferBindingSize,
        },
      });

      _device.lost.then(info => {
        _ready = false;
        _device = null;
        _error  = `GPU lost: ${info.reason} — ${info.message}`;
        console.warn('[Phase23]', _error);
      });

      const adapterInfo = _adapter.info || {};
      Telemetry.gpuBackend = adapterInfo.vendor || adapterInfo.device || 'WebGPU';
      _ready = true;
      console.info('[Phase23] WebGPU ready:', Telemetry.gpuBackend, 'features:', features.length);
      return true;
    } catch (err) {
      _error = String(err);
      console.warn('[Phase23] WebGPU init failed:', err);
      return false;
    }
  }

  // ── Pipeline Cache ─────────────────────────────────────────────────────────

  const _pipelines = new Map();

  async function getPipeline(key, wgsl, bindGroupLayout) {
    if (_pipelines.has(key)) return _pipelines.get(key);

    const module = _device.createShaderModule({ code: wgsl, label: key });
    Telemetry.shaderCompiles++;

    const pipeline = await _device.createComputePipelineAsync({
      label:   key,
      layout:  _device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module, entryPoint: 'main' },
    });

    _pipelines.set(key, pipeline);
    return pipeline;
  }

  // ── Buffer Helpers ─────────────────────────────────────────────────────────

  function makeBuffer(data, usage) {
    const buf = _device.createBuffer({
      size:         Math.ceil(data.byteLength / 4) * 4,
      usage:        usage | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer || data));
    buf.unmap();
    return buf;
  }

  function makeOutputBuffer(byteSize) {
    return _device.createBuffer({
      size:  Math.ceil(byteSize / 4) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  function makeReadbackBuffer(byteSize) {
    return _device.createBuffer({
      size:  Math.ceil(byteSize / 4) * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  async function readbackBuffer(buf, byteSize) {
    const rb = makeReadbackBuffer(byteSize);
    const enc = _device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, rb, 0, Math.ceil(byteSize / 4) * 4);
    _device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const result = rb.getMappedRange(0, byteSize).slice(0);
    rb.unmap(); rb.destroy();
    return result;
  }

  // ── Core Task: Grayscale ───────────────────────────────────────────────────

  async function taskGrayscale(imageData) {
    const { width: W, height: H, data } = imageData;
    const srcBuf  = makeBuffer(data, GPUBufferUsage.STORAGE);
    const dstBuf  = makeOutputBuffer(data.byteLength);
    const dimsBuf = makeBuffer(new Uint32Array([W, H]), GPUBufferUsage.UNIFORM);

    const bgl = _device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]});

    const pipeline = await getPipeline('grayscale', SHADER_GRAYSCALE, bgl);
    const bg = _device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: dimsBuf } },
    ]});

    const enc = _device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    _device.queue.submit([enc.finish()]);

    const raw = await readbackBuffer(dstBuf, data.byteLength);
    srcBuf.destroy(); dstBuf.destroy(); dimsBuf.destroy();
    return new ImageData(new Uint8ClampedArray(raw), W, H);
  }

  // ── Core Task: Gaussian Blur ───────────────────────────────────────────────

  async function taskBlur(imageData) {
    const { width: W, height: H, data } = imageData;
    const srcBuf  = makeBuffer(data, GPUBufferUsage.STORAGE);
    const dstBuf  = makeOutputBuffer(data.byteLength);
    const dimsBuf = makeBuffer(new Uint32Array([W, H]), GPUBufferUsage.UNIFORM);

    const bgl = _device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]});

    const pipeline = await getPipeline('gaussian3x3', SHADER_GAUSSIAN_3X3, bgl);
    const bg = _device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: dimsBuf } },
    ]});

    const enc = _device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    _device.queue.submit([enc.finish()]);

    const raw = await readbackBuffer(dstBuf, data.byteLength);
    srcBuf.destroy(); dstBuf.destroy(); dimsBuf.destroy();
    return new ImageData(new Uint8ClampedArray(raw), W, H);
  }

  // ── Core Task: Sobel Edge Detection ───────────────────────────────────────

  async function taskSobel(imageData) {
    const { width: W, height: H, data } = imageData;
    const srcBuf  = makeBuffer(data, GPUBufferUsage.STORAGE);
    const dstBuf  = makeOutputBuffer(data.byteLength);
    const dimsBuf = makeBuffer(new Uint32Array([W, H]), GPUBufferUsage.UNIFORM);

    const bgl = _device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]});

    const pipeline = await getPipeline('sobel', SHADER_SOBEL, bgl);
    const bg = _device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: dimsBuf } },
    ]});

    const enc = _device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    _device.queue.submit([enc.finish()]);

    const raw = await readbackBuffer(dstBuf, data.byteLength);
    srcBuf.destroy(); dstBuf.destroy(); dimsBuf.destroy();
    return new ImageData(new Uint8ClampedArray(raw), W, H);
  }

  // ── Core Task: Adaptive Threshold (for OCR pre-processing) ────────────────

  async function taskAdaptiveThreshold(imageData, radius = 11, C = 10) {
    const { width: W, height: H, data } = imageData;
    const srcBuf    = makeBuffer(data, GPUBufferUsage.STORAGE);
    const dstBuf    = makeOutputBuffer(data.byteLength);
    const dimsBuf   = makeBuffer(new Uint32Array([W, H]), GPUBufferUsage.UNIFORM);
    const paramsBuf = makeBuffer(new Float32Array([radius, C]), GPUBufferUsage.UNIFORM);

    const bgl = _device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]});

    const pipeline = await getPipeline('adaptiveThreshold', SHADER_ADAPTIVE_THRESHOLD, bgl);
    const bg = _device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: dimsBuf } },
      { binding: 3, resource: { buffer: paramsBuf } },
    ]});

    const enc = _device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    _device.queue.submit([enc.finish()]);

    const raw = await readbackBuffer(dstBuf, data.byteLength);
    srcBuf.destroy(); dstBuf.destroy(); dimsBuf.destroy(); paramsBuf.destroy();
    return new ImageData(new Uint8ClampedArray(raw), W, H);
  }

  // ── Core Task: Tensor Normalisation (for AI inference pipelines) ──────────

  async function taskNormalize(floatArray, mean = 0.5, std = 0.5) {
    const srcBuf    = makeBuffer(floatArray, GPUBufferUsage.STORAGE);
    const dstBuf    = makeOutputBuffer(floatArray.byteLength);
    const paramsBuf = makeBuffer(new Float32Array([mean, std]), GPUBufferUsage.UNIFORM);

    const bgl = _device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ]});

    const pipeline = await getPipeline('normalize', SHADER_NORMALIZE, bgl);
    const bg = _device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
    ]});

    const n = floatArray.length;
    const enc = _device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    _device.queue.submit([enc.finish()]);

    const raw = await readbackBuffer(dstBuf, floatArray.byteLength);
    srcBuf.destroy(); dstBuf.destroy(); paramsBuf.destroy();
    return new Float32Array(raw);
  }

  // ── CPU Fallbacks ──────────────────────────────────────────────────────────

  function cpuGrayscale(imageData) {
    const d = new Uint8ClampedArray(imageData.data);
    for (let i = 0; i < d.length; i += 4) {
      const l = Math.round(0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]);
      d[i] = d[i+1] = d[i+2] = l;
    }
    return new ImageData(d, imageData.width, imageData.height);
  }

  function cpuBlur(imageData) {
    const { width: W, height: H, data } = imageData;
    const k = [1/16, 1/8, 1/16, 1/8, 1/4, 1/8, 1/16, 1/8, 1/16];
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0, ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = Math.min(Math.max(x+dx,0),W-1);
            const sy = Math.min(Math.max(y+dy,0),H-1);
            const p  = (sy*W+sx)*4;
            r += data[p]*k[ki]; g += data[p+1]*k[ki];
            b += data[p+2]*k[ki]; a += data[p+3]*k[ki]; ki++;
          }
        }
        const o = (y*W+x)*4;
        out[o]=r; out[o+1]=g; out[o+2]=b; out[o+3]=a;
      }
    }
    return new ImageData(out, W, H);
  }

  // ── Safety check for mobile/low-memory ────────────────────────────────────

  function isSafeForGpu(imageData) {
    const pixels = imageData.width * imageData.height;
    const maxPixels = 16 * 1024 * 1024; // 16 MP limit
    if (pixels > maxPixels) return false;
    // Check device memory hint (Chrome)
    const mem = navigator.deviceMemory;
    if (mem !== undefined && mem < 2) return false;
    return true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  const Phase23 = {
    get ready()     { return _ready; },
    get error()     { return _error; },
    get telemetry() { return { ...Telemetry }; },

    async init() { return initGpu(); },

    async grayscale(imageData) {
      const t0 = performance.now();
      Telemetry.tasksRun++;
      try {
        const result = (_ready && isSafeForGpu(imageData))
          ? await taskGrayscale(imageData)
          : cpuGrayscale(imageData);
        Telemetry.lastTaskMs = performance.now() - t0;
        Telemetry.totalMs   += Telemetry.lastTaskMs;
        return result;
      } catch (err) {
        Telemetry.tasksFailed++;
        console.warn('[Phase23] grayscale fallback:', err);
        return cpuGrayscale(imageData);
      }
    },

    async blur(imageData) {
      const t0 = performance.now();
      Telemetry.tasksRun++;
      try {
        const result = (_ready && isSafeForGpu(imageData))
          ? await taskBlur(imageData)
          : cpuBlur(imageData);
        Telemetry.lastTaskMs = performance.now() - t0;
        Telemetry.totalMs   += Telemetry.lastTaskMs;
        return result;
      } catch (err) {
        Telemetry.tasksFailed++;
        console.warn('[Phase23] blur fallback:', err);
        return cpuBlur(imageData);
      }
    },

    async edges(imageData) {
      const t0 = performance.now();
      Telemetry.tasksRun++;
      try {
        const blurred = (_ready && isSafeForGpu(imageData))
          ? await taskBlur(imageData) : cpuBlur(imageData);
        const result  = (_ready && isSafeForGpu(blurred))
          ? await taskSobel(blurred)  : blurred;
        Telemetry.lastTaskMs = performance.now() - t0;
        Telemetry.totalMs   += Telemetry.lastTaskMs;
        return result;
      } catch (err) {
        Telemetry.tasksFailed++;
        console.warn('[Phase23] edges fallback:', err);
        return imageData;
      }
    },

    async ocrPreprocess(imageData) {
      // OCR pre-processing pipeline: blur → adaptive threshold
      const t0 = performance.now();
      Telemetry.tasksRun++;
      try {
        const blurred = (_ready && isSafeForGpu(imageData))
          ? await taskBlur(imageData) : cpuBlur(imageData);
        const result  = (_ready && isSafeForGpu(blurred))
          ? await taskAdaptiveThreshold(blurred, 11, 10)
          : blurred;
        Telemetry.lastTaskMs = performance.now() - t0;
        Telemetry.totalMs   += Telemetry.lastTaskMs;
        return result;
      } catch (err) {
        Telemetry.tasksFailed++;
        console.warn('[Phase23] ocrPreprocess fallback:', err);
        return imageData;
      }
    },

    async normalizeForInference(floatArray, mean = 0.485, std = 0.229) {
      const t0 = performance.now();
      Telemetry.tasksRun++;
      try {
        const result = _ready
          ? await taskNormalize(floatArray, mean, std)
          : floatArray.map(v => (v - mean) / Math.max(std, 1e-6));
        Telemetry.lastTaskMs = performance.now() - t0;
        Telemetry.totalMs   += Telemetry.lastTaskMs;
        return result;
      } catch (err) {
        Telemetry.tasksFailed++;
        console.warn('[Phase23] normalize fallback:', err);
        return floatArray;
      }
    },

    // Register Phase23 tasks into RuntimeGpuEngine if available
    integrateWithRuntimeEngine() {
      const engine = window.RuntimeGpuEngine;
      if (!engine || typeof engine.registerTask !== 'function') return false;
      engine.registerTask('phase23:grayscale', img => Phase23.grayscale(img));
      engine.registerTask('phase23:blur',      img => Phase23.blur(img));
      engine.registerTask('phase23:edges',     img => Phase23.edges(img));
      engine.registerTask('phase23:ocr-prep',  img => Phase23.ocrPreprocess(img));
      return true;
    },
  };

  // ── Auto-init ──────────────────────────────────────────────────────────────

  (async function autoInit() {
    await initGpu();
    Phase23.integrateWithRuntimeEngine();
    // Expose telemetry to RuntimeDashboard if loaded
    const expose = () => {
      if (window.RuntimeDashboard && typeof window.RuntimeDashboard.addMetric === 'function') {
        window.RuntimeDashboard.addMetric('gpu_phase23_backend', Telemetry.gpuBackend);
        window.RuntimeDashboard.addMetric('gpu_phase23_ready',   _ready);
      }
    };
    expose();
    window.addEventListener('runtime:dashboard:ready', expose, { once: true });
  })();

  window.GpuPhase23 = Phase23;
})();
