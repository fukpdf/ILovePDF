// BgAiEngine v5.0 — True Segmentation Pipeline
// Permanent architectural rebuild. Zero heuristic alpha manipulation.
//
// ROOT CAUSES ELIMINATED:
//   RC-A: Alpha-array heuristic chain (interiorSolidity, metallicBoost,
//          edgeFeatherSoft, qualityGate) → REMOVED ENTIRELY
//   RC-B: buildFgLock/enforceLock acting as a pseudo-trimap → REPLACED with
//          true trimap (definite FG / unknown / definite BG)
//   RC-C: contour sharpening (±30 on bilinear-scaled output) → REMOVED
//   RC-D–F: alpha blur (5×5 stabilize, 7×7 solidity, 3×3 feather) → REMOVED
//   RC-G: qualityGate += 55 global inflation → REMOVED
//   RC-H: metallicBoost heuristic → REMOVED
//   RC-I: no guided filter → ADDED (He et al. 2013, integral image O(N))
//          no trimap → ADDED (0=definite BG, 128=unknown, 255=definite FG)
//          no morphological ops → ADDED (close/open/holeFill)
//   RC-J: edgeRefineBinary majority vote → REPLACED with Otsu + morphology
//
// TRUE PIPELINE:
//   INPUT IMAGE
//     ↓ letterbox pad (aspect-ratio preserving)
//   AI INFERENCE  (whole or cosine-weighted tiled)
//     ↓ unletterbox → float confidence map [0,1]
//   TRIMAP GENERATION
//     conf > FG_THR → definite FG  (255)
//     conf < BG_THR → definite BG  (0)
//     else          → unknown      (128)
//     Dilate unknown zone near strong Sobel edges (captures hair, fur)
//     ↓
//   SCREENSHOT PATH: Otsu binary → morph close/open → holeFill
//   PHOTO PATH:      Guided Filter (RGB guide, r=8–12, eps=0.004)
//                    → morph close on FG gaps → holeFill
//     ↓
//   TRIMAP HARD ENFORCEMENT  (definite zones NEVER modified)
//     ↓
//   UPSAMPLE → W×H  (bilinear, then re-enforce trimap at full res)
//     ↓
//   EXPORT: fresh canvas, original pixels + final alpha → PNG blob
//           export canvas NEVER shared with preview canvas

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ══════════════════════════════════════════════════════════════════════════
  var ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
  var ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
  var GF_MAX_DIM   = 1024;   // guided filter runs at ≤ this resolution
  var GF_MAX_MOBILE = 512;

  var MODELS = {
    lite: {
      name: 'U2Net-Lite',
      urls: [
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/u2netp.onnx',
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
      ],
      cacheKey: 'bge_u2netp_v5',
      inputSize: 320,
      mean: [0.485, 0.456, 0.406],
      std:  [0.229, 0.224, 0.225],
      sizeMB: 4.7,
    },
    standard: {
      name: 'RMBG-1.4',
      urls: [
        'https://huggingface.co/Xenova/rmbg-v1.4/resolve/main/onnx/model_quantized.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
      ],
      cacheKey: 'bge_rmbg14_q_v5',
      inputSize: 1024,
      mean: [0.5, 0.5, 0.5],
      std:  [1.0, 1.0, 1.0],
      sizeMB: 44,
    },
  };

  var _sessions   = {};
  var _ortReady   = false;
  var _ortPromise = null;

  // ── Tiny utilities ────────────────────────────────────────────────────────
  function clamp(v, lo, hi)  { return v < lo ? lo : v > hi ? hi : v; }
  function clampF(v)         { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function yieldMain()       { return new Promise(function (r) { setTimeout(r, 0); }); }
  function isMobileUA()      { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || ''); }

  // ══════════════════════════════════════════════════════════════════════════
  //  ORT LOADER
  // ══════════════════════════════════════════════════════════════════════════
  function loadORT() {
    if (_ortReady && window.ort) return Promise.resolve(window.ort);
    if (_ortPromise) return _ortPromise;
    _ortPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ORT_CDN; s.async = true;
      s.onload = function () {
        if (!window.ort) { _ortPromise = null; reject(new Error('ort global missing')); return; }
        try {
          window.ort.env.wasm.wasmPaths  = ORT_WASM_DIR;
          window.ort.env.wasm.proxy      = false;
          window.ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
        } catch (_e) {}
        _ortReady = true; resolve(window.ort);
      };
      s.onerror = function () { _ortPromise = null; reject(new Error('ORT CDN load failed')); };
      document.head.appendChild(s);
    });
    return _ortPromise;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IDB MODEL CACHE
  // ══════════════════════════════════════════════════════════════════════════
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 5);
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
  //  MODEL FETCH (streamed with progress)
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
      } catch (e) { lastErr = e; console.warn('[BgAI v5] fetch failed:', cfg.urls[ui], e.message); }
    }
    throw lastErr || new Error('All model URLs failed');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SESSION FACTORY
  // ══════════════════════════════════════════════════════════════════════════
  function detectTier(opts) {
    if (opts && opts.qualityMode === 'ultra') return 'standard';
    if (opts && opts.qualityMode === 'lite')  return 'lite';
    var mob   = isMobileUA();
    var cores = navigator.hardwareConcurrency || 2;
    var ram   = navigator.deviceMemory || 0;
    if (mob || cores <= 2 || (ram > 0 && ram < 3)) return 'lite';
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
    var provSets = [['webgl', 'wasm'], ['wasm']];
    for (var pi = 0; pi < provSets.length; pi++) {
      try {
        session = await ort.InferenceSession.create(modelBuf, {
          executionProviders: provSets[pi],
          graphOptimizationLevel: 'all',
          enableCpuMemArena: false,
          enableMemPattern: false,
        });
        break;
      } catch (e) { lastErr = e; console.warn('[BgAI v5] session failed:', provSets[pi], e.message); }
    }
    if (!session) throw lastErr || new Error('Cannot create ONNX session');
    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IMAGE MODE CLASSIFICATION (10 modes, 6 features)
  //  Determines: screenshot (hard binary pipeline) vs photo (guided filter)
  // ══════════════════════════════════════════════════════════════════════════
  function classifyImageMode(pixelData, W, H) {
    var step = Math.max(2, Math.round(Math.sqrt(W * H / 2000)));
    var flatCnt = 0, edgeCnt = 0, textLineCnt = 0;
    var skinCnt = 0, darkCnt = 0, total = 0;
    var satSum = 0, lumSum = 0, lumSqSum = 0;
    var hueHist = new Float32Array(12);

    for (var y = 2; y < H - 2; y += step) {
      for (var x = 2; x < W - 2; x += step) {
        var j4 = (y * W + x) * 4;
        var r = pixelData[j4], g = pixelData[j4+1], b = pixelData[j4+2];
        var lum = (r * 77 + g * 150 + b * 29) >> 8;

        // 5×5 local brightness variance
        var ls = 0, lsq = 0;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var k4 = ((y+dy)*W+(x+dx))*4;
            var br = (pixelData[k4]*77+pixelData[k4+1]*150+pixelData[k4+2]*29)>>8;
            ls += br; lsq += br*br;
          }
        }
        var lm = ls/25, lvar = lsq/25 - lm*lm;
        if (lvar < 120)  flatCnt++;
        if (lvar > 1600) edgeCnt++;

        // Text-line proxy: strong horizontal luminance step
        var ll = (pixelData[(y*W+x-2)*4]*77+pixelData[(y*W+x-2)*4+1]*150+pixelData[(y*W+x-2)*4+2]*29)>>8;
        var lr = (pixelData[(y*W+x+2)*4]*77+pixelData[(y*W+x+2)*4+1]*150+pixelData[(y*W+x+2)*4+2]*29)>>8;
        if (Math.abs(ll-lr)>80 && lvar>500 && lvar<3000) textLineCnt++;

        var mx = r>g?(r>b?r:b):(g>b?g:b);
        var mn = r<g?(r<b?r:b):(g<b?g:b);
        var sat = mx>0?(mx-mn)/mx:0;
        satSum += sat;
        if (mx>mn) {
          var hue = mx===r?((g-b)/(mx-mn)+6)%6 : mx===g?(b-r)/(mx-mn)+2 : (r-g)/(mx-mn)+4;
          hueHist[Math.floor(hue*2)%12]++;
        }
        lumSum += lum; lumSqSum += lum*lum;
        if (lum < 50)  darkCnt++;
        if (r>100&&r<240&&g>60&&g<200&&b>40&&b<180&&r>g+8&&g>b-20&&sat>0.08&&sat<0.65) skinCnt++;
        total++;
      }
    }
    if (!total) return { mode: 'photo', isScreenshot: false };

    var flatR = flatCnt/total, edgeR = edgeCnt/total, textR = textLineCnt/total;
    var skinR = skinCnt/total, darkR = darkCnt/total;
    var avgSat = satSum/total, avgLum = lumSum/total;
    var lumVar = lumSqSum/total - avgLum*avgLum;

    var hTotal = 0;
    for (var hi = 0; hi < 12; hi++) hTotal += hueHist[hi];
    var hueEnt = 0;
    for (var hi2 = 0; hi2 < 12; hi2++) {
      if (hueHist[hi2]>0) { var p=hueHist[hi2]/hTotal; hueEnt -= p*Math.log2(p); }
    }
    var hueSpread = hueEnt / Math.log2(12);

    // Screenshot: flat + text-edges OR flat + low-sat OR text-heavy
    var isScreenshot = (flatR>0.42 && (edgeR>0.04||textR>0.03))
                    || (flatR>0.60 && avgSat<0.20)
                    || textR>0.08;
    if (isScreenshot) return { mode: 'screenshot', isScreenshot: true };

    if (darkR>0.55&&avgLum<80)            return { mode: 'dark',     isScreenshot: false };
    if (hueSpread>0.72&&flatR>0.30&&lumVar<2500) return { mode: 'anime', isScreenshot: false };
    if (skinR>0.18)                        return { mode: 'selfie',   isScreenshot: false };
    if (skinR>0.07)                        return { mode: 'portrait', isScreenshot: false };
    if (avgSat<0.18&&lumVar>3500&&darkR<0.30) return { mode: 'metallic', isScreenshot: false };
    if (avgLum>190&&avgSat<0.10&&textR>0.02) return { mode: 'document', isScreenshot: true };
    if (avgLum>150&&avgSat>0.15)           return { mode: 'product',  isScreenshot: false };
    if (flatR>0.45&&hueSpread<0.40)        return { mode: 'logo',     isScreenshot: false };
    return { mode: 'photo', isScreenshot: false };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LETTERBOX PAD (aspect-ratio preserving for inference)
  //  Pads the shorter axis so the image fits in inputSize×inputSize square.
  //  Records offX/offY/sw/sh so the mask can be unpadded precisely.
  // ══════════════════════════════════════════════════════════════════════════
  function letterboxCanvas(src, W, H, inputSize) {
    var scale = inputSize / Math.max(W, H);
    var sw    = Math.round(W * scale);
    var sh    = Math.round(H * scale);
    var offX  = Math.floor((inputSize - sw) / 2);
    var offY  = Math.floor((inputSize - sh) / 2);
    var lc    = document.createElement('canvas');
    lc.width  = inputSize; lc.height = inputSize;
    var lctx  = lc.getContext('2d');
    lctx.fillStyle = 'rgb(128,128,128)'; // neutral pad
    lctx.fillRect(0, 0, inputSize, inputSize);
    lctx.drawImage(src, offX, offY, sw, sh);
    return { canvas: lc, sw: sw, sh: sh, offX: offX, offY: offY };
  }

  function toTensor(canvas, inputSize, mean, std) {
    var n   = inputSize * inputSize;
    var px  = canvas.getContext('2d').getImageData(0, 0, inputSize, inputSize).data;
    var buf = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      buf[i]       = (px[i*4]   / 255 - mean[0]) / std[0];
      buf[n   + i] = (px[i*4+1] / 255 - mean[1]) / std[1];
      buf[2*n + i] = (px[i*4+2] / 255 - mean[2]) / std[2];
    }
    return buf;
  }

  // Extract float confidence [0,1] from raw model mask.
  // Crops the letterbox padding and scales to targetW×targetH.
  // Returns Float32Array — NO threshold, NO contour sharpening.
  function extractConfidence(rawMask, maskSize, targetW, targetH, lb) {
    var mn = maskSize * maskSize;
    var mc = document.createElement('canvas');
    mc.width = maskSize; mc.height = maskSize;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(maskSize, maskSize);
    for (var i = 0; i < mn; i++) {
      var v = clamp(Math.round(rawMask[i] * 255), 0, 255);
      mImg.data[i*4]     = v;
      mImg.data[i*4 + 1] = v;
      mImg.data[i*4 + 2] = v;
      mImg.data[i*4 + 3] = 255;
    }
    mctx.putImageData(mImg, 0, 0);

    var tc = document.createElement('canvas');
    tc.width = targetW; tc.height = targetH;
    var tctx = tc.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    // Crop letterbox padding, scale directly to target
    tctx.drawImage(mc, lb.offX, lb.offY, lb.sw, lb.sh, 0, 0, targetW, targetH);
    mc.width = 0; mc.height = 0;

    var px   = tctx.getImageData(0, 0, targetW, targetH).data;
    tc.width = 0; tc.height = 0;

    var conf = new Float32Array(targetW * targetH);
    for (var j = 0; j < conf.length; j++) conf[j] = px[j * 4] / 255;
    return conf;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GRAYSCALE GUIDE EXTRACTION
  //  Uses browser bilinear scaling via canvas (GPU-accelerated).
  //  Returns Float32Array luminance [0,1] at targetW×targetH.
  // ══════════════════════════════════════════════════════════════════════════
  function imgToGray(imgEl, targetW, targetH) {
    var tc = document.createElement('canvas');
    tc.width = targetW; tc.height = targetH;
    var tctx = tc.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(imgEl, 0, 0, imgEl.naturalWidth, imgEl.naturalHeight, 0, 0, targetW, targetH);
    var px  = tctx.getImageData(0, 0, targetW, targetH).data;
    tc.width = 0; tc.height = 0;
    var gray = new Float32Array(targetW * targetH);
    for (var i = 0; i < gray.length; i++) {
      // ITU-R BT.601 luminance
      gray[i] = (px[i*4]*0.299 + px[i*4+1]*0.587 + px[i*4+2]*0.114) / 255;
    }
    return gray;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BILINEAR UPSAMPLE Float32 array via canvas
  //  Used to scale refined alpha from GF resolution back to full resolution.
  // ══════════════════════════════════════════════════════════════════════════
  function upsampleFloat(arr, srcW, srcH, dstW, dstH) {
    var sc = document.createElement('canvas');
    sc.width = srcW; sc.height = srcH;
    var sctx = sc.getContext('2d');
    var img  = sctx.createImageData(srcW, srcH);
    for (var i = 0; i < arr.length; i++) {
      var v = clamp(Math.round(arr[i] * 255), 0, 255);
      img.data[i*4]     = v;
      img.data[i*4 + 1] = v;
      img.data[i*4 + 2] = v;
      img.data[i*4 + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    var tc = document.createElement('canvas');
    tc.width = dstW; tc.height = dstH;
    var tctx = tc.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(sc, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
    sc.width = 0; sc.height = 0;

    var px  = tctx.getImageData(0, 0, dstW, dstH).data;
    tc.width = 0; tc.height = 0;

    var out = new Float32Array(dstW * dstH);
    for (var j = 0; j < out.length; j++) out[j] = px[j * 4] / 255;
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SOBEL EDGE DETECTION (from grayscale float array)
  //  Returns Float32Array of edge magnitude [0,1].
  //  Used to extend the trimap unknown zone near strong edges.
  // ══════════════════════════════════════════════════════════════════════════
  function sobelEdges(gray, W, H) {
    var edges = new Float32Array(W * H);
    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var i  = y * W + x;
        var tl = gray[i-W-1], tm = gray[i-W], tr = gray[i-W+1];
        var ml = gray[i-1],                   mr = gray[i+1];
        var bl = gray[i+W-1], bm = gray[i+W], br = gray[i+W+1];
        var gx = -tl - 2*ml - bl + tr + 2*mr + br;
        var gy = -tl - 2*tm - tr + bl + 2*bm + br;
        edges[i] = clampF(Math.sqrt(gx*gx + gy*gy) / 1.5);
      }
    }
    return edges;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TRIMAP GENERATION
  //  Divides image into definite FG (255), definite BG (0), unknown (128).
  //  Extends unknown zone by EDGE_DILATION pixels near strong Sobel edges
  //  to ensure hair, fur, and fine structures fall in the unknown region
  //  and get refined by the guided filter (not hard-clamped to BG).
  // ══════════════════════════════════════════════════════════════════════════
  function generateTrimap(conf, edges, W, H, FG_THR, BG_THR) {
    var N   = W * H;
    var tm  = new Uint8Array(N);
    var R   = 5; // edge dilation radius (pixels at GF resolution)

    for (var i = 0; i < N; i++) {
      if      (conf[i] > FG_THR) tm[i] = 255;
      else if (conf[i] < BG_THR) tm[i] = 0;
      else                       tm[i] = 128;
    }

    // Extend unknown zone near strong edges
    var ext = new Uint8Array(N); // pixels to convert to unknown
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var ci = y * W + x;
        if (edges[ci] > 0.14 && tm[ci] !== 128) {
          var y1 = Math.max(0, y - R), y2 = Math.min(H - 1, y + R);
          var x1 = Math.max(0, x - R), x2 = Math.min(W - 1, x + R);
          for (var ny = y1; ny <= y2; ny++) {
            for (var nx = x1; nx <= x2; nx++) {
              var ni = ny * W + nx;
              if (tm[ni] !== 128) ext[ni] = 1;
            }
          }
        }
      }
    }
    for (var j = 0; j < N; j++) { if (ext[j]) tm[j] = 128; }
    return tm;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUMMED AREA TABLE (integral image) — O(N) box filtering
  //  Uses (W+1)×(H+1) 1-indexed table with zero-padded first row/col.
  // ══════════════════════════════════════════════════════════════════════════
  function buildSAT(arr, W, H) {
    var W1 = W + 1;
    var S  = new Float64Array((H + 1) * W1);
    for (var y = 1; y <= H; y++) {
      for (var x = 1; x <= W; x++) {
        S[y*W1+x] = arr[(y-1)*W+(x-1)]
                  + S[(y-1)*W1+x]
                  + S[y*W1+(x-1)]
                  - S[(y-1)*W1+(x-1)];
      }
    }
    return S;
  }

  function boxFilter(arr, W, H, r) {
    var W1  = W + 1;
    var S   = buildSAT(arr, W, H);
    var out = new Float32Array(W * H);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var xa = Math.max(0, x - r),     xb = Math.min(W - 1, x + r);
        var ya = Math.max(0, y - r),     yb = Math.min(H - 1, y + r);
        var cnt = (xb - xa + 1) * (yb - ya + 1);
        // SAT box sum: S[yb+1][xb+1] - S[ya][xb+1] - S[yb+1][xa] + S[ya][xa]
        var sum = S[(yb+1)*W1+(xb+1)] - S[ya*W1+(xb+1)] - S[(yb+1)*W1+xa] + S[ya*W1+xa];
        out[y*W+x] = sum / cnt;
      }
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GUIDED FILTER (He, Sun, Tang — CVPR 2010 / PAMI 2013)
  //  Uses original image luminance as the guide.
  //  Edges in the guide → large local variance → small linear coefficient →
  //  filter output tracks input closely (edge preserved).
  //  Uniform regions → small variance → filter smooths (noise removed).
  //
  //  Mathematically prevents halos: the linear model a*I+b cannot create
  //  new edges that don't exist in the guide.
  //
  //  Complexity: O(N) via 8 box filters with integral images.
  //  Memory: ~10 × Float32[N] arrays, freed progressively.
  // ══════════════════════════════════════════════════════════════════════════
  function guidedFilter(guide, input, W, H, r, eps) {
    var N = W * H;

    var mean_I  = boxFilter(guide, W, H, r);
    var mean_p  = boxFilter(input, W, H, r);

    var II = new Float32Array(N);
    var Ip = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      II[i] = guide[i] * guide[i];
      Ip[i] = guide[i] * input[i];
    }
    var corr_I  = boxFilter(II, W, H, r);
    var corr_Ip = boxFilter(Ip, W, H, r);
    II = null; Ip = null;

    var a = new Float32Array(N);
    var b = new Float32Array(N);
    for (var j = 0; j < N; j++) {
      var varI  = corr_I[j]  - mean_I[j] * mean_I[j];
      var covIp = corr_Ip[j] - mean_I[j] * mean_p[j];
      a[j] = covIp / (varI + eps);
      b[j] = mean_p[j] - a[j] * mean_I[j];
    }
    corr_I = null; corr_Ip = null; mean_I = null; mean_p = null;

    var mean_a = boxFilter(a, W, H, r);
    var mean_b = boxFilter(b, W, H, r);
    a = null; b = null;

    var output = new Float32Array(N);
    for (var k = 0; k < N; k++) {
      output[k] = clampF(mean_a[k] * guide[k] + mean_b[k]);
    }
    return output;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  OTSU THRESHOLD
  //  Finds optimal binary threshold from confidence histogram.
  //  Used exclusively in screenshot mode for clean binary segmentation.
  // ══════════════════════════════════════════════════════════════════════════
  function otsuThreshold(conf, N) {
    var hist = new Int32Array(256);
    for (var i = 0; i < N; i++) hist[clamp(Math.round(conf[i] * 255), 0, 255)]++;
    var sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, maxVar = 0, threshold = 128;
    for (var t2 = 0; t2 < 256; t2++) {
      wB += hist[t2];
      if (!wB) continue;
      var wF = N - wB;
      if (!wF) break;
      sumB += t2 * hist[t2];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = t2; }
    }
    return threshold / 255;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MORPHOLOGICAL OPERATIONS
  //  3×3 structuring element (8-connected), iterable for larger effective radius.
  //  These operate on Float32 arrays [0,1].
  //
  //  close(r) = dilate(r) then erode(r): fills thin gaps in FG (fingers, cables)
  //  open(r)  = erode(r) then dilate(r): removes BG noise specks near edges
  // ══════════════════════════════════════════════════════════════════════════
  function morphDilate3(alpha, W, H) {
    var N = W * H, out = new Float32Array(N);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i  = y * W + x;
        var mx = alpha[i];
        if (x > 0)       { var v=alpha[i-1];   if(v>mx) mx=v; }
        if (x < W-1)     { var v=alpha[i+1];   if(v>mx) mx=v; }
        if (y > 0)       { var v=alpha[i-W];   if(v>mx) mx=v; }
        if (y < H-1)     { var v=alpha[i+W];   if(v>mx) mx=v; }
        if (x>0&&y>0)    { var v=alpha[i-W-1]; if(v>mx) mx=v; }
        if (x<W-1&&y>0)  { var v=alpha[i-W+1]; if(v>mx) mx=v; }
        if (x>0&&y<H-1)  { var v=alpha[i+W-1]; if(v>mx) mx=v; }
        if (x<W-1&&y<H-1){ var v=alpha[i+W+1]; if(v>mx) mx=v; }
        out[i] = mx;
      }
    }
    return out;
  }

  function morphErode3(alpha, W, H) {
    var N = W * H, out = new Float32Array(N);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i  = y * W + x;
        var mn = alpha[i];
        if (x > 0)       { var v=alpha[i-1];   if(v<mn) mn=v; }
        if (x < W-1)     { var v=alpha[i+1];   if(v<mn) mn=v; }
        if (y > 0)       { var v=alpha[i-W];   if(v<mn) mn=v; }
        if (y < H-1)     { var v=alpha[i+W];   if(v<mn) mn=v; }
        if (x>0&&y>0)    { var v=alpha[i-W-1]; if(v<mn) mn=v; }
        if (x<W-1&&y>0)  { var v=alpha[i-W+1]; if(v<mn) mn=v; }
        if (x>0&&y<H-1)  { var v=alpha[i+W-1]; if(v<mn) mn=v; }
        if (x<W-1&&y<H-1){ var v=alpha[i+W+1]; if(v<mn) mn=v; }
        out[i] = mn;
      }
    }
    return out;
  }

  function morphClose(alpha, W, H, iters) {
    var a = alpha;
    for (var i = 0; i < iters; i++) a = morphDilate3(a, W, H);
    for (var j = 0; j < iters; j++) a = morphErode3(a, W, H);
    return a;
  }

  function morphOpen(alpha, W, H, iters) {
    var a = alpha;
    for (var i = 0; i < iters; i++) a = morphErode3(a, W, H);
    for (var j = 0; j < iters; j++) a = morphDilate3(a, W, H);
    return a;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  8-CONNECTED HOLE FILL (BFS from image border)
  //  Any transparent pixel NOT reachable from the border is interior → FG.
  //  threshold: pixels BELOW this float value are "hole candidates".
  //  Raised from 0.15 (v3) to 0.31 to catch semi-transparent interiors
  //  (glasses lenses, reflective surfaces, transparent clothing).
  // ══════════════════════════════════════════════════════════════════════════
  function holeFill8(alpha, W, H, threshold) {
    threshold = threshold !== undefined ? threshold : 0.31;
    var N    = W * H;
    var DX8  = [-1,0,1,-1,1,-1,0,1];
    var DY8  = [-1,-1,-1,0,0,1,1,1];
    var reach = new Uint8Array(N);
    var q = [], qi = 0;

    function seed(pi) {
      if (alpha[pi] < threshold && !reach[pi]) { reach[pi] = 1; q.push(pi); }
    }
    for (var x = 0; x < W; x++) { seed(x); seed((H-1)*W+x); }
    for (var y = 1; y < H-1; y++) { seed(y*W); seed(y*W+W-1); }

    while (qi < q.length) {
      var pi = q[qi++];
      var px = pi % W, py = (pi - px) / W;
      for (var di = 0; di < 8; di++) {
        var nx = px+DX8[di], ny = py+DY8[di];
        if (nx<0||nx>=W||ny<0||ny>=H) continue;
        var ni = ny*W+nx;
        if (reach[ni]||alpha[ni]>=threshold) continue;
        reach[ni]=1; q.push(ni);
      }
    }
    var filled = new Float32Array(alpha);
    for (var i = 0; i < N; i++) {
      if (alpha[i]<threshold&&!reach[i]) filled[i]=0.9; // interior → FG
    }
    return filled;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TRIMAP HARD ENFORCEMENT
  //  Definite zones from the trimap are NEVER modified by any refinement stage.
  //  This is the mathematical guarantee that prevents:
  //   - false FG locks (old buildFgLock issue)
  //   - alpha inflation bleeding into BG regions
  //   - hair/edge destruction by interior passes
  // ══════════════════════════════════════════════════════════════════════════
  function enforceTrimapHard(alpha, conf, N, FG_THR, BG_THR) {
    for (var i = 0; i < N; i++) {
      if (conf[i] > FG_THR) alpha[i] = 1.0;  // definite FG: always fully opaque
      if (conf[i] < BG_THR) alpha[i] = 0.0;  // definite BG: always fully transparent
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  QUALITY VALIDATION (logging only — never modifies alpha)
  // ══════════════════════════════════════════════════════════════════════════
  function validateAlpha(alpha, N, label) {
    var solidFg = 0, softFg = 0, bg = 0;
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 0.78) solidFg++;
      else if (a > 0.20) softFg++;
      else               bg++;
    }
    var fgR     = (solidFg + softFg) / N;
    var solidR  = solidFg / (solidFg + softFg + 1);
    console.log('[BgAI v5] ' + label + ': FG=' + (fgR*100).toFixed(1) + '% solid=' + (solidR*100).toFixed(1) + '%');
    if (fgR < 0.01) console.warn('[BgAI v5] WARN: nearly empty foreground');
    if (fgR > 0.97) console.warn('[BgAI v5] WARN: background not removed');
    return { fgR: fgR, solidR: solidR };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INFERENCE: WHOLE IMAGE
  //  Returns { confGF, confFull } — float confidence at GF res and full res.
  // ══════════════════════════════════════════════════════════════════════════
  async function inferWhole(session, cfg, img, W, H, gfW, gfH) {
    var lb  = letterboxCanvas(img, W, H, cfg.inputSize);
    var buf = toTensor(lb.canvas, cfg.inputSize, cfg.mean, cfg.std);
    lb.canvas.width = 0; lb.canvas.height = 0;

    var feeds = {};
    feeds[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
    var results  = await session.run(feeds);
    var rawMask  = results[session.outputNames[0]].data;

    var confGF   = extractConfidence(rawMask, cfg.inputSize, gfW, gfH, lb);
    var confFull = extractConfidence(rawMask, cfg.inputSize, W,   H,   lb);
    return { confGF: confGF, confFull: confFull };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INFERENCE: TILED (large images — cosine-weighted multiplicative overlap)
  //  Tile weights: wx*wy (multiplicative, not Math.min).
  //  Eliminates rectangular seam artifacts at tile corners.
  // ══════════════════════════════════════════════════════════════════════════
  async function inferTiled(session, cfg, img, W, H, gfW, gfH, onProgress) {
    var TILE    = 640;
    var OVERLAP = clamp(Math.floor(Math.min(W, H) / 10), 48, 128);
    var STEP    = TILE - OVERLAP;
    var tilesX  = Math.max(1, Math.ceil((W - OVERLAP) / STEP));
    var tilesY  = Math.max(1, Math.ceil((H - OVERLAP) / STEP));
    var total   = tilesX * tilesY, done = 0;

    var accConf   = new Float32Array(W * H);
    var accWeight = new Float32Array(W * H);

    for (var ty = 0; ty < tilesY; ty++) {
      for (var tx = 0; tx < tilesX; tx++) {
        var x0 = tx * STEP, y0 = ty * STEP;
        var x1 = Math.min(x0 + TILE, W), y1 = Math.min(y0 + TILE, H);
        var tw = x1 - x0, th = y1 - y0;

        var tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(img, x0, y0, tw, th, 0, 0, tw, th);

        var lb  = letterboxCanvas(tc, tw, th, cfg.inputSize);
        var buf = toTensor(lb.canvas, cfg.inputSize, cfg.mean, cfg.std);
        lb.canvas.width = 0; lb.canvas.height = 0;
        tc.width = 0; tc.height = 0;

        var feeds = {};
        feeds[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
        var res      = await session.run(feeds);
        var rawMask  = res[session.outputNames[0]].data;
        var tileConf = extractConfidence(rawMask, cfg.inputSize, tw, th, lb);

        var isL = tx === 0, isR = tx === tilesX - 1;
        var isT = ty === 0, isB = ty === tilesY - 1;

        for (var py = 0; py < th; py++) {
          for (var px = 0; px < tw; px++) {
            var wx = 1.0, wy = 1.0;
            if (!isL && px < OVERLAP)       wx = (px + 0.5) / OVERLAP;
            if (!isR && px >= tw - OVERLAP) wx = (tw - px - 0.5) / OVERLAP;
            if (!isT && py < OVERLAP)       wy = (py + 0.5) / OVERLAP;
            if (!isB && py >= th - OVERLAP) wy = (th - py - 0.5) / OVERLAP;
            wx = clampF(wx); wy = clampF(wy);
            var w  = wx * wy; // multiplicative — zero rectangular seam artifacts
            var gi = (y0 + py) * W + (x0 + px);
            accConf[gi]   += tileConf[py * tw + px] * w;
            accWeight[gi] += w;
          }
        }

        done++;
        if (onProgress) onProgress(32 + Math.round(done/total*44), 'AI segmentation\u2026 ' + Math.round(done/total*100) + '%');
        if (done % 2 === 0) await yieldMain();
      }
    }

    var confFull = new Float32Array(W * H);
    for (var i = 0; i < W * H; i++) {
      confFull[i] = accWeight[i] > 0 ? clampF(accConf[i] / accWeight[i]) : 0;
    }
    var confGF = upsampleFloat(confFull, W, H, gfW, gfH); // downscale to GF res
    return { confGF: confGF, confFull: confFull };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN PROCESS FUNCTION
  // ══════════════════════════════════════════════════════════════════════════
  async function process(file, opts, onProgress) {
    opts = opts || {};
    var tier = detectTier(opts);
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
    // Read pixel data for the classifier (sampled, not full-res)
    var clsC = document.createElement('canvas');
    var clsMax = Math.min(1, 256 / Math.max(W, H));
    var clsW = Math.round(W * clsMax), clsH = Math.round(H * clsMax);
    clsC.width = clsW; clsC.height = clsH;
    var clsCtx = clsC.getContext('2d');
    clsCtx.drawImage(img, 0, 0, W, H, 0, 0, clsW, clsH);
    var clsData = clsCtx.getImageData(0, 0, clsW, clsH).data;
    clsC.width = 0; clsC.height = 0;

    var imageMode = classifyImageMode(clsData, clsW, clsH);
    clsData = null;

    // User subject mode override
    if (opts.subjectMode && opts.subjectMode !== 'auto') {
      if (opts.subjectMode === 'logo') imageMode = { mode: 'logo', isScreenshot: true };
    }
    console.log('[BgAI v5] Mode:', imageMode.mode, '| Screenshot:', imageMode.isScreenshot);

    // ── Load ONNX session ──────────────────────────────────────────────────
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      if (tier !== 'lite') {
        console.warn('[BgAI v5] standard failed → lite:', e1.message);
        if (onProgress) onProgress(8, 'Switching to lightweight AI\u2026');
        sessionData = await getSession('lite', onProgress);
      } else { throw e1; }
    }
    var session = sessionData.session, cfg = sessionData.cfg;

    // ── Compute GF dimensions ──────────────────────────────────────────────
    var mob       = isMobileUA();
    var gfMaxDim  = mob ? GF_MAX_MOBILE : GF_MAX_DIM;
    var gfScale   = Math.min(1.0, gfMaxDim / Math.max(W, H));
    var gfW       = Math.max(8, Math.round(W * gfScale));
    var gfH       = Math.max(8, Math.round(H * gfScale));

    if (onProgress) onProgress(33, 'Running AI segmentation\u2026');
    await yieldMain();

    // ── AI Inference ───────────────────────────────────────────────────────
    var largeImage = W > cfg.inputSize * 2.2 || H > cfg.inputSize * 2.2;
    var useTiling  = largeImage && !mob && !imageMode.isScreenshot;
    var confResult;
    if (useTiling) {
      confResult = await inferTiled(session, cfg, img, W, H, gfW, gfH, onProgress);
    } else {
      confResult = await inferWhole(session, cfg, img, W, H, gfW, gfH);
    }
    var confGF   = confResult.confGF;    // Float32[gfW*gfH] — for refinement
    var confFull = confResult.confFull;  // Float32[W*H] — for hard constraints

    if (onProgress) onProgress(79, 'Trimap + guided filter\u2026');
    await yieldMain();

    // ── Mode-specific thresholds ───────────────────────────────────────────
    var FG_THR = imageMode.isScreenshot ? 0.82 : 0.87;
    var BG_THR = imageMode.isScreenshot ? 0.18 : 0.12;
    var GF_R   = imageMode.mode === 'portrait' || imageMode.mode === 'selfie' ? 12
               : imageMode.mode === 'anime'    ? 6
               : imageMode.mode === 'product'  ? 8 : 10;
    var GF_EPS = imageMode.mode === 'metallic' ? 0.002 : 0.004;

    // ── Grayscale guide for guided filter ─────────────────────────────────
    var grayGF = imgToGray(img, gfW, gfH);

    // ── Sobel edges at GF resolution (for trimap extension) ───────────────
    var edgesGF = sobelEdges(grayGF, gfW, gfH);

    // ── Trimap generation ──────────────────────────────────────────────────
    var trimapGF = generateTrimap(confGF, edgesGF, gfW, gfH, FG_THR, BG_THR);
    edgesGF = null; // free memory

    // ── Refinement pipeline ────────────────────────────────────────────────
    var refinedGF;

    if (imageMode.isScreenshot) {
      // ── SCREENSHOT PATH: Otsu binary → morph close/open → holeFill ──────
      // No guided filter (would soften crisp UI edges).
      // No feathering (screenshots must have hard pixel-perfect boundaries).
      var otsuThr = otsuThreshold(confGF, gfW * gfH);
      refinedGF   = new Float32Array(gfW * gfH);
      for (var i = 0; i < refinedGF.length; i++) {
        refinedGF[i] = confGF[i] > otsuThr ? 1.0 : 0.0;
      }
      // Close r=2: fill sub-pixel gaps in UI text, thin borders
      refinedGF = morphClose(refinedGF, gfW, gfH, 2);
      // Open r=1: remove single-pixel BG specks
      refinedGF = morphOpen(refinedGF, gfW, gfH, 1);

    } else {
      // ── PHOTO PATH: Guided Filter → morph close → holeFill ──────────────
      // Guided filter output naturally preserves all edges from the original
      // image — hair, fur, soft textures, metallic reflections.
      // It cannot create halos (linear model) and cannot soften edges
      // that exist in the guide (the original RGB image).
      refinedGF = guidedFilter(grayGF, confGF, gfW, gfH, GF_R, GF_EPS);

      // Morphological close on FG region: fills thin gaps in subjects
      // (gaps between fingers, between hair strands, jewelry, cables).
      // IMPORTANT: only applied within the UNKNOWN region — definite BG
      // pixels are not touched (trimap hard enforcement happens after).
      var fgForClose = new Float32Array(gfW * gfH);
      for (var i2 = 0; i2 < fgForClose.length; i2++) {
        fgForClose[i2] = refinedGF[i2] > 0.5 ? refinedGF[i2] : 0.0;
      }
      var fgClosed = morphClose(fgForClose, gfW, gfH, 1);
      fgForClose = null;
      // Only apply close result in unknown region (not to definite BG)
      for (var i3 = 0; i3 < refinedGF.length; i3++) {
        if (trimapGF[i3] === 128 && fgClosed[i3] > refinedGF[i3]) {
          refinedGF[i3] = fgClosed[i3];
        }
      }
      fgClosed = null;
    }
    grayGF = null; // free memory

    // ── 8-connected hole fill at GF resolution ────────────────────────────
    refinedGF = holeFill8(refinedGF, gfW, gfH, 0.31);

    // ── Trimap hard enforcement at GF resolution ───────────────────────────
    // definite FG → 1.0, definite BG → 0.0 (ABSOLUTE, cannot be overridden)
    for (var i4 = 0; i4 < gfW * gfH; i4++) {
      if (trimapGF[i4] === 255) refinedGF[i4] = 1.0;
      if (trimapGF[i4] === 0)   refinedGF[i4] = 0.0;
    }
    trimapGF = null;

    await yieldMain();
    if (onProgress) onProgress(91, 'Upsampling to full resolution\u2026');

    // ── Upsample refined alpha GF → full resolution ───────────────────────
    var alphaFull;
    if (gfW === W && gfH === H) {
      alphaFull = refinedGF; // already at full res
    } else {
      alphaFull = upsampleFloat(refinedGF, gfW, gfH, W, H);
    }
    refinedGF = null;

    // ── Trimap hard enforcement at full resolution ─────────────────────────
    // Re-apply using full-res confidence to correct any bilinear artefacts
    // at zone boundaries introduced by the upsample step.
    enforceTrimapHard(alphaFull, confFull, W * H, FG_THR, BG_THR);
    confFull = null; // free memory

    // ── Validate ───────────────────────────────────────────────────────────
    validateAlpha(alphaFull, W * H, 'final');

    if (onProgress) onProgress(95, 'Compositing\u2026');
    await yieldMain();

    // ── Export: fresh canvas — NEVER shared with preview ──────────────────
    // The export canvas contains ONLY: original image pixels with final alpha.
    // No checkerboard, no overlays, no debug data.
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
    // Exposed for debugging / audit verification:
    classify:     classifyImageMode,
    otsu:         otsuThreshold,
    guidedFilter: guidedFilter,
    morphClose:   morphClose,
    morphOpen:    morphOpen,
    holeFill8:    holeFill8,
    sobelEdges:   sobelEdges,
    generateTrimap: generateTrimap,
  };

  // Auto-preload lite model 4 s after page load (model is 4.7 MB)
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () {
      setTimeout(function () { preload('lite'); }, 4000);
    });
  }

}());
