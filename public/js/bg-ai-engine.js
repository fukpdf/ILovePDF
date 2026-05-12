// Background Removal AI Engine v1.0
// ONNX Runtime Web — fully browser-side, no server, no cloud.
// Architecture:
//   1. Device-adaptive tier selection  (lite / standard)
//   2. Lazy ORT loading from CDN       (cached in memory)
//   3. Model fetch with progress       (cached in IndexedDB)
//   4. ONNX inference                  (WebGL → WASM fallback)
//   5. Tiled inference for large imgs  (desktop only)
//   6. CV post-processing              (hole-fill + edge feather)
//   7. Smart fallbacks at every stage
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
  // Lite  : U2Net-Lite  ~4.7 MB — mobile + fallback
  // Standard: RMBG-1.4 quantized ~44 MB — desktop HD
  var MODELS = {
    lite: {
      name: 'U2Net-Lite',
      urls: [
        'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
        'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/u2netp.onnx',
      ],
      cacheKey: 'bge_u2netp_v1',
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
      cacheKey: 'bge_rmbg14_q_v1',
      inputSize: 1024,
      mean: [0.5, 0.5, 0.5],
      std:  [1.0, 1.0, 1.0],
      sizeMB: 44,
    },
  };

  // ── Module-level state ────────────────────────────────────────────────────
  var _sessions    = {};     // tier → InferenceSession
  var _ortReady    = false;
  var _ortPromise  = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function yieldMain() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ── Device tier detection ─────────────────────────────────────────────────
  function detectTier(opts) {
    if (opts && opts.qualityMode === 'ultra')   return 'standard';
    if (opts && opts.qualityMode === 'lite')    return 'lite';

    var ua       = navigator.userAgent || '';
    var isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    var cores    = navigator.hardwareConcurrency || 2;
    var ramGB    = navigator.deviceMemory || 0; // Chrome only; 0 = unknown

    // Be conservative: mobile or low-core or explicitly low-RAM → lite
    if (isMobile || cores <= 2 || (ramGB > 0 && ramGB < 3)) return 'lite';
    return 'standard';
  }

  // ── ONNX Runtime loader ───────────────────────────────────────────────────
  function loadORT() {
    if (_ortReady && window.ort) return Promise.resolve(window.ort);
    if (_ortPromise) return _ortPromise;

    _ortPromise = new Promise(function (resolve, reject) {
      var s  = document.createElement('script');
      s.src  = ORT_CDN;
      s.async = true;
      s.onload = function () {
        if (!window.ort) { _ortPromise = null; reject(new Error('ort global missing')); return; }
        try {
          window.ort.env.wasm.wasmPaths    = ORT_WASM_DIR;
          window.ort.env.wasm.proxy        = false;
          window.ort.env.wasm.numThreads   = Math.min(4, navigator.hardwareConcurrency || 1);
        } catch (_e) {}
        _ortReady = true;
        resolve(window.ort);
      };
      s.onerror = function () { _ortPromise = null; reject(new Error('ORT script load failed')); };
      document.head.appendChild(s);
    });
    return _ortPromise;
  }

  // ── IndexedDB model cache ─────────────────────────────────────────────────
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bge-model-cache', 1);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore('models');
      };
      req.onsuccess  = function (e) { resolve(e.target.result); };
      req.onerror    = function ()  { reject(new Error('IDB open failed')); };
    });
  }

  async function cacheGet(key) {
    // Try shared IDBCache first (defined in browser-tools.js)
    if (window.IDBCache) {
      try { var v = await window.IDBCache.get('__bge__' + key); if (v) return v; } catch (_e) {}
    }
    try {
      var db = await idbOpen();
      return await new Promise(function (res, rej) {
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

  // ── Model downloader with progress ────────────────────────────────────────
  async function fetchModel(cfg, onProgress) {
    // Check cache
    var cached = await cacheGet(cfg.cacheKey);
    if (cached) {
      if (onProgress) onProgress(25, 'AI model ready \u2014 starting\u2026');
      return cached instanceof ArrayBuffer ? cached : cached.buffer || cached;
    }

    if (onProgress) onProgress(3, 'Downloading AI model (' + cfg.sizeMB.toFixed(0) + '\u202fMB)\u2026');

    var lastErr;
    for (var ui = 0; ui < cfg.urls.length; ui++) {
      var url = cfg.urls[ui];
      try {
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        var contentLen = parseInt(resp.headers.get('content-length') || '0', 10);

        if (!resp.body || !contentLen) {
          var ab = await resp.arrayBuffer();
          await cacheSet(cfg.cacheKey, ab);
          return ab;
        }

        // Streaming download with byte-level progress
        var reader = resp.body.getReader();
        var chunks = [], received = 0;
        while (true) {
          var _ref = await reader.read(), done = _ref.done, value = _ref.value;
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (onProgress && contentLen) {
            var dlPct = Math.round(received / contentLen * 100);
            var dlMB  = (received / 1048576).toFixed(1);
            var totMB = cfg.sizeMB.toFixed(0);
            onProgress(
              3 + Math.round(received / contentLen * 22),
              'Downloading AI model\u2026 ' + dlMB + '\u202fMB\u202f/\u202f' + totMB + '\u202fMB (' + dlPct + '%)'
            );
          }
        }

        var total = 0;
        for (var ci = 0; ci < chunks.length; ci++) total += chunks[ci].length;
        var merged = new Uint8Array(total);
        var off = 0;
        for (var ci2 = 0; ci2 < chunks.length; ci2++) { merged.set(chunks[ci2], off); off += chunks[ci2].length; }

        await cacheSet(cfg.cacheKey, merged.buffer);
        return merged.buffer;

      } catch (e) {
        lastErr = e;
        console.warn('[BgAI] model fetch failed from', url, ':', e.message);
      }
    }
    throw lastErr || new Error('All model URLs failed');
  }

  // ── ONNX session factory ──────────────────────────────────────────────────
  async function getSession(tier, onProgress) {
    if (_sessions[tier]) return { session: _sessions[tier], cfg: MODELS[tier] };

    var cfg = MODELS[tier];
    if (!cfg) throw new Error('Unknown model tier: ' + tier);

    var ort      = await loadORT();
    var modelBuf = await fetchModel(cfg, onProgress);

    if (onProgress) onProgress(28, 'Compiling AI model\u2026');

    var session;
    var providerSets = [['webgl', 'wasm'], ['wasm']];
    var lastErr;

    for (var pi = 0; pi < providerSets.length; pi++) {
      try {
        session = await ort.InferenceSession.create(modelBuf, {
          executionProviders:     providerSets[pi],
          graphOptimizationLevel: 'all',
          enableCpuMemArena:      false,
          enableMemPattern:       false,
        });
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[BgAI] session create failed with', providerSets[pi], ':', e.message);
      }
    }

    if (!session) throw lastErr || new Error('Cannot create ONNX session');

    _sessions[tier] = session;
    return { session: session, cfg: cfg };
  }

  // ── Image → Float32 NCHW tensor ───────────────────────────────────────────
  // Accepts HTMLImageElement or HTMLCanvasElement as source.
  function toTensor(src, inputSize, mean, std) {
    var c = document.createElement('canvas');
    c.width = inputSize; c.height = inputSize;
    c.getContext('2d').drawImage(src, 0, 0, inputSize, inputSize);
    var px  = c.getContext('2d').getImageData(0, 0, inputSize, inputSize).data;
    c.width = 0; c.height = 0;

    var n   = inputSize * inputSize;
    var buf = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      buf[i]         = (px[i*4]   / 255 - mean[0]) / std[0];
      buf[n   + i]   = (px[i*4+1] / 255 - mean[1]) / std[1];
      buf[2*n + i]   = (px[i*4+2] / 255 - mean[2]) / std[2];
    }
    return buf;
  }

  // ── Raw ONNX mask → Uint8Array alpha (upscaled to W×H) ───────────────────
  function maskToAlpha(rawMask, maskSize, W, H) {
    var mn  = maskSize * maskSize;
    var mc  = document.createElement('canvas');
    mc.width = maskSize; mc.height = maskSize;
    var mctx = mc.getContext('2d');
    var mImg = mctx.createImageData(maskSize, maskSize);
    for (var i = 0; i < mn; i++) {
      var v = Math.min(255, Math.max(0, Math.round(rawMask[i] * 255)));
      mImg.data[i*4]   = v;
      mImg.data[i*4+1] = v;
      mImg.data[i*4+2] = v;
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

    var pix   = octx.getImageData(0, 0, W, H).data;
    oc.width  = 0; oc.height = 0;

    var alpha = new Uint8Array(W * H);
    for (var j = 0; j < W * H; j++) alpha[j] = pix[j * 4];
    return alpha;
  }

  // ── Whole-image inference ─────────────────────────────────────────────────
  async function inferWhole(session, cfg, src, W, H) {
    var buf       = toTensor(src, cfg.inputSize, cfg.mean, cfg.std);
    var inputName = session.inputNames[0];
    var feeds     = {};
    feeds[inputName] = new window.ort.Tensor('float32', buf, [1, 3, cfg.inputSize, cfg.inputSize]);

    var results   = await session.run(feeds);
    var rawMask   = results[session.outputNames[0]].data;
    return maskToAlpha(rawMask, cfg.inputSize, W, H);
  }

  // ── Tiled inference (large images, desktop) ───────────────────────────────
  // Divides image into overlapping tiles, runs inference per tile,
  // blends boundaries with linear feathering.
  async function inferTiled(session, cfg, src, W, H, onProgress) {
    var TILE    = 640;
    var OVERLAP = Math.min(96, Math.floor(Math.min(W, H) / 8));
    var STEP    = TILE - OVERLAP;

    var tilesX = Math.max(1, Math.ceil((W - OVERLAP) / STEP));
    var tilesY = Math.max(1, Math.ceil((H - OVERLAP) / STEP));
    var total  = tilesX * tilesY;
    var done   = 0;

    var accAlpha  = new Float32Array(W * H);
    var accWeight = new Float32Array(W * H);

    for (var ty = 0; ty < tilesY; ty++) {
      for (var tx = 0; tx < tilesX; tx++) {
        var x0 = tx * STEP,             y0 = ty * STEP;
        var x1 = Math.min(x0 + TILE, W), y1 = Math.min(y0 + TILE, H);
        var tw = x1 - x0,              th = y1 - y0;

        // Extract tile to canvas
        var tc = document.createElement('canvas');
        tc.width = tw; tc.height = th;
        tc.getContext('2d').drawImage(src, x0, y0, tw, th, 0, 0, tw, th);

        // Inference on tile
        var tileBuf  = toTensor(tc, cfg.inputSize, cfg.mean, cfg.std);
        tc.width = 0; tc.height = 0;

        var feeds2 = {};
        feeds2[session.inputNames[0]] = new window.ort.Tensor('float32', tileBuf, [1, 3, cfg.inputSize, cfg.inputSize]);
        var res2     = await session.run(feeds2);
        var tileMask = maskToAlpha(res2[session.outputNames[0]].data, cfg.inputSize, tw, th);

        // Accumulate with linear blend weights (feathered overlap zones)
        var isLeftEdge  = (tx === 0);
        var isRightEdge = (tx === tilesX - 1);
        var isTopEdge   = (ty === 0);
        var isBottomEdge = (ty === tilesY - 1);

        for (var py = 0; py < th; py++) {
          for (var px = 0; px < tw; px++) {
            // Weight = 1 at tile centre, tapers to 0 at overlapping edges
            // (but keeps weight=1 at true image boundary to avoid fade)
            var wx = 1, wy = 1;
            if (!isLeftEdge  && px < OVERLAP)        wx = px / OVERLAP;
            if (!isRightEdge && px >= tw - OVERLAP)  wx = (tw - px) / OVERLAP;
            if (!isTopEdge   && py < OVERLAP)        wy = py / OVERLAP;
            if (!isBottomEdge && py >= th - OVERLAP) wy = (th - py) / OVERLAP;
            var w  = Math.min(wx, wy);

            var gi = (y0 + py) * W + (x0 + px);
            accAlpha[gi]  += tileMask[py * tw + px] * w;
            accWeight[gi] += w;
          }
        }

        done++;
        if (onProgress) {
          var pct = 30 + Math.round(done / total * 50);
          onProgress(pct, 'AI segmentation\u2026 ' + Math.round(done / total * 100) + '%');
        }

        // Yield every 2 tiles for mobile safety
        if (done % 2 === 0) await yieldMain();
      }
    }

    // Normalise accumulated alpha
    var alpha = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) {
      alpha[i] = accWeight[i] > 0 ? Math.round(accAlpha[i] / accWeight[i]) : 0;
    }
    return alpha;
  }

  // ── CV post-processing (Phase 5–7) ────────────────────────────────────────
  // Runs after AI mask to:
  //   • Fill interior holes
  //   • Edge-only feathering
  //   • Foreground solidity boost
  //   • Halo cleanup
  function refineAlpha(alpha, d, W, H) {
    var N   = W * H;
    var DX4 = [-1, 1,  0, 0];
    var DY4 = [ 0, 0, -1, 1];

    // ── Interior hole fill ────────────────────────────────────────────────
    var reach = new Uint8Array(N);
    var q     = [], qi = 0;

    function seedTrans(pi) {
      if (alpha[pi] < 35 && !reach[pi]) { reach[pi] = 1; q.push(pi); }
    }
    for (var x = 0; x < W; x++) { seedTrans(x); seedTrans((H-1)*W+x); }
    for (var y = 1; y < H-1; y++) { seedTrans(y*W); seedTrans(y*W+W-1); }

    while (qi < q.length) {
      var pi = q[qi++];
      var px = pi % W, py = Math.floor(pi / W);
      for (var di = 0; di < 4; di++) {
        var nx = px + DX4[di], ny = py + DY4[di];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        var ni = ny * W + nx;
        if (reach[ni] || alpha[ni] >= 35) continue;
        reach[ni] = 1; q.push(ni);
      }
    }
    for (var i = 0; i < N; i++) {
      if (alpha[i] < 35 && !reach[i]) alpha[i] = 230;
    }

    // ── Solidity boost: pull up weak pixels surrounded by solid FG ────────
    for (var i2 = 0; i2 < N; i2++) {
      if (alpha[i2] >= 190 || alpha[i2] < 25) continue;
      var px2 = i2 % W, py2 = Math.floor(i2 / W);
      var nSum = 0, nCnt = 0;
      for (var di2 = 0; di2 < 4; di2++) {
        var nx2 = px2 + DX4[di2], ny2 = py2 + DY4[di2];
        if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
        nSum += alpha[ny2 * W + nx2]; nCnt++;
      }
      if (nCnt > 0 && nSum / nCnt > 195) {
        alpha[i2] = Math.round(alpha[i2] * 0.25 + (nSum / nCnt) * 0.75);
      }
    }

    // ── Edge-only feathering ──────────────────────────────────────────────
    for (var ey = 1; ey < H-1; ey++) {
      for (var ex = 1; ex < W-1; ex++) {
        var ei = ey * W + ex;
        if (alpha[ei] < 15 || alpha[ei] > 238) continue;

        var hasBg = false, hasFg = false;
        for (var fy = -1; fy <= 1 && !(hasBg && hasFg); fy++) {
          for (var fx = -1; fx <= 1 && !(hasBg && hasFg); fx++) {
            var na = alpha[(ey+fy)*W+(ex+fx)];
            if (na < 20)  hasBg = true;
            if (na > 230) hasFg = true;
          }
        }
        if (!hasBg || !hasFg) continue;

        var fsum = 0, fwt = 0;
        for (var fy2 = -1; fy2 <= 1; fy2++) {
          for (var fx2 = -1; fx2 <= 1; fx2++) {
            var w2 = (fx2 === 0 && fy2 === 0) ? 3 : 1;
            fsum += alpha[(ey+fy2)*W+(ex+fx2)] * w2; fwt += w2;
          }
        }
        alpha[ei] = Math.round(fsum / fwt);
      }
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

    // ── Session loading (with fallback lite) ────────────────────────────────
    var sessionData;
    try {
      sessionData = await getSession(tier, onProgress);
    } catch (e1) {
      if (tier !== 'lite') {
        console.warn('[BgAI] standard model failed, trying lite:', e1.message);
        if (onProgress) onProgress(8, 'Switching to lightweight AI\u2026');
        sessionData = await getSession('lite', onProgress);
      } else {
        throw e1;
      }
    }

    var session = sessionData.session;
    var cfg     = sessionData.cfg;

    if (onProgress) onProgress(33, 'Running AI segmentation\u2026');
    await yieldMain();

    // ── Inference ────────────────────────────────────────────────────────────
    // Tile large images on desktop; whole-image on mobile (already using lite model)
    var isMobile    = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    var largeImage  = W > cfg.inputSize * 2.5 || H > cfg.inputSize * 2.5;
    var useTiling   = largeImage && !isMobile;

    var alpha;
    if (useTiling) {
      alpha = await inferTiled(session, cfg, img, W, H, onProgress);
    } else {
      alpha = await inferWhole(session, cfg, img, W, H);
    }

    if (onProgress) onProgress(82, 'Refining edges\u2026');
    await yieldMain();

    // ── CV refinement ────────────────────────────────────────────────────────
    var origC = document.createElement('canvas');
    origC.width = W; origC.height = H;
    origC.getContext('2d').drawImage(img, 0, 0);
    var imgData = origC.getContext('2d').getImageData(0, 0, W, H);
    origC.width = 0; origC.height = 0;

    alpha = refineAlpha(alpha, imgData.data, W, H);

    if (onProgress) onProgress(93, 'Compositing\u2026');
    await yieldMain();

    // ── Apply alpha & export PNG ─────────────────────────────────────────────
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
    isReady:      function (tier) { return !!_sessions[tier || 'lite']; },
    getModelInfo: function (tier) { return MODELS[tier || 'lite']; },
  };

  // Auto-preload lite model after a quiet period (non-blocking)
  if (document.readyState === 'complete') {
    setTimeout(function () { preload('lite'); }, 4000);
  } else {
    window.addEventListener('load', function () { setTimeout(function () { preload('lite'); }, 4000); });
  }

}());
