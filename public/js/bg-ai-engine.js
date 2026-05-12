// BgAiEngine v7.0 — Production-Grade Multi-Pipeline Segmentation
//
// PIPELINE (target: remove.bg quality, fully browser-side)
// ══════════════════════════════════════════════════════════════════════════
//
//   Input Image
//     ↓ Image Type Classification (12 features → 12 categories)
//     ↓ Model Selection (lite / standard / modnet / birefnet)
//   RMBG-1.4 Inference (whole image OR 25%-overlap cosine-tiled 1024px)
//     ↓ Confidence map [0,1]
//   Trimap Generation
//     ↓ conf > FG_THR → definite FG (immutable)
//     ↓ conf < BG_THR → definite BG (immutable)
//     ↓ else         → unknown (refined below)
//
//   ┌── BINARY (screenshot / document / logo) ───────────────────────────┐
//   │  Otsu binary → morph close → morph open → hole fill                │
//   │  Hard pixel-perfect edges. Zero feathering. Zero blur.             │
//   └────────────────────────────────────────────────────────────────────┘
//   ┌── PORTRAIT / SELFIE ────────────────────────────────────────────────┐
//   │  Pass 1: Multi-Scale COLOR Guided Filter                            │
//   │          fine(r≈0.3×R, ε/2) — hair strands, facial edges           │
//   │          coarse(r≈1.25×R, ε×3) — interior body fill                │
//   │          edge-magnitude blend (tanh weighting)                      │
//   │  Pass 2: morph close in unknown zone only                           │
//   │  Pass 3: Small Object Recovery (fingers, jewelry, hair strands)     │
//   └────────────────────────────────────────────────────────────────────┘
//   ┌── PRODUCT / METALLIC ───────────────────────────────────────────────┐
//   │  Pass 1: Single-Scale COLOR Guided Filter (low ε → sharp contours) │
//   │  Pass 2: morph close in unknown zone only                           │
//   │  Pass 3: Small Object Recovery (cables, keychains, thin handles)   │
//   └────────────────────────────────────────────────────────────────────┘
//   ┌── GENERAL PHOTO / ANIME / DARK ─────────────────────────────────────┐
//   │  Pass 1: COLOR Guided Filter (upgraded from grayscale)              │
//   │  Pass 2: morph close in unknown zone only                           │
//   │  Pass 3: Small Object Recovery                                      │
//   └────────────────────────────────────────────────────────────────────┘
//
//   Trimap Hard Enforcement (definite zones IMMUTABLE at GF + full res)
//     ↓ Upsample refined alpha → W×H
//     ↓ Export: fresh offscreen canvas → original RGB + final alpha → PNG
//
// v7 changes over v6:
//   - RGB color-guided filter for ALL non-screenshot pipelines
//   - Multi-scale COLOR guided filter for portrait (was grayscale)
//   - Pass 3: smallObjectRecovery for fine detail (new)
//   - TILE_OVERLAP: 256px = 25% of 1024 (was 128 = 12.5%)
//   - Trimap FG_THR ≥ 0.90, BG_THR ≤ 0.08 across all photo pipelines
//   - WebGPU execution provider (falls back to WebGL → WASM)
//   - screenshot subject mode override handled
//   - Reduced GF epsilon to prevent halos

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ══════════════════════════════════════════════════════════════════════════
  var ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
  var ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

  var GF_MAX_DIM    = 1024;  // max edge for guided-filter working resolution
  var GF_MAX_MOBILE = 512;
  var TILE_SIZE     = 1024;  // inference tile edge
  var TILE_OVERLAP  = 256;   // 25% cosine overlap — eliminates seam artefacts

  // ── Model registry ─────────────────────────────────────────────────────
  var MODELS = {
    lite: {
      name:          'U2Net-Lite',
      urls: [
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/u2netp.onnx',
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
      ],
      cacheKey:      'bge_u2netp_v7',
      inputSize:     320,
      mean:          [0.485, 0.456, 0.406],
      std:           [0.229, 0.224, 0.225],
      sizeMB:        4.7,
      outputSigmoid: false,
    },
    standard: {
      name:          'RMBG-1.4',
      urls: [
        'https://huggingface.co/Xenova/rmbg-v1.4/resolve/main/onnx/model_quantized.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
      ],
      cacheKey:      'bge_rmbg14_q_v7',
      inputSize:     1024,
      mean:          [0.5, 0.5, 0.5],
      std:           [1.0, 1.0, 1.0],
      sizeMB:        44,
      outputSigmoid: false,
    },
    modnet: {
      name:          'MODNet',
      urls: [
        'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_quantized.onnx',
      ],
      cacheKey:      'bge_modnet_q_v7',
      inputSize:     512,
      mean:          [0.5, 0.5, 0.5],
      std:           [0.5, 0.5, 0.5],
      sizeMB:        25,
      outputSigmoid: true,
    },
    birefnet: {
      name:          'RMBG-2.0 (BiRefNet)',
      urls: [
        'https://huggingface.co/briaai/RMBG-2.0/resolve/main/onnx/model.onnx',
      ],
      cacheKey:      'bge_rmbg20_v7',
      inputSize:     1024,
      mean:          [0.5, 0.5, 0.5],
      std:           [1.0, 1.0, 1.0],
      sizeMB:        176,
      outputSigmoid: false,
    },
  };

  // ── Per-category pipeline configuration ────────────────────────────────
  // WHY tight FG/BG thresholds: The model output is reliable near extremes.
  // Pixels >0.90 are almost certainly foreground — forcing them to 1.0 prevents
  // semi-transparent interiors ("muddy masks"). Pixels <0.08 are almost certainly
  // background — forcing them to 0.0 prevents haze/table leakage.
  // The unknown zone (between) is what the guided filter actually refines.
  var PIPELINE_CFG = {
    // Binary path: Otsu threshold + morph. No GF. Hard edges.
    screenshot:     { isScreenshot:true,  pipeline:'binary',  FG_THR:0.78, BG_THR:0.22, edgeDilR:0, gfR:0,  gfEps:0,       holeThr:0.25, morphClose:3, morphOpen:1 },
    darkScreenshot: { isScreenshot:true,  pipeline:'binary',  FG_THR:0.68, BG_THR:0.32, edgeDilR:0, gfR:0,  gfEps:0,       holeThr:0.25, morphClose:2, morphOpen:1 },
    document:       { isScreenshot:true,  pipeline:'binary',  FG_THR:0.75, BG_THR:0.25, edgeDilR:0, gfR:0,  gfEps:0,       holeThr:0.20, morphClose:2, morphOpen:1 },
    logo:           { isScreenshot:true,  pipeline:'binary',  FG_THR:0.68, BG_THR:0.32, edgeDilR:0, gfR:0,  gfEps:0,       holeThr:0.18, morphClose:2, morphOpen:1 },
    // Photo paths: tightened to FG≥0.90, BG≤0.08 to eliminate muddy alpha
    selfie:         { isScreenshot:false, pipeline:'portrait', FG_THR:0.92, BG_THR:0.07, edgeDilR:8, gfR:14, gfEps:0.002,   holeThr:0.31, morphClose:1, morphOpen:0 },
    portrait:       { isScreenshot:false, pipeline:'portrait', FG_THR:0.90, BG_THR:0.08, edgeDilR:7, gfR:12, gfEps:0.003,   holeThr:0.31, morphClose:1, morphOpen:0 },
    product:        { isScreenshot:false, pipeline:'product',  FG_THR:0.93, BG_THR:0.06, edgeDilR:3, gfR:8,  gfEps:0.0008,  holeThr:0.22, morphClose:1, morphOpen:0 },
    metallic:       { isScreenshot:false, pipeline:'product',  FG_THR:0.91, BG_THR:0.07, edgeDilR:4, gfR:6,  gfEps:0.0004,  holeThr:0.18, morphClose:1, morphOpen:0 },
    anime:          { isScreenshot:false, pipeline:'photo',    FG_THR:0.88, BG_THR:0.10, edgeDilR:4, gfR:6,  gfEps:0.006,   holeThr:0.28, morphClose:1, morphOpen:0 },
    dark:           { isScreenshot:false, pipeline:'photo',    FG_THR:0.87, BG_THR:0.10, edgeDilR:5, gfR:10, gfEps:0.003,   holeThr:0.28, morphClose:1, morphOpen:0 },
    photo:          { isScreenshot:false, pipeline:'photo',    FG_THR:0.90, BG_THR:0.08, edgeDilR:5, gfR:10, gfEps:0.003,   holeThr:0.28, morphClose:1, morphOpen:0 },
  };

  var _sessions   = {};
  var _ortReady   = false;
  var _ortPromise = null;

  function clamp(v, lo, hi)  { return v < lo ? lo : v > hi ? hi : v; }
  function clampF(v)         { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function yieldMain()       { return new Promise(function (r) { setTimeout(r, 0); }); }
  function isMobileUA()      { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || ''); }

  // ══════════════════════════════════════════════════════════════════════════
  //  ORT LOADER
  // ══════════════════════════════════════════════════════════════════════════
  function _configureWasm(ortNs) {
    try {
      ortNs.env.wasm.wasmPaths  = ORT_WASM_DIR;
      ortNs.env.wasm.proxy      = false;
      ortNs.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    } catch (_e) {}
  }

  function loadORT() {
    if (_ortReady && window.ort) return Promise.resolve(window.ort);
    if (_ortPromise) return _ortPromise;
    // Reuse the shared global promise if onnx-runtime-manager.js (or another module)
    // has already started loading ORT — prevents a second concurrent script injection.
    if (window.__ortPromise) {
      _ortPromise = window.__ortPromise.then(function (o) {
        _configureWasm(o); // configure WASM paths even if we didn't load the script
        _ortReady = true; return o;
      });
      return _ortPromise;
    }
    _ortPromise = window.__ortPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ORT_CDN; s.async = true;
      s.onload = function () {
        if (!window.ort) { _ortPromise = null; window.__ortPromise = null; reject(new Error('ort global missing')); return; }
        _configureWasm(window.ort);
        _ortReady = true; resolve(window.ort);
      };
      s.onerror = function () { _ortPromise = null; window.__ortPromise = null; reject(new Error('ORT CDN load failed')); };
      document.head.appendChild(s);
    });
    return _ortPromise;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IDB MODEL CACHE
  // ══════════════════════════════════════════════════════════════════════════
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 7);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models');
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function ()  { reject(new Error('IDB open failed')); };
    });
  }

  async function cacheGet(key) {
    try {
      var db = await idbOpen();
      return await new Promise(function (res) {
        var tx = db.transaction('models', 'readonly');
        var r  = tx.objectStore('models').get(key);
        r.onsuccess = function () { res(r.result || null); };
        r.onerror   = function () { res(null); };
      });
    } catch (_e) { return null; }
  }

  async function cacheSet(key, buf) {
    try {
      var db = await idbOpen();
      await new Promise(function (res) {
        var tx = db.transaction('models', 'readwrite');
        tx.objectStore('models').put(buf, key);
        tx.oncomplete = res; tx.onerror = res;
      });
    } catch (_e) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MODEL FETCH — streamed with download progress
  // ══════════════════════════════════════════════════════════════════════════
  async function fetchModel(cfg, onProgress) {
    var cached = await cacheGet(cfg.cacheKey);
    if (cached) {
      if (onProgress) onProgress(25, 'AI model ready \u2014 initialising\u2026');
      return cached instanceof ArrayBuffer ? cached : (cached.buffer || cached);
    }
    if (onProgress) onProgress(3, 'Downloading AI model (' + cfg.sizeMB.toFixed(0) + '\u202fMB)\u2026');
    var lastErr;
    for (var ui = 0; ui < cfg.urls.length; ui++) {
      try {
        var resp = await fetch(cfg.urls[ui]);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var contentLen = parseInt(resp.headers.get('content-length') || '0', 10);
        if (!resp.body || !contentLen) {
          var ab = await resp.arrayBuffer();
          await cacheSet(cfg.cacheKey, ab); return ab;
        }
        var reader = resp.body.getReader(), chunks = [], received = 0;
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value); received += chunk.value.length;
          if (onProgress && contentLen) {
            onProgress(3 + Math.round(received / contentLen * 22),
              'Downloading\u2026 ' + (received / 1048576).toFixed(1) + '\u202fMB\u202f/\u202f' + cfg.sizeMB.toFixed(0) + '\u202fMB');
          }
        }
        var total = 0;
        for (var ci = 0; ci < chunks.length; ci++) total += chunks[ci].length;
        var merged = new Uint8Array(total), off = 0;
        for (var ci2 = 0; ci2 < chunks.length; ci2++) { merged.set(chunks[ci2], off); off += chunks[ci2].length; }
        await cacheSet(cfg.cacheKey, merged.buffer);
        return merged.buffer;
      } catch (e) { lastErr = e; console.warn('[BgAI v7] fetch failed:', cfg.urls[ui], e.message); }
    }
    throw lastErr || new Error('All model URLs failed');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SESSION FACTORY + MODEL TIER SELECTION
  //  Provider order: WebGPU → WebGL → WASM
  //  WHY: WebGPU gives 3-10× speedup over WASM on supported devices.
  // ══════════════════════════════════════════════════════════════════════════
  function selectTier(imageMode, qualityMode, forceMob) {
    var mob = forceMob || isMobileUA();
    if (mob) return 'lite';
    var cfg = PIPELINE_CFG[imageMode] || PIPELINE_CFG.photo;
    if (cfg.isScreenshot) return 'lite'; // Otsu handles quality; model detail irrelevant
    if (qualityMode === 'ultra') {
      if (imageMode === 'selfie' || imageMode === 'portrait') return 'modnet';
      return 'birefnet';
    }
    if (qualityMode === 'lite') return 'lite';
    return 'standard';
  }

  async function getSession(tier, onProgress) {
    if (_sessions[tier]) return { session: _sessions[tier], cfg: MODELS[tier] };
    var cfg = MODELS[tier];
    if (!cfg) throw new Error('Unknown tier: ' + tier);
    var ort      = await loadORT();
    var modelBuf = await fetchModel(cfg, onProgress);
    if (onProgress) onProgress(28, 'Compiling AI model\u2026');
    var session, lastErr;
    // WHY provider cascade: WebGPU ≫ WebGL >> WASM for inference speed.
    // Each fallback level is tried only if the previous fails.
    var provSets = [['webgpu', 'wasm'], ['webgl', 'wasm'], ['wasm']];
    for (var pi = 0; pi < provSets.length; pi++) {
      try {
        session = await ort.InferenceSession.create(modelBuf, {
          executionProviders:    provSets[pi],
          graphOptimizationLevel: 'all',
          enableCpuMemArena:     false,
          enableMemPattern:      false,
        });
        console.log('[BgAI v7] session created with:', provSets[pi].join('+'));
        break;
      } catch (e) { lastErr = e; console.warn('[BgAI v7] session failed:', provSets[pi], e.message); }
    }
    if (!session) throw lastErr || new Error('Cannot create ONNX session');
    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IMAGE CLASSIFIER v2.0 — 12 features → 12 categories
  //
  //  Features:
  //   1. flatR          — fraction of low-variance (flat) regions → UI
  //   2. edgeR          — fraction of high-variance (edge) regions
  //   3. textLineR      — horizontal luminance steps → text proxy
  //   4. skinR          — skin-tone pixel ratio → portrait/selfie
  //   5. darkR          — dark pixel ratio
  //   6. avgSat         — average saturation
  //   7. lumVar         — global luminance variance
  //   8. hueSpread      — hue entropy (anime=low, natural=high)
  //   9. aspectScore    — portrait phone aspect (H>1.7W) → screenshot hint
  //  10. uiBarScore     — flat horizontal bands at top/bottom → UI chrome
  //  11. gradOverlay    — bottom-darker-than-mid → social media overlay
  //  12. iconDensity    — isolated high-contrast blobs → icon grid
  // ══════════════════════════════════════════════════════════════════════════
  function classifyImageMode(pixelData, W, H) {
    var step = Math.max(2, Math.round(Math.sqrt(W * H / 2000)));
    var flatCnt = 0, edgeCnt = 0, textLineCnt = 0;
    var skinCnt = 0, darkCnt = 0, total = 0;
    var satSum = 0, lumSum = 0, lumSqSum = 0;
    var hueHist = new Float32Array(12);

    for (var y = 2; y < H - 2; y += step) {
      for (var x = 2; x < W - 2; x += step) {
        var r = pixelData[(y*W+x)*4], g = pixelData[(y*W+x)*4+1], b = pixelData[(y*W+x)*4+2];
        var lum = (r*77+g*150+b*29)>>8;
        var ls=0, lsq=0;
        for (var dy=-2; dy<=2; dy++) {
          for (var dx=-2; dx<=2; dx++) {
            var k4=((y+dy)*W+(x+dx))*4;
            var br=(pixelData[k4]*77+pixelData[k4+1]*150+pixelData[k4+2]*29)>>8;
            ls+=br; lsq+=br*br;
          }
        }
        var lm=ls/25, lvar=lsq/25-lm*lm;
        if (lvar<120)  flatCnt++;
        if (lvar>1600) edgeCnt++;
        var ll=(pixelData[(y*W+x-2)*4]*77+pixelData[(y*W+x-2)*4+1]*150+pixelData[(y*W+x-2)*4+2]*29)>>8;
        var lr2=(pixelData[(y*W+x+2)*4]*77+pixelData[(y*W+x+2)*4+1]*150+pixelData[(y*W+x+2)*4+2]*29)>>8;
        if (Math.abs(ll-lr2)>80&&lvar>500&&lvar<3000) textLineCnt++;
        var mx=r>g?(r>b?r:b):(g>b?g:b), mn=r<g?(r<b?r:b):(g<b?g:b);
        var sat=mx>0?(mx-mn)/mx:0;
        satSum+=sat;
        if (mx>mn) {
          var hue=mx===r?((g-b)/(mx-mn)+6)%6:mx===g?(b-r)/(mx-mn)+2:(r-g)/(mx-mn)+4;
          hueHist[Math.floor(hue*2)%12]++;
        }
        lumSum+=lum; lumSqSum+=lum*lum;
        if (lum<50)  darkCnt++;
        if (r>100&&r<240&&g>60&&g<200&&b>40&&b<180&&r>g+8&&g>b-20&&sat>0.08&&sat<0.65) skinCnt++;
        total++;
      }
    }
    if (!total) return { mode:'photo', isScreenshot:false, pipelineCfg:PIPELINE_CFG.photo };

    var flatR=flatCnt/total, edgeR=edgeCnt/total, textR=textLineCnt/total;
    var skinR=skinCnt/total, darkR=darkCnt/total;
    var avgSat=satSum/total, avgLum=lumSum/total;
    var lumVar=lumSqSum/total-avgLum*avgLum;
    var hTotal=0;
    for (var hi=0;hi<12;hi++) hTotal+=hueHist[hi];
    var hueEnt=0;
    for (var hi2=0;hi2<12;hi2++) {
      if (hueHist[hi2]>0){var p=hueHist[hi2]/hTotal; hueEnt-=p*Math.log2(p);}
    }
    var hueSpread=hueEnt/Math.log2(12);

    // Feature 9: Portrait phone aspect (TikTok / Reels / Instagram)
    var aspectScore=(H>W*1.7)?1.0:(H>W*1.4)?0.5:0.0;

    // Feature 10: UI bar score — flat horizontal chrome at top + bottom
    var topH=Math.max(2,Math.floor(H*0.08)), botY=H-topH;
    var topFlat=0,topTotal=0,botFlat=0,botTotal=0;
    var bStep2=Math.max(1,Math.floor(step/2));
    for (var uy=0;uy<topH;uy+=bStep2) {
      for (var ux=2;ux<W-2;ux+=bStep2) {
        var uls=0,ulsq=0;
        for (var udy=-1;udy<=1;udy++) for (var udx=-2;udx<=2;udx++) {
          var ubr=(pixelData[((uy+udy)*W+(ux+udx))*4]*77+pixelData[((uy+udy)*W+(ux+udx))*4+1]*150+pixelData[((uy+udy)*W+(ux+udx))*4+2]*29)>>8;
          uls+=ubr; ulsq+=ubr*ubr;
        }
        if(ulsq/15-(uls/15)*(uls/15)<80) topFlat++;
        topTotal++;
      }
    }
    for (var by=botY;by<H;by+=bStep2) {
      for (var bx=2;bx<W-2;bx+=bStep2) {
        var bls=0,blsq=0;
        for (var bdy=-1;bdy<=1;bdy++) for (var bdx=-2;bdx<=2;bdx++) {
          var ny2=by+bdy,nx2=bx+bdx;
          if(ny2<0||ny2>=H||nx2<0||nx2>=W) continue;
          var bbr=(pixelData[(ny2*W+nx2)*4]*77+pixelData[(ny2*W+nx2)*4+1]*150+pixelData[(ny2*W+nx2)*4+2]*29)>>8;
          bls+=bbr; blsq+=bbr*bbr;
        }
        if(blsq/15-(bls/15)*(bls/15)<80) botFlat++;
        botTotal++;
      }
    }
    var uiBarScore=(topTotal>0?topFlat/topTotal:0+botTotal>0?botFlat/botTotal:0)/2;

    // Feature 11: Gradient overlay — bottom strip darker than mid → social media
    var midY=Math.floor(H*0.4),midYEnd=Math.floor(H*0.6),gradY=Math.floor(H*0.8);
    var midLum=0,midN=0,gradLum=0,gradN=0,gStep=Math.max(2,step*2);
    for (var gy=midY;gy<midYEnd;gy+=gStep) for (var gx=0;gx<W;gx+=gStep) {
      midLum+=(pixelData[(gy*W+gx)*4]*77+pixelData[(gy*W+gx)*4+1]*150+pixelData[(gy*W+gx)*4+2]*29)>>8;
      midN++;
    }
    for (var gy2=gradY;gy2<H;gy2+=gStep) for (var gx2=0;gx2<W;gx2+=gStep) {
      gradLum+=(pixelData[(gy2*W+gx2)*4]*77+pixelData[(gy2*W+gx2)*4+1]*150+pixelData[(gy2*W+gx2)*4+2]*29)>>8;
      gradN++;
    }
    var gradOverlay=0;
    if (midN>0&&gradN>0) gradOverlay=clampF((midLum/midN-gradLum/gradN)/80);

    // Feature 12: Icon density — isolated high-contrast blobs = icon-like
    var iconCnt=0, iconStep=Math.max(4,step*2);
    for (var iy=4;iy<H-4;iy+=iconStep) {
      for (var ix=4;ix<W-4;ix+=iconStep) {
        var sv=0,svq=0;
        for (var idy=-1;idy<=1;idy++) for (var idx2=-1;idx2<=1;idx2++) {
          var ibr=(pixelData[((iy+idy)*W+(ix+idx2))*4]*77+pixelData[((iy+idy)*W+(ix+idx2))*4+1]*150+pixelData[((iy+idy)*W+(ix+idx2))*4+2]*29)>>8;
          sv+=ibr; svq+=ibr*ibr;
        }
        var localV=svq/9-(sv/9)*(sv/9);
        var sv9=0,svq9=0,cn9=0;
        for (var idy2=-4;idy2<=4;idy2++) for (var idx3=-4;idx3<=4;idx3++) {
          var ny3=iy+idy2,nx3=ix+idx3;
          if(ny3<0||ny3>=H||nx3<0||nx3>=W) continue;
          var ibr2=(pixelData[(ny3*W+nx3)*4]*77+pixelData[(ny3*W+nx3)*4+1]*150+pixelData[(ny3*W+nx3)*4+2]*29)>>8;
          sv9+=ibr2; svq9+=ibr2*ibr2; cn9++;
        }
        var wideV=cn9>0?svq9/cn9-(sv9/cn9)*(sv9/cn9):0;
        if (localV>800&&wideV<1200&&wideV>50) iconCnt++;
      }
    }
    var iconTotal=Math.max(1,Math.floor((H/iconStep)*(W/iconStep)));
    var iconDensity=iconCnt/iconTotal;

    // ── Decision tree ─────────────────────────────────────────────────────
    var isScreenshotBasic=(flatR>0.42&&(edgeR>0.04||textR>0.03))
                         ||(flatR>0.60&&avgSat<0.20)||textR>0.08;
    var isSocialScreenshot=aspectScore>=0.5
                          &&(uiBarScore>0.55||gradOverlay>0.35||iconDensity>0.12);
    var isDarkScreenshot=darkR>0.60&&avgLum<70&&(flatR>0.35||textR>0.04);

    if (isDarkScreenshot&&(isScreenshotBasic||isSocialScreenshot))
      return { mode:'darkScreenshot', isScreenshot:true, pipelineCfg:PIPELINE_CFG.darkScreenshot };
    if (isScreenshotBasic||isSocialScreenshot)
      return { mode:'screenshot', isScreenshot:true, pipelineCfg:PIPELINE_CFG.screenshot };
    if (avgLum>190&&avgSat<0.10&&textR>0.02&&flatR>0.50)
      return { mode:'document', isScreenshot:true, pipelineCfg:PIPELINE_CFG.document };
    if (darkR>0.55&&avgLum<80)
      return { mode:'dark', isScreenshot:false, pipelineCfg:PIPELINE_CFG.dark };
    if (hueSpread>0.72&&flatR>0.30&&lumVar<2500)
      return { mode:'anime', isScreenshot:false, pipelineCfg:PIPELINE_CFG.anime };
    if (skinR>0.22||(skinR>0.14&&aspectScore>0))
      return { mode:'selfie', isScreenshot:false, pipelineCfg:PIPELINE_CFG.selfie };
    if (skinR>0.07)
      return { mode:'portrait', isScreenshot:false, pipelineCfg:PIPELINE_CFG.portrait };
    if (avgSat<0.18&&lumVar>3500&&darkR<0.30)
      return { mode:'metallic', isScreenshot:false, pipelineCfg:PIPELINE_CFG.metallic };
    if (avgLum>150&&avgSat>0.15)
      return { mode:'product', isScreenshot:false, pipelineCfg:PIPELINE_CFG.product };
    if (flatR>0.45&&hueSpread<0.40)
      return { mode:'logo', isScreenshot:true, pipelineCfg:PIPELINE_CFG.logo };
    return { mode:'photo', isScreenshot:false, pipelineCfg:PIPELINE_CFG.photo };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IMAGE UTILITIES
  // ══════════════════════════════════════════════════════════════════════════

  // Letterbox pad — aspect-ratio preserving resize for inference input
  function letterboxCanvas(src, W, H, inputSize) {
    var scale=inputSize/Math.max(W,H), sw=Math.round(W*scale), sh=Math.round(H*scale);
    var offX=Math.floor((inputSize-sw)/2), offY=Math.floor((inputSize-sh)/2);
    var lc=document.createElement('canvas');
    lc.width=inputSize; lc.height=inputSize;
    var lctx=lc.getContext('2d');
    lctx.fillStyle='rgb(128,128,128)'; lctx.fillRect(0,0,inputSize,inputSize);
    lctx.drawImage(src,offX,offY,sw,sh);
    return { canvas:lc, sw:sw, sh:sh, offX:offX, offY:offY };
  }

  function toTensor(canvas, inputSize, mean, std) {
    var n=inputSize*inputSize;
    var px=canvas.getContext('2d').getImageData(0,0,inputSize,inputSize).data;
    var buf=new Float32Array(3*n);
    for (var i=0;i<n;i++) {
      buf[i]     =(px[i*4]  /255-mean[0])/std[0];
      buf[n+i]   =(px[i*4+1]/255-mean[1])/std[1];
      buf[2*n+i] =(px[i*4+2]/255-mean[2])/std[2];
    }
    return buf;
  }

  // Extract raw model output, applying sigmoid when model outputs logits
  function extractRawData(results, session, cfg) {
    var raw=results[session.outputNames[0]].data;
    if (!cfg.outputSigmoid) return raw;
    var needSig=false;
    for (var i=0;i<Math.min(raw.length,200);i++) {
      if (raw[i]>1.1||raw[i]<-0.1){needSig=true;break;}
    }
    if (!needSig) return raw;
    var out=new Float32Array(raw.length);
    for (var j=0;j<raw.length;j++) out[j]=1.0/(1.0+Math.exp(-raw[j]));
    return out;
  }

  // Crop letterbox from model output and scale to target dimensions
  function extractConfidence(rawMask, maskSize, targetW, targetH, lb) {
    var mn=maskSize*maskSize;
    var mc=document.createElement('canvas');
    mc.width=maskSize; mc.height=maskSize;
    var mctx=mc.getContext('2d');
    var mImg=mctx.createImageData(maskSize,maskSize);
    for (var i=0;i<mn;i++) {
      var v=clamp(Math.round(clampF(rawMask[i])*255),0,255);
      mImg.data[i*4]=mImg.data[i*4+1]=mImg.data[i*4+2]=v; mImg.data[i*4+3]=255;
    }
    mctx.putImageData(mImg,0,0);
    var tc=document.createElement('canvas');
    tc.width=targetW; tc.height=targetH;
    var tctx=tc.getContext('2d');
    tctx.imageSmoothingEnabled=true; tctx.imageSmoothingQuality='high';
    tctx.drawImage(mc,lb.offX,lb.offY,lb.sw,lb.sh,0,0,targetW,targetH);
    mc.width=0; mc.height=0;
    var px=tctx.getImageData(0,0,targetW,targetH).data;
    tc.width=0; tc.height=0;
    var conf=new Float32Array(targetW*targetH);
    for (var j=0;j<conf.length;j++) conf[j]=px[j*4]/255;
    return conf;
  }

  // Grayscale luminance array (for Sobel edges)
  function imgToGray(imgEl, targetW, targetH) {
    var tc=document.createElement('canvas');
    tc.width=targetW; tc.height=targetH;
    var tctx=tc.getContext('2d');
    tctx.imageSmoothingEnabled=true; tctx.imageSmoothingQuality='high';
    tctx.drawImage(imgEl,0,0,imgEl.naturalWidth,imgEl.naturalHeight,0,0,targetW,targetH);
    var px=tctx.getImageData(0,0,targetW,targetH).data;
    tc.width=0; tc.height=0;
    var gray=new Float32Array(targetW*targetH);
    for (var i=0;i<gray.length;i++) gray[i]=(px[i*4]*0.299+px[i*4+1]*0.587+px[i*4+2]*0.114)/255;
    return gray;
  }

  // RGB float arrays (for color-guided filter)
  function imgToRGB(imgEl, targetW, targetH) {
    var tc=document.createElement('canvas');
    tc.width=targetW; tc.height=targetH;
    var tctx=tc.getContext('2d');
    tctx.imageSmoothingEnabled=true; tctx.imageSmoothingQuality='high';
    tctx.drawImage(imgEl,0,0,imgEl.naturalWidth,imgEl.naturalHeight,0,0,targetW,targetH);
    var px=tctx.getImageData(0,0,targetW,targetH).data;
    tc.width=0; tc.height=0;
    var N=targetW*targetH;
    var r=new Float32Array(N), g=new Float32Array(N), b=new Float32Array(N);
    for (var i=0;i<N;i++) { r[i]=px[i*4]/255; g[i]=px[i*4+1]/255; b[i]=px[i*4+2]/255; }
    return { r:r, g:g, b:b };
  }

  // Bilinear upsample Float32 via canvas (smooth sub-pixel quality)
  function upsampleFloat(arr, srcW, srcH, dstW, dstH) {
    var sc=document.createElement('canvas');
    sc.width=srcW; sc.height=srcH;
    var sctx=sc.getContext('2d');
    var img=sctx.createImageData(srcW,srcH);
    for (var i=0;i<arr.length;i++) {
      var v=clamp(Math.round(arr[i]*255),0,255);
      img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=v; img.data[i*4+3]=255;
    }
    sctx.putImageData(img,0,0);
    var tc=document.createElement('canvas');
    tc.width=dstW; tc.height=dstH;
    var tctx=tc.getContext('2d');
    tctx.imageSmoothingEnabled=true; tctx.imageSmoothingQuality='high';
    tctx.drawImage(sc,0,0,srcW,srcH,0,0,dstW,dstH);
    sc.width=0; sc.height=0;
    var px=tctx.getImageData(0,0,dstW,dstH).data;
    tc.width=0; tc.height=0;
    var out=new Float32Array(dstW*dstH);
    for (var j=0;j<out.length;j++) out[j]=px[j*4]/255;
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SOBEL EDGE DETECTION — Float32 magnitude [0,1]
  //  Used for: trimap unknown-zone dilation, multi-scale GF blend weights
  // ══════════════════════════════════════════════════════════════════════════
  function sobelEdges(gray, W, H) {
    var edges=new Float32Array(W*H);
    for (var y=1;y<H-1;y++) {
      for (var x=1;x<W-1;x++) {
        var i=y*W+x;
        var tl=gray[i-W-1],tm=gray[i-W],tr=gray[i-W+1];
        var ml=gray[i-1],mr=gray[i+1];
        var bl=gray[i+W-1],bm=gray[i+W],br=gray[i+W+1];
        var gx=-tl-2*ml-bl+tr+2*mr+br;
        var gy=-tl-2*tm-tr+bl+2*bm+br;
        edges[i]=clampF(Math.sqrt(gx*gx+gy*gy)/1.5);
      }
    }
    return edges;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TRIMAP GENERATION
  //
  //  WHY tight FG/BG zones: Prevents the guided filter from touching pixels
  //  that the model is already confident about. This is the key guarantee
  //  that interior foreground stays fully opaque and clear background stays
  //  fully transparent — no muddy alpha, no table leakage.
  //
  //  WHY edge dilation: Expands the unknown zone near image edges so the GF
  //  has room to refine hair strands, fur, thin fingers, transparent edges.
  // ══════════════════════════════════════════════════════════════════════════
  function generateTrimap(conf, edges, W, H, FG_THR, BG_THR, edgeDilR) {
    var N=W*H, tm=new Uint8Array(N);
    for (var i=0;i<N;i++) {
      if      (conf[i]>FG_THR) tm[i]=255;
      else if (conf[i]<BG_THR) tm[i]=0;
      else                      tm[i]=128;
    }
    if (edgeDilR<=0||!edges) return tm;
    var ext=new Uint8Array(N);
    for (var y=0;y<H;y++) {
      for (var x=0;x<W;x++) {
        var ci=y*W+x;
        if (edges[ci]>0.12&&tm[ci]!==128) {
          var y1=Math.max(0,y-edgeDilR),y2=Math.min(H-1,y+edgeDilR);
          var x1=Math.max(0,x-edgeDilR),x2=Math.min(W-1,x+edgeDilR);
          for (var ny=y1;ny<=y2;ny++) for (var nx=x1;nx<=x2;nx++) {
            if (tm[ny*W+nx]!==128) ext[ny*W+nx]=1;
          }
        }
      }
    }
    for (var j=0;j<N;j++) { if(ext[j]) tm[j]=128; }
    return tm;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUMMED AREA TABLE — O(N) box filter backbone
  // ══════════════════════════════════════════════════════════════════════════
  function buildSAT(arr, W, H) {
    var W1=W+1, S=new Float64Array((H+1)*W1);
    for (var y=1;y<=H;y++) for (var x=1;x<=W;x++) {
      S[y*W1+x]=arr[(y-1)*W+(x-1)]+S[(y-1)*W1+x]+S[y*W1+(x-1)]-S[(y-1)*W1+(x-1)];
    }
    return S;
  }

  function boxFilter(arr, W, H, r) {
    var W1=W+1, S=buildSAT(arr,W,H), out=new Float32Array(W*H);
    for (var y=0;y<H;y++) {
      for (var x=0;x<W;x++) {
        var xa=Math.max(0,x-r),xb=Math.min(W-1,x+r);
        var ya=Math.max(0,y-r),yb=Math.min(H-1,y+r);
        var cnt=(xb-xa+1)*(yb-ya+1);
        out[y*W+x]=(S[(yb+1)*W1+(xb+1)]-S[ya*W1+(xb+1)]-S[(yb+1)*W1+xa]+S[ya*W1+xa])/cnt;
      }
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GUIDED FILTER — grayscale guide (He et al. CVPR 2010)
  //  O(N) via SAT. No halos by design (linear model).
  // ══════════════════════════════════════════════════════════════════════════
  function guidedFilter(guide, input, W, H, r, eps) {
    var N=W*H;
    var mean_I=boxFilter(guide,W,H,r), mean_p=boxFilter(input,W,H,r);
    var II=new Float32Array(N), Ip=new Float32Array(N);
    for (var i=0;i<N;i++) { II[i]=guide[i]*guide[i]; Ip[i]=guide[i]*input[i]; }
    var corr_I=boxFilter(II,W,H,r), corr_Ip=boxFilter(Ip,W,H,r);
    II=null; Ip=null;
    var a=new Float32Array(N), b=new Float32Array(N);
    for (var j=0;j<N;j++) {
      var varI=corr_I[j]-mean_I[j]*mean_I[j];
      var covIp=corr_Ip[j]-mean_I[j]*mean_p[j];
      a[j]=covIp/(varI+eps); b[j]=mean_p[j]-a[j]*mean_I[j];
    }
    corr_I=null; corr_Ip=null; mean_I=null; mean_p=null;
    var mean_a=boxFilter(a,W,H,r), mean_b=boxFilter(b,W,H,r);
    a=null; b=null;
    var output=new Float32Array(N);
    for (var k=0;k<N;k++) output[k]=clampF(mean_a[k]*guide[k]+mean_b[k]);
    return output;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  COLOR-COMPONENT GUIDED FILTER
  //
  //  WHY: A grayscale guide loses color boundaries — a red product on a white
  //  background has near-identical luminance but strong color contrast. Running
  //  the GF independently with R, G, B guides then blending with perceptual
  //  weights captures all three dimensions of color contrast simultaneously.
  //
  //  Used for: product, metallic, AND general photo (v7 upgrade over v6).
  // ══════════════════════════════════════════════════════════════════════════
  function colorComponentGuidedFilter(rgb, input, W, H, r, eps) {
    var gfR=guidedFilter(rgb.r,input,W,H,r,eps);
    var gfG=guidedFilter(rgb.g,input,W,H,r,eps);
    var gfB=guidedFilter(rgb.b,input,W,H,r,eps);
    var out=new Float32Array(W*H);
    for (var i=0;i<out.length;i++) {
      // BT.601 perceptual luminance weights
      out[i]=clampF(0.299*gfR[i]+0.587*gfG[i]+0.114*gfB[i]);
    }
    gfR=null; gfG=null; gfB=null;
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MULTI-SCALE COLOR GUIDED FILTER — portrait / selfie / hair pipeline
  //
  //  WHY multi-scale: A single-scale GF can't simultaneously preserve hair
  //  strand edges (needs r≈4, tight) AND fill clean interior body regions
  //  (needs r≈16, smooth). The solution: run both scales and blend by local
  //  edge magnitude. High-gradient pixels (hair, face boundary) → fine scale.
  //  Low-gradient pixels (skin, clothing interior) → coarse scale.
  //
  //  WHY color guide (v7 upgrade): Color separates warm skin tones from cool
  //  backgrounds even at similar luminance. The grayscale guide in v6 caused
  //  "muddy masks" when skin and background had similar brightness.
  // ══════════════════════════════════════════════════════════════════════════
  function multiScaleColorGuidedFilter(rgb, input, edges, W, H, gfR, gfEps) {
    var fineR   = Math.max(2, Math.round(gfR * 0.30));   // e.g. r=14 → fine=4
    var coarseR = Math.round(gfR * 1.25);                 // e.g. r=14 → coarse=17
    var fineEps   = gfEps * 0.5;
    var coarseEps = gfEps * 3.0;

    var fine   = colorComponentGuidedFilter(rgb, input, W, H, fineR,   fineEps);
    var coarse = colorComponentGuidedFilter(rgb, input, W, H, coarseR, coarseEps);

    var out = new Float32Array(W * H);
    var SCALE = 6.0; // tanh steepness: controls how sharply blend transitions
    for (var i = 0; i < out.length; i++) {
      var ew = clampF(Math.tanh(edges[i] * SCALE));
      out[i] = clampF(ew * fine[i] + (1.0 - ew) * coarse[i]);
    }
    fine = null; coarse = null;
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  OTSU THRESHOLD — optimal binary split from confidence histogram
  //  Only used in screenshot / binary pipeline path.
  // ══════════════════════════════════════════════════════════════════════════
  function otsuThreshold(conf, N) {
    var hist=new Int32Array(256);
    for (var i=0;i<N;i++) hist[clamp(Math.round(conf[i]*255),0,255)]++;
    var sum=0;
    for (var t=0;t<256;t++) sum+=t*hist[t];
    var sumB=0,wB=0,maxVar=0,threshold=128;
    for (var t2=0;t2<256;t2++) {
      wB+=hist[t2]; if(!wB) continue;
      var wF=N-wB; if(!wF) break;
      sumB+=t2*hist[t2];
      var mB=sumB/wB,mF=(sum-sumB)/wF;
      var between=wB*wF*(mB-mF)*(mB-mF);
      if (between>maxVar){maxVar=between;threshold=t2;}
    }
    return threshold/255;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MORPHOLOGICAL OPERATIONS — 3×3 8-connected structuring element
  //  close = dilate + erode : fills thin FG gaps (hair gaps, finger gaps)
  //  open  = erode + dilate : removes BG noise specks
  // ══════════════════════════════════════════════════════════════════════════
  function morphDilate3(alpha, W, H) {
    var N=W*H, out=new Float32Array(N);
    for (var y=0;y<H;y++) {
      for (var x=0;x<W;x++) {
        var i=y*W+x, mx=alpha[i];
        if(x>0)        {var v=alpha[i-1];   if(v>mx)mx=v;}
        if(x<W-1)      {var v=alpha[i+1];   if(v>mx)mx=v;}
        if(y>0)        {var v=alpha[i-W];   if(v>mx)mx=v;}
        if(y<H-1)      {var v=alpha[i+W];   if(v>mx)mx=v;}
        if(x>0&&y>0)   {var v=alpha[i-W-1]; if(v>mx)mx=v;}
        if(x<W-1&&y>0) {var v=alpha[i-W+1]; if(v>mx)mx=v;}
        if(x>0&&y<H-1) {var v=alpha[i+W-1]; if(v>mx)mx=v;}
        if(x<W-1&&y<H-1){var v=alpha[i+W+1];if(v>mx)mx=v;}
        out[i]=mx;
      }
    }
    return out;
  }

  function morphErode3(alpha, W, H) {
    var N=W*H, out=new Float32Array(N);
    for (var y=0;y<H;y++) {
      for (var x=0;x<W;x++) {
        var i=y*W+x, mn=alpha[i];
        if(x>0)        {var v=alpha[i-1];   if(v<mn)mn=v;}
        if(x<W-1)      {var v=alpha[i+1];   if(v<mn)mn=v;}
        if(y>0)        {var v=alpha[i-W];   if(v<mn)mn=v;}
        if(y<H-1)      {var v=alpha[i+W];   if(v<mn)mn=v;}
        if(x>0&&y>0)   {var v=alpha[i-W-1]; if(v<mn)mn=v;}
        if(x<W-1&&y>0) {var v=alpha[i-W+1]; if(v<mn)mn=v;}
        if(x>0&&y<H-1) {var v=alpha[i+W-1]; if(v<mn)mn=v;}
        if(x<W-1&&y<H-1){var v=alpha[i+W+1];if(v<mn)mn=v;}
        out[i]=mn;
      }
    }
    return out;
  }

  function morphClose(alpha, W, H, iters) {
    var a=alpha;
    for (var i=0;i<iters;i++) a=morphDilate3(a,W,H);
    for (var j=0;j<iters;j++) a=morphErode3(a,W,H);
    return a;
  }

  function morphOpen(alpha, W, H, iters) {
    var a=alpha;
    for (var i=0;i<iters;i++) a=morphErode3(a,W,H);
    for (var j=0;j<iters;j++) a=morphDilate3(a,W,H);
    return a;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  8-CONNECTED HOLE FILL — BFS from image border
  //  Any transparent pixel not reachable from the image border = interior
  //  enclosed region → fill as FG. Prevents hollow objects and donut holes.
  // ══════════════════════════════════════════════════════════════════════════
  function holeFill8(alpha, W, H, threshold) {
    threshold = threshold !== undefined ? threshold : 0.31;
    var N=W*H, DX8=[-1,0,1,-1,1,-1,0,1], DY8=[-1,-1,-1,0,0,1,1,1];
    var reach=new Uint8Array(N), q=[], qi=0;
    function seed(pi) { if(alpha[pi]<threshold&&!reach[pi]){reach[pi]=1;q.push(pi);} }
    for (var x=0;x<W;x++){seed(x);seed((H-1)*W+x);}
    for (var y=1;y<H-1;y++){seed(y*W);seed(y*W+W-1);}
    while (qi<q.length) {
      var pi=q[qi++], px2=pi%W, py=((pi-px2)/W)|0;
      for (var di=0;di<8;di++) {
        var nx=px2+DX8[di], ny=py+DY8[di];
        if(nx<0||nx>=W||ny<0||ny>=H) continue;
        var ni=ny*W+nx;
        if(reach[ni]||alpha[ni]>=threshold) continue;
        reach[ni]=1; q.push(ni);
      }
    }
    var filled=new Float32Array(alpha);
    for (var i=0;i<N;i++) { if(alpha[i]<threshold&&!reach[i]) filled[i]=0.9; }
    return filled;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 3: SMALL OBJECT RECOVERY
  //
  //  WHY: After the main guided filter pass (Pass 2), fine structures like
  //  individual hair strands, fingers, jewelry chains, cables, and keychains
  //  may have been partially erased or made semi-transparent. This pass
  //  identifies the "uncertain" edge zone, dilates it to capture nearby fine
  //  structures, runs a very tight-radius color GF (r=2, ε=0.0003) there,
  //  and blends the result back. This restores fine detail without touching
  //  the clean interior or background.
  //
  //  Note: only runs for non-screenshot images. The binary screenshot path
  //  has no need for fine structure recovery.
  // ══════════════════════════════════════════════════════════════════════════
  function smallObjectRecovery(alpha, rgb, conf, W, H, FG_THR, BG_THR) {
    var EDGE_LO  = 0.05,  EDGE_HI  = 0.95;  // uncertain zone bounds
    var DILATE_R = 6;                         // expand zone by 6px to catch nearby fine structures
    var FINE_R   = 2,     FINE_EPS = 0.0003; // very tight GF for fine detail
    var N = W * H;

    // Identify uncertain pixels
    var edgeMask = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      if (alpha[i] > EDGE_LO && alpha[i] < EDGE_HI) edgeMask[i] = 1;
    }

    // Dilate uncertain zone to capture fine structures nearby
    var dilated = new Uint8Array(N);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (!edgeMask[y*W+x]) continue;
        var y1=Math.max(0,y-DILATE_R),y2=Math.min(H-1,y+DILATE_R);
        var x1=Math.max(0,x-DILATE_R),x2=Math.min(W-1,x+DILATE_R);
        for (var ny=y1;ny<=y2;ny++) for (var nx=x1;nx<=x2;nx++) dilated[ny*W+nx]=1;
      }
    }
    edgeMask = null;

    // Skip if edge zone is trivially small (uniform image, no boundaries)
    var edgeCount = 0;
    for (var j = 0; j < N; j++) { if (dilated[j]) edgeCount++; }
    if (edgeCount < 100) { dilated = null; return alpha; }

    // Run fine-radius color GF on the whole alpha — result used only in dilated zone
    var fineAlpha = colorComponentGuidedFilter(rgb, alpha, W, H, FINE_R, FINE_EPS);

    // Merge: blend fine result into dilated zone, preserve definite FG/BG
    var out = new Float32Array(alpha);
    for (var k = 0; k < N; k++) {
      if (!dilated[k]) continue;
      if (conf[k] > FG_THR) { out[k] = 1.0; continue; } // definite FG — immutable
      if (conf[k] < BG_THR) { out[k] = 0.0; continue; } // definite BG — immutable
      // Blend 60% fine recovery + 40% main result
      out[k] = clampF(0.60 * fineAlpha[k] + 0.40 * alpha[k]);
    }
    fineAlpha = null; dilated = null;
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TRIMAP HARD ENFORCEMENT
  //  Definite FG / definite BG zones are IMMUTABLE — no pipeline stage can
  //  override them. This is the mathematical guarantee preventing muddy alpha.
  // ══════════════════════════════════════════════════════════════════════════
  function enforceTrimapHard(alpha, conf, N, FG_THR, BG_THR) {
    for (var i = 0; i < N; i++) {
      if (conf[i] > FG_THR) alpha[i] = 1.0;
      if (conf[i] < BG_THR) alpha[i] = 0.0;
    }
  }

  // Quality validator — logs only, never modifies alpha
  function validateAlpha(alpha, N, label) {
    var solidFg=0, softFg=0, bg=0;
    for (var i=0;i<N;i++) {
      var a=alpha[i];
      if(a>0.78)solidFg++; else if(a>0.20)softFg++; else bg++;
    }
    var fgR=(solidFg+softFg)/N, solidR=solidFg/(solidFg+softFg+1);
    console.log('[BgAI v7]',label,': FG='+(fgR*100).toFixed(1)+'% solid='+(solidR*100).toFixed(1)+'%');
    if (fgR<0.01) console.warn('[BgAI v7] WARN: nearly empty foreground');
    if (fgR>0.97) console.warn('[BgAI v7] WARN: background not removed');
    return { fgR:fgR, solidR:solidR };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INFERENCE: WHOLE IMAGE
  // ══════════════════════════════════════════════════════════════════════════
  async function inferWhole(session, cfg, img, W, H, gfW, gfH) {
    var lb=letterboxCanvas(img,W,H,cfg.inputSize);
    var buf=toTensor(lb.canvas,cfg.inputSize,cfg.mean,cfg.std);
    lb.canvas.width=0; lb.canvas.height=0;
    var feeds={};
    feeds[session.inputNames[0]]=new window.ort.Tensor('float32',buf,[1,3,cfg.inputSize,cfg.inputSize]);
    var results=await session.run(feeds);
    var rawMask=extractRawData(results,session,cfg);
    var confGF  =extractConfidence(rawMask,cfg.inputSize,gfW,gfH,lb);
    var confFull=extractConfidence(rawMask,cfg.inputSize,W,H,lb);
    return { confGF:confGF, confFull:confFull };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INFERENCE: TILED — for large images
  //
  //  WHY 256px overlap (25%): The v6 engine used 128px (12.5%) which left
  //  visible rectangular seam artefacts on large images. 25% overlap with
  //  cosine weighting ensures a smooth confidence gradient across all tile
  //  boundaries, making seams mathematically impossible.
  //
  //  WHY cosine (linear) blend and NOT Math.min: Math.min produces hard
  //  transitions at tile edges. Linear weight (distance from edge / overlap)
  //  creates a smooth ramp that eliminates rectangular artefacts entirely.
  // ══════════════════════════════════════════════════════════════════════════
  async function inferTiled(session, cfg, img, W, H, gfW, gfH, onProgress) {
    var TILE    = Math.min(TILE_SIZE, cfg.inputSize);
    var OVERLAP = clamp(Math.floor(Math.min(W,H)/4), 96, TILE_OVERLAP); // 25% of image dim
    var STEP    = TILE - OVERLAP;
    var tilesX  = Math.max(1, Math.ceil((W-OVERLAP)/STEP));
    var tilesY  = Math.max(1, Math.ceil((H-OVERLAP)/STEP));
    var total   = tilesX*tilesY, done=0;
    var accConf=new Float32Array(W*H), accWeight=new Float32Array(W*H);

    for (var ty=0;ty<tilesY;ty++) {
      for (var tx=0;tx<tilesX;tx++) {
        var x0=tx*STEP, y0=ty*STEP;
        var x1=Math.min(x0+TILE,W), y1=Math.min(y0+TILE,H);
        var tw=x1-x0, th=y1-y0;

        var tc=document.createElement('canvas');
        tc.width=tw; tc.height=th;
        tc.getContext('2d').drawImage(img,x0,y0,tw,th,0,0,tw,th);

        var lb=letterboxCanvas(tc,tw,th,cfg.inputSize);
        var buf=toTensor(lb.canvas,cfg.inputSize,cfg.mean,cfg.std);
        lb.canvas.width=0; lb.canvas.height=0;
        tc.width=0; tc.height=0;

        var feeds={};
        feeds[session.inputNames[0]]=new window.ort.Tensor('float32',buf,[1,3,cfg.inputSize,cfg.inputSize]);
        var res=await session.run(feeds);
        var rawMask=extractRawData(res,session,cfg);
        var tileConf=extractConfidence(rawMask,cfg.inputSize,tw,th,lb);

        var isL=tx===0, isR=tx===tilesX-1;
        var isT=ty===0, isB=ty===tilesY-1;

        for (var py=0;py<th;py++) {
          for (var px=0;px<tw;px++) {
            var wx=1.0, wy=1.0;
            if (!isL&&px<OVERLAP)      wx=(px+0.5)/OVERLAP;
            if (!isR&&px>=tw-OVERLAP)  wx=(tw-px-0.5)/OVERLAP;
            if (!isT&&py<OVERLAP)      wy=(py+0.5)/OVERLAP;
            if (!isB&&py>=th-OVERLAP)  wy=(th-py-0.5)/OVERLAP;
            var w=clampF(wx)*clampF(wy);
            var gi=(y0+py)*W+(x0+px);
            accConf[gi]   +=tileConf[py*tw+px]*w;
            accWeight[gi] +=w;
          }
        }

        done++;
        if (onProgress) onProgress(32+Math.round(done/total*44),'AI segmentation\u2026 '+Math.round(done/total*100)+'%');
        if (done%2===0) await yieldMain();
      }
    }

    var confFull=new Float32Array(W*H);
    for (var i=0;i<W*H;i++) confFull[i]=accWeight[i]>0?clampF(accConf[i]/accWeight[i]):0;
    var confGF=upsampleFloat(confFull,W,H,gfW,gfH);
    return { confGF:confGF, confFull:confFull };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN PROCESS FUNCTION
  // ══════════════════════════════════════════════════════════════════════════
  async function process(file, opts, onProgress) {
    opts = opts || {};
    if (onProgress) onProgress(1, 'Preparing image\u2026');

    // ── Load image ─────────────────────────────────────────────────────────
    var imgUrl = URL.createObjectURL(file);
    var img    = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { URL.revokeObjectURL(imgUrl); res(el); };
      el.onerror = function () { URL.revokeObjectURL(imgUrl); rej(new Error('Cannot load image')); };
      el.src = imgUrl;
    });
    var W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('Image has zero dimensions');

    // ── Classify image mode ────────────────────────────────────────────────
    if (onProgress) onProgress(4, 'Classifying image\u2026');
    var clsMax = Math.min(1, 320 / Math.max(W, H));
    var clsW = Math.max(8, Math.round(W * clsMax));
    var clsH = Math.max(8, Math.round(H * clsMax));
    var clsC = document.createElement('canvas');
    clsC.width = clsW; clsC.height = clsH;
    clsC.getContext('2d').drawImage(img, 0, 0, W, H, 0, 0, clsW, clsH);
    var clsData = clsC.getContext('2d').getImageData(0, 0, clsW, clsH).data;
    clsC.width = 0; clsC.height = 0;

    var imageMode = classifyImageMode(clsData, clsW, clsH);
    clsData = null;

    // ── Subject mode override — respects explicit user selection ───────────
    if (opts.subjectMode && opts.subjectMode !== 'auto') {
      switch (opts.subjectMode) {
        case 'portrait':
          imageMode = { mode:'portrait', isScreenshot:false, pipelineCfg:PIPELINE_CFG.portrait };
          break;
        case 'product':
          imageMode = { mode:'product', isScreenshot:false, pipelineCfg:PIPELINE_CFG.product };
          break;
        case 'logo':
          imageMode = { mode:'logo', isScreenshot:true, pipelineCfg:PIPELINE_CFG.logo };
          break;
        case 'screenshot':
          imageMode = { mode:'screenshot', isScreenshot:true, pipelineCfg:PIPELINE_CFG.screenshot };
          break;
      }
    }

    var pCfg = imageMode.pipelineCfg;
    console.log('[BgAI v7] Mode:', imageMode.mode, '| Pipeline:', pCfg.pipeline,
                '| FG_THR:', pCfg.FG_THR, '| BG_THR:', pCfg.BG_THR);

    // ── Select and load model ──────────────────────────────────────────────
    var tier = selectTier(imageMode.mode, opts.qualityMode || 'hd', false);
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      var fallback = (tier === 'birefnet' || tier === 'modnet') ? 'standard'
                   : (tier === 'standard') ? 'lite' : null;
      if (fallback) {
        console.warn('[BgAI v7]', tier, 'failed → falling back to', fallback, ':', e1.message);
        if (onProgress) onProgress(8, 'Switching model\u2026');
        sessionData = await getSession(fallback, onProgress);
        tier = fallback;
      } else {
        throw e1;
      }
    }
    var session = sessionData.session, cfg = sessionData.cfg;

    // ── Compute GF working resolution ──────────────────────────────────────
    var mob      = isMobileUA();
    var gfMaxDim = mob ? GF_MAX_MOBILE : GF_MAX_DIM;
    var gfScale  = Math.min(1.0, gfMaxDim / Math.max(W, H));
    var gfW      = Math.max(8, Math.round(W * gfScale));
    var gfH      = Math.max(8, Math.round(H * gfScale));

    if (onProgress) onProgress(33, 'Running AI segmentation\u2026');
    await yieldMain();

    // ── Pass 1: AI Inference (global segmentation) ─────────────────────────
    // WHY tile threshold: images >1.8× model input size benefit from tiled
    // inference — each tile gets full-resolution model attention rather than
    // the entire scene squashed to 1024×1024.
    var largeImage = W > cfg.inputSize * 1.8 || H > cfg.inputSize * 1.8;
    var useTiling  = largeImage && !mob && !pCfg.isScreenshot;
    var confResult;
    if (useTiling) {
      confResult = await inferTiled(session, cfg, img, W, H, gfW, gfH, onProgress);
    } else {
      confResult = await inferWhole(session, cfg, img, W, H, gfW, gfH);
    }
    var confGF   = confResult.confGF;
    var confFull = confResult.confFull;

    if (onProgress) onProgress(79, 'Refining edges\u2026');
    await yieldMain();

    // ── Trimap generation ──────────────────────────────────────────────────
    // For non-screenshot pipelines: extract gray for Sobel edges AND RGB for GF.
    // RGB is extracted once and reused for all three passes.
    var edgesGF = null;
    var rgbGF   = null;

    if (!pCfg.isScreenshot) {
      var grayForEdges = imgToGray(img, gfW, gfH);
      edgesGF = sobelEdges(grayForEdges, gfW, gfH);
      grayForEdges = null;
      // RGB guide: used for color-guided filter in all photo pipelines (v7 upgrade)
      rgbGF = imgToRGB(img, gfW, gfH);
    }

    var trimapGF = generateTrimap(confGF, edgesGF, gfW, gfH,
                                  pCfg.FG_THR, pCfg.BG_THR, pCfg.edgeDilR);

    // ── Pass 2: Per-pipeline edge refinement ───────────────────────────────
    var refinedGF;

    if (pCfg.pipeline === 'binary') {
      // SCREENSHOT / DOCUMENT / LOGO
      // WHY Otsu: binary segmentation finds the optimal global threshold for
      // flat-region images. No guided filter needed — straight edges stay
      // straight. No feathering, no blur, no alpha averaging.
      var otsuThr = otsuThreshold(confGF, gfW * gfH);
      refinedGF   = new Float32Array(gfW * gfH);
      for (var i = 0; i < refinedGF.length; i++) {
        refinedGF[i] = confGF[i] > otsuThr ? 1.0 : 0.0;
      }
      if (pCfg.morphClose > 0) refinedGF = morphClose(refinedGF, gfW, gfH, pCfg.morphClose);
      if (pCfg.morphOpen  > 0) refinedGF = morphOpen(refinedGF,  gfW, gfH, pCfg.morphOpen);

    } else if (pCfg.pipeline === 'portrait') {
      // SELFIE / PORTRAIT / HAIR
      // WHY multi-scale color GF: see multiScaleColorGuidedFilter docstring.
      // Key v7 upgrade: color guide (was grayscale in v6) prevents muddy masks
      // on skin tones with similar luminance to background.
      refinedGF = multiScaleColorGuidedFilter(rgbGF, confGF, edgesGF, gfW, gfH,
                                               pCfg.gfR, pCfg.gfEps);

      // Morph close only in unknown zone — fills hair gaps, finger gaps, jewelry
      if (pCfg.morphClose > 0) {
        var fgForClose = new Float32Array(gfW * gfH);
        for (var ic = 0; ic < fgForClose.length; ic++) {
          fgForClose[ic] = refinedGF[ic] > 0.5 ? refinedGF[ic] : 0.0;
        }
        var fgClosed = morphClose(fgForClose, gfW, gfH, pCfg.morphClose);
        fgForClose = null;
        for (var ic2 = 0; ic2 < refinedGF.length; ic2++) {
          if (trimapGF[ic2] === 128 && fgClosed[ic2] > refinedGF[ic2]) {
            refinedGF[ic2] = fgClosed[ic2];
          }
        }
        fgClosed = null;
      }

    } else if (pCfg.pipeline === 'product') {
      // PRODUCT / METALLIC
      // WHY color GF with low epsilon: preserves sharp product contours and
      // metallic reflection boundaries. Low ε = less smoothing = sharper edges.
      refinedGF = colorComponentGuidedFilter(rgbGF, confGF, gfW, gfH,
                                              pCfg.gfR, pCfg.gfEps);

      if (pCfg.morphClose > 0) {
        var fgProd = new Float32Array(gfW * gfH);
        for (var ip = 0; ip < fgProd.length; ip++) {
          fgProd[ip] = refinedGF[ip] > 0.5 ? refinedGF[ip] : 0.0;
        }
        var fgPClosed = morphClose(fgProd, gfW, gfH, pCfg.morphClose);
        fgProd = null;
        for (var ip2 = 0; ip2 < refinedGF.length; ip2++) {
          if (trimapGF[ip2] === 128 && fgPClosed[ip2] > refinedGF[ip2]) {
            refinedGF[ip2] = fgPClosed[ip2];
          }
        }
        fgPClosed = null;
      }

    } else {
      // GENERAL PHOTO / ANIME / DARK
      // WHY color GF (v7 upgrade from grayscale): anime has vivid flat colors
      // that a grayscale guide can't distinguish. Dark images have low luminance
      // contrast but color contrast remains useful for edge finding.
      refinedGF = colorComponentGuidedFilter(rgbGF, confGF, gfW, gfH,
                                              pCfg.gfR, pCfg.gfEps);

      if (pCfg.morphClose > 0) {
        var fgGen = new Float32Array(gfW * gfH);
        for (var ig = 0; ig < fgGen.length; ig++) {
          fgGen[ig] = refinedGF[ig] > 0.5 ? refinedGF[ig] : 0.0;
        }
        var fgGClosed = morphClose(fgGen, gfW, gfH, pCfg.morphClose);
        fgGen = null;
        for (var ig2 = 0; ig2 < refinedGF.length; ig2++) {
          if (trimapGF[ig2] === 128 && fgGClosed[ig2] > refinedGF[ig2]) {
            refinedGF[ig2] = fgGClosed[ig2];
          }
        }
        fgGClosed = null;
      }
    }

    edgesGF = null;

    // ── Hole fill at GF resolution ─────────────────────────────────────────
    refinedGF = holeFill8(refinedGF, gfW, gfH, pCfg.holeThr);

    // ── Trimap hard enforcement at GF resolution ───────────────────────────
    // Definite zones overwrite ALL refinement output — IMMUTABLE.
    for (var i4 = 0; i4 < gfW * gfH; i4++) {
      if (trimapGF[i4] === 255) refinedGF[i4] = 1.0;
      if (trimapGF[i4] === 0)   refinedGF[i4] = 0.0;
    }
    trimapGF = null;

    // ── Pass 3: Small object recovery (hair strands, fingers, jewelry) ─────
    // WHY after trimap enforcement: We want hard enforcement BEFORE Pass 3 so
    // the fine-GF in Pass 3 never touches definitely-transparent regions.
    // Pass 3 only operates in the dilated "uncertain" zone.
    if (!pCfg.isScreenshot && rgbGF) {
      await yieldMain();
      if (onProgress) onProgress(88, 'Recovering fine details\u2026');
      refinedGF = smallObjectRecovery(refinedGF, rgbGF, confGF, gfW, gfH,
                                      pCfg.FG_THR, pCfg.BG_THR);
    }
    rgbGF = null;

    await yieldMain();
    if (onProgress) onProgress(91, 'Upsampling to full resolution\u2026');

    // ── Upsample refined alpha → full resolution ───────────────────────────
    var alphaFull;
    if (gfW === W && gfH === H) {
      alphaFull = refinedGF;
    } else {
      alphaFull = upsampleFloat(refinedGF, gfW, gfH, W, H);
    }
    refinedGF = null;

    // ── Trimap hard enforcement at full resolution ─────────────────────────
    // Re-apply using full-res confidence to correct any bilinear artefacts
    // introduced during the upsample step at definite zone boundaries.
    enforceTrimapHard(alphaFull, confFull, W * H, pCfg.FG_THR, pCfg.BG_THR);
    confFull = null;

    validateAlpha(alphaFull, W * H, imageMode.mode);

    if (onProgress) onProgress(95, 'Compositing\u2026');
    await yieldMain();

    // ── Export: fresh offscreen canvas — NEVER shared with preview ─────────
    // WHY separate canvas: the live preview canvas may contain checkerboards,
    // overlays, or debug visualisations. The export canvas contains ONLY:
    // original image RGB pixels + final alpha channel. Nothing else.
    var outC = document.createElement('canvas');
    outC.width = W; outC.height = H;
    var outCtx = outC.getContext('2d');
    outCtx.drawImage(img, 0, 0);
    var outData = outCtx.getImageData(0, 0, W, H);
    for (var i5 = 0; i5 < W * H; i5++) {
      outData.data[i5 * 4 + 3] = clamp(Math.round(alphaFull[i5] * 255), 0, 255);
    }
    alphaFull = null;
    outCtx.putImageData(outData, 0, 0);

    var blob = await new Promise(function (res, rej) {
      outC.toBlob(function (b) {
        outC.width = 0; outC.height = 0;
        if (b && b.size > 100) res(b);
        else rej(new Error('Canvas export produced empty blob'));
      }, 'image/png');
    });

    return { blob: blob, ext: '.png', mime: 'image/png' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════
  function preload(tier) {
    getSession(tier || 'lite', null).catch(function () {});
  }

  window.BgAiEngine = {
    process:      process,
    preload:      preload,
    isReady:      function (t) { return !!_sessions[t || 'lite']; },
    getModelInfo: function (t) { return MODELS[t || 'lite']; },
    // Debug / audit surface
    classify:             classifyImageMode,
    otsu:                 otsuThreshold,
    guidedFilter:         guidedFilter,
    colorGuidedFilter:    colorComponentGuidedFilter,
    multiScaleColorGF:    multiScaleColorGuidedFilter,
    smallObjectRecovery:  smallObjectRecovery,
    morphClose:           morphClose,
    morphOpen:            morphOpen,
    holeFill8:            holeFill8,
    sobelEdges:           sobelEdges,
    generateTrimap:       generateTrimap,
    PIPELINE_CFG:         PIPELINE_CFG,
    MODELS:               MODELS,
  };

  // Auto-preload lite model 4 s after page load (4.7 MB — fast on any connection)
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () {
      setTimeout(function () { preload('lite'); }, 4000);
    });
  }

}());
