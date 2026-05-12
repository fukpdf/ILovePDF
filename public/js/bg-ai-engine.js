// Background Removal AI Engine v2.0
// ONNX Runtime Web — fully browser-side, no server, no cloud.
//
// Pipeline (correct order):
//   1.  Load image at original resolution
//   2.  Run AI inference at model input size (320 or 1024)
//   3.  Upscale raw mask to original resolution (bilinear + contour sharpen)
//   4.  Snapshot foreground lock from raw upscaled mask
//   5.  BFS hole-fill  (border-reachable transparent → background; interior transparent → foreground)
//   6.  Alpha stabilisation  (5×5 neighbourhood pull-up for weak FG pixels)
//   7.  Metallic / low-contrast / specular rescue
//   8.  Edge-ONLY feathering  (3×3 weighted, only true-edge pixels touched)
//   9.  Apply foreground lock  (max(refined, lockFloor) — lock always wins)
//   10. Second BFS hole-fill  (catch any holes reopened by feathering)
//   11. Quality assertion  (if >22 % of FG pixels are weak, auto-boost and re-lock)
//   12. Full-res compositing → PNG export
//
// window.BgAiEngine.process(file, opts, onProgress) → Promise<{blob,ext,mime}>
// window.BgAiEngine.preload(tier)   — background warm-up
// window.BgAiEngine.isReady(tier)   — bool

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
      cacheKey: 'bge_u2netp_v2',
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
      cacheKey: 'bge_rmbg14_q_v2',
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  function yieldMain() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ── Device tier detection ─────────────────────────────────────────────────
  function detectTier(opts) {
    if (opts && opts.qualityMode === 'ultra') return 'standard';
    if (opts && opts.qualityMode === 'lite')  return 'lite';
    var ua      = navigator.userAgent || '';
    var mobile  = /Mobi|Android|iPhone|iPad/i.test(ua);
    var cores   = navigator.hardwareConcurrency || 2;
    var ramGB   = navigator.deviceMemory || 0;
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
      s.onerror = function () { _ortPromise = null; reject(new Error('ORT script load failed')); };
      document.head.appendChild(s);
    });
    return _ortPromise;
  }

  // ── IndexedDB model cache ─────────────────────────────────────────────────
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 2);
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

        var reader = resp.body.getReader();
        var chunks = [], received = 0;
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value); received += chunk.value.length;
          if (onProgress && contentLen) {
            onProgress(
              3 + Math.round(received / contentLen * 22),
              'Downloading\u2026 ' + (received / 1048576).toFixed(1) + '\u202fMB\u202f/\u202f' + cfg.sizeMB.toFixed(0) + '\u202fMB'
            );
          }
        }

        var total = 0;
        for (var ci = 0; ci < chunks.length; ci++) total += chunks[ci].length;
        var merged = new Uint8Array(total), off = 0;
        for (var ci2 = 0; ci2 < chunks.length; ci2++) { merged.set(chunks[ci2], off); off += chunks[ci2].length; }
        await cacheSet(cfg.cacheKey, merged.buffer);
        return merged.buffer;
      } catch (e) {
        lastErr = e;
        console.warn('[BgAI] fetch failed from', cfg.urls[ui], ':', e.message);
      }
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
    var providerSets = [['webgl', 'wasm'], ['wasm']];
    for (var pi = 0; pi < providerSets.length; pi++) {
      try {
        session = await ort.InferenceSession.create(modelBuf, {
          executionProviders:     providerSets[pi],
          graphOptimizationLevel: 'all',
          enableCpuMemArena:      false,
          enableMemPattern:       false,
        });
        break;
      } catch (e) { lastErr = e; console.warn('[BgAI] session failed with', providerSets[pi], e.message); }
    }
    if (!session) throw lastErr || new Error('Cannot create ONNX session');
    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ── Image → Float32 NCHW tensor ───────────────────────────────────────────
  function toTensor(src, inputSize, mean, std) {
    var c   = document.createElement('canvas');
    c.width = inputSize; c.height = inputSize;
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, inputSize, inputSize);
    var px  = ctx.getImageData(0, 0, inputSize, inputSize).data;
    c.width = 0; c.height = 0;

    var n   = inputSize * inputSize;
    var buf = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      buf[i]       = (px[i*4]   / 255 - mean[0]) / std[0];
      buf[n   + i] = (px[i*4+1] / 255 - mean[1]) / std[1];
      buf[2*n + i] = (px[i*4+2] / 255 - mean[2]) / std[2];
    }
    return buf;
  }

  // ── STEP 3: Upscale raw AI mask → Uint8Array alpha at W×H ─────────────────
  // Uses canvas bilinear then applies contour sharpening:
  //   pixels clearly FG (>200) pushed higher; clearly BG (<28) pushed lower.
  //   Mid-range (28–200) = genuine edges/hair — left untouched.
  function maskToAlpha(rawMask, maskSize, W, H) {
    // Draw mask to small canvas as grayscale
    var mc   = document.createElement('canvas');
    mc.width = maskSize; mc.height = maskSize;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(maskSize, maskSize);
    var mn   = maskSize * maskSize;
    for (var i = 0; i < mn; i++) {
      var v = clamp(Math.round(rawMask[i] * 255), 0, 255);
      mImg.data[i*4] = mImg.data[i*4+1] = mImg.data[i*4+2] = v;
      mImg.data[i*4+3] = 255;
    }
    mctx.putImageData(mImg, 0, 0);

    // Bilinear upscale to original resolution via canvas
    var oc   = document.createElement('canvas');
    oc.width = W; oc.height = H;
    var octx = oc.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(mc, 0, 0, W, H);
    mc.width = 0; mc.height = 0;

    var pix   = octx.getImageData(0, 0, W, H).data;
    oc.width  = 0; oc.height = 0;

    var N     = W * H;
    var alpha = new Uint8Array(N);

    // Contour sharpening: push extreme values further from the midpoint.
    // This compensates for bilinear blur at the upscale step.
    for (var j = 0; j < N; j++) {
      var a = pix[j * 4];
      if      (a > 200) a = clamp(a + 35, 0, 255); // solid FG → very solid
      else if (a < 28)  a = clamp(a - 20, 0, 255); // solid BG → very transparent
      // 28–200 = genuine transition zone (hair, soft edges) — leave intact
      alpha[j] = a;
    }
    return alpha;
  }

  // ── STEP 4: Snapshot foreground lock ─────────────────────────────────────
  // Call BEFORE any refinement. Returns lockFloor[] per pixel:
  //   raw > 183 (≈72 % confidence) → lock = 245
  //   raw > 158 (≈62 % confidence) → lock = 220
  //   else                          → lock = 0  (no lock)
  function buildFgLock(alpha, N) {
    var lock = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      if      (alpha[i] > 183) lock[i] = 245;
      else if (alpha[i] > 158) lock[i] = 220;
    }
    return lock;
  }

  // ── STEP 5: BFS border-transparent flood-fill ─────────────────────────────
  // Marks every transparent pixel reachable from the image border as "real BG".
  // Any transparent pixel NOT reachable = interior hole → restore to FG.
  function bfsHoleFill(alpha, W, H) {
    var N   = W * H;
    var DX4 = [-1, 1, 0, 0];
    var DY4 = [0, 0, -1, 1];
    var BG_THRESH = 40; // alpha < this is considered transparent/BG

    var reach = new Uint8Array(N);
    var q = [], qi = 0;

    function seed(pi) {
      if (alpha[pi] < BG_THRESH && !reach[pi]) { reach[pi] = 1; q.push(pi); }
    }
    // Seed from all four borders
    for (var x = 0; x < W; x++) { seed(x); seed((H-1)*W + x); }
    for (var y = 1; y < H-1; y++) { seed(y*W); seed(y*W + W-1); }

    // BFS from border
    while (qi < q.length) {
      var pi  = q[qi++];
      var px_ = pi % W, py_ = Math.floor(pi / W);
      for (var di = 0; di < 4; di++) {
        var nx_ = px_ + DX4[di], ny_ = py_ + DY4[di];
        if (nx_ < 0 || nx_ >= W || ny_ < 0 || ny_ >= H) continue;
        var ni = ny_ * W + nx_;
        if (reach[ni] || alpha[ni] >= BG_THRESH) continue;
        reach[ni] = 1; q.push(ni);
      }
    }

    // Interior holes → FG
    for (var i = 0; i < N; i++) {
      if (alpha[i] < BG_THRESH && !reach[i]) alpha[i] = 232;
    }
  }

  // ── STEP 6: Alpha stabilisation (5×5 neighbourhood pull-up) ───────────────
  // For each weak FG pixel (alpha < 150) where the 5×5 window is majority FG:
  //   alpha = alpha * 0.35 + neighbourAvg * 0.65
  // Prevents AI-model uncertainty from washing out solid interiors.
  function alphaStabilize(alpha, W, H) {
    var N    = W * H;
    var out  = new Uint8Array(alpha); // copy; write back after pass
    var R    = 2; // 5×5 window radius
    var WIN  = (2*R+1) * (2*R+1);
    var MAJORITY = Math.ceil(WIN * 0.55); // 55 % of 25 = 14

    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        if (alpha[ci] >= 150 || alpha[ci] < 20) continue; // only weak FG

        var sum = 0, fgCnt = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var na = alpha[(y+dy)*W + (x+dx)];
            sum += na;
            if (na > 200) fgCnt++;
          }
        }

        if (fgCnt >= MAJORITY) {
          var avg  = sum / WIN;
          out[ci]  = clamp(Math.round(alpha[ci] * 0.35 + avg * 0.65), 0, 255);
        }
      }
    }

    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ── STEP 7: Metallic / low-contrast / specular rescue ─────────────────────
  // For each transitional pixel (40–210), examine original image pixel data:
  //   • high local brightness variance  → specular / metallic surface
  //   • high RGB saturation             → colourful object
  //   • AND has an adjacent solid-FG neighbour (alpha > 185)
  // If conditions met → boost alpha floor to 210.
  function metallicBoost(alpha, d, W, H) {
    var R = 2; // 5×5 window

    for (var y = R; y < H - R; y++) {
      for (var x = R; x < W - R; x++) {
        var ci = y * W + x;
        if (alpha[ci] < 40 || alpha[ci] > 210) continue;

        // Check for adjacent solid-FG neighbour (4-connected)
        var hasSolidNeighbour = false;
        if (x > 0     && alpha[ci - 1] > 185) hasSolidNeighbour = true;
        if (x < W-1   && alpha[ci + 1] > 185) hasSolidNeighbour = true;
        if (y > 0     && alpha[ci - W] > 185) hasSolidNeighbour = true;
        if (y < H-1   && alpha[ci + W] > 185) hasSolidNeighbour = true;
        if (!hasSolidNeighbour) continue;

        // Compute local 5×5 brightness variance + average saturation
        var brightSum = 0, brightSqSum = 0, satSum = 0, cnt = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            var pi  = ((y+dy)*W + (x+dx)) * 4;
            var r   = d[pi], g = d[pi+1], b = d[pi+2];
            var br  = (r + g + b) / 3;
            var mx  = Math.max(r, g, b), mn2 = Math.min(r, g, b);
            var sat = mx > 0 ? (mx - mn2) / mx : 0;
            brightSum   += br;
            brightSqSum += br * br;
            satSum      += sat;
            cnt++;
          }
        }
        var brightMean = brightSum / cnt;
        var brightVar  = brightSqSum / cnt - brightMean * brightMean;
        var avgSat     = satSum / cnt;

        // High brightness variance  → specular/metallic
        // High saturation           → coloured object (key, jewellery, electronics)
        if (brightVar > 360 || avgSat > 0.28) {
          alpha[ci] = clamp(Math.max(alpha[ci], 210), 0, 255);
        }
      }
    }
  }

  // ── STEP 8: Edge-ONLY feathering ──────────────────────────────────────────
  // A pixel is an "edge pixel" iff its 3×3 neighbourhood contains
  //   BOTH a solid-FG pixel (>220) AND a solid-BG pixel (<22).
  // Only edge pixels are feathered (3×3 weighted average, centre weight 3).
  // Interior pixels are NEVER touched.
  function edgeFeather(alpha, W, H) {
    var N   = W * H;
    var out = new Uint8Array(alpha);

    for (var y = 1; y < H-1; y++) {
      for (var x = 1; x < W-1; x++) {
        var ci = y * W + x;
        var av = alpha[ci];
        if (av < 15 || av > 240) continue; // already solid FG or BG — skip

        var hasFg = false, hasBg = false;
        for (var dy = -1; dy <= 1 && !(hasFg && hasBg); dy++) {
          for (var dx = -1; dx <= 1 && !(hasFg && hasBg); dx++) {
            var na = alpha[(y+dy)*W + (x+dx)];
            if (na > 220) hasFg = true;
            if (na < 22)  hasBg = true;
          }
        }
        if (!hasFg || !hasBg) continue; // not an edge pixel — skip

        // 3×3 weighted feather (centre weight = 3)
        var sum = 0, wt = 0;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            var w2 = (dx2 === 0 && dy2 === 0) ? 3 : 1;
            sum += alpha[(y+dy2)*W + (x+dx2)] * w2; wt += w2;
          }
        }
        out[ci] = clamp(Math.round(sum / wt), 0, 255);
      }
    }

    for (var i = 0; i < N; i++) alpha[i] = out[i];
  }

  // ── STEP 9: Apply foreground lock ─────────────────────────────────────────
  // Ensures that pixels locked at step 4 can NEVER have their alpha
  // reduced below the lock floor by any refinement stage.
  function applyFgLock(alpha, lock, N) {
    for (var i = 0; i < N; i++) {
      if (lock[i] > 0 && alpha[i] < lock[i]) alpha[i] = lock[i];
    }
  }

  // ── STEP 11: Quality assertion + auto-boost ────────────────────────────────
  // If more than 22 % of foreground pixels (alpha > 80) have alpha < 170,
  // the result is "weak" — apply a targeted boost pass and re-lock.
  function qualityAssert(alpha, lock, N) {
    var fgCount   = 0, weakCount = 0;
    for (var i = 0; i < N; i++) {
      if (alpha[i] > 80) {
        fgCount++;
        if (alpha[i] < 170) weakCount++;
      }
    }
    if (fgCount === 0) return;

    var weakRatio = weakCount / fgCount;
    if (weakRatio <= 0.22) return; // quality OK

    console.log('[BgAI] Quality assertion triggered: ' + Math.round(weakRatio * 100) + '% weak FG — boosting');

    for (var j = 0; j < N; j++) {
      if (alpha[j] > 80 && alpha[j] < 170) {
        alpha[j] = clamp(alpha[j] + 65, 0, 255);
      }
    }

    // Re-apply lock after boost
    applyFgLock(alpha, lock, N);
  }

  // ── Full refinement pipeline ──────────────────────────────────────────────
  // Runs all CV post-processing phases in the correct order.
  // alpha is modified in-place.
  async function refineAlpha(alpha, d, W, H, onProgress) {
    var N = W * H;

    // Phase 4a: Snapshot foreground lock before ANY refinement
    var lock = buildFgLock(alpha, N);

    // Phase 4b: BFS hole-fill (first pass)
    bfsHoleFill(alpha, W, H);
    await yieldMain();

    // Phase 3: Alpha stabilisation (5×5 pull-up for weak FG inside solid FG)
    alphaStabilize(alpha, W, H);
    await yieldMain();

    // Phase 6: Metallic / specular rescue
    metallicBoost(alpha, d, W, H);
    await yieldMain();

    // Phase 5: Edge-only feathering (interior pixels never touched)
    edgeFeather(alpha, W, H);
    await yieldMain();

    // Phase 1: Apply foreground lock — lock wins against ALL above
    applyFgLock(alpha, lock, N);

    // Phase 4c: Second BFS hole-fill (catch any holes reopened by feathering)
    bfsHoleFill(alpha, W, H);

    // Phase 9: Quality assertion
    qualityAssert(alpha, lock, N);

    return alpha;
  }

  // ── Whole-image inference ─────────────────────────────────────────────────
  async function inferWhole(session, cfg, src, W, H) {
    var buf   = toTensor(src, cfg.inputSize, cfg.mean, cfg.std);
    var feeds = {};
    feeds[session.inputNames[0]] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);
    var results = await session.run(feeds);
    return maskToAlpha(results[session.outputNames[0]].data, cfg.inputSize, W, H);
  }

  // ── Tiled inference (large images on desktop) ─────────────────────────────
  // Each tile is inferred at model input size and stitched with linear feathering.
  async function inferTiled(session, cfg, src, W, H, onProgress) {
    var TILE    = 640;
    var OVERLAP = clamp(Math.floor(Math.min(W, H) / 8), 48, 120);
    var STEP    = TILE - OVERLAP;

    var tilesX = Math.max(1, Math.ceil((W - OVERLAP) / STEP));
    var tilesY = Math.max(1, Math.ceil((H - OVERLAP) / STEP));
    var total  = tilesX * tilesY, done = 0;

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
        var tileMask = maskToAlpha(res2[session.outputNames[0]].data, cfg.inputSize, tw, th);

        // Accumulate with linear blend weights at overlap zones
        var isL = (tx === 0), isR = (tx === tilesX-1);
        var isT = (ty === 0), isB = (ty === tilesY-1);
        for (var py = 0; py < th; py++) {
          for (var px = 0; px < tw; px++) {
            var wx = 1, wy = 1;
            if (!isL && px < OVERLAP)        wx = px / OVERLAP;
            if (!isR && px >= tw - OVERLAP)  wx = (tw - px) / OVERLAP;
            if (!isT && py < OVERLAP)        wy = py / OVERLAP;
            if (!isB && py >= th - OVERLAP)  wy = (th - py) / OVERLAP;
            var w  = Math.min(wx, wy);
            var gi = (y0 + py) * W + (x0 + px);
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

    // Load original image at full resolution
    var imgUrl = URL.createObjectURL(file);
    var img = await new Promise(function (res, rej) {
      var el = new Image();
      el.onload  = function () { URL.revokeObjectURL(imgUrl); res(el); };
      el.onerror = function () { URL.revokeObjectURL(imgUrl); rej(new Error('Cannot load image')); };
      el.src = imgUrl;
    });

    var W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('Image has zero dimensions');

    // ── Load ONNX session ────────────────────────────────────────────────────
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      if (tier !== 'lite') {
        console.warn('[BgAI] standard model failed, trying lite:', e1.message);
        if (onProgress) onProgress(8, 'Switching to lightweight AI\u2026');
        sessionData = await getSession('lite', onProgress);
      } else { throw e1; }
    }

    var session = sessionData.session, cfg = sessionData.cfg;

    if (onProgress) onProgress(33, 'Running AI segmentation\u2026');
    await yieldMain();

    // ── Inference ────────────────────────────────────────────────────────────
    // Tile large images on desktop; whole-image on mobile (lite model).
    var isMobile   = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    var largeImage = W > cfg.inputSize * 2.5 || H > cfg.inputSize * 2.5;
    var useTiling  = largeImage && !isMobile;

    var alpha;
    if (useTiling) {
      alpha = await inferTiled(session, cfg, img, W, H, onProgress);
    } else {
      alpha = await inferWhole(session, cfg, img, W, H);
    }

    if (onProgress) onProgress(78, 'Refining at full resolution\u2026');
    await yieldMain();

    // ── CV refinement at full original resolution ────────────────────────────
    // Read original image pixels once (needed for metallic boost)
    var origC = document.createElement('canvas');
    origC.width = W; origC.height = H;
    origC.getContext('2d').drawImage(img, 0, 0);
    var imgData = origC.getContext('2d').getImageData(0, 0, W, H).data;
    origC.width = 0; origC.height = 0;

    // Run all refinement phases (modifies alpha in-place)
    await refineAlpha(alpha, imgData, W, H, onProgress);

    if (onProgress) onProgress(93, 'Compositing\u2026');
    await yieldMain();

    // ── Apply alpha to original image pixels → PNG blob ───────────────────────
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

  // Auto-preload lite model 4 s after page is fully loaded (non-blocking)
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () { setTimeout(function () { preload('lite'); }, 4000); });
  }

}());
