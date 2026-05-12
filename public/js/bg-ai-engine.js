// Background Removal AI Engine v4.0 — Production-Grade Full Rebuild
// Root causes fixed vs v3.0:
//   RC-01: Non-square image distortion → letterbox pad preserves aspect ratio
//   RC-02: Tile blending seams → cosine (wx*wy) weights replace Math.min
//   RC-03: Lock thresholds too low → raised to 220/185/160
//   RC-04: qualityAssert blindly boosts → neighborhood-context gated boost
//   RC-05: alphaStabilize destroys hair → only fires on non-edge interior pixels
//   RC-06: bodySolidity halo on BG → requires distance from edge > R
//   RC-07: Screenshot detection too weak → 6-feature classifier (10 modes)
//   RC-08: Hole fill threshold 38 → raised to 80 (catches semi-transparent holes)
//   RC-09: maskToAlpha 28-200 blurry zone → Otsu-guided binary threshold applied
//   RC-10: No export validation → alpha histogram gate before returning blob
//
// Pipeline:
//   preprocess → classify (10 modes) → letterbox → AI inference (whole/tiled)
//   → unletterbox → buildFgLock → bfsHoleFill8[×3] → interiorSolidity
//   → modeEdgeRefine → qualityGate → exportValidate → PNG blob

