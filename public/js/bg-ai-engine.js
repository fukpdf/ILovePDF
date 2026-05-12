// Background Removal AI Engine v3.0
// ONNX Runtime Web — fully browser-side, no server, no cloud API.
//
// Key fixes over v2.0:
//   • Lock is enforced after EVERY refinement stage (not just at the end)
//   • Lock is expanded after boost passes (captures newly-rescued pixels)
//   • 8-connected BFS — no diagonal leaks
//   • Stronger lock tiers: >210→255, >170→235, >140→210
//   • Screenshot / UI image mode detection → hard-contour path
//   • Body-solidity pass (7×7 interior density)
//   • Quality assertion gate at 18 % (was 22 %)
//   • Zero debug/overlay code — export canvas contains ONLY the final RGBA
//
// Pipeline order:
//   1.  Load image at original resolution
//   2.  Detect screenshot / UI mode from pixel statistics
//   3.  AI inference at model resolution
//   4.  maskToAlpha — bilinear upscale → contour-sharpen → full-res Uint8Array
//   5.  buildFgLock — snapshot 3-tier lock from raw upscaled alpha
//   6.  enforceLock (pass 0)
//   7.  bfsHoleFill8 (pass 1)  → enforceLock
//   8.  alphaStabilize  5×5    → enforceLock
//   9.  bodySolidity    7×7    → enforceLock
//  10.  metallicBoost          → updateLock → enforceLock
//  11.  edgeFeather (adaptive) → enforceLock
//  12.  bfsHoleFill8 (pass 2)  → enforceLock
//  13.  qualityAssert (18%)    → enforceLock
//  14.  bfsHoleFill8 (pass 3)  → enforceLock (final)
//  15.  Full-res compositing → PNG blob export