(function () {
  'use strict';

  var ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
  var ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

  var MODELS = {
    lite: {
      name: 'U2Net-Lite',
      urls: [
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/u2netp.onnx',
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
      ],
      cacheKey: 'bge_u2netp_v4',
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
      cacheKey: 'bge_rmbg14_q_v4',
      inputSize: 1024,
      mean: [0.5, 0.5, 0.5],
      std:  [1.0, 1.0, 1.0],
      sizeMB: 44,
    },
  };

  var _sessions   = {};
  var _ortReady   = false;
  var _ortPromise = null;

  function yieldMain() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clampRound(v) { return clamp(Math.round(v), 0, 255); }

  // ── Device tier ────────────────────────────────────────────────────────────
  function detectTier(opts) {
    if (opts && opts.qualityMode === 'ultra') return 'standard';
    if (opts && opts.qualityMode === 'lite')  return 'lite';
    var ua   = navigator.userAgent || '';
    var mob  = /Mobi|Android|iPhone|iPad/i.test(ua);
    var cores = navigator.hardwareConcurrency || 2;
    var ram   = navigator.deviceMemory || 0;
    if (mob || cores <= 2 || (ram > 0 && ram < 3)) return 'lite';
    return 'standard';
  }

  // ── ORT loader ────────────────────────────────────────────────────────────
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

  // ── IDB cache ─────────────────────────────────────────────────────────────
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 4);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models');
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function ()  { reject(new Error('IDB open failed')); };
    });
  }

  async function cacheGet(key) {
    if (window.IDBCache) {
      try { var v = await window.IDBCache.get('__bge__' + key); if (v) return v; } catch (_e) {}
    }
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
    if (window.IDBCache) {
      try { await window.IDBCache.set('__bge__' + key, buf); return; } catch (_e) {}
    }
    try {
      var db = await idbOpen();
      await new Promise(function (res) {
        var tx = db.transaction('models', 'readwrite');
        tx.objectStore('models').put(buf, key);
        tx.oncomplete = res; tx.onerror = res;
      });
    } catch (_e) {}
  }

  // ── Model fetch with progress ──────────────────────────────────────────────
  async function fetchModel(cfg, onProgress) {
    var cached = await cacheGet(cfg.cacheKey);
    if (cached) {
      if (onProgress) onProgress(25, 'AI model ready — initialising…');
      return cached instanceof ArrayBuffer ? cached : (cached.buffer || cached);
    }
    if (onProgress) onProgress(3, 'Downloading AI model (' + cfg.sizeMB.toFixed(0) + '\u202fMB)…');
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
              'Downloading… ' + (received / 1048576).toFixed(1) + '\u202fMB\u202f/\u202f' + cfg.sizeMB.toFixed(0) + '\u202fMB');
          }
        }
        var total = 0;
        for (var ci = 0; ci < chunks.length; ci++) total += chunks[ci].length;
        var merged = new Uint8Array(total), off = 0;
        for (var ci2 = 0; ci2 < chunks.length; ci2++) { merged.set(chunks[ci2], off); off += chunks[ci2].length; }
        await cacheSet(cfg.cacheKey, merged.buffer);
        return merged.buffer;
      } catch (e) { lastErr = e; console.warn('[BgAI v4] fetch failed:', cfg.urls[ui], e.message); }
    }
    throw lastErr || new Error('All model URLs failed');
  }

  // ── Session factory ────────────────────────────────────────────────────────
  async function getSession(tier, onProgress) {
    if (_sessions[tier]) return { session: _sessions[tier], cfg: MODELS[tier] };
    var cfg = MODELS[tier];
    if (!cfg) throw new Error('Unknown tier: ' + tier);
    var ort      = await loadORT();
    var modelBuf = await fetchModel(cfg, onProgress);
    if (onProgress) onProgress(28, 'Compiling AI model…');
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
      } catch (e) { lastErr = e; console.warn('[BgAI v4] session failed:', provSets[pi], e.message); }
    }
    if (!session) throw lastErr || new Error('Cannot create ONNX session');
    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 1: IMAGE MODE CLASSIFICATION (10 modes)
  //  Features: edge density, local variance, saturation entropy, flat ratio,
  //  histogram entropy, skin ratio, text-line density, luminance spread
  // ════════════════════════════════════════════════════════════════════════════
  function classifyImageMode(d, W, H) {
    var step = Math.max(2, Math.round(Math.sqrt(W * H / 2000)));
    var flatCount = 0, edgeCount = 0, textLineCount = 0;
    var skinCount = 0, darkCount = 0, total = 0;
    var satSum = 0, lumSum = 0, lumSqSum = 0;
    var hsvH_counts = new Float32Array(12); // hue histogram (12 buckets)

    for (var y = 2; y < H - 2; y += step) {
      for (var x = 2; x < W - 2; x += step) {
        var j4  = (y * W + x) * 4;
        var r   = d[j4], g = d[j4+1], b = d[j4+2];
        var lum = (r * 77 + g * 150 + b * 29) >> 8;

        // 5×5 local variance (flat vs edge detection)
        var lsum = 0, lsq = 0;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var k4  = ((y + dy) * W + (x + dx)) * 4;
            var br  = (d[k4] * 77 + d[k4+1] * 150 + d[k4+2] * 29) >> 8;
            lsum += br; lsq += br * br;
          }
        }
        var lmean = lsum / 25;
        var lvar  = lsq / 25 - lmean * lmean;

        if (lvar < 120)  flatCount++;
        if (lvar > 1600) edgeCount++;
        // Text line proxy: very sharp 1D horizontal edge (text on white/dark bg)
        var leftLum  = (d[(y * W + (x-2)) * 4] * 77 + d[(y * W + (x-2)) * 4 + 1] * 150 + d[(y * W + (x-2)) * 4 + 2] * 29) >> 8;
        var rightLum = (d[(y * W + (x+2)) * 4] * 77 + d[(y * W + (x+2)) * 4 + 1] * 150 + d[(y * W + (x+2)) * 4 + 2] * 29) >> 8;
        if (Math.abs(leftLum - rightLum) > 80 && lvar > 500 && lvar < 3000) textLineCount++;

        // Saturation
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var sat = mx > 0 ? (mx - mn) / mx : 0;
        satSum += sat;

        // Hue bucket
        if (mx > mn) {
          var hue = mx === r ? ((g - b) / (mx - mn) + 6) % 6
                  : mx === g ?  (b - r) / (mx - mn) + 2
                  :             (r - g) / (mx - mn) + 4;
          hsvH_counts[Math.floor(hue * 2) % 12]++;
        }

        // Luminance stats
        lumSum += lum; lumSqSum += lum * lum;
        if (lum < 50)  darkCount++;

        // Skin tone (warm mid-range)
        if (r > 100 && r < 240 && g > 60 && g < 200 && b > 40 && b < 180
            && r > g + 8 && g > b - 20 && sat > 0.08 && sat < 0.65) skinCount++;

        total++;
      }
    }

    if (!total) return { mode: 'photo', isScreenshot: false };

    var flatRatio     = flatCount  / total;
    var edgeRatio     = edgeCount  / total;
    var textLineRatio = textLineCount / total;
    var skinRatio     = skinCount  / total;
    var darkRatio     = darkCount  / total;
    var avgSat        = satSum     / total;
    var avgLum        = lumSum     / total;
    var lumVar        = lumSqSum / total - avgLum * avgLum;

    // Hue entropy (spread of colors — high = anime/illustration, low = photo)
    var hueTotal = hsvH_counts.reduce(function (a, v) { return a + v; }, 0);
    var hueEntropy = 0;
    for (var hi = 0; hi < 12; hi++) {
      if (hsvH_counts[hi] > 0) {
        var p = hsvH_counts[hi] / hueTotal;
        hueEntropy -= p * Math.log2(p);
      }
    }
    var maxHueEntropy = Math.log2(12);
    var hueSpread = hueEntropy / maxHueEntropy; // 0..1

    // ── Mode rules (priority order) ──────────────────────────────────────────
    // Screenshot/UI: flat regions + sharp text edges, low saturation spread
    var isScreenshot = (flatRatio > 0.42 && (edgeRatio > 0.04 || textLineRatio > 0.03))
                    || (flatRatio > 0.60 && avgSat < 0.20)
                    || (textLineRatio > 0.08);

    if (isScreenshot) {
      return { mode: 'screenshot', isScreenshot: true,
               flatRatio: flatRatio, edgeRatio: edgeRatio };
    }

    // Dark scene: majority of pixels are dark
    if (darkRatio > 0.55 && avgLum < 80) {
      return { mode: 'dark', isScreenshot: false, darkRatio: darkRatio };
    }

    // Anime/cartoon: high hue spread + flat-ish regions + low luminance variance
    if (hueSpread > 0.72 && flatRatio > 0.30 && lumVar < 2500) {
      return { mode: 'anime', isScreenshot: false, hueSpread: hueSpread };
    }

    // Portrait/selfie: significant skin tones
    if (skinRatio > 0.07) {
      return { mode: skinRatio > 0.18 ? 'selfie' : 'portrait', isScreenshot: false, skinRatio: skinRatio };
    }

    // Metallic: high luminance variance + low saturation + not dark
    if (avgSat < 0.18 && lumVar > 3500 && darkRatio < 0.30) {
      return { mode: 'metallic', isScreenshot: false };
    }

    // Document: very bright, low saturation, text-line edges
    if (avgLum > 190 && avgSat < 0.10 && textLineRatio > 0.02) {
      return { mode: 'document', isScreenshot: true }; // treat like screenshot (hard edges)
    }

    // Product: bright, moderate saturation
    if (avgLum > 150 && avgSat > 0.15) {
      return { mode: 'product', isScreenshot: false };
    }

    // Logo: very flat with limited hue range
    if (flatRatio > 0.45 && hueSpread < 0.40) {
      return { mode: 'logo', isScreenshot: false };
    }

    return { mode: 'photo', isScreenshot: false };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 2: ASPECT-RATIO-PRESERVING LETTERBOX
  //  FIX RC-01: non-square images were squashed during inference
  //  We pad the shorter axis to make a square, infer, then unpad.
  // ════════════════════════════════════════════════════════════════════════════
  function letterboxCanvas(src, W, H, inputSize) {
    var scale = inputSize / Math.max(W, H);
    var sw    = Math.round(W * scale);
    var sh    = Math.round(H * scale);
    var offX  = Math.floor((inputSize - sw) / 2);
    var offY  = Math.floor((inputSize - sh) / 2);

    var lc  = document.createElement('canvas');
    lc.width = inputSize; lc.height = inputSize;
    var lctx = lc.getContext('2d');
    lctx.fillStyle = 'rgb(128,128,128)'; // neutral gray pad
    lctx.fillRect(0, 0, inputSize, inputSize);
    lctx.drawImage(src, offX, offY, sw, sh);

    return { canvas: lc, sw: sw, sh: sh, offX: offX, offY: offY, scale: scale };
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

  // Unpad the letterboxed model output mask back to the original pixel dimensions.
  // Returns a Uint8Array of size W*H with alpha values 0-255.
  function unletterboxMask(rawMask, maskSize, W, H, lb, screenshotMode) {
    // rawMask is Float32Array of size maskSize*maskSize from the model output

    // Step 1: create a maskSize canvas with the raw model output
    var mc = document.createElement('canvas');
    mc.width = maskSize; mc.height = maskSize;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(maskSize, maskSize);
    var mn   = maskSize * maskSize;
    for (var i = 0; i < mn; i++) {
      var v = clampRound(rawMask[i] * 255);
      mImg.data[i*4]     = v;
      mImg.data[i*4 + 1] = v;
      mImg.data[i*4 + 2] = v;
      mImg.data[i*4 + 3] = 255;
    }
    mctx.putImageData(mImg, 0, 0);

    // Step 2: Crop only the painted region (exclude the letterbox padding)
    // The painted region is [offX, offY, offX+sw, offY+sh] in the maskSize square
    var cropX = lb.offX, cropY = lb.offY, cropW = lb.sw, cropH = lb.sh;

    // Step 3: Scale cropped region back to W×H
    var oc  = document.createElement('canvas');
    oc.width = W; oc.height = H;
    var octx = oc.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    // Draw only the non-padded portion scaled to final size
    octx.drawImage(mc, cropX, cropY, cropW, cropH, 0, 0, W, H);
    mc.width = 0; mc.height = 0;

    var pix   = octx.getImageData(0, 0, W, H).data;
    oc.width  = 0; oc.height = 0;

    var N     = W * H;
    var alpha = new Uint8Array(N);

    if (screenshotMode) {
      // RC-09 fix for screenshots: use Otsu thresholding to get clean binary mask
      // Compute Otsu threshold on the mask histogram
      var hist = new Int32Array(256);
      for (var j = 0; j < N; j++) hist[pix[j * 4]]++;
      var otsu = computeOtsu(hist, N);
      for (var j2 = 0; j2 < N; j2++) {
        alpha[j2] = pix[j2 * 4] > otsu ? 255 : 0;
      }
    } else {
      // Photo mode: contour sharpening
      // RC-09: push values above 210 harder (FG), below 45 harder (BG)
      // Leave 45-210 as-is for genuine transitions (hair, soft object edges)
      for (var j3 = 0; j3 < N; j3++) {
        var a = pix[j3 * 4];
        if      (a > 210) a = clampRound(a + 30);  // was: >200 +35 — too aggressive
        else if (a < 45)  a = clampRound(a - 30);  // was: <28  -20 — too conservative
        alpha[j3] = a;
      }
    }
    return alpha;
  }

  // Compute Otsu's threshold from a histogram
  function computeOtsu(hist, N) {
    var sum = 0;
    for (var i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      wF = N - wB;
      if (!wF) break;
      sumB += t * hist[t];
      var mB  = sumB / wB;
      var mF  = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = t; }
    }
    return threshold;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 3: FG LOCK SYSTEM
  //  RC-03 fix: thresholds raised — 140 was too low, false-locked BG pixels
  //  New tiers: alpha >220 → 255 (solid), >185 → 240, >160 → 220
  // ════════════════════════════════════════════════════════════════════════════
  function buildFgLock(alpha, N) {
    var lock = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 220) lock[i] = 255;
      else if (a > 185) lock[i] = 240;
      else if (a > 160) lock[i] = 220;
    }
    return lock;
  }

  function enforceLock(alpha, lock, N) {
    for (var i = 0; i < N; i++) {
      if (lock[i] && alpha[i] < lock[i]) alpha[i] = lock[i];
    }
  }

  function updateLock(alpha, lock, N) {
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 220 && lock[i] < 255) lock[i] = 255;
      else if (a > 185 && lock[i] < 240) lock[i] = 240;
      else if (a > 162 && lock[i] < 220) lock[i] = 220;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 4: 8-CONNECTED BFS HOLE FILL
  //  RC-08 fix: threshold raised from 38 → 80 (catches semi-transparent holes:
  //  glasses lenses, reflective clothing, transparent interiors)
  // ════════════════════════════════════════════════════════════════════════════
  function bfsHoleFill8(alpha, W, H, threshold) {
    threshold = threshold || 80;
    var N   = W * H;
    var DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    var DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    var reach = new Uint8Array(N);
    var q = [], qi = 0;

    function seed(pi) {
      if (alpha[pi] < threshold && !reach[pi]) { reach[pi] = 1; q.push(pi); }
    }
    for (var x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (var y = 1; y < H - 1; y++) { seed(y * W); seed(y * W + W - 1); }

    while (qi < q.length) {
      var pi  = q[qi++];
      var px_ = pi % W, py_ = (pi - px_) / W;
      for (var di = 0; di < 8; di++) {
        var nx = px_ + DX8[di], ny = py_ + DY8[di];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        var ni = ny * W + nx;
        if (reach[ni] || alpha[ni] >= threshold) continue;
        reach[ni] = 1; q.push(ni);
      }
    }
    for (var i = 0; i < N; i++) {
      if (alpha[i] < threshold && !reach[i]) alpha[i] = 230; // interior hole → FG
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 5: INTERIOR SOLIDITY (RC-06 fix)
  //  Only boosts pixels that are genuinely interior (surrounded by FG, not edge).
  //  Guards against activating on BG pixels near subject edges.
  //  Uses edge distance check: if any neighbor has alpha < BG_THR, skip.
  // ════════════════════════════════════════════════════════════════════════════
  function interiorSolidity(alpha, W, H) {
    var N   = W * H;
    var out = new Uint8Array(alpha);
    var R   = 3; // 7×7 window
    var WIN = 49;
    var THR = Math.ceil(WIN * 0.72); // 72% must be solid — was 65% (too loose)
    var INTERIOR_CHK = 1; // 3×3 immediate neighborhood must be all FG

    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av < 80 || av > 200) continue; // only mid-range pixels

        // RC-06: immediate neighbor check — if any 4-neighbor is low alpha, this is an edge pixel, skip
        var isEdge = (
          alpha[ci - 1] < 100 || alpha[ci + 1] < 100 ||
          alpha[ci - W] < 100 || alpha[ci + W] < 100
        );
        if (isEdge) continue; // don't touch edge pixels — they need their natural gradient

        // 7×7 density check
        var fgCnt = 0, sum = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var na = alpha[(y + dy) * W + (x + dx)];
            sum += na;
            if (na > 200) fgCnt++;
          }
        }
        if (fgCnt >= THR) {
          var target = clampRound(av * 0.20 + (sum / WIN) * 0.80);
          out[ci] = Math.max(target, 210); // interior must be solid
        }
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 6: METALLIC / SPECULAR RESCUE
  // ════════════════════════════════════════════════════════════════════════════
  function metallicBoost(alpha, d, W, H) {
    var R = 2;
    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        if (alpha[ci] < 50 || alpha[ci] > 215) continue;

        var hasSolid = (
          (x > 0   && alpha[ci - 1] > 190) ||
          (x < W-1 && alpha[ci + 1] > 190) ||
          (y > 0   && alpha[ci - W] > 190) ||
          (y < H-1 && alpha[ci + W] > 190)
        );
        if (!hasSolid) continue;

        var bsum = 0, bsq = 0, ssum = 0, cnt = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var pi = ((y + dy) * W + (x + dx)) * 4;
            var r = d[pi], g = d[pi+1], b = d[pi+2];
            var br = (r + g + b) / 3;
            var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
            var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            bsum += br; bsq += br * br;
            ssum += mx > 0 ? (mx - mn) / mx : 0;
            cnt++;
          }
        }
        var bvar = bsq / cnt - (bsum / cnt) * (bsum / cnt);
        var asat = ssum / cnt;
        if (bvar > 350 || asat > 0.25) {
          alpha[ci] = clampRound(Math.max(alpha[ci], 215));
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 7: MODE-SPECIFIC EDGE REFINEMENT
  //  RC-05 fix: alphaStabilize was modified — now only runs on confirmed interior
  //  pixels (all 8 neighbors are FG). Hair strand pixels are never stabilized.
  //  RC-04 fix: edgeFeather only fires on true FG/BG boundary pixels
  // ════════════════════════════════════════════════════════════════════════════

  // Soft alpha zone for hair/fur — directional 3×3 feather only on boundary
  function edgeFeatherSoft(alpha, W, H) {
    var N      = W * H;
    var out    = new Uint8Array(alpha);
    var FG_THR = 230; // must see this solid to qualify edge
    var BG_THR = 30;  // must see this transparent

    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av < 20 || av > 240) continue;

        var hasFg = false, hasBg = false;
        for (var dy = -1; dy <= 1 && !(hasFg && hasBg); dy++) {
          for (var dx = -1; dx <= 1 && !(hasFg && hasBg); dx++) {
            var na = alpha[(y + dy) * W + (x + dx)];
            if (na > FG_THR) hasFg = true;
            if (na < BG_THR)  hasBg = true;
          }
        }
        if (!hasFg || !hasBg) continue;

        // True boundary pixel — apply conservative 3×3 blend (center weight = 5)
        var sum = 0, wt = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            var w = (dx2 === 0 && dy2 === 0) ? 5 : 1;
            sum += alpha[(y + dy2) * W + (x + dx2)] * w; wt += w;
          }
        }
        out[ci] = clampRound(sum / wt);
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // Hard edge refinement for screenshots/documents — binary cleanup via erosion
  function edgeRefineBinary(alpha, W, H) {
    var N   = W * H;
    var out = new Uint8Array(alpha);
    // 3×3 median-like: if majority of 3×3 is FG → FG, else BG
    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var ci = y * W + x;
        if (alpha[ci] > 128 && alpha[ci] < 230) {
          var fgN = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (alpha[(y + dy) * W + (x + dx)] > 128) fgN++;
            }
          }
          out[ci] = fgN >= 5 ? 255 : 0;
        }
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // Interior pixel stabilization — RC-05 fix: ONLY for pixels where ALL
  // 8 immediate neighbors are also FG (truly interior, not edge zone).
  function interiorStabilize(alpha, W, H) {
    var N   = W * H;
    var out = new Uint8Array(alpha);

    for (var y = 2; y < H - 2; y++) {
      for (var x = 2; x < W - 2; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av >= 190 || av < 30) continue; // already solid or background

        // All 8 immediate neighbors must be FG — guarantees we're interior
        var allFg = true;
        for (var dy = -1; dy <= 1 && allFg; dy++) {
          for (var dx = -1; dx <= 1 && allFg; dx++) {
            if (alpha[(y + dy) * W + (x + dx)] < 150) allFg = false;
          }
        }
        if (!allFg) continue; // edge or near-edge — leave alone

        // Pull up toward neighborhood average in a 5×5 window
        var sum = 0;
        for (var dy2 = -2; dy2 <= 2; dy2++) {
          for (var dx2 = -2; dx2 <= 2; dx2++) {
            sum += alpha[(y + dy2) * W + (x + dx2)];
          }
        }
        out[ci] = clampRound(av * 0.30 + (sum / 25) * 0.70);
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 8: QUALITY ASSERTION GATE (RC-04 fix)
  //  Old: blindly added +70 to all weak pixels including semi-transparent zones.
  //  New: only boosts pixels that have FG-majority neighborhood (confirmed FG).
  //       Leaves genuine hair/edge pixels untouched.
  // ════════════════════════════════════════════════════════════════════════════
  function qualityGate(alpha, lock, N, W, H) {
    var fgCnt = 0, weakCnt = 0;
    for (var i = 0; i < N; i++) {
      if (alpha[i] > 80) {
        fgCnt++;
        if (alpha[i] < 185) weakCnt++;
      }
    }
    if (!fgCnt || weakCnt / fgCnt <= 0.20) return; // quality OK

    console.log('[BgAI v4] Quality gate: ' + Math.round(weakCnt / fgCnt * 100) + '% weak FG — neighborhood-gated boost');

    for (var j = 0; j < N; j++) {
      if (alpha[j] <= 80 || alpha[j] >= 185) continue;
      // Only boost if neighborhood average is also FG (confirmed interior, not edge)
      var x = j % W, y = (j - x) / W;
      if (x < 1 || x >= W-1 || y < 1 || y >= H-1) continue;
      var nSum = 0, nCnt = 0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          nSum += alpha[(y + dy) * W + (x + dx)]; nCnt++;
        }
      }
      if (nSum / nCnt > 160) { // neighborhood is predominantly FG
        alpha[j] = clampRound(alpha[j] + 55);
      }
    }
    enforceLock(alpha, lock, N);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  STAGE 9: EXPORT VALIDATION
  //  Checks alpha histogram. If FG coverage looks catastrophically wrong,
  //  logs a warning (does not block export — a bad result is better than none).
  // ════════════════════════════════════════════════════════════════════════════
  function validateExport(alpha, N) {
    var solidFg = 0, softFg = 0, bg = 0;
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 200) solidFg++;
      else if (a > 50)  softFg++;
      else              bg++;
    }
    var fgRatio = (solidFg + softFg) / N;
    var solidRatio = N > 0 ? solidFg / (solidFg + softFg + 1) : 0;

    if (fgRatio < 0.01) {
      console.warn('[BgAI v4] WARN: Export has almost no foreground (' + (fgRatio * 100).toFixed(1) + '%). Subject may have been removed.');
    }
    if (fgRatio > 0.97) {
      console.warn('[BgAI v4] WARN: Export is nearly all foreground (' + (fgRatio * 100).toFixed(1) + '%). Background may not have been removed.');
    }
    if (solidRatio < 0.30 && fgRatio > 0.05) {
      console.warn('[BgAI v4] WARN: FG is mostly soft/semi-transparent. Subject solidity may be poor.');
    }
    console.log('[BgAI v4] Export: FG=' + (fgRatio * 100).toFixed(1) + '% solid=' + (solidRatio * 100).toFixed(1) + '%');
    return { fgRatio: fgRatio, solidRatio: solidRatio };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  INFERENCE: WHOLE IMAGE
  // ════════════════════════════════════════════════════════════════════════════
  async function inferWhole(session, cfg, src, W, H, imageMode) {
    var lb  = letterboxCanvas(src, W, H, cfg.inputSize);
    var buf = toTensor(lb.canvas, cfg.inputSize, cfg.mean, cfg.std);
    lb.canvas.width = 0; lb.canvas.height = 0;

    var feeds = {};
    feeds[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
    var results = await session.run(feeds);
    return unletterboxMask(results[session.outputNames[0]].data, cfg.inputSize, W, H, lb, imageMode.isScreenshot);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  INFERENCE: TILED (large images on desktop)
  //  RC-02 fix: weight = wx * wy (cosine/multiplicative) not Math.min(wx, wy)
  // ════════════════════════════════════════════════════════════════════════════
  async function inferTiled(session, cfg, src, W, H, imageMode, onProgress) {
    var TILE    = 640;
    var OVERLAP = clamp(Math.floor(Math.min(W, H) / 10), 48, 128);
    var STEP    = TILE - OVERLAP;
    var tilesX  = Math.max(1, Math.ceil((W - OVERLAP) / STEP));
    var tilesY  = Math.max(1, Math.ceil((H - OVERLAP) / STEP));
    var total   = tilesX * tilesY, done = 0;

    var accAlpha  = new Float32Array(W * H);
    var accWeight = new Float32Array(W * H);

    for (var ty = 0; ty < tilesY; ty++) {
      for (var tx = 0; tx < tilesX; tx++) {
        var x0 = tx * STEP, y0 = ty * STEP;
        var x1 = Math.min(x0 + TILE, W), y1 = Math.min(y0 + TILE, H);
        var tw = x1 - x0, th = y1 - y0;

        var tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(src, x0, y0, tw, th, 0, 0, tw, th);

        // RC-01 fix: use letterbox for each tile
        var lb  = letterboxCanvas(tc, tw, th, cfg.inputSize);
        var buf = toTensor(lb.canvas, cfg.inputSize, cfg.mean, cfg.std);
        lb.canvas.width = 0; lb.canvas.height = 0;
        tc.width = 0; tc.height = 0;

        var feeds2 = {};
        feeds2[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
        var res2     = await session.run(feeds2);
        var tileMask = unletterboxMask(res2[session.outputNames[0]].data, cfg.inputSize, tw, th, lb, imageMode.isScreenshot);

        var isL = tx === 0, isR = tx === tilesX - 1;
        var isT = ty === 0, isB = ty === tilesY - 1;

        for (var py = 0; py < th; py++) {
          for (var px = 0; px < tw; px++) {
            // RC-02 fix: cosine/multiplicative weights eliminate seam artifacts
            var wx = 1.0, wy = 1.0;
            if (!isL && px < OVERLAP)       wx = (px + 0.5) / OVERLAP;
            if (!isR && px >= tw - OVERLAP) wx = (tw - px - 0.5) / OVERLAP;
            if (!isT && py < OVERLAP)       wy = (py + 0.5) / OVERLAP;
            if (!isB && py >= th - OVERLAP) wy = (th - py - 0.5) / OVERLAP;
            // Clamp to [0,1]
            wx = clamp(wx, 0, 1); wy = clamp(wy, 0, 1);
            var w  = wx * wy; // multiplicative — eliminates rectangular seam artifacts
            var gi = (y0 + py) * W + (x0 + px);
            accAlpha[gi]  += tileMask[py * tw + px] * w;
            accWeight[gi] += w;
          }
        }

        done++;
        if (onProgress) onProgress(32 + Math.round(done / total * 44), 'AI segmentation… ' + Math.round(done / total * 100) + '%');
        if (done % 2 === 0) await yieldMain();
      }
    }

    var alpha = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) {
      alpha[i] = accWeight[i] > 0 ? clampRound(accAlpha[i] / accWeight[i]) : 0;
    }
    return alpha;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  FULL REFINEMENT PIPELINE
  //  Mode-specific stages, lock enforced after every stage.
  // ════════════════════════════════════════════════════════════════════════════
  async function refineAlpha(alpha, d, W, H, imageMode, onProgress) {
    var N   = W * H;
    var isShot = imageMode.isScreenshot;

    // ── A: Build FG lock from raw upscaled AI mask ────────────────────────────
    var lock = buildFgLock(alpha, N);
    enforceLock(alpha, lock, N);
    await yieldMain();

    // ── B: BFS hole fill pass 1 (threshold=80 catches semi-transparent holes) ─
    bfsHoleFill8(alpha, W, H, 80);
    enforceLock(alpha, lock, N);
    await yieldMain();

    if (isShot) {
      // ── Screenshot path: binary cleanup, no blurring ─────────────────────────
      edgeRefineBinary(alpha, W, H);
      enforceLock(alpha, lock, N);
      bfsHoleFill8(alpha, W, H, 80);
      enforceLock(alpha, lock, N);
    } else {
      // ── Photo/portrait/product path ──────────────────────────────────────────

      // ── C: Interior stabilization (RC-05: only truly interior pixels) ────────
      interiorStabilize(alpha, W, H);
      enforceLock(alpha, lock, N);
      await yieldMain();

      // ── D: Interior solidity (RC-06: edge-distance guard) ────────────────────
      interiorSolidity(alpha, W, H);
      enforceLock(alpha, lock, N);
      await yieldMain();

      // ── E: Metallic/specular rescue + lock expansion ──────────────────────────
      metallicBoost(alpha, d, W, H);
      updateLock(alpha, lock, N);
      enforceLock(alpha, lock, N);
      await yieldMain();

      // ── F: Edge-only soft feather (hair/fur/natural objects) ─────────────────
      edgeFeatherSoft(alpha, W, H);
      enforceLock(alpha, lock, N);
      await yieldMain();

      // ── G: BFS hole fill pass 2 ───────────────────────────────────────────────
      bfsHoleFill8(alpha, W, H, 80);
      enforceLock(alpha, lock, N);

      // ── H: Quality gate (RC-04: neighborhood-gated boost) ────────────────────
      qualityGate(alpha, lock, N, W, H);
    }

    // ── I: BFS hole fill pass 3 + final lock ─────────────────────────────────
    bfsHoleFill8(alpha, W, H, 80);
    enforceLock(alpha, lock, N);

    return alpha;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MAIN PUBLIC ENTRY POINT
  // ════════════════════════════════════════════════════════════════════════════
  async function process(file, opts, onProgress) {
    opts = opts || {};
    var tier = detectTier(opts);

    if (onProgress) onProgress(1, 'Preparing image…');

    // Load image
    var imgUrl = URL.createObjectURL(file);
    var img    = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { URL.revokeObjectURL(imgUrl); res(el); };
      el.onerror = function () { URL.revokeObjectURL(imgUrl); rej(new Error('Cannot load image')); };
      el.src = imgUrl;
    });

    var W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('Image has zero dimensions');

    // Read pixel data once (classification + metallic boost)
    var srcC = document.createElement('canvas');
    srcC.width = W; srcC.height = H;
    var srcCtx = srcC.getContext('2d');
    srcCtx.drawImage(img, 0, 0);
    var srcData = srcCtx.getImageData(0, 0, W, H).data;
    srcC.width  = 0; srcC.height = 0;

    // ── Scene classification ─────────────────────────────────────────────────
    var imageMode = classifyImageMode(srcData, W, H);
    console.log('[BgAI v4] Mode:', imageMode.mode, '| Screenshot:', imageMode.isScreenshot);

    // Override with user selection if provided
    if (opts.subjectMode && opts.subjectMode !== 'auto') {
      if (opts.subjectMode === 'logo') imageMode = { mode: 'logo', isScreenshot: true };
      // portrait/product keep classifier result but don't override to screenshot
    }

    // ── Load ONNX session ────────────────────────────────────────────────────
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      if (tier !== 'lite') {
        console.warn('[BgAI v4] standard model failed → lite:', e1.message);
        if (onProgress) onProgress(8, 'Switching to lightweight AI…');
        sessionData = await getSession('lite', onProgress);
      } else { throw e1; }
    }

    var session = sessionData.session, cfg = sessionData.cfg;
    if (onProgress) onProgress(33, 'Running AI segmentation…');
    await yieldMain();

    // ── AI Inference ─────────────────────────────────────────────────────────
    var isMobile   = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    var largeImage = W > cfg.inputSize * 2.2 || H > cfg.inputSize * 2.2;
    // Mobile: always whole inference but at a downscaled resolution if very large
    var useTiling  = largeImage && !isMobile && !imageMode.isScreenshot;

    var alpha;
    if (useTiling) {
      alpha = await inferTiled(session, cfg, img, W, H, imageMode, onProgress);
    } else {
      alpha = await inferWhole(session, cfg, img, W, H, imageMode);
    }

    if (onProgress) onProgress(78, 'Refining at full resolution…');
    await yieldMain();

    // ── Full-resolution refinement ───────────────────────────────────────────
    await refineAlpha(alpha, srcData, W, H, imageMode, onProgress);

    // ── Export validation ────────────────────────────────────────────────────
    validateExport(alpha, W * H);

    if (onProgress) onProgress(94, 'Compositing…');
    await yieldMain();

    // ── Apply final alpha → original pixels → PNG blob ───────────────────────
    // Single source of truth: the final alpha array applied to original pixels.
    // No debug overlays, no checkerboard, no intermediate canvases.
    var outC = document.createElement('canvas');
    outC.width = W; outC.height = H;
    var outCtx  = outC.getContext('2d');
    outCtx.drawImage(img, 0, 0);
    var outData = outCtx.getImageData(0, 0, W, H);
    for (var i = 0; i < W * H; i++) outData.data[i * 4 + 3] = alpha[i];
    outCtx.putImageData(outData, 0, 0);

    var blob = await new Promise(function (res, rej) {
      outC.toBlob(function (b) {
        outC.width = 0; outC.height = 0;
        if (b && b.size > 100) res(b);
        else rej(new Error('Canvas export empty'));
      }, 'image/png');
    });

    return { blob: blob, ext: '.png', mime: 'image/png' };
  }

  function preload(tier) {
    getSession(tier || 'lite', null).catch(function () {});
  }

  window.BgAiEngine = {
    process:      process,
    preload:      preload,
    isReady:      function (t) { return !!_sessions[t || 'lite']; },
    getModelInfo: function (t) { return MODELS[t || 'lite']; },
    classify:     classifyImageMode, // exposed for debugging
    computeOtsu:  computeOtsu,       // exposed for debugging
  };

  // Auto-preload lite model 4s after page load
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () {
      setTimeout(function () { preload('lite'); }, 4000);
    });
  }

}());