(function () {
  'use strict';

  // ── CDN constants ──────────────────────────────────────────────────────────
  var ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js';
  var ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

  // ── Model registry ─────────────────────────────────────────────────────────
  var MODELS = {
    lite: {
      name: 'U2Net-Lite',
      urls: [
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/u2netp.onnx',
      ],
      cacheKey: 'bge_u2netp_v3',
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
      cacheKey: 'bge_rmbg14_q_v3',
      inputSize: 1024,
      mean: [0.5, 0.5, 0.5],
      std:  [1.0, 1.0, 1.0],
      sizeMB: 44,
    },
  };

  // ── Module-level state ────────────────────────────────────────────────────
  var _sessions   = {};
  var _ortReady   = false;
  var _ortPromise = null;

  // ── Micro helpers ─────────────────────────────────────────────────────────
  function yieldMain() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ── Device tier detection ─────────────────────────────────────────────────
  function detectTier(opts) {
    if (opts && opts.qualityMode === 'ultra') return 'standard';
    if (opts && opts.qualityMode === 'lite')  return 'lite';
    var ua     = navigator.userAgent || '';
    var mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    var cores  = navigator.hardwareConcurrency || 2;
    var ramGB  = navigator.deviceMemory || 0;
    if (mobile || cores <= 2 || (ramGB > 0 && ramGB < 3)) return 'lite';
    return 'standard';
  }

  // ── ONNX Runtime loader ───────────────────────────────────────────────────
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

  // ── IndexedDB model cache ─────────────────────────────────────────────────
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 3);
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

  // ── Model downloader with streaming progress ──────────────────────────────
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
            onProgress(
              3 + Math.round(received / contentLen * 22),
              'Downloading\u2026 ' + (received / 1048576).toFixed(1) +
              '\u202fMB\u202f/\u202f' + cfg.sizeMB.toFixed(0) + '\u202fMB'
            );
          }
        }
        var total = 0;
        for (var ci = 0; ci < chunks.length; ci++) total += chunks[ci].length;
        var merged = new Uint8Array(total), off = 0;
        for (var ci2 = 0; ci2 < chunks.length; ci2++) { merged.set(chunks[ci2], off); off += chunks[ci2].length; }
        await cacheSet(cfg.cacheKey, merged.buffer);
        return merged.buffer;
      } catch (e) { lastErr = e; console.warn('[BgAI] fetch failed:', cfg.urls[ui], e.message); }
    }
    throw lastErr || new Error('All model URLs failed');
  }

  // ── ONNX session factory ──────────────────────────────────────────────────
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
      } catch (e) { lastErr = e; console.warn('[BgAI] session failed:', provSets[pi], e.message); }
    }
    if (!session) throw lastErr || new Error('Cannot create ONNX session');
    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ── Image → Float32 NCHW tensor ───────────────────────────────────────────
  function toTensor(src, inputSize, mean, std) {
    var c = document.createElement('canvas');
    c.width = inputSize; c.height = inputSize;
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, inputSize, inputSize);
    var px = ctx.getImageData(0, 0, inputSize, inputSize).data;
    c.width = 0; c.height = 0;
    var n = inputSize * inputSize;
    var buf = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      buf[i]       = (px[i*4]   / 255 - mean[0]) / std[0];
      buf[n   + i] = (px[i*4+1] / 255 - mean[1]) / std[1];
      buf[2*n + i] = (px[i*4+2] / 255 - mean[2]) / std[2];
    }
    return buf;
  }

  // ── PHASE 1: Screenshot / UI mode detection ───────────────────────────────
  // Samples ~2000 evenly-spaced pixels. Computes average local brightness
  // variance (5×5 window) and "flat region" ratio.
  // High flat ratio + significant sharp edges → screenshot/UI mode.
  // In screenshot mode: feathering is disabled, sharpening bias is +50.
  function detectScreenshotMode(d, W, H) {
    var step = Math.max(3, Math.round(Math.sqrt(W * H / 1500)));
    var flatCount = 0, edgeCount = 0, total = 0;
    for (var y = 2; y < H - 2; y += step) {
      for (var x = 2; x < W - 2; x += step) {
        var lsum = 0, lsq = 0;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var j4 = ((y + dy) * W + (x + dx)) * 4;
            var br = (d[j4] + d[j4+1] + d[j4+2]) / 3;
            lsum += br; lsq += br * br;
          }
        }
        var lmean = lsum / 25;
        var lvar  = lsq / 25 - lmean * lmean;
        if (lvar < 150) flatCount++;   // very flat (UI block, solid bg)
        if (lvar > 1800) edgeCount++;  // sharp contrast (text, icon edge)
        total++;
      }
    }
    if (!total) return false;
    // Screenshot: majority of image is flat BUT there are sharp text/icon edges
    return (flatCount / total > 0.50) && (edgeCount / total > 0.06);
  }

  // ── PHASE 2: Upscale AI mask to full resolution + contour sharpening ──────
  // Bilinear upscale via canvas (high quality), then push extreme values
  // further from mid-point to compensate for bilinear blur.
  // screenshotMode uses a stronger sharpening bias (+50 vs +35).
  function maskToAlpha(rawMask, maskSize, W, H, screenshotMode) {
    var mn = maskSize * maskSize;
    var mc = document.createElement('canvas');
    mc.width = maskSize; mc.height = maskSize;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(maskSize, maskSize);
    for (var i = 0; i < mn; i++) {
      var v = clamp(Math.round(rawMask[i] * 255), 0, 255);
      mImg.data[i*4] = mImg.data[i*4+1] = mImg.data[i*4+2] = v;
      mImg.data[i*4+3] = 255;
    }
    mctx.putImageData(mImg, 0, 0);

    var oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    var octx = oc.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(mc, 0, 0, W, H);
    mc.width = 0; mc.height = 0;

    var pix = octx.getImageData(0, 0, W, H).data;
    oc.width = 0; oc.height = 0;

    var N = W * H;
    var alpha = new Uint8Array(N);
    // Contour sharpening: push clearly-FG and clearly-BG further from midpoint.
    // Screenshot mode uses a harder push (+50/−25) to preserve hard edges.
    var fgPush = screenshotMode ? 50 : 35;
    var bgPull = screenshotMode ? 25 : 20;
    for (var j = 0; j < N; j++) {
      var a = pix[j * 4];
      if      (a > 200) a = clamp(a + fgPush, 0, 255);
      else if (a < 28)  a = clamp(a - bgPull, 0, 255);
      // 28–200: genuine transitions (hair, soft edges) — leave untouched
      alpha[j] = a;
    }
    return alpha;
  }

  // ── PHASE 3 (lock infrastructure) ────────────────────────────────────────
  // buildFgLock: snapshot a 3-tier hard lock from the raw upscaled mask.
  //   rawAlpha > 210  →  lock = 255   (solid FG, never reduces)
  //   rawAlpha > 170  →  lock = 235   (confident FG)
  //   rawAlpha > 140  →  lock = 210   (probable FG)
  function buildFgLock(alpha, N) {
    var lock = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 210) lock[i] = 255;
      else if (a > 170) lock[i] = 235;
      else if (a > 140) lock[i] = 210;
    }
    return lock;
  }

  // enforceLock: called after EVERY stage — lock always wins.
  function enforceLock(alpha, lock, N) {
    for (var i = 0; i < N; i++) {
      if (lock[i] && alpha[i] < lock[i]) alpha[i] = lock[i];
    }
  }

  // updateLock: after boost passes, expand the lock to capture newly-rescued
  // pixels so the subsequent feathering pass cannot reduce them.
  function updateLock(alpha, lock, N) {
    for (var i = 0; i < N; i++) {
      var a = alpha[i];
      if      (a > 210 && lock[i] < 255) lock[i] = 255;
      else if (a > 175 && lock[i] < 235) lock[i] = 235;
      else if (a > 148 && lock[i] < 210) lock[i] = 210;
    }
  }

  // ── PHASE 4: 8-connected BFS hole-fill ───────────────────────────────────
  // Seeds from all four image borders. Marks every transparent pixel
  // reachable (via 8-connectivity) from the border as real background.
  // Any transparent pixel NOT reachable = interior hole → becomes foreground.
  // Minimum alpha for restored holes: 220.
  function bfsHoleFill8(alpha, W, H) {
    var N   = W * H;
    var DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    var DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    var BG  = 38; // alpha < this → transparent / background

    var reach = new Uint8Array(N);
    var q     = [], qi = 0;

    function seed(pi) {
      if (alpha[pi] < BG && !reach[pi]) { reach[pi] = 1; q.push(pi); }
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
        if (reach[ni] || alpha[ni] >= BG) continue;
        reach[ni] = 1; q.push(ni);
      }
    }
    // Interior holes → solid foreground (minimum 220)
    for (var i = 0; i < N; i++) {
      if (alpha[i] < BG && !reach[i]) alpha[i] = 220;
    }
  }

  // ── PHASE 5: Alpha stabilisation — 5×5 neighbourhood pull-up ─────────────
  // For each weak-FG pixel (alpha 20–149): if ≥55 % of its 5×5 window
  // has alpha > 200, pull it upward: alpha = 0.35·self + 0.65·windowAvg.
  // Prevents AI uncertainty from washing out solid subject interiors.
  // In screenshot mode this pass is skipped (hard edges must stay hard).
  function alphaStabilize(alpha, W, H, screenshotMode) {
    if (screenshotMode) return;
    var N   = W * H;
    var out = new Uint8Array(alpha);
    var R   = 2; // radius → 5×5 window
    var WIN = 25;
    var MAJ = 14; // ≥55 % of 25

    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av >= 150 || av < 20) continue; // only weak FG

        var sum = 0, fgCnt = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var na = alpha[(y + dy) * W + (x + dx)];
            sum += na;
            if (na > 200) fgCnt++;
          }
        }
        if (fgCnt >= MAJ) {
          out[ci] = clamp(Math.round(av * 0.35 + (sum / WIN) * 0.65), 0, 255);
        }
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ── PHASE 6: Body solidity pass — 7×7 interior density ───────────────────
  // For each pixel with alpha in [65, 175]: examine its 7×7 neighbourhood.
  // If ≥65 % of those 49 pixels have alpha > 195, this pixel is inside the
  // subject's body — boost it proportionally toward 230.
  // Specifically rescues human torso, clothing, arms, product bodies.
  function bodySolidity(alpha, W, H, screenshotMode) {
    var N   = W * H;
    var out = new Uint8Array(alpha);
    var R   = 3; // radius → 7×7 window
    var WIN = 49;
    var THR = Math.ceil(WIN * 0.65); // ≥65 % = 32

    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av < 65 || av > 175) continue;

        var sum = 0, fgCnt = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var na = alpha[(y + dy) * W + (x + dx)];
            sum += na;
            if (na > 195) fgCnt++;
          }
        }
        if (fgCnt >= THR) {
          // Pull toward neighbourhood average, minimum result 175
          var target = clamp(Math.round(av * 0.25 + (sum / WIN) * 0.75), 0, 255);
          out[ci] = Math.max(target, 175);
        }
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ── PHASE 7: Metallic / specular / low-contrast rescue ────────────────────
  // For transitional pixels (40–210) adjacent to solid FG:
  //   • high local brightness variance → specular / metallic surface
  //   • high average saturation        → coloured objects (keys, jewellery)
  // Either condition → boost alpha floor to 210.
  function metallicBoost(alpha, d, W, H) {
    var R = 2; // 5×5 window
    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        if (alpha[ci] < 40 || alpha[ci] > 210) continue;

        // Must have at least one solid-FG neighbour
        var hasSolid = (
          (x > 0   && alpha[ci - 1] > 185) ||
          (x < W-1 && alpha[ci + 1] > 185) ||
          (y > 0   && alpha[ci - W] > 185) ||
          (y < H-1 && alpha[ci + W] > 185)
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
        if (bvar > 360 || asat > 0.28) {
          alpha[ci] = clamp(Math.max(alpha[ci], 210), 0, 255);
        }
      }
    }
  }

  // ── PHASE 8: Edge-ONLY feathering ─────────────────────────────────────────
  // A pixel is featherable iff its 3×3 neighbourhood contains BOTH:
  //   a solid-FG pixel (> fgThresh) AND a solid-BG pixel (< bgThresh).
  // Only qualifying edge pixels receive the 3×3 weighted average.
  // Interior pixels are NEVER touched. Radius is adaptive.
  // In screenshot mode: feathering is completely skipped.
  function edgeFeather(alpha, W, H, screenshotMode) {
    if (screenshotMode) return; // hard contours — no blurring at all

    var N      = W * H;
    var out    = new Uint8Array(alpha);
    var FG_THR = 222; // must see a pixel THIS solid to qualify as edge
    var BG_THR = 18;  // must see a pixel THIS transparent to qualify as edge

    for (var y = 1; y < H - 1; y++) {
      for (var x = 1; x < W - 1; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av < 15 || av > 242) continue; // already solid — skip

        var hasFg = false, hasBg = false;
        for (var dy = -1; dy <= 1 && !(hasFg && hasBg); dy++) {
          for (var dx = -1; dx <= 1 && !(hasFg && hasBg); dx++) {
            var na = alpha[(y + dy) * W + (x + dx)];
            if (na > FG_THR) hasFg = true;
            if (na < BG_THR)  hasBg = true;
          }
        }
        if (!hasFg || !hasBg) continue; // not a true edge — skip

        // 3×3 weighted average (centre weight = 4 for conservative blend)
        var sum = 0, wt = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            var w = (dx2 === 0 && dy2 === 0) ? 4 : 1;
            sum += alpha[(y + dy2) * W + (x + dx2)] * w; wt += w;
          }
        }
        out[ci] = clamp(Math.round(sum / wt), 0, 255);
      }
    }
    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ── PHASE 9: Quality assertion gate ──────────────────────────────────────
  // If more than 18 % of foreground pixels (alpha > 75) have alpha < 170,
  // the result is "weak" — apply a targeted +70 boost, then re-lock.
  function qualityAssert(alpha, lock, N) {
    var fgCnt = 0, weakCnt = 0;
    for (var i = 0; i < N; i++) {
      if (alpha[i] > 75) {
        fgCnt++;
        if (alpha[i] < 170) weakCnt++;
      }
    }
    if (!fgCnt) return;
    if (weakCnt / fgCnt <= 0.18) return; // quality OK

    console.log('[BgAI v3] Quality gate: ' + Math.round(weakCnt / fgCnt * 100) + '% weak FG — auto-boost');
    for (var j = 0; j < N; j++) {
      if (alpha[j] > 75 && alpha[j] < 170) alpha[j] = clamp(alpha[j] + 70, 0, 255);
    }
    enforceLock(alpha, lock, N);
  }

  // ── Complete refinement pipeline ──────────────────────────────────────────
  // All stages run at original full resolution.
  // Lock is enforced after EVERY stage — nothing can reduce a locked pixel.
  async function refineAlpha(alpha, d, W, H, screenshotMode, onProgress) {
    var N = W * H;

    // ── Step A: Snapshot initial FG lock from raw upscaled AI mask ──────────
    var lock = buildFgLock(alpha, N);
    enforceLock(alpha, lock, N);           // pass 0 — ensure raw mask is already locked

    // ── Step B: BFS hole-fill pass 1 ────────────────────────────────────────
    bfsHoleFill8(alpha, W, H);
    enforceLock(alpha, lock, N);
    await yieldMain();

    // ── Step C: Alpha stabilisation (5×5 pull-up, skipped in screenshot mode)
    alphaStabilize(alpha, W, H, screenshotMode);
    enforceLock(alpha, lock, N);
    await yieldMain();

    // ── Step D: Body solidity (7×7 interior density boost) ──────────────────
    bodySolidity(alpha, W, H, screenshotMode);
    enforceLock(alpha, lock, N);
    await yieldMain();

    // ── Step E: Metallic / specular rescue ───────────────────────────────────
    metallicBoost(alpha, d, W, H);
    // After boost passes: expand the lock to include newly-rescued pixels
    // so that the following feathering pass cannot reduce them.
    updateLock(alpha, lock, N);
    enforceLock(alpha, lock, N);
    await yieldMain();

    // ── Step F: Edge-ONLY feathering (skipped in screenshot mode) ───────────
    edgeFeather(alpha, W, H, screenshotMode);
    enforceLock(alpha, lock, N);           // lock re-applied immediately after feather
    await yieldMain();

    // ── Step G: BFS hole-fill pass 2 (feathering can reopen tiny holes) ─────
    bfsHoleFill8(alpha, W, H);
    enforceLock(alpha, lock, N);

    // ── Step H: Quality assertion gate (18 % threshold) ─────────────────────
    qualityAssert(alpha, lock, N);

    // ── Step I: BFS hole-fill pass 3 + final lock (pre-export) ──────────────
    bfsHoleFill8(alpha, W, H);
    enforceLock(alpha, lock, N);

    return alpha;
  }

  // ── Whole-image inference ─────────────────────────────────────────────────
  async function inferWhole(session, cfg, src, W, H, screenshotMode) {
    var buf   = toTensor(src, cfg.inputSize, cfg.mean, cfg.std);
    var feeds = {};
    feeds[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
    var results = await session.run(feeds);
    return maskToAlpha(results[session.outputNames[0]].data, cfg.inputSize, W, H, screenshotMode);
  }

  // ── Tiled inference (large images, desktop) ───────────────────────────────
  async function inferTiled(session, cfg, src, W, H, screenshotMode, onProgress) {
    var TILE    = 640;
    var OVERLAP = clamp(Math.floor(Math.min(W, H) / 8), 48, 120);
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
        var tileBuf = toTensor(tc, cfg.inputSize, cfg.mean, cfg.std);
        tc.width = 0; tc.height = 0;

        var feeds2 = {};
        feeds2[session.inputNames[0]] = new window.ort.Tensor('float32', tileBuf, [1, 3, cfg.inputSize, cfg.inputSize]);
        var res2     = await session.run(feeds2);
        var tileMask = maskToAlpha(res2[session.outputNames[0]].data, cfg.inputSize, tw, th, screenshotMode);

        var isL = tx === 0, isR = tx === tilesX - 1;
        var isT = ty === 0, isB = ty === tilesY - 1;
        for (var py = 0; py < th; py++) {
          for (var px = 0; px < tw; px++) {
            var wx = 1, wy = 1;
            if (!isL && px < OVERLAP)       wx = px / OVERLAP;
            if (!isR && px >= tw - OVERLAP) wx = (tw - px) / OVERLAP;
            if (!isT && py < OVERLAP)       wy = py / OVERLAP;
            if (!isB && py >= th - OVERLAP) wy = (th - py) / OVERLAP;
            var gi = (y0 + py) * W + (x0 + px);
            var w  = Math.min(wx, wy);
            accAlpha[gi]  += tileMask[py * tw + px] * w;
            accWeight[gi] += w;
          }
        }

        done++;
        if (onProgress) onProgress(30 + Math.round(done / total * 45), 'AI segmentation\u2026 ' + Math.round(done / total * 100) + '%');
        if (done % 2 === 0) await yieldMain();
      }
    }

    var alpha = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) {
      alpha[i] = accWeight[i] > 0 ? clamp(Math.round(accAlpha[i] / accWeight[i]), 0, 255) : 0;
    }
    return alpha;
  }

  // ── Main public entry point ───────────────────────────────────────────────
  async function process(file, opts, onProgress) {
    opts = opts || {};
    var tier = detectTier(opts);

    if (onProgress) onProgress(1, 'Preparing image\u2026');

    // Load original image
    var imgUrl = URL.createObjectURL(file);
    var img = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { URL.revokeObjectURL(imgUrl); res(el); };
      el.onerror = function () { URL.revokeObjectURL(imgUrl); rej(new Error('Cannot load image')); };
      el.src = imgUrl;
    });

    var W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('Image has zero dimensions');

    // Read pixel data once (needed for screenshot detection + metallic boost)
    var srcC = document.createElement('canvas');
    srcC.width = W; srcC.height = H;
    srcC.getContext('2d').drawImage(img, 0, 0);
    var srcData = srcC.getContext('2d').getImageData(0, 0, W, H).data;
    srcC.width  = 0; srcC.height = 0;

    // Detect image type before inference
    var screenshotMode = detectScreenshotMode(srcData, W, H);
    if (screenshotMode) console.log('[BgAI v3] Screenshot/UI mode detected — using hard-contour path');

    // ── Load ONNX session ────────────────────────────────────────────────────
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      if (tier !== 'lite') {
        console.warn('[BgAI] standard model failed, falling back to lite:', e1.message);
        if (onProgress) onProgress(8, 'Switching to lightweight AI\u2026');
        sessionData = await getSession('lite', onProgress);
      } else { throw e1; }
    }

    var session = sessionData.session, cfg = sessionData.cfg;

    if (onProgress) onProgress(33, 'Running AI segmentation\u2026');
    await yieldMain();

    // ── AI Inference ─────────────────────────────────────────────────────────
    var isMobile   = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    var largeImage = W > cfg.inputSize * 2.5 || H > cfg.inputSize * 2.5;
    var useTiling  = largeImage && !isMobile;

    var alpha;
    if (useTiling) {
      alpha = await inferTiled(session, cfg, img, W, H, screenshotMode, onProgress);
    } else {
      alpha = await inferWhole(session, cfg, img, W, H, screenshotMode);
    }

    if (onProgress) onProgress(78, 'Refining at full resolution\u2026');
    await yieldMain();

    // ── Full-resolution CV refinement pipeline ───────────────────────────────
    // (srcData was read before inference — reuse, no second canvas read needed)
    await refineAlpha(alpha, srcData, W, H, screenshotMode, onProgress);

    if (onProgress) onProgress(94, 'Compositing\u2026');
    await yieldMain();

    // ── Apply final alpha → original pixels → PNG blob ───────────────────────
    // The export canvas contains ONLY the final RGBA — no debug, no overlays.
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

  // ── Background preload ────────────────────────────────────────────────────
  function preload(tier) {
    getSession(tier || 'lite', null).catch(function () {});
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.BgAiEngine = {
    process:      process,
    preload:      preload,
    isReady:      function (t) { return !!_sessions[t || 'lite']; },
    getModelInfo: function (t) { return MODELS[t || 'lite']; },
  };

  // Auto-preload lite model 4 s after page load (non-blocking warm-up)
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () {
      setTimeout(function () { preload('lite'); }, 4000);
    });
  }

}());
