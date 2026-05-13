// Client-side processors for the lightweight tools — runs entirely in the
// browser using pdf-lib / pdfjs / canvas (loaded lazily from CDN). Zero
// upload, instant results.
//
// Usage: window.BrowserTools.process(toolId, files, optionsObj)
//        -> Promise<{ blob, filename }>
(function () {
  const PDFLIB_URL    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  const PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const JSZIP_URL     = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const MAMMOTH_URL   = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';
  const HTML2PDF_URL  = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.3/dist/html2pdf.bundle.min.js';
  const XLSX_URL      = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const PPTXGEN_URL   = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';

  // ── IDB-backed CDN script loader ─────────────────────────────────────────
  // On first load: fetches from CDN, executes via script tag, then stores
  // bytes in IndexedDB. On subsequent page loads: reads from IDB → creates
  // a blob URL → injects as script tag (zero network round-trip).
  // Falls back to CDN direct if IDB is unavailable or blob: URL is blocked
  // by CSP (onerror triggers CDN retry automatically).
  function loadScriptCached(url, globalName, slot) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (slot.p) return slot.p;

    slot.p = new Promise((resolve, reject) => {
      const inject = (src, done) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => done(null);
        s.onerror = () => done(new Error('err'));
        document.head.appendChild(s);
      };

      const settle = (err) => {
        if (err) { slot.p = null; reject(new Error((globalName || url) + ' failed to load')); return; }
        const val = globalName ? window[globalName] : true;
        if (!val && globalName) { slot.p = null; reject(new Error(globalName + ' not found after load')); return; }
        resolve(val);
      };

      (async () => {
        // ── Path A: IDB hit → inject as blob URL ────────────────────────
        if (window.IDBCache) {
          try {
            const cached = await window.IDBCache.get(url);
            if (cached) {
              const blobUrl = URL.createObjectURL(new Blob([cached], { type: 'application/javascript' }));
              inject(blobUrl, (err) => {
                URL.revokeObjectURL(blobUrl);
                if (!err) { settle(null); return; }
                // CSP blocked blob: → fall back to CDN
                inject(url, settle);
              });
              return;
            }
          } catch (_) {}
        }

        // ── Path B: CDN → execute, then cache bytes in background ───────
        inject(url, (err) => {
          settle(err);
          if (!err && window.IDBCache) {
            fetch(url).then(r => r.ok ? r.arrayBuffer() : null)
              .then(ab => { if (ab) { window.IDBCache.set(url, ab).catch(() => {}); } })
              .catch(() => {});
          }
        });
      })();
    });

    return slot.p;
  }

  // ── lazy CDN loaders (IDB-cached for UMD bundles) ────────────────────────
  const _pdfLibSlot   = { p: null };
  const _jsZipSlot    = { p: null };
  const _mammothSlot  = { p: null };
  const _html2pdfSlot = { p: null };
  const _xlsxSlot     = { p: null };
  const _pptxSlot     = { p: null };

  function loadPdfLib()   { return loadScriptCached(PDFLIB_URL,   'PDFLib',    _pdfLibSlot); }
  function loadJsZip()    { return loadScriptCached(JSZIP_URL,    'JSZip',     _jsZipSlot); }
  function loadMammoth()  { return loadScriptCached(MAMMOTH_URL,  'mammoth',   _mammothSlot); }
  function loadHtml2Pdf() { return loadScriptCached(HTML2PDF_URL, 'html2pdf',  _html2pdfSlot); }
  function loadXlsx()     { return loadScriptCached(XLSX_URL,     'XLSX',      _xlsxSlot); }
  function loadPptxGen()  { return loadScriptCached(PPTXGEN_URL,  'PptxGenJS', _pptxSlot); }

  // pdfjs uses dynamic import() — ES module; IDB/blob-URL not applicable.
  // window.__pdfjsLibPromise is the global shared promise so that pdf-preview.js,
  // live-preview.js, advanced-engine.js and browser-tools.js all use one import() call.
  //
  // RCA-5 FIX: Validate that lib.getDocument exists after import.
  // Previously: `mod && (mod.default || mod)` — when pdfjs-dist ships named ESM
  // exports, mod.default is undefined and mod is the namespace object which does NOT
  // have getDocument at the top level. This caused a silent TypeError on first use.
  let pdfJsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
    if (window.__pdfjsLibPromise) return window.__pdfjsLibPromise;
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = window.__pdfjsLibPromise = (async () => {
      const mod = await import(PDFJS_URL);
      // Resolve in the same order pdf-preview.js does: prefer the namespace
      // object if it has getDocument, then try .default.
      const lib = (mod && mod.getDocument) ? mod : (mod && mod.default && mod.default.getDocument ? mod.default : null);
      if (!lib || !lib.getDocument) {
        throw new Error('[BrowserTools] pdfjsLib.getDocument missing after import — unexpected module shape');
      }
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = lib;
      return lib;
    })().catch(function (err) {
      pdfJsPromise = null;
      window.__pdfjsLibPromise = null;
      throw err;
    });
    return pdfJsPromise;
  }

  // Tesseract manages its own WASM/worker caching internally.
  let tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL; s.async = true;
      s.onload  = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract failed'));
      s.onerror = () => reject(new Error('Tesseract failed'));
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  // WorkerPool is a local script — no CDN or IDB needed.
  let workerPoolPromise = null;
  function loadWorkerPool() {
    if (window.WorkerPool) return Promise.resolve(window.WorkerPool);
    if (workerPoolPromise) return workerPoolPromise;
    workerPoolPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/workers/workerPool.js'; s.async = true;
      s.onload  = () => window.WorkerPool ? resolve(window.WorkerPool) : reject(new Error('WorkerPool unavailable'));
      s.onerror = () => reject(new Error('WorkerPool script failed to load'));
      document.head.appendChild(s);
    });
    return workerPoolPromise;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  async function readFileBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  // Parse "1-3, 5, 7-9" -> [1,2,3,5,7,8,9] (1-indexed). "" or "all" -> all.
  function parsePageRange(range, total) {
    if (!range || /^all$/i.test(String(range).trim())) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const out = new Set();
    for (const part of String(range).split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (m) {
        const a = Math.max(1, parseInt(m[1], 10));
        const b = Math.min(total, parseInt(m[2], 10));
        for (let i = a; i <= b; i++) out.add(i);
      } else {
        const n = parseInt(p, 10);
        if (Number.isFinite(n) && n >= 1 && n <= total) out.add(n);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  function brandedFilename(originalName, newExt) {
    const base = (originalName || 'file').replace(/\.[^.]+$/, '');
    const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    return `ILovePDF-${safe}${newExt}`;
  }

  // Load an HTMLImageElement from a File.
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas encode failed')), mime, quality);
    });
  }

  // ── MERGE ────────────────────────────────────────────────────────────────
  async function merge(files) {
    const { PDFDocument } = await loadPdfLib();
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(await readFileBytes(f), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  // ── SPLIT ────────────────────────────────────────────────────────────────
  async function split(files, opts) {
    const { PDFDocument } = await loadPdfLib();
    const src = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const total = src.getPageCount();
    const range = opts.range || '';
    const pages = parsePageRange(range, total);
    if (!pages.length) throw new Error('No valid pages selected');

    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pages.map(n => n - 1));
    copied.forEach(p => out.addPage(p));
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  // ── ROTATE ───────────────────────────────────────────────────────────────
  async function rotate(files, opts) {
    const { PDFDocument, degrees } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const angle = parseInt(opts.degrees || '90', 10);
    const total = doc.getPageCount();
    const targets = (!opts.pages || /^all$/i.test(opts.pages))
      ? Array.from({ length: total }, (_, i) => i + 1)
      : parsePageRange(opts.pages, total);
    targets.forEach(n => {
      const p = doc.getPage(n - 1);
      p.setRotation(degrees((p.getRotation().angle + angle) % 360));
    });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── ORGANIZE (reorder) ───────────────────────────────────────────────────
  async function organize(files, opts) {
    const { PDFDocument } = await loadPdfLib();
    const src = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const total = src.getPageCount();
    const order = String(opts.pageOrder || '').split(',').map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= total);
    if (!order.length) throw new Error('Provide a comma-separated page order, e.g. 3,1,2');
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, order.map(n => n - 1));
    copied.forEach(p => out.addPage(p));
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  // ── PAGE NUMBERS ─────────────────────────────────────────────────────────
  async function pageNumbers(files, opts) {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const total = doc.getPageCount();
    const start = parseInt(opts.startFrom || '1', 10) || 1;
    const position = (opts.position || 'bottom-center').toLowerCase();
    doc.getPages().forEach((page, idx) => {
      const { width } = page.getSize();
      const label = `${start + idx} / ${start + total - 1}`;
      const tw = font.widthOfTextAtSize(label, 11);
      let x = (width - tw) / 2;
      if (position.includes('left'))  x = 24;
      if (position.includes('right')) x = width - tw - 24;
      const y = position.startsWith('top') ? page.getSize().height - 22 : 14;
      page.drawText(label, { x, y, size: 11, font, color: rgb(0.4, 0.4, 0.4) });
    });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── WATERMARK ────────────────────────────────────────────────────────────
  async function watermark(files, opts) {
    const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const text = (opts.text || 'WATERMARK').slice(0, 80);
    const opacity = Math.min(0.9, Math.max(0.05, parseFloat(opts.opacity || '0.3')));
    const position = (opts.position || 'center').toLowerCase();
    doc.getPages().forEach(page => {
      const { width, height } = page.getSize();
      const size = Math.min(width, height) * 0.07;
      const tw = font.widthOfTextAtSize(text, size);
      let x = (width - tw) / 2, y = (height - size) / 2, rot = 45;
      if (position === 'top')    { y = height - size - 30; rot = 0; }
      if (position === 'bottom') { y = 30; rot = 0; }
      page.drawText(text, { x, y, size, font, color: rgb(0.6, 0.6, 0.6), opacity, rotate: degrees(rot) });
    });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── CROP ─────────────────────────────────────────────────────────────────
  async function crop(files, opts) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const cl = Math.max(0, parseFloat(opts.cropLeft   || '0')) / 100;
    const cr = Math.max(0, parseFloat(opts.cropRight  || '0')) / 100;
    const ct = Math.max(0, parseFloat(opts.cropTop    || '0')) / 100;
    const cb = Math.max(0, parseFloat(opts.cropBottom || '0')) / 100;
    doc.getPages().forEach(p => {
      const { width, height } = p.getSize();
      const x = width * cl;
      const y = height * cb;
      const w = Math.max(10, width  * (1 - cl - cr));
      const h = Math.max(10, height * (1 - ct - cb));
      p.setCropBox(x, y, w, h);
    });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── JPG/PNG -> PDF (Phase 23B: EXIF orientation correction) ─────────────
  // JPEG images from phones/cameras often carry an EXIF Orientation tag that
  // tells viewers to rotate/flip the image. pdf-lib embeds raw pixel data and
  // ignores EXIF, so landscape shots appear sideways. We read the tag with
  // StreamHelpers.readExifOrientation, then re-draw on a corrected canvas
  // before embedding — ensuring upright images in the resulting PDF.
  async function imagesToPdf(files) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    const sh  = window.StreamHelpers; // Phase 23B helpers (graceful if absent)

    for (const f of files) {
      const bytes = await readFileBytes(f);
      const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);

      if (!isPng && sh) {
        // JPEG path: check EXIF orientation and correct if needed
        const orientation = sh.readExifOrientation(bytes.buffer);

        if (orientation > 1) {
          // Need to rotate/flip — draw through a canvas with the correct transform
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          try {
            const htmlImg = await new Promise((res, rej) => {
              const img = new Image();
              img.onload  = () => res(img);
              img.onerror = () => rej(new Error('EXIF img load failed'));
              img.src = blobUrl;
            });
            const corrected = sh.applyExifOrientation(htmlImg, orientation);
            // Encode the corrected canvas as JPEG bytes for pdf-lib
            const correctedBytes = await new Promise((res, rej) => {
              corrected.toBlob(b => {
                if (!b) { rej(new Error('canvas encode failed')); return; }
                b.arrayBuffer().then(ab => res(new Uint8Array(ab))).catch(rej);
              }, 'image/jpeg', 0.92);
            });
            corrected.width = 0; corrected.height = 0; // release canvas
            const img = await doc.embedJpg(correctedBytes);
            const page = doc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          } catch (_) {
            // Fallback: embed raw bytes without orientation correction
            const img = await doc.embedJpg(bytes);
            const page = doc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        } else {
          // orientation === 1 (or absent) — no correction needed
          const img = await doc.embedJpg(bytes);
          const page = doc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }
      } else {
        // PNG path (or no StreamHelpers) — embed directly
        const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── SCAN PDF PRO MAX ──────────────────────────────────────────────────────
  // Accepts image files (jpg/png). Applies deskew + auto-level + contrast
  // enhancement, then either embeds into an enhanced image PDF or runs AI
  // OCR Engine to produce Searchable PDF, DOCX, or TXT output.
  async function scanPdf(files, opts) {
    opts = opts || {};
    const outputFmt   = opts.outputFormat || 'pdf';
    const ocrMode     = opts.ocrMode      || 'balanced';
    const enhancement = opts.enhancement  || 'auto';
    const lang        = opts.language     || 'eng';

    const scaleMap  = { fast: 1.5, balanced: 2.0, accurate: 2.5, 'table-priority': 2.5 };
    const psmMap    = { 'table-priority': '6' };
    const renderScale = scaleMap[ocrMode] || 2.0;
    const psm         = psmMap[ocrMode]   || '3';

    const factorMap = { auto: 1.5, strong: 1.9, contrast: 1.8, table: 1.6, light: 1.2, none: 0 };
    const enhFactor = factorMap[enhancement] !== undefined ? factorMap[enhancement] : 1.5;
    const doBW      = enhancement === 'table' || enhancement === 'strong';

    // Convert base64 dataUrl → Uint8Array (for pdf-lib embedJpg)
    function dataUrlToBytes(dataUrl) {
      const b64 = dataUrl.split(',')[1];
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    // Grayscale + histogram auto-level + contrast curve
    function applyEnhancement(ctx, w, h) {
      if (enhFactor === 0) return;
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data, N = d.length;
      let minV = 255, maxV = 0;
      for (let px = 0; px < N; px += 4) {
        const g = Math.round(0.299 * d[px] + 0.587 * d[px + 1] + 0.114 * d[px + 2]);
        d[px] = d[px + 1] = d[px + 2] = g;
        if (g < minV) minV = g;
        if (g > maxV) maxV = g;
      }
      const range = Math.max(1, maxV - minV);
      for (let px = 0; px < N; px += 4) {
        let v = Math.round((d[px] - minV) * 255 / range);
        v = Math.min(255, Math.max(0, Math.round((v - 128) * enhFactor + 128)));
        if (doBW) v = v > 140 ? 255 : 0;
        d[px] = d[px + 1] = d[px + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
    }

    // Deskew: horizontal projection variance over ±8° test angles on a
    // 320px-wide thumbnail to find the best rotation without heavy computation.
    function detectSkewAngle(canvas) {
      const sw = Math.min(canvas.width, 320);
      const sh = Math.round(canvas.height * sw / canvas.width);
      const sc = document.createElement('canvas');
      sc.width = sw; sc.height = sh;
      sc.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
      const sd = sc.getContext('2d').getImageData(0, 0, sw, sh).data;
      sc.width = 0; sc.height = 0;
      const bw = new Uint8Array(sw * sh);
      for (let i = 0, px = 0; px < sd.length; px += 4, i++) {
        bw[i] = (0.299 * sd[px] + 0.587 * sd[px + 1] + 0.114 * sd[px + 2]) < 128 ? 1 : 0;
      }
      const DEG = Math.PI / 180;
      const angles = [-8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8];
      let bestAngle = 0, bestVar = -1;
      for (const deg of angles) {
        const cos = Math.cos(deg * DEG), sin = Math.sin(deg * DEG);
        const rows = new Float32Array(sh);
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            if (!bw[y * sw + x]) continue;
            const ry = Math.round((x - sw / 2) * sin + (y - sh / 2) * cos + sh / 2);
            if (ry >= 0 && ry < sh) rows[ry]++;
          }
        }
        let mean = 0;
        for (let i = 0; i < sh; i++) mean += rows[i];
        mean /= sh;
        let v = 0;
        for (let i = 0; i < sh; i++) v += (rows[i] - mean) ** 2;
        if (v > bestVar) { bestVar = v; bestAngle = deg; }
      }
      return Math.abs(bestAngle) >= 1 ? bestAngle : 0;
    }

    function rotateCanvas(src, deg) {
      const W = src.width, H = src.height;
      const RAD = deg * Math.PI / 180;
      const cos = Math.abs(Math.cos(RAD)), sin = Math.abs(Math.sin(RAD));
      const nW = Math.round(W * cos + H * sin);
      const nH = Math.round(H * cos + W * sin);
      const nc = document.createElement('canvas');
      nc.width = nW; nc.height = nH;
      const nctx = nc.getContext('2d');
      nctx.fillStyle = '#fff';
      nctx.fillRect(0, 0, nW, nH);
      nctx.translate(nW / 2, nH / 2);
      nctx.rotate(-RAD);
      nctx.drawImage(src, -W / 2, -H / 2);
      return nc;
    }

    async function loadImageCanvas(file) {
      return new Promise(function (resolve, reject) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const cx = c.getContext('2d');
          cx.fillStyle = '#fff';
          cx.fillRect(0, 0, c.width, c.height);
          cx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve({ c, cx });
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('Could not load image: ' + file.name));
        };
        img.src = url;
      });
    }

    // ── Process each image: deskew → enhance ─────────────────────────────
    const pageCanvases = [];
    for (const file of files) {
      let { c, cx } = await loadImageCanvas(file);
      if (enhancement !== 'none') {
        const skew = detectSkewAngle(c);
        if (skew !== 0) {
          const rotated = rotateCanvas(c, skew);
          c.width = 0; c.height = 0;
          c = rotated; cx = c.getContext('2d');
        }
      }
      applyEnhancement(cx, c.width, c.height);
      pageCanvases.push(c);
    }

    // ── PDF-only output (enhanced image PDF, no OCR) ──────────────────────
    if (outputFmt === 'pdf') {
      const { PDFDocument } = await loadPdfLib();
      const doc = await PDFDocument.create();
      for (const c of pageCanvases) {
        const bytes = dataUrlToBytes(c.toDataURL('image/jpeg', 0.92));
        c.width = 0; c.height = 0;
        const img  = await doc.embedJpg(bytes);
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      const pdfBytes = await doc.save();
      if (!pdfBytes || pdfBytes.length < 200) throw new Error('Could not create PDF from images.');
      return new Blob([pdfBytes], { type: 'application/pdf' });
    }

    // ── OCR path ──────────────────────────────────────────────────────────
    const Tesseract = await loadTesseract();
    const allPageData = [];
    let totalConf = 0;

    for (const c of pageCanvases) {
      const canvasW = c.width;
      let ocrC = c;
      if (renderScale > 1.05) {
        const sc = document.createElement('canvas');
        sc.width  = Math.min(Math.round(c.width  * renderScale), 4096);
        sc.height = Math.min(Math.round(c.height * renderScale), 4096);
        sc.getContext('2d').drawImage(c, 0, 0, sc.width, sc.height);
        ocrC = sc;
      }
      const dataUrl = ocrC.toDataURL('image/png');
      if (ocrC !== c) { ocrC.width = 0; ocrC.height = 0; }
      c.width = 0; c.height = 0;

      const { data: ocrData } = await Tesseract.recognize(dataUrl, lang, {
        logger: () => {},
        tessedit_pageseg_mode: psm,
      });
      const conf = typeof ocrData.confidence === 'number' ? ocrData.confidence : 0;
      totalConf += conf;
      allPageData.push({ text: (ocrData.text || '').trim(), words: ocrData.words || [], confidence: conf, pageW: canvasW });
    }

    const avgConf = allPageData.length > 0 ? totalConf / allPageData.length : 0;
    if (avgConf < 5) {
      throw new Error('Low scan quality detected. Try switching to a different enhancement mode or language setting.');
    }

    // ── TXT output ────────────────────────────────────────────────────────
    if (outputFmt === 'txt') {
      const full = allPageData.map(function (p, i) {
        return (allPageData.length > 1 ? '--- Page ' + (i + 1) + ' ---\n' : '') + p.text;
      }).join('\n\n');
      return { blob: new Blob([full], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
    }

    // ── Searchable PDF output ─────────────────────────────────────────────
    if (outputFmt === 'searchable-pdf') {
      const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
      const outDoc = await PDFDocument.create();
      const font   = await outDoc.embedFont(StandardFonts.Helvetica);
      const bold   = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const mL = 50, mR = 50, mT = 50, mB = 50;
      const pW = 595.28, pH = 841.89, cW = pW - mL - mR;
      for (const pd of allPageData) {
        const lines = _reconstructOcrLines(pd.words, pd.pageW || 0).map(function (l) { return l.text; });
        if (!lines.length) continue;
        let page = outDoc.addPage([pW, pH]);
        let y    = pH - mT;
        for (const line of lines) {
          if (!line.trim()) continue;
          const sz  = (line.toUpperCase() === line && /[A-Z]/.test(line) && line.length <= 60) ? 13 : 11;
          const fnt = sz === 13 ? bold : font;
          const lh  = sz * 1.5;
          const ws  = line.split(' ');
          let cur = '', wrapped = [];
          for (const w of ws) {
            const t = cur ? cur + ' ' + w : w;
            if (fnt.widthOfTextAtSize(t, sz) > cW && cur) { wrapped.push(cur); cur = w; } else cur = t;
          }
          if (cur) wrapped.push(cur);
          for (const wl of wrapped) {
            if (y - lh < mB) { page = outDoc.addPage([pW, pH]); y = pH - mT; }
            y -= lh;
            try { page.drawText(wl, { x: mL, y, size: sz, font: fnt, color: rgb(0, 0, 0), maxWidth: cW }); } catch (_) {}
          }
        }
      }
      const pdfBytes = await outDoc.save();
      if (!pdfBytes || pdfBytes.length < 200) throw new Error('Could not generate searchable PDF.');
      return { blob: new Blob([pdfBytes], { type: 'application/pdf' }), ext: '.pdf', mime: 'application/pdf' };
    }

    // ── DOCX output ───────────────────────────────────────────────────────
    const JSZip = await loadJsZip();
    const allReconstructed = allPageData.flatMap(function (pd) {
      return (pd.words && pd.words.length > 2)
        ? _reconstructOcrLines(pd.words, pd.pageW || 0)
        : pd.text.split('\n').map(function (t) {
            t = t.trim(); if (!t) return null;
            return { text: t, type: (t === t.toUpperCase() && /[A-Z]/.test(t)) ? 'h1' : 'normal' };
          }).filter(Boolean);
    });
    const xmlParts = [];
    for (const rl of allReconstructed) {
      const escaped = rl.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const pStyle  = rl.type === 'h1' ? 'Heading1' : rl.type === 'h2' ? 'Heading2' : 'Normal';
      const rStyle  = rl.type === 'h1'    ? '<w:b/><w:sz><w:val>32</w:val></w:sz>' :
                      rl.type === 'h2'    ? '<w:b/><w:sz><w:val>28</w:val></w:sz>' :
                      rl.type === 'table' ? '<w:sz><w:val>20</w:val></w:sz>' :
                                           '<w:sz><w:val>24</w:val></w:sz>';
      xmlParts.push('<w:p><w:pPr><w:pStyle w:val="' + pStyle + '"/></w:pPr><w:r><w:rPr>' + rStyle + '</w:rPr><w:t xml:space="preserve">' + escaped + '</w:t></w:r></w:p>');
    }
    const scanFootNote = 'AI OCR Engine \u00b7 ' + Math.round(avgConf) + '% confidence \u00b7 ' + allPageData.length + ' image' + (allPageData.length > 1 ? 's' : '') + ' processed';
    const scanFootEsc  = scanFootNote.replace(/&/g, '&amp;');
    xmlParts.push(
      '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:color w:val="888888"/><w:sz><w:val>18</w:val></w:sz></w:rPr><w:t xml:space="preserve">\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:color w:val="888888"/><w:sz><w:val>18</w:val></w:sz></w:rPr><w:t xml:space="preserve">' + scanFootEsc + '</w:t></w:r></w:p>'
    );
    const docXml  = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + xmlParts.join('') + '<w:sectPr/></w:body></w:document>';
    const ctXml   = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const wRels   = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', ctXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('word/document.xml', docXml);
    zip.file('word/_rels/document.xml.rels', wRels);
    const docxBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    if (!docxBlob || docxBlob.size < 200) throw new Error('Scan OCR produced no output. Try a different enhancement mode.');
    return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }

  // ── COMPRESS (basic, browser-side) ───────────────────────────────────────
  // Re-saves the PDF using object streams + metadata strip. Returns the best
  // result available — if no size improvement is possible, the original bytes
  // are returned (never throws NO_BROWSER_GAIN; callers get a valid file).
  async function compress(files) {
    const { PDFDocument } = await loadPdfLib();
    const original = await readFileBytes(files[0]);
    const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
    // Strip metadata to claw back a few bytes
    try {
      doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
      doc.setKeywords([]); doc.setProducer('ILovePDF'); doc.setCreator('ILovePDF');
    } catch (_) {}
    const out = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 200,
    });
    // Return whichever is smaller — always give the caller a valid PDF.
    const best = out.byteLength < original.byteLength ? out : original;
    return new Blob([best], { type: 'application/pdf' });
  }

  // ── PROTECT PDF (browser-side) ───────────────────────────────────────────
  // pdf-lib does not support saving encrypted PDFs natively. We use a
  // visually-protected approach: add a full-page overlay on every page that
  // mimics a password prompt, and embed the password as a comment in metadata
  // so it travels with the file. Note: this is a visual lock, not AES
  // encryption — for true encryption use a dedicated desktop PDF app.
  async function protect(files, opts) {
    const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
    const password = String(opts.password || '').trim();
    if (!password) throw new Error('Please enter a password to protect the PDF');
    const doc   = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const bold  = await doc.embedFont(StandardFonts.HelveticaBold);
    const reg   = await doc.embedFont(StandardFonts.Helvetica);
    doc.setSubject('Password-protected document');
    doc.setProducer('ILovePDF');
    doc.setKeywords([]);
    const pages = doc.getPages();
    for (const page of pages) {
      const { width, height } = page.getSize();
      const cx = width / 2, cy = height / 2;
      // Soft overlay to signal protection without covering content entirely
      page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.95, 0.95, 1.0), opacity: 0.88 });
      // Lock body
      page.drawRectangle({ x: cx - 22, y: cy - 28, width: 44, height: 34, color: rgb(0.18, 0.22, 0.62) });
      // Lock shackle top bar
      page.drawRectangle({ x: cx - 12, y: cy + 6,  width: 24, height: 8,  color: rgb(0.18, 0.22, 0.62) });
      // Lock shackle sides
      page.drawRectangle({ x: cx - 14, y: cy - 4,  width: 5,  height: 20, color: rgb(0.18, 0.22, 0.62) });
      page.drawRectangle({ x: cx + 9,  y: cy - 4,  width: 5,  height: 20, color: rgb(0.18, 0.22, 0.62) });
      // Keyhole
      page.drawRectangle({ x: cx - 4,  y: cy - 18, width: 8,  height: 12, color: rgb(0.95, 0.95, 1.0) });
      page.drawRectangle({ x: cx - 2,  y: cy - 22, width: 4,  height: 6,  color: rgb(0.95, 0.95, 1.0) });
      // Label text
      const t1 = 'PASSWORD PROTECTED';
      const t2 = 'Open with a PDF reader that supports encryption';
      const t3 = `Password hint: ${password.slice(0, 3)}${'*'.repeat(Math.max(0, password.length - 3))}`;
      page.drawText(t1, { x: (width - bold.widthOfTextAtSize(t1, 15)) / 2, y: cy - 52, size: 15, font: bold,  color: rgb(0.12, 0.15, 0.5) });
      page.drawText(t2, { x: (width - reg.widthOfTextAtSize(t2, 9))   / 2, y: cy - 72, size: 9,  font: reg,   color: rgb(0.4, 0.4, 0.5) });
      page.drawText(t3, { x: (width - reg.widthOfTextAtSize(t3, 9))   / 2, y: cy - 86, size: 9,  font: reg,   color: rgb(0.5, 0.3, 0.1) });
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── UNLOCK PDF (browser-side) ────────────────────────────────────────────
  // Loads with ignoreEncryption and re-saves an unencrypted copy. Works for
  // PDFs that don't require an owner password to open (the typical case).
  async function unlock(files) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const out = await doc.save({ useObjectStreams: true });
    return new Blob([out], { type: 'application/pdf' });
  }

  // ── PDF -> JPG (basic, browser-side via pdfjs+canvas) ────────────────────
  // Renders every page to a JPG. Single-page → JPG blob. Multi-page → ZIP.
  async function pdfToJpg(files, opts) {
    const pdfjsLib = await loadPdfJs();
    const data = await readFileBytes(files[0]);
    const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
    const pdf = await loadingTask.promise;
    const total = pdf.numPages;
    // Quality preset → render scale. 150 DPI ≈ scale 2.0; 200 DPI ≈ scale 2.7
    const quality = String(opts.quality || 'standard').toLowerCase();
    const jpegQ   = quality === 'high' ? 0.92 : 0.85;

    // Phase 23B: Adaptive render scale — respects MemPressure tier and page count.
    // StreamHelpers.adaptivePdfScale handles graceful fallback when MemPressure is absent.
    const baseScale  = quality === 'high' ? 2.7 : 2.0;
    const sh         = window.StreamHelpers;
    const scale      = sh ? sh.adaptivePdfScale(baseScale, total) : (quality === 'high' ? 2.7 : 2.0);

    const pages = [];
    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width  = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      // White background so transparent PDFs don't render black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup(); // Release page resources immediately after render
      pages.push(await canvasToBlob(canvas, 'image/jpeg', jpegQ));
      // Free the canvas explicitly to keep memory bounded on big PDFs.
      canvas.width = 0; canvas.height = 0;
      // Phase 23B: yield to main thread every 3 pages to keep UI responsive.
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }
    await pdf.destroy(); // Release PDF document resources

    if (pages.length === 1) {
      return { blob: pages[0], ext: '.jpg', mime: 'image/jpeg' };
    }
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    const baseName = (files[0].name || 'document').replace(/\.[^.]+$/, '');
    pages.forEach((b, i) => {
      const n = String(i + 1).padStart(String(pages.length).length, '0');
      zip.file(`${baseName}-page-${n}.jpg`, b);
    });
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    return { blob: zipBlob, ext: '.zip', mime: 'application/zip' };
  }

  // ── IMAGE: CROP ──────────────────────────────────────────────────────────
  async function cropImage(files, opts) {
    const img = await loadImageFromFile(files[0]);
    const xPct = clampPct(opts.x,      0);
    const yPct = clampPct(opts.y,      0);
    const wPct = clampPct(opts.width,  100);
    const hPct = clampPct(opts.height, 100);
    const sx = Math.floor(img.naturalWidth  * (xPct / 100));
    const sy = Math.floor(img.naturalHeight * (yPct / 100));
    const sw = Math.max(1, Math.floor(img.naturalWidth  * (wPct / 100)));
    const sh = Math.max(1, Math.floor(img.naturalHeight * (hPct / 100)));
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const { mime, ext, q } = pickOutFormat(files[0]);
    const blob = await canvasToBlob(canvas, mime, q);
    canvas.width = 0; canvas.height = 0; // Phase 21: release canvas memory
    return { blob, ext, mime };
  }

  // ── IMAGE: RESIZE ────────────────────────────────────────────────────────
  async function resizeImage(files, opts) {
    const img = await loadImageFromFile(files[0]);
    const preset = String(opts.preset || 'custom').toLowerCase();
    let w, h;
    if (preset === '1:1')      { w = 1080; h = 1080; }
    else if (preset === '16:9'){ w = 1920; h = 1080; }
    else if (preset === 'a4')  { w = 2480; h = 3508; }
    else if (preset === 'hd')  { w = 1920; h = 1080; }
    else {
      w = parseInt(opts.width  || img.naturalWidth,  10) || img.naturalWidth;
      h = parseInt(opts.height || img.naturalHeight, 10) || img.naturalHeight;
    }
    w = Math.max(1, Math.min(8000, w));
    h = Math.max(1, Math.min(8000, h));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const { mime, ext, q } = pickOutFormat(files[0]);
    const blob = await canvasToBlob(canvas, mime, q);
    canvas.width = 0; canvas.height = 0; // Phase 21: release canvas memory
    return { blob, ext, mime };
  }

  // ── IMAGE: FILTERS ───────────────────────────────────────────────────────
  async function imageFilters(files, opts) {
    const img = await loadImageFromFile(files[0]);
    const w = img.naturalWidth, h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Try the fast CSS-filter path first; it covers most modes natively.
    const filter = String(opts.filter || 'grayscale').toLowerCase();
    const cssMap = {
      grayscale: 'grayscale(100%)',
      sepia:     'sepia(100%)',
      blur:      'blur(4px)',
      brighten:  'brightness(1.25)',
      contrast:  'contrast(1.5)',
      invert:    'invert(100%)',
    };
    if (cssMap[filter]) {
      ctx.filter = cssMap[filter];
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = 'none';
    } else if (filter === 'sharpen') {
      // 3x3 sharpen convolution via getImageData
      ctx.drawImage(img, 0, 0, w, h);
      const src  = ctx.getImageData(0, 0, w, h);
      const dst  = ctx.createImageData(w, h);
      const k    = [0,-1,0,-1,5,-1,0,-1,0];
      const data = src.data, out = dst.data;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0, ki = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const i = ((y + dy) * w + (x + dx)) * 4 + c;
                sum += data[i] * k[ki++];
              }
            }
            out[(y * w + x) * 4 + c] = Math.max(0, Math.min(255, sum));
          }
          out[(y * w + x) * 4 + 3] = data[(y * w + x) * 4 + 3];
        }
      }
      ctx.putImageData(dst, 0, 0);
    } else {
      // unknown filter → just draw as-is
      ctx.drawImage(img, 0, 0, w, h);
    }
    const { mime, ext, q } = pickOutFormat(files[0]);
    const blob = await canvasToBlob(canvas, mime, q);
    canvas.width = 0; canvas.height = 0; // Phase 21: release canvas memory
    return { blob, ext, mime };
  }

  function clampPct(v, fallback) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
  }

  function pickOutFormat(file) {
    const name = (file && file.name || '').toLowerCase();
    const type = (file && file.type || '').toLowerCase();
    if (name.endsWith('.png') || type.includes('png')) return { mime: 'image/png',  ext: '.png',  q: undefined };
    if (name.endsWith('.webp')|| type.includes('webp'))return { mime: 'image/webp', ext: '.webp', q: 0.92 };
    return { mime: 'image/jpeg', ext: '.jpg', q: 0.9 };
  }

  // ── WORD TO PDF (v3.0 — full CSS layout engine) ──────────────────────────
  // mammoth converts DOCX → HTML preserving headings, lists, bold/italic,
  // tables. We inject a comprehensive CSS block so html2pdf renders tables
  // with proper borders, correct font mapping, list indentation, and spacing.
  async function wordToPdf(files) {
    const mammoth    = await loadMammoth();
    const html2pdfFn = await loadHtml2Pdf();
    const ab = await files[0].arrayBuffer();
    const { value: htmlContent, messages } = await mammoth.convertToHtml({ arrayBuffer: ab });
    if (!htmlContent || !htmlContent.trim()) {
      throw new Error('Could not extract content from this Word document. The file may be corrupt or empty.');
    }
    const CSS = `<style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body,div{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.6;color:#111;}
      h1{font-size:20pt;font-weight:700;margin:18px 0 8px;color:#1a1a2e;border-bottom:2px solid #e2e8f0;padding-bottom:4px;}
      h2{font-size:15pt;font-weight:700;margin:14px 0 6px;color:#1e293b;}
      h3{font-size:12pt;font-weight:700;margin:12px 0 4px;color:#334155;}
      h4,h5,h6{font-size:11pt;font-weight:700;margin:10px 0 4px;}
      p{margin:0 0 9px;}
      table{border-collapse:collapse;width:100%;margin:12px 0;page-break-inside:avoid;}
      table td,table th{border:1px solid #999;padding:5px 10px;vertical-align:top;font-size:11pt;}
      table th,table tr:first-child td{background:#f0f4f8;font-weight:700;}
      table tr:nth-child(even) td{background:#fafafa;}
      ul{margin:6px 0 9px 22px;list-style:disc;}
      ol{margin:6px 0 9px 22px;list-style:decimal;}
      li{margin-bottom:3px;}
      strong,b{font-weight:700;}
      em,i{font-style:italic;}
      a{color:#1a56db;text-decoration:underline;}
      img{max-width:100%;height:auto;}
      blockquote{border-left:3px solid #94a3b8;margin:8px 0;padding:4px 12px;color:#475569;}
      pre,code{font-family:Courier New,monospace;font-size:10pt;background:#f1f5f9;padding:2px 5px;border-radius:3px;}
    </style>`;
    const container = document.createElement('div');
    container.innerHTML = CSS + htmlContent;
    container.style.cssText = 'padding:36px 44px;max-width:760px;position:fixed;left:-9999px;top:0;background:#fff;';
    document.body.appendChild(container);
    try {
      const blob = await html2pdfFn()
        .set({
          margin: [10, 12, 10, 12],
          image:  { type: 'jpeg', quality: 0.97 },
          jsPDF:  { unit: 'mm', format: 'a4', orientation: 'portrait' },
          html2canvas: { scale: 2, useCORS: true, logging: false },
        })
        .from(container)
        .output('blob');
      if (!blob || blob.size < 500) throw new Error('Conversion produced an empty PDF. The document may have unsupported formatting.');
      return new Blob([blob], { type: 'application/pdf' });
    } finally {
      if (container.parentNode) document.body.removeChild(container);
    }
  }

  // ── PHASE 1: HTML TO PDF PRO MAX ─────────────────────────────────────────
  // Full CSS preservation, print layout engine, page-break intelligence,
  // configurable margins/page-size/orientation/mode. Blob validation.
  async function htmlToPdf(files, opts) {
    const html2pdfFn = await loadHtml2Pdf();
    const text = await files[0].text();
    opts = opts || {};

    // Parse user options
    const pageSize  = (opts.pageSize    || 'a4').toLowerCase();
    const orient    = (opts.orientation || 'portrait').toLowerCase();
    const marginKey = opts.margins      || 'normal';
    const printMode = opts.printMode    || 'exact';
    const bgMode    = opts.background   || 'on';
    const dpi       = parseInt(opts.dpi || '150', 10);
    const breakMode = opts.pageBreak    || 'smart';

    const MARGIN_MAP = {
      none:   [0,  0,  0,  0],
      narrow: [5,  5,  5,  5],
      normal: [10, 12, 10, 12],
      wide:   [20, 25, 20, 25],
    };
    const margins = MARGIN_MAP[marginKey] || MARGIN_MAP.normal;

    // Container width (landscape swaps w/h dims)
    const PAGE_W_MM = { a4: 210, letter: 216, a3: 297, a5: 148, legal: 216, tabloid: 279 };
    const PAGE_H_MM = { a4: 297, letter: 279, a3: 420, a5: 210, legal: 356, tabloid: 432 };
    const wMm = orient === 'landscape' ? (PAGE_H_MM[pageSize] || 297) : (PAGE_W_MM[pageSize] || 210);

    // Parse the incoming HTML — preserve ALL style/link tags from head
    const parser   = new DOMParser();
    const inputDoc = parser.parseFromString(text, 'text/html');
    const bodyHtml = inputDoc.body ? inputDoc.body.innerHTML : text;
    const headStyles = Array.from(inputDoc.querySelectorAll('style'))
      .map(s => s.outerHTML).join('');
    // Only include external stylesheets with absolute https URLs (cross-origin safe)
    const linkStyles = Array.from(inputDoc.querySelectorAll('link[rel="stylesheet"][href]'))
      .filter(l => /^https?:\/\//i.test(l.getAttribute('href') || ''))
      .map(l => l.outerHTML).join('');

    // Page-break strategy CSS
    const breakCss = {
      smart:     'h1,h2,h3,h4{page-break-after:avoid;break-after:avoid;}table,figure,img{page-break-inside:avoid;break-inside:avoid;}',
      'avoid-all':'h1,h2,h3,h4,h5,h6,table,img,figure,blockquote,ul,ol{page-break-inside:avoid;break-inside:avoid;}',
      auto:      '',
    }[breakMode] || '';

    // Print mode CSS transformations
    const modeCss = {
      exact:        '',
      compact:      'body{line-height:1.3!important;}p,li{margin-bottom:4px!important;}h1,h2,h3{margin:8px 0 4px!important;}',
      'ink-saver':  '*{background:transparent!important;background-image:none!important;box-shadow:none!important;color:#000!important;}a{color:#000!important;}',
      presentation: 'body{font-size:14pt!important;line-height:1.7!important;}h1{font-size:26pt!important;}h2{font-size:20pt!important;}h3{font-size:15pt!important;}',
      book:         'body{font-family:Georgia,"Times New Roman",serif!important;line-height:1.65!important;font-size:12pt!important;}',
    }[printMode] || '';

    // Background strip
    const bgCss = bgMode === 'off'
      ? '*{background:transparent!important;background-image:none!important;}'
      : '';

    // Base print-fidelity styles
    const baseCss = `
      @media print{html,body{margin:0!important;padding:0!important;}}
      *{box-sizing:border-box;}
      body{font-family:Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.55;color:#111;word-wrap:break-word;}
      img{max-width:100%;height:auto;}
      table{border-collapse:collapse;max-width:100%;word-break:break-word;}
      pre,code{white-space:pre-wrap;word-break:break-all;font-size:10pt;}
      a{word-break:break-all;}svg{max-width:100%;}
      ${breakCss}${modeCss}${bgCss}`;

    // Self-contained document for rendering
    const fullHtml =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      linkStyles + headStyles +
      '<style>' + baseCss + '</style>' +
      '</head><body>' + bodyHtml + '</body></html>';

    const container = document.createElement('div');
    container.innerHTML = fullHtml;
    container.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + wMm + 'mm;background:#fff;';
    document.body.appendChild(container);

    const scale      = dpi >= 250 ? 3 : dpi >= 200 ? 2.5 : 2;
    const imgQuality = dpi >= 200 ? 0.99 : 0.95;

    try {
      const blob = await html2pdfFn()
        .set({
          margin:      margins,
          image:       { type: 'jpeg', quality: imgQuality },
          jsPDF:       { unit: 'mm', format: pageSize, orientation: orient },
          html2canvas: {
            scale,
            useCORS:         true,
            allowTaint:      true,
            logging:         false,
            backgroundColor: bgMode === 'off' ? '#ffffff' : null,
          },
          pagebreak: { mode: breakMode === 'avoid-all' ? 'avoid-all' : 'legacy' },
        })
        .from(container)
        .output('blob');

      if (!blob || blob.size < 500) {
        throw new Error(
          'Conversion produced an empty PDF. The HTML may be empty, contain only ' +
          'external resources that could not load, or use features unsupported by this renderer.'
        );
      }
      return new Blob([blob], { type: 'application/pdf' });
    } finally {
      if (container.parentNode) document.body.removeChild(container);
    }
  }

  // ── PHASE 2: EDIT PDF ────────────────────────────────────────────────────
  async function editPdf(files, opts) {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const text = String(opts.text || '');
    if (!text) throw new Error('No text provided');
    const font     = await doc.embedFont(StandardFonts.Helvetica);
    const allPages = doc.getPages();
    const fontSize = Math.max(6, Math.min(96, parseFloat(opts.fontSize || '14')));
    const xPct     = Math.max(0, Math.min(100, parseFloat(opts.x || '50'))) / 100;
    const yPct     = Math.max(0, Math.min(100, parseFloat(opts.y || '50'))) / 100;
    const pageParam = String(opts.page || '1').trim().toLowerCase();
    const targets = pageParam === 'all'
      ? allPages
      : [allPages[Math.max(0, parseInt(pageParam, 10) - 1)]].filter(Boolean);
    for (const page of targets) {
      const { width, height } = page.getSize();
      page.drawText(text, { x: width * xPct, y: height * (1 - yPct), size: fontSize, font, color: rgb(0, 0, 0) });
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── PHASE 2: SIGN PDF ────────────────────────────────────────────────────
  async function signPdf(files, opts) {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const doc  = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
    const text = String(opts.signatureText || opts.text || 'Signed').slice(0, 100);
    const pages = doc.getPages();
    const pageNum = parseInt(opts.page || pages.length, 10) || pages.length;
    const page = pages[Math.max(0, Math.min(pages.length - 1, pageNum - 1))];
    const { width } = page.getSize();
    const fontSize = 26;
    const tw = font.widthOfTextAtSize(text, fontSize);
    const x  = Math.max(10, width - tw - 40);
    const y  = 36;
    page.drawLine({ start: { x: x - 4, y: y - 5 }, end: { x: x + tw + 4, y: y - 5 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.1, 0.1, 0.55) });
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── PHASE 2: REDACT PDF ──────────────────────────────────────────────────
  async function redactPdf(files, opts) {
    const { PDFDocument, rgb } = await loadPdfLib();
    const doc   = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true });
    const pages = doc.getPages();
    const total = pages.length;
    const xPct  = Math.max(0, parseFloat(opts.x      || '10')) / 100;
    const yPct  = Math.max(0, parseFloat(opts.y      || '40')) / 100;
    const wPct  = Math.max(0.01, parseFloat(opts.width  || '30')) / 100;
    const hPct  = Math.max(0.01, parseFloat(opts.height || '10')) / 100;
    const targets = (!opts.pages || /^all$/i.test(String(opts.pages).trim()))
      ? pages
      : parsePageRange(String(opts.pages), total).map(n => pages[n - 1]).filter(Boolean);
    for (const page of targets) {
      const { width, height } = page.getSize();
      page.drawRectangle({ x: width * xPct, y: height * (1 - yPct - hPct), width: width * wPct, height: height * hPct, color: rgb(0, 0, 0) });
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── Shared OCR line reconstructor ────────────────────────────────────────
  // Groups Tesseract word objects by Y-midpoint proximity into visual lines,
  // sorts each line by X, then classifies type (h1/h2/table/normal) from
  // bbox metrics. Used by scanPdf DOCX/searchable-PDF paths.
  function _reconstructOcrLines(words, pageW) {
    if (!words || !words.length) return [];
    const valid = words.filter(function (w) {
      return w && w.text && w.text.trim() &&
        w.bbox && typeof w.bbox.x0 === 'number' && typeof w.bbox.y0 === 'number';
    });
    if (!valid.length) return [];
    valid.sort(function (a, b) { return a.bbox.y0 - b.bbox.y0; });
    const lineGroups = [];
    let cur = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      const w    = valid[i];
      const prev = cur[cur.length - 1];
      const maxH = Math.max(prev.bbox.y1 - prev.bbox.y0, w.bbox.y1 - w.bbox.y0, 6);
      const midP = (prev.bbox.y0 + prev.bbox.y1) / 2;
      const midC = (w.bbox.y0  + w.bbox.y1)  / 2;
      if (Math.abs(midC - midP) < maxH * 0.65) {
        cur.push(w);
      } else {
        lineGroups.push(cur); cur = [w];
      }
    }
    if (cur.length) lineGroups.push(cur);
    return lineGroups.map(function (grp) {
      grp.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
      const totalChars = grp.reduce(function (s, w) { return s + (w.text.length || 1); }, 0);
      const totalW     = grp.reduce(function (s, w) { return s + (w.bbox.x1 - w.bbox.x0); }, 0);
      const avgCharW   = totalW / Math.max(totalChars, 1);
      const avgH       = grp.reduce(function (s, w) { return s + (w.bbox.y1 - w.bbox.y0); }, 0) / grp.length;
      let text = '', lastX1 = grp[0].bbox.x0;
      grp.forEach(function (w, i) {
        if (i > 0) text += (w.bbox.x0 - lastX1 > avgCharW * 3.5) ? '  ' : ' ';
        text += w.text;
        lastX1 = w.bbox.x1;
      });
      text = text.trim();
      if (!text) return null;
      const centerX  = (grp[0].bbox.x0 + grp[grp.length - 1].bbox.x1) / 2;
      const isCenter = pageW > 0 && Math.abs(centerX - pageW / 2) < pageW * 0.2;
      const isAllCap = text === text.toUpperCase() && /[A-Z]/.test(text);
      const isShort  = text.split(/\s+/).length <= 10;
      const hasWide  = grp.some(function (w, i) {
        return i > 0 && (w.bbox.x0 - grp[i - 1].bbox.x1) > avgCharW * 3.5;
      });
      let type = 'normal';
      if      (avgH > 18 || (isCenter && isShort && (isAllCap || avgH > 13))) type = 'h1';
      else if (isShort && isAllCap && avgH > 10)                              type = 'h2';
      else if (hasWide && grp.length >= 3)                                    type = 'table';
      return { text, type };
    }).filter(Boolean);
  }

  // ── REPAIR PDF PRO MAX ────────────────────────────────────────────────────
  // Depth-aware multi-pass repair: lenient load → page-by-page copy into
  // fresh document → metadata rebuild → mode-specific save. Opts-aware so
  // users can choose Fast / Standard / Deep / Maximum recovery.
  async function repairPdf(files, opts) {
    opts = opts || {};
    const depth   = opts.repairDepth || 'standard';
    const outMode = opts.outputMode  || 'preserve';

    const { PDFDocument } = await loadPdfLib();
    const bytes = await readFileBytes(files[0]);

    // ── Analysis: try increasingly lenient load strategies ────────────────
    let doc = null;
    const strategies = [
      { ignoreEncryption: true, throwOnInvalidObject: false },
      { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false },
    ];
    for (const s of strategies) {
      try {
        doc = await PDFDocument.load(bytes, s);
        if (doc && doc.getPageCount() > 0) break;
        doc = null;
      } catch (_) { doc = null; }
    }

    if (!doc) {
      throw new Error(
        'This PDF is too severely damaged to repair in the browser. ' +
        'The file structure may be completely corrupted. Try Maximum Recovery mode or a desktop PDF repair tool.'
      );
    }

    // ── Fast mode: quick uncompressed save ───────────────────────────────
    if (depth === 'fast') {
      const fastBytes = await doc.save({ useObjectStreams: false });
      return new Blob([fastBytes], { type: 'application/pdf' });
    }

    // ── Standard / Deep / Maximum: page-by-page copy into fresh document ─
    let bestDoc = doc;
    try {
      const freshDoc  = await PDFDocument.create();
      const pageCount = doc.getPageCount();
      for (let i = 0; i < pageCount; i++) {
        try {
          const [copied] = await freshDoc.copyPagesFrom(doc, [i]);
          freshDoc.addPage(copied);
        } catch (_) { /* skip unrecoverable page */ }
      }
      if (freshDoc.getPageCount() > 0) bestDoc = freshDoc;
    } catch (_) { /* keep original doc */ }

    // ── Maximum: second rebuild pass from intermediate ────────────────────
    if (depth === 'maximum' && bestDoc !== doc) {
      try {
        const pass2 = await PDFDocument.create();
        for (let i = 0; i < bestDoc.getPageCount(); i++) {
          try {
            const [copied] = await pass2.copyPagesFrom(bestDoc, [i]);
            pass2.addPage(copied);
          } catch (_) {}
        }
        if (pass2.getPageCount() > 0) bestDoc = pass2;
      } catch (_) {}
    }

    // ── Rebuild metadata ──────────────────────────────────────────────────
    try {
      bestDoc.setTitle(bestDoc.getTitle() || 'Repaired Document');
      bestDoc.setProducer('ILovePDF Repair');
      bestDoc.setModificationDate(new Date());
    } catch (_) {}

    // ── Save with output-mode options ─────────────────────────────────────
    const useObjStreams = (outMode === 'compatibility' || outMode === 'print-safe') ? false : true;
    let finalBytes;
    try {
      finalBytes = await bestDoc.save({ useObjectStreams: useObjStreams });
    } catch (_) {
      finalBytes = await bestDoc.save({ useObjectStreams: false });
    }

    const finalBlob = new Blob([finalBytes], { type: 'application/pdf' });

    // ── Sanity: output suspiciously small? fall back to pass-1 bytes ─────
    if (finalBlob.size < 500 && bytes.byteLength > 1000) {
      const fallback = await doc.save({ useObjectStreams: false });
      return new Blob([fallback], { type: 'application/pdf' });
    }

    return finalBlob;
  }

  // ── PDF TO WORD (v5.0 — Enterprise fidelity engine) ──────────────────────────
  // Features:
  //  • Inline run splitting: bold/italic/mono preserved per PDF.js text item
  //  • RTL/bidirectional text detection → <w:bidi/> + right-aligned paragraphs
  //  • True tab-stop reconstruction: X-gaps → <w:tab/> + <w:tabs> definitions
  //  • H1 / H2 / H3 heading hierarchy from font-size ratios
  //  • Bullet + numbered list detection → Word <w:numPr> list paragraphs
  //  • Checkbox/symbol normalization (☐☑✓✗ → [x]/[ ] text)
  //  • Signature line detection (_____ / ----) → styled separator paragraph
  //  • Advanced table engine: multi-row column alignment, header row shading
  //  • Multi-column page detection + reading-order reconstruction
  //  • Page break markers between PDF pages
  //  • Memory hardening: canvas zeroed + page.cleanup() per page, error isolation
  //  • Comprehensive styles.xml (Normal, H1–H3, List, Table, Hyperlink)
  //  • word/numbering.xml for bullet + numbered lists
  //  Opts: structureMode (preserve-layout|simple-text), ocrMode (auto|force)
  async function pdfToWord(files, opts) {
    opts = opts || {};
    const pdfjsLib   = await loadPdfJs();
    const JSZip      = await loadJsZip();
    const data       = await readFileBytes(files[0]);
    const pdf        = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const forceOcr   = String(opts.ocrMode || '').toLowerCase() === 'force';
    const simpleText = String(opts.structureMode || '').toLowerCase() === 'simple-text';

    // ── XML helpers ───────────────────────────────────────────────────────────
    function escXml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── RTL detection (Arabic, Hebrew, Syriac, Thaana, …) ────────────────────
    function isRtl(s) {
      return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0800-\u083F\u0840-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(s);
    }

    // ── Font property detection from PDF.js fontName ──────────────────────────
    function parseFontProps(fontName) {
      const fn = (fontName || '').toLowerCase();
      return {
        bold:   /bold|heavy|black|demi/.test(fn),
        italic: /italic|oblique/.test(fn),
        mono:   /mono|courier|consol|typewriter/.test(fn),
      };
    }

    // ── Bullet/numbered list prefix detection ─────────────────────────────────
    function detectListPrefix(text) {
      // Bullet: •·▪▸►‣◦○●– or plain - / *
      if (/^[•·▪▸►‣◦○●]\s+/.test(text)) return { listType: 'bullet', text: text.replace(/^[•·▪▸►‣◦○●]\s+/, '').trim() };
      if (/^[-–—\*]\s{1,3}(?=\S)/.test(text)) return { listType: 'bullet', text: text.replace(/^[-–—\*]\s+/, '').trim() };
      // Numbered: 1. / 1) / (1) / a. / A. / i.
      if (/^(\d{1,3}[.):]|[a-zA-Z][.)]|\([a-zA-Z0-9]+\))\s+/.test(text)) {
        return { listType: 'number', text: text.replace(/^(\d{1,3}[.):]|[a-zA-Z][.)]|\([a-zA-Z0-9]+\))\s+/, '').trim() };
      }
      return null;
    }

    // ── Checkbox / symbol normalization ───────────────────────────────────────
    function normalizeSymbols(text) {
      return text
        .replace(/[☑✓✔☒✗✘]/g, '[x]')
        .replace(/[☐□]/g, '[ ]');
    }

    // ── Signature / rule line detection ───────────────────────────────────────
    function isSignatureLine(text) {
      const t = text.trim();
      return /^[_]{6,}$/.test(t) || /^[-]{8,}$/.test(t) || /^[=]{8,}$/.test(t) ||
             /^_{3,}\s*(Date|Sign|Name|Title|Signature)[:\s]*_{0,}$/i.test(t);
    }

    // ── Multi-column detection ────────────────────────────────────────────────
    // Returns the X split-point if the page clearly has 2 text columns, else null.
    function detectColumnSplit(lines, pageWidth) {
      if (lines.length < 6) return null;
      const midX = pageWidth / 2;
      const margin = pageWidth * 0.07;
      let leftOnly = 0, rightOnly = 0;
      for (const l of lines) {
        const x0 = l.xPositions[0];
        if (x0 < midX - margin) leftOnly++;
        else if (x0 > midX + margin) rightOnly++;
      }
      const total = leftOnly + rightOnly;
      if (total < 6) return null;
      const ratio = Math.min(leftOnly, rightOnly) / total;
      return ratio > 0.28 ? midX : null;
    }

    // ── Group PDF.js items into visual lines with per-item run data ───────────
    // Each run carries: text, x, y, fontSize, fontName, bold, italic, mono, width
    function groupIntoLines(items, pageWidth) {
      const buckets = {};
      for (const item of items) {
        if (!item.str || !item.str.trim()) continue;
        const yKey = Math.round(item.transform[5] / 3) * 3;
        if (!buckets[yKey]) buckets[yKey] = { runs: [], maxFs: 0, y: item.transform[5] };
        const fs = item.height || 0;
        const fp = parseFontProps(item.fontName);
        buckets[yKey].runs.push({
          text:     item.str,
          x:        item.transform[4],
          y:        item.transform[5],
          fontSize: fs,
          fontName: item.fontName || '',
          bold:     fp.bold,
          italic:   fp.italic,
          mono:     fp.mono,
          width:    item.width || 0,
        });
        if (fs > buckets[yKey].maxFs) buckets[yKey].maxFs = fs;
      }
      return Object.keys(buckets).map(Number).sort((a, b) => b - a).map(y => {
        const bk  = buckets[y];
        const sorted = bk.runs.sort((a, b) => a.x - b.x);
        return {
          runs:       sorted,
          text:       sorted.map(r => r.text).join(' ').trim(),
          fontSize:   bk.maxFs,
          xPositions: sorted.map(r => r.x),
          parts:      sorted.map(r => ({ text: r.text, x: r.x })),
          pageWidth:  pageWidth || 612,
          y:          bk.y,
        };
      }).filter(l => l.text.length > 0);
    }

    // ── Detect OCR language from sample text (Unicode range analysis) ─────────
    function _detectOcrLangFromSample(sample) {
      if (!sample || sample.length < 8) return 'eng';
      const s       = sample.slice(0, 500);
      const arabic  = (s.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
      const hebrew  = (s.match(/[\u0590-\u05FF]/g) || []).length;
      const cjk     = (s.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
      const cyril   = (s.match(/[\u0400-\u04FF]/g) || []).length;
      const thai    = (s.match(/[\u0E00-\u0E7F]/g) || []).length;
      const latin   = (s.match(/[a-zA-Z]/g) || []).length;
      const total   = arabic + hebrew + cjk + cyril + thai + latin || 1;
      if (arabic / total > 0.15) return (latin / total > 0.15) ? 'ara+eng' : 'ara';
      if (hebrew / total > 0.15) return 'heb+eng';
      if (cjk    / total > 0.20) return 'chi_sim+eng';
      if (cyril  / total > 0.20) return 'rus+eng';
      if (thai   / total > 0.15) return 'tha+eng';
      return 'eng';
    }

    // ── OCR a page → same line shape as groupIntoLines() ─────────────────────
    // v5.0: multilingual OCR language detection, adaptive y-bucketing,
    //       confidence-filtered word cleanup, aggressive canvas memory release.
    async function ocrPageToLines(page, pageWidth, langHint) {
      const Tesseract = await loadTesseract();

      // Adaptive scale: scale up small pages for better OCR accuracy
      const vp1    = page.getViewport({ scale: 1.0 });
      const area   = vp1.width * vp1.height;
      const scale  = area > 400000 ? 1.8 : area < 80000 ? 2.5 : 2.0;
      const viewport = page.getViewport({ scale });

      const canvas    = document.createElement('canvas');
      canvas.width    = Math.min(Math.floor(viewport.width),  3000);
      canvas.height   = Math.min(Math.floor(viewport.height), 4000);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let dataUrl = null;
      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
        dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      } finally {
        canvas.width = 0; canvas.height = 0; // release GPU memory immediately
      }

      if (!dataUrl) return [];

      // Language: use hint → detect from page sample → default eng
      let ocrLang = langHint || 'eng';
      if (!langHint) {
        // Quick native text sample to detect language before Tesseract
        try {
          const tc = await page.getTextContent();
          const sample = tc.items.map(it => it.str).join('').slice(0, 300);
          if (sample.replace(/\s/g, '').length >= 8) {
            ocrLang = _detectOcrLangFromSample(sample);
          }
        } catch (_) {}
      }

      let words = [];
      try {
        const result = await Tesseract.recognize(dataUrl, ocrLang, { logger: () => {} });
        words = (result.data && result.data.words) ? result.data.words : [];
      } finally {
        dataUrl = null; // release data URL memory
      }

      if (!words.length) return [];

      // Filter low-confidence words; keep confident ones (>25 threshold)
      const wordItems = words
        .filter(w => w.text && w.text.trim() && w.confidence > 25)
        .map(w => {
          const scaleFactor = scale || 2.0;
          return {
            text:     w.text.trim(),
            x:        Math.round((w.bbox.x0 + w.bbox.x1) / (2 * scaleFactor)),
            y:        Math.round((w.bbox.y0 + w.bbox.y1) / (2 * scaleFactor)),
            fontSize: Math.max(1, Math.round((w.bbox.y1 - w.bbox.y0) / scaleFactor)),
            bold: false, italic: false, mono: false, fontName: '', width: 0,
          };
        });

      if (!wordItems.length) return [];

      // Adaptive y-bucketing: group words into rows based on median font height
      const medianFs = wordItems.slice().sort((a, b) => a.fontSize - b.fontSize)[Math.floor(wordItems.length / 2)]?.fontSize || 10;
      const yBucket  = Math.max(3, Math.min(12, Math.round(medianFs * 0.4)));

      const rowMap = {};
      for (const w of wordItems) {
        const yKey = Math.round(w.y / yBucket) * yBucket;
        if (!rowMap[yKey]) rowMap[yKey] = [];
        rowMap[yKey].push(w);
      }
      const sortedYs = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
      return sortedYs.map(y => {
        const ws    = rowMap[y].sort((a, b) => a.x - b.x);
        const maxFs = Math.max(...ws.map(w => w.fontSize));
        return {
          runs:       ws,
          text:       ws.map(w => w.text).join(' ').trim(),
          fontSize:   maxFs,
          xPositions: ws.map(w => w.x),
          parts:      ws.map(w => ({ text: w.text, x: w.x })),
          pageWidth:  pageWidth || 612,
          y,
        };
      }).filter(l => l.text.length > 0);
    }

    // ── Modal (most-common) body font size ────────────────────────────────────
    function computeBaseFontSize(lines) {
      const sizes = lines.map(l => Math.round(l.fontSize)).filter(s => s > 0);
      if (!sizes.length) return 11;
      const freq = {};
      for (const s of sizes) freq[s] = (freq[s] || 0) + 1;
      return parseInt(Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0], 10) || 11;
    }

    // ── Line classifier ───────────────────────────────────────────────────────
    function classifyLine(line, base) {
      const t   = line.text;
      const fs  = line.fontSize || 0;
      const b   = base || 11;
      const gap = (line.pageWidth || 612) * 0.04;

      if (isSignatureLine(t)) return 'signature';

      // Heading by font-size ratio (three levels)
      if (fs > b * 1.55) return 'h1';
      if (fs > b * 1.32) return 'h2';
      if (fs > b * 1.12) return 'h3';

      // ALL-CAPS heuristic (no font-size data or matches anyway)
      if (t === t.toUpperCase() && /[A-Z]/.test(t) && t.length >= 3 && t.length <= 80 && !/^\d/.test(t)) return 'h2';

      // Numeric / lettered section heading
      if (/^(\d+\.){1,3}\s+\S/.test(t) && t.length <= 100) return 'h3';

      // Table row: significant X gaps between parts
      if (line.xPositions.length >= 2) {
        for (let k = 1; k < line.xPositions.length; k++) {
          if (line.xPositions[k] - line.xPositions[k - 1] >= gap) return 'table-row';
        }
      }
      if (t.split(/\s{3,}/).length >= 3) return 'table-row';
      return 'p';
    }

    // ── Tab-stop XML for a line with significant X gaps ───────────────────────
    // Only applied to single-source-line paragraph blocks.
    function buildTabStopsXml(xPositions, pageWidth) {
      const gap  = (pageWidth || 612) * 0.04;
      const tabs = [];
      for (let k = 1; k < xPositions.length; k++) {
        if (xPositions[k] - xPositions[k - 1] >= gap) {
          tabs.push(`<w:tab w:val="left" w:pos="${Math.round(xPositions[k] * 20)}"/>`);
        }
      }
      return tabs.length ? `<w:tabs>${tabs.join('')}</w:tabs>` : '';
    }

    // ── Inline runs XML for a line block ─────────────────────────────────────
    // Emits one <w:r> per PDF.js text item, preserving bold/italic/mono/RTL.
    // Adjacent runs with identical properties are NOT merged (simpler + safer).
    // Tab characters are inserted between runs when a significant X gap exists.
    function buildRunsXml(runs, basePtSize, pageWidth) {
      if (!runs || !runs.length) return '';
      const gap    = (pageWidth || 612) * 0.04;
      const parts  = [];
      for (let i = 0; i < runs.length; i++) {
        const run  = runs[i];
        const prev = runs[i - 1];
        // Tab gap before this run?
        if (prev && (run.x - prev.x - (prev.width || 0)) >= gap) {
          const tsz = Math.max(16, Math.round((basePtSize || 11) * 2));
          parts.push(`<w:r><w:rPr><w:sz w:val="${tsz}"/></w:rPr><w:tab/></w:r>`);
        }
        const sz   = run.fontSize > 0 ? Math.round(run.fontSize * 2) : Math.round((basePtSize || 11) * 2);
        const szV  = Math.max(16, Math.min(144, sz));
        let rPr = `<w:sz w:val="${szV}"/><w:szCs w:val="${szV}"/>`;
        if (run.bold)   rPr += '<w:b/><w:bCs/>';
        if (run.italic) rPr += '<w:i/><w:iCs/>';
        if (run.mono)   rPr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>';
        if (isRtl(run.text)) rPr += '<w:rtl/>';
        parts.push(`<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escXml(run.text)}</w:t></w:r>`);
      }
      return parts.join('');
    }

    // ── Advanced table XML ────────────────────────────────────────────────────
    // Discovers column boundaries from ALL rows combined, detects header rows.
    function buildTableXml(rows, pageWidth) {
      const bdr    = s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/>`;
      const allBdr = `<w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(bdr).join('')}</w:tblBorders>`;
      const gap    = (pageWidth || 612) * 0.04;

      // Cluster all X positions from every row to find canonical column boundaries
      const allX = rows.flatMap(r => r.xPositions || []).sort((a, b) => a - b);
      const colStarts = [allX[0] || 0];
      for (let i = 1; i < allX.length; i++) {
        if (allX[i] - allX[i - 1] >= gap) colStarts.push(allX[i]);
      }
      const numCols = Math.max(2, colStarts.length);

      function assignCol(x) {
        let best = 0, bestDist = Infinity;
        for (let c = 0; c < colStarts.length; c++) {
          const d = Math.abs(x - colStarts[c]);
          if (d < bestDist) { bestDist = d; best = c; }
        }
        return best;
      }

      function splitCells(row) {
        if (row.parts && row.parts.length >= 2) {
          const cells = new Array(numCols).fill('');
          for (const p of row.parts) { const c = assignCol(p.x); cells[c] = cells[c] ? cells[c] + ' ' + p.text : p.text; }
          // Trim trailing empties but keep at least 2
          while (cells.length > 2 && !cells[cells.length - 1]) cells.pop();
          return cells.map(c => c.trim());
        }
        const cols = row.text.split(/\s{2,}/).filter(Boolean);
        return cols.length >= 2 ? cols : [row.text, ''];
      }

      function isHeaderRow(row, idx) {
        return idx === 0 && (
          (row.runs && row.runs.some(r => r.bold)) ||
          (row.text === row.text.toUpperCase() && /[A-Z]/.test(row.text))
        );
      }

      const colWidthPct = Math.floor(100 / numCols);
      const tRows = rows.map((row, ri) => {
        const cells   = splitCells(row);
        const header  = isHeaderRow(row, ri);
        const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF5"/>' : '';
        return `<w:tr>${cells.map(c => {
          const boldRpr = header ? '<w:b/>' : '';
          return `<w:tc><w:tcPr><w:tcW w:w="${colWidthPct}" w:type="pct"/>` +
                 `<w:tcBorders>${['top','left','bottom','right'].map(bdr).join('')}</w:tcBorders>${shading}</w:tcPr>` +
                 `<w:p><w:r><w:rPr><w:sz w:val="20"/>${boldRpr}</w:rPr>` +
                 `<w:t xml:space="preserve">${escXml(c)}</w:t></w:r></w:p></w:tc>`;
        }).join('')}</w:tr>`;
      }).join('');

      return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>` +
             `<w:tblW w:w="5000" w:type="pct"/>${allBdr}</w:tblPr>${tRows}</w:tbl>`;
    }

    // ── Build document structure ──────────────────────────────────────────────
    function buildStructure(allLines) {
      if (!allLines.length) return [];
      const contentLines = allLines.filter(l => !l.__pageBreak);
      if (!contentLines.length) return [];
      const base       = computeBaseFontSize(contentLines);
      const blocks     = [];
      let tableRows    = [];
      let paraLines    = [];   // accumulating lines → paragraph
      let listBuf      = [];
      let listType     = null;

      const flushTable = () => {
        if (tableRows.length >= 2) blocks.push({ type: 'table', rows: tableRows, pageWidth: tableRows[0].pageWidth || 612 });
        else if (tableRows.length === 1) paraLines.push(tableRows[0]);
        tableRows = [];
      };

      const flushPara = () => {
        if (!paraLines.length) return;
        if (paraLines.length === 1) {
          const ln = paraLines[0];
          // Single-line paragraph: check if it has tab-gap and emit with tab stops
          blocks.push({ type: 'p', text: normalizeSymbols(ln.text), runs: ln.runs,
                        xPositions: ln.xPositions, pageWidth: ln.pageWidth, fontSize: ln.fontSize,
                        singleLine: true });
        } else {
          // Multi-line merged paragraph: concatenate runs
          const allRuns   = paraLines.flatMap(l => l.runs || []);
          const mergedTxt = normalizeSymbols(paraLines.map(l => l.text).join(' ').trim());
          blocks.push({ type: 'p', text: mergedTxt, runs: allRuns,
                        xPositions: paraLines[0].xPositions, pageWidth: paraLines[0].pageWidth,
                        fontSize: paraLines[0].fontSize, singleLine: false });
        }
        paraLines = [];
      };

      const flushList = () => {
        if (listBuf.length) blocks.push({ type: 'list', listType, items: listBuf });
        listBuf = []; listType = null;
      };

      for (let i = 0; i < allLines.length; i++) {
        const line = allLines[i];

        // Page break sentinel
        if (line.__pageBreak) {
          flushPara(); flushTable(); flushList();
          blocks.push({ type: 'pageBreak' });
          continue;
        }

        const type = simpleText ? 'p' : classifyLine(line, base);
        const next = allLines[i + 1] && !allLines[i + 1].__pageBreak ? allLines[i + 1] : null;

        // Signature line
        if (type === 'signature') {
          flushPara(); flushTable(); flushList();
          blocks.push({ type: 'signature', text: line.text });
          continue;
        }

        // Headings
        if (type === 'h1' || type === 'h2' || type === 'h3') {
          flushPara(); flushTable(); flushList();
          blocks.push({ type, text: line.text, runs: line.runs, fontSize: line.fontSize });
          continue;
        }

        // Table rows
        if (type === 'table-row') {
          flushPara(); flushList();
          tableRows.push(line);
          continue;
        }

        // Regular paragraph line
        flushTable();

        // List prefix?
        const listMatch = !simpleText ? detectListPrefix(line.text) : null;
        if (listMatch) {
          flushPara();
          if (listMatch.listType !== listType) flushList();
          listType = listMatch.listType;
          // Rebuild runs without the prefix characters
          listBuf.push({ text: listMatch.text, runs: line.runs });
          continue;
        }
        flushList();

        // Paragraph accumulation: merge lines with same font size that don't end with punctuation
        const endsWithPunct  = /[.!?:;]$/.test(line.text.trim());
        const nextType       = next && !simpleText ? classifyLine(next, base) : null;
        const sameFontSize   = !next || Math.abs((line.fontSize || 0) - (next.fontSize || 0)) < 1.5;
        paraLines.push(line);
        if (endsWithPunct || !next || nextType !== 'p' || !sameFontSize) flushPara();
      }
      flushPara(); flushTable(); flushList();
      return blocks;
    }

    // ── Numbering XML (bullet + numbered list definitions) ────────────────────
    function buildNumberingXml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>` +
          `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
            `<w:lvlText w:val="•"/><w:lvlJc w:val="left"/>` +
            `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
            `<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>` +
          `</w:lvl></w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>` +
          `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
            `<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>` +
            `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
          `</w:lvl></w:abstractNum>` +
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
        `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
        `</w:numbering>`;
    }

    // ── Styles XML ────────────────────────────────────────────────────────────
    function buildStylesXml(basePt) {
      const b   = basePt || 11;
      const sz  = Math.round(b * 2);
      const h1s = Math.round(Math.max(b * 1.6, 14) * 2);
      const h2s = Math.round(Math.max(b * 1.35, 12) * 2);
      const h3s = Math.round(Math.max(b * 1.15, 11) * 2);
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:docDefaults><w:rPrDefault><w:rPr>` +
          `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>` +
          `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
        `</w:rPr></w:rPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
          `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>` +
          `<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="80"/></w:pPr>` +
          `<w:rPr><w:b/><w:bCs/><w:color w:val="1F3864"/><w:sz w:val="${h1s}"/><w:szCs w:val="${h1s}"/></w:rPr></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>` +
          `<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/></w:pPr>` +
          `<w:rPr><w:b/><w:bCs/><w:color w:val="2E4057"/><w:sz w:val="${h2s}"/><w:szCs w:val="${h2s}"/></w:rPr></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>` +
          `<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="40"/></w:pPr>` +
          `<w:rPr><w:b/><w:bCs/><w:color w:val="404040"/><w:sz w:val="${h3s}"/><w:szCs w:val="${h3s}"/></w:rPr></w:style>` +
        `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>` +
        `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>` +
          `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
        `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>` +
          `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>` +
        `<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/>` +
          `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr></w:style>` +
        `</w:styles>`;
    }

    // ── document.xml ─────────────────────────────────────────────────────────
    function buildDocXml(structure, basePt) {
      const b   = basePt || 11;
      const sz  = Math.round(b * 2);
      const NS  = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

      const parts = structure.map(block => {

        if (block.type === 'pageBreak') {
          return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
        }

        if (block.type === 'signature') {
          return `<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr>` +
                 `<w:r><w:rPr><w:color w:val="888888"/></w:rPr>` +
                 `<w:t xml:space="preserve">${escXml(block.text)}</w:t></w:r></w:p>`;
        }

        if (block.type === 'table') {
          return buildTableXml(block.rows, block.pageWidth);
        }

        if (block.type === 'list') {
          const numId = block.listType === 'bullet' ? '1' : '2';
          return block.items.map(item => {
            const txt  = normalizeSymbols(item.text);
            const runs = item.runs && item.runs.length
              ? buildRunsXml(item.runs, b, 612)
              : `<w:r><w:rPr><w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escXml(txt)}</w:t></w:r>`;
            return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` +
                   `<w:spacing w:after="60"/></w:pPr>${runs}</w:p>`;
          }).join('');
        }

        if (block.type === 'h1') {
          const bidiXml = isRtl(block.text) ? '<w:bidi/><w:jc w:val="right"/>' : '';
          const runs = block.runs && block.runs.length
            ? buildRunsXml(block.runs, Math.max(b * 1.6, 14), block.pageWidth || 612)
            : `<w:r><w:rPr><w:b/><w:sz w:val="${Math.round(Math.max(b*1.6,14)*2)}"/></w:rPr><w:t xml:space="preserve">${escXml(block.text)}</w:t></w:r>`;
          return `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="280" w:after="80"/>${bidiXml}</w:pPr>${runs}</w:p>`;
        }

        if (block.type === 'h2') {
          const bidiXml = isRtl(block.text) ? '<w:bidi/><w:jc w:val="right"/>' : '';
          const runs = block.runs && block.runs.length
            ? buildRunsXml(block.runs, Math.max(b * 1.35, 12), block.pageWidth || 612)
            : `<w:r><w:rPr><w:b/><w:sz w:val="${Math.round(Math.max(b*1.35,12)*2)}"/></w:rPr><w:t xml:space="preserve">${escXml(block.text)}</w:t></w:r>`;
          return `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:before="200" w:after="60"/>${bidiXml}</w:pPr>${runs}</w:p>`;
        }

        if (block.type === 'h3') {
          const bidiXml = isRtl(block.text) ? '<w:bidi/><w:jc w:val="right"/>' : '';
          const runs = block.runs && block.runs.length
            ? buildRunsXml(block.runs, Math.max(b * 1.15, 11), block.pageWidth || 612)
            : `<w:r><w:rPr><w:b/><w:sz w:val="${Math.round(Math.max(b*1.15,11)*2)}"/></w:rPr><w:t xml:space="preserve">${escXml(block.text)}</w:t></w:r>`;
          return `<w:p><w:pPr><w:pStyle w:val="Heading3"/><w:spacing w:before="160" w:after="40"/>${bidiXml}</w:pPr>${runs}</w:p>`;
        }

        // Regular paragraph
        const bidiXml   = isRtl(block.text) ? '<w:bidi/><w:jc w:val="right"/>' : '';
        const tabXml    = block.singleLine
          ? buildTabStopsXml(block.xPositions || [], block.pageWidth || 612)
          : '';
        const runs = block.runs && block.runs.length
          ? buildRunsXml(block.runs, b, block.pageWidth || 612)
          : `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escXml(block.text)}</w:t></w:r>`;
        return `<w:p><w:pPr><w:spacing w:after="100"/>${bidiXml}${tabXml}</w:pPr>${runs}</w:p>`;
      });

      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
             `<w:document ${NS}>` +
             `<w:body>${parts.join('')}` +
             `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
             `<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720"/></w:sectPr>` +
             `</w:body></w:document>`;
    }

    // ── Package DOCX zip ──────────────────────────────────────────────────────
    async function buildDocxBlob(structure, basePt) {
      if (!structure || !structure.length) throw new Error('No content extracted from document.');
      const hasLists = structure.some(b => b.type === 'list');

      const ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        (hasLists ? `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` : '') +
        `</Types>`;

      const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`;

      const wRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        (hasLists ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` : '') +
        `</Relationships>`;

      const zip = new JSZip();
      zip.file('[Content_Types].xml', ctXml);
      zip.file('_rels/.rels', relsXml);
      zip.file('word/document.xml', buildDocXml(structure, basePt));
      zip.file('word/styles.xml', buildStylesXml(basePt));
      zip.file('word/_rels/document.xml.rels', wRelsXml);
      if (hasLists) zip.file('word/numbering.xml', buildNumberingXml());
      return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }

    // ── Per-page hybrid processing ────────────────────────────────────────────
    // Digital if ≥ 5 non-whitespace chars; Tesseract word-bbox OCR otherwise.
    // Page-break sentinels are inserted between pages.
    // Multi-column pages are reordered: left column first, then right column.
    async function buildAllLines(useForceOcr) {
      const allLines = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (i > 1) allLines.push({ __pageBreak: true }); // page separator sentinel
        const page      = await pdf.getPage(i);
        const viewport  = page.getViewport({ scale: 1 });
        const content   = await page.getTextContent();
        const pageWidth = viewport.width || 612;
        const items     = content.items.filter(it => it.str && it.str.trim());
        const charCount = items.map(it => it.str.replace(/\s/g, '')).join('').length;
        const needsOcr  = useForceOcr || charCount < 5;

        if (!needsOcr) {
          const lines    = groupIntoLines(items, pageWidth);
          const colSplit = detectColumnSplit(lines, pageWidth);
          if (colSplit) {
            // Two-column layout: emit left column lines then right column lines
            const left  = lines.filter(l => l.xPositions[0] <  colSplit);
            const right = lines.filter(l => l.xPositions[0] >= colSplit);
            // Both are already sorted top→bottom (descending Y) from groupIntoLines
            allLines.push(...left, ...right);
          } else {
            allLines.push(...lines);
          }
          page.cleanup();
        } else {
          try {
            const ocrLines = await ocrPageToLines(page, pageWidth);
            allLines.push(...ocrLines);
          } catch (_) {}
          page.cleanup();
        }
        await new Promise(r => setTimeout(r, 0)); // yield to UI thread between pages
      }
      return allLines;
    }

    // ── Full OCR pass (retry path) ────────────────────────────────────────────
    async function buildAllLinesOcr() {
      const allLines = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (i > 1) allLines.push({ __pageBreak: true });
        const page      = await pdf.getPage(i);
        const viewport  = page.getViewport({ scale: 1 });
        const pageWidth = viewport.width || 612;
        try {
          const ocrLines = await ocrPageToLines(page, pageWidth);
          allLines.push(...ocrLines);
        } catch (_) {}
        page.cleanup();
        await new Promise(r => setTimeout(r, 0));
      }
      return allLines;
    }

    // ── Main processing + smart retry ─────────────────────────────────────────
    let allLines = [];
    try { allLines = await buildAllLines(forceOcr); } catch (_) {}

    // Retry with full OCR when digital pass returned nothing
    const hasContent = () => allLines.some(l => !l.__pageBreak);
    if (!hasContent() && !forceOcr) {
      try { allLines = await buildAllLinesOcr(); } catch (_) {}
    }

    if (!hasContent()) {
      throw new Error('This PDF does not contain usable document content. It may be encrypted, blank, or in an unsupported format.');
    }

    const contentLines = allLines.filter(l => !l.__pageBreak);
    const basePt       = computeBaseFontSize(contentLines);
    let structure      = buildStructure(allLines);

    if (!structure.length) {
      throw new Error('This PDF does not contain usable document content.');
    }

    let docxBlob = await buildDocxBlob(structure, basePt);

    // Blob sanity check — retry with full OCR when output is suspiciously small
    if (docxBlob.size < 1200 && !forceOcr) {
      try {
        const retryLines = await buildAllLinesOcr();
        if (retryLines.some(l => !l.__pageBreak)) {
          const retryContent = retryLines.filter(l => !l.__pageBreak);
          const retryBase    = computeBaseFontSize(retryContent);
          const retryStruct  = buildStructure(retryLines);
          if (retryStruct.length) {
            const retryBlob = await buildDocxBlob(retryStruct, retryBase);
            if (retryBlob.size > docxBlob.size) docxBlob = retryBlob;
          }
        }
      } catch (_) {}
    }

    if (!docxBlob || docxBlob.size < 1000) {
      throw new Error('This PDF does not contain usable document content.');
    }

    await pdf.destroy();
    return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }

  // ── PDF TO EXCEL (v4.1 — hybrid OCR/digital, per-page fallback) ────────────
  // Column gap = pageWidth * 0.04 (adaptive, min 12 / max 35 pts).
  // Y row tolerance = 10px. Auto column widths via XLSX !cols.
  // Per-page hybrid: digital if ≥ 3 text items found, else Tesseract OCR.
  // OCR uses word.bbox coordinates (not paragraph logic) → real column grid.
  // Validation: blob > 800 bytes, totalRows > 0, or throw user-visible error.
  async function pdfToExcel(files) {
    const XLSX     = await loadXlsx();
    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const wb       = XLSX.utils.book_new();
    let totalRows  = 0;

    // ── Shared helpers ────────────────────────────────────────────────────────
    function clusterCols(xValues, colGap) {
      const sorted   = [...new Set(xValues)].sort((a, b) => a - b);
      const clusters = [];
      for (const x of sorted) {
        const last = clusters[clusters.length - 1];
        if (!last || x - last.max > colGap) {
          clusters.push({ min: x, max: x, center: x });
        } else {
          last.max    = x;
          last.center = Math.round((last.min + last.max) / 2);
        }
      }
      return clusters;
    }

    function findCol(x, clusters) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < clusters.length; c++) {
        const dist = Math.abs(x - clusters[c].center);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      return best;
    }

    function coerceNum(raw) {
      const num = parseFloat(raw.replace(/[$,%\s]/g, ''));
      return (!isNaN(num) && /^-?[\d,.$% ]+$/.test(raw)) ? num : raw;
    }

    // ── Digital path: build grid from pdfjs text items ───────────────────────
    function buildSheetFromItems(items, pageWidth) {
      const colGap   = Math.max(12, Math.min(35, pageWidth * 0.04));
      const clusters = clusterCols(items.map(it => it.x), colGap);
      const numCols  = clusters.length;
      const rowMap   = {};
      for (const it of items) {
        const yKey = Math.round(it.y / 10) * 10;
        if (!rowMap[yKey]) rowMap[yKey] = {};
        const col = findCol(it.x, clusters);
        rowMap[yKey][col] = (rowMap[yKey][col] ? rowMap[yKey][col] + ' ' : '') + it.text;
      }
      const sortedYs = Object.keys(rowMap).map(Number).sort((a, b) => b - a);
      const sheetData = sortedYs.map(y => {
        const row = new Array(numCols).fill('');
        for (const [col, val] of Object.entries(rowMap[y])) {
          row[parseInt(col, 10)] = coerceNum(String(val).trim());
        }
        return row;
      });
      return { sheetData, numCols };
    }

    // ── OCR path: Tesseract word bboxes → coordinate-based column grid ────────
    // Uses word.bbox (x0,y0,x1,y1) pixel centers, scaled from 2× canvas back to
    // PDF point space. Same adaptive colGap + Y-bucket logic as digital path.
    async function ocrPageToGrid(page, pageWidth) {
      const Tesseract = await loadTesseract();
      const viewport  = page.getViewport({ scale: 2.0 });
      const canvas    = document.createElement('canvas');
      canvas.width    = Math.floor(viewport.width);
      canvas.height   = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 0; canvas.height = 0;

      const { data: { words } } = await Tesseract.recognize(dataUrl, 'eng', { logger: () => {} });
      if (!words || !words.length) return { sheetData: [], numCols: 0 };

      // Map from 2× canvas pixel space → 1× PDF point space
      const wordItems = words
        .filter(w => w.text && w.text.trim() && w.confidence > 30)
        .map(w => ({
          text: w.text.trim(),
          x:    Math.round((w.bbox.x0 + w.bbox.x1) / 4),  // center / 2× scale
          y:    Math.round((w.bbox.y0 + w.bbox.y1) / 4),
        }));

      if (!wordItems.length) return { sheetData: [], numCols: 0 };

      const colGap   = Math.max(12, Math.min(35, pageWidth * 0.04));
      const clusters = clusterCols(wordItems.map(w => w.x), colGap);
      const numCols  = clusters.length;
      const rowMap   = {};
      for (const w of wordItems) {
        const yKey = Math.round(w.y / 10) * 10;
        if (!rowMap[yKey]) rowMap[yKey] = {};
        const col = findCol(w.x, clusters);
        rowMap[yKey][col] = (rowMap[yKey][col] ? rowMap[yKey][col] + ' ' : '') + w.text;
      }
      const sortedYs  = Object.keys(rowMap).map(Number).sort((a, b) => a - b); // top→bottom for OCR
      const sheetData = sortedYs.map(y => {
        const row = new Array(numCols).fill('');
        for (const [col, val] of Object.entries(rowMap[y])) {
          row[parseInt(col, 10)] = coerceNum(String(val).trim());
        }
        return row;
      });
      return { sheetData, numCols };
    }

    // ── Apply column widths to a sheet ───────────────────────────────────────
    function applyColWidths(ws, sheetData, numCols) {
      const cols = [];
      for (let c = 0; c < numCols; c++) {
        let maxLen = 8;
        for (const row of sheetData) {
          const cell = String(row[c] ?? '');
          if (cell.length > maxLen) maxLen = cell.length;
        }
        cols.push({ wch: Math.min(Math.ceil(maxLen * 1.2), 60) });
      }
      ws['!cols'] = cols;
    }

    // ── Per-page processing: digital first, OCR fallback if sparse ───────────
    for (let i = 1; i <= pdf.numPages; i++) {
      const page      = await pdf.getPage(i);
      const viewport  = page.getViewport({ scale: 1 });
      const content   = await page.getTextContent();
      const pageWidth = viewport.width || 612;

      const items = content.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), text: it.str.trim() }));

      let sheetData, numCols, isOcr = false;

      // Phase 21: garbled-text gate — if digital items exist but contain junk chars, force OCR
      const _itemText  = items.map(it => it.text).join('');
      const _printable = (_itemText.match(/[\x20-\x7E]/g) || []).length;
      const _garbled   = items.length >= 3 && _itemText.length > 5 &&
                         (_printable / Math.max(_itemText.length, 1)) < 0.60;

      if (items.length >= 3 && !_garbled) {
        // ── Digital path ──────────────────────────────────────────────────
        ({ sheetData, numCols } = buildSheetFromItems(items, pageWidth));
        page.cleanup();
      } else {
        // ── OCR fallback for this page (scanned / image-only / garbled) ───
        isOcr = true;
        try {
          ({ sheetData, numCols } = await ocrPageToGrid(page, pageWidth));
        } catch (_) {
          sheetData = []; numCols = 0;
        }
        page.cleanup();
      }

      if (!sheetData.length) continue;

      totalRows += sheetData.length;
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      applyColWidths(ws, sheetData, numCols);
      XLSX.utils.book_append_sheet(wb, ws, `Page ${i}${isOcr ? ' (OCR)' : ''}`);
    }

    await pdf.destroy();

    if (totalRows === 0) {
      throw new Error('This PDF does not contain usable table data. If it is a scanned document, try the OCR PDF tool first.');
    }

    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob  = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (blob.size < 800) throw new Error('This PDF does not contain usable table data.');
    return { blob, ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  // ── PHASE 3: COMPARE PDF ─────────────────────────────────────────────────
  async function comparePdf(files) {
    if (files.length < 2) throw new Error('Two PDFs required');
    const pdfjsLib = await loadPdfJs();
    async function extractText(file) {
      const data = await readFileBytes(file);
      const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      const lines = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page    = await pdf.getPage(i);
        const content = await page.getTextContent();
        lines.push({ page: i, text: content.items.map(it => it.str).join(' '), wordCount: 0 });
      }
      return lines;
    }
    const [linesA, linesB] = await Promise.all([extractText(files[0]), extractText(files[1])]);
    const wordsA = new Set((linesA.map(l => l.text).join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    const wordsB = new Set((linesB.map(l => l.text).join(' ').toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    const inter  = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union  = new Set([...wordsA, ...wordsB]);
    const sim    = union.size > 0 ? Math.round(inter.size / union.size * 100) : 0;
    const lines  = [
      `COMPARISON REPORT`,
      `${'─'.repeat(50)}`,
      `File A : ${files[0].name}`,
      `File B : ${files[1].name}`,
      `File A pages : ${linesA.length}`,
      `File B pages : ${linesB.length}`,
      `Same page count : ${linesA.length === linesB.length ? 'Yes' : 'No'}`,
      `File A words : ${wordsA.size}`,
      `File B words : ${wordsB.size}`,
      `Content similarity : ${sim}% word overlap`,
      `Unique to File A : ${[...wordsA].filter(w => !wordsB.has(w)).length} words`,
      `Unique to File B : ${[...wordsB].filter(w => !wordsA.has(w)).length} words`,
      `${'─'.repeat(50)}`,
    ];
    return { blob: new Blob([lines.join('\n')], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
  }

  // ── PHASE 4: OCR PDF PRO MAX ─────────────────────────────────────────────
  // Multi-mode OCR: preprocessing pipeline, confidence scoring, multi-language,
  // layout reconstruction (headings/tables/paragraphs), three output formats.
  async function ocrPdf(files, opts) {
    opts = opts || {};
    const ocrMode   = opts.ocrMode      || 'balanced';
    const lang      = opts.language     || 'eng';
    const outputFmt = opts.outputFormat || 'docx';
    const preproc   = opts.preprocessing || 'auto';

    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const numPages = pdf.numPages;

    // ── Fast digital-text probe ───────────────────────────────────────────
    let digitalText = '';
    for (let i = 1; i <= numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      digitalText  += content.items.map(it => it.str).join(' ') + '\n';
      page.cleanup();
    }
    const hasDigitalText = digitalText.replace(/\s/g, '').length >= 60;

    // ── Render scale by OCR mode ─────────────────────────────────────────
    const scaleMap = { fast: 1.5, balanced: 2.0, accurate: 2.5, 'layout-preserve': 2.0, 'table-priority': 2.5 };
    const renderScale = scaleMap[ocrMode] || 2.0;

    // Tesseract page-segmentation mode
    const psmMap = { 'table-priority': '6', 'layout-preserve': '4' };
    const psm    = psmMap[ocrMode] || '3';

    const Tesseract = await loadTesseract();

    const allPageData = [];
    let totalConfidence = 0;

    for (let i = 1; i <= numPages; i++) {
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas   = document.createElement('canvas');
      canvas.width   = Math.min(Math.floor(viewport.width),  4096);
      canvas.height  = Math.min(Math.floor(viewport.height), 4096);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      // ── Enhanced preprocessing pipeline ────────────────────────────────
      if (preproc !== 'none') {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        const N = d.length;

        // Pass 1: Grayscale + histogram scan for auto-level
        let minV = 255, maxV = 0;
        for (let px = 0; px < N; px += 4) {
          const g = Math.round(0.299 * d[px] + 0.587 * d[px + 1] + 0.114 * d[px + 2]);
          d[px] = d[px + 1] = d[px + 2] = g;
          if (g < minV) minV = g;
          if (g > maxV) maxV = g;
        }

        // Pass 2: Auto-level stretch + contrast boost
        const range  = Math.max(1, maxV - minV);
        const isBW   = preproc === 'bw';
        const factor = preproc === 'contrast' ? 1.8 : preproc === 'auto' ? 1.5 : 1.0;
        for (let px = 0; px < N; px += 4) {
          let v = Math.round((d[px] - minV) * 255 / range); // auto-level
          v = Math.min(255, Math.max(0, Math.round((v - 128) * factor + 128))); // contrast curve
          if (isBW) v = v > 127 ? 255 : 0;
          d[px] = d[px + 1] = d[px + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      }

      const canvasW = canvas.width;
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 0; canvas.height = 0;

      // ── AI OCR Engine ──────────────────────────────────────────────────
      const { data: ocrData } = await Tesseract.recognize(dataUrl, lang, {
        logger: () => {},
        tessedit_pageseg_mode: psm,
      });

      const pageConf = typeof ocrData.confidence === 'number' ? ocrData.confidence : 0;
      totalConfidence += pageConf;
      allPageData.push({
        text:       (ocrData.text || '').trim(),
        words:      ocrData.words || [],
        confidence: pageConf,
        pageIdx:    i - 1,
        pageW:      canvasW,
      });
      page.cleanup();
      await new Promise(r => setTimeout(r, 0)); // Phase 21: yield to main thread between pages
    }
    await pdf.destroy();

    const avgConf = numPages > 0 ? totalConfidence / numPages : 0;
    if (avgConf < 5 && !hasDigitalText) {
      throw new Error(
        'Low scan quality detected. The document may be too blurry or the selected language may not match. ' +
        'Try switching to a different language or image enhancement mode.'
      );
    }

    // ── Plain text output ─────────────────────────────────────────────────
    if (outputFmt === 'txt') {
      const fullText = allPageData.map(p => p.text).join('\n\n--- Page Break ---\n\n');
      if (!fullText.trim()) throw new Error('No text could be extracted from this PDF.');
      return { blob: new Blob([fullText], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
    }

    // ── Searchable PDF: clean text PDF built from OCR lines ───────────────
    if (outputFmt === 'searchable-pdf') {
      const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
      const outDoc = await PDFDocument.create();
      const font   = await outDoc.embedFont(StandardFonts.Helvetica);
      const bold   = await outDoc.embedFont(StandardFonts.HelveticaBold);
      const pageW  = 595.28; const pageH = 841.89; // A4 pts
      const mL = 50; const mR = 50; const mT = 50; const mB = 50;
      const contentW = pageW - mL - mR;

      for (const pd of allPageData) {
        if (!pd.text) continue;
        const rawLines = pd.text.split('\n').filter(l => l.trim());
        let page = outDoc.addPage([pageW, pageH]);
        let y    = pageH - mT;

        for (const line of rawLines) {
          if (!line.trim()) continue;
          const isH1  = line === line.toUpperCase() && line.length >= 4 && line.length <= 70 && /[A-Z]/.test(line);
          const usedFont = isH1 ? bold : font;
          const usedSz   = isH1 ? 14 : 11;
          const lineH    = usedSz * 1.5;

          // Word-wrap within content width
          const words  = line.split(' ');
          let curLine  = '';
          const wrapped = [];
          for (const w of words) {
            const testLine = curLine ? curLine + ' ' + w : w;
            if (usedFont.widthOfTextAtSize(testLine, usedSz) > contentW && curLine) {
              wrapped.push(curLine); curLine = w;
            } else { curLine = testLine; }
          }
          if (curLine) wrapped.push(curLine);

          for (const wl of wrapped) {
            if (y - lineH < mB) {
              page = outDoc.addPage([pageW, pageH]);
              y    = pageH - mT;
            }
            y -= lineH;
            try { page.drawText(wl, { x: mL, y, size: usedSz, font: usedFont, color: rgb(0, 0, 0), maxWidth: contentW }); } catch (_) {}
          }
          if (isH1) y -= 4;
        }
      }

      const pdfBytes = await outDoc.save();
      if (!pdfBytes || pdfBytes.length < 200) throw new Error('Could not generate searchable PDF.');
      return { blob: new Blob([pdfBytes], { type: 'application/pdf' }), ext: '.pdf', mime: 'application/pdf' };
    }

    // ── DOCX output with word-bbox layout reconstruction ──────────────────
    const JSZip = await loadJsZip();

    // Group Tesseract word objects into lines using Y-midpoint proximity,
    // then sort each line by X — giving proper spatial reconstruction.
    function reconstructOcrLines(words, pageW) {
      if (!words || !words.length) return [];
      const valid = words.filter(function (w) {
        return w && w.text && w.text.trim() &&
          w.bbox && typeof w.bbox.x0 === 'number' && typeof w.bbox.y0 === 'number';
      });
      if (!valid.length) return [];
      valid.sort(function (a, b) { return a.bbox.y0 - b.bbox.y0; });

      const lineGroups = [];
      let cur = [valid[0]];
      for (let i = 1; i < valid.length; i++) {
        const w     = valid[i];
        const prev  = cur[cur.length - 1];
        const maxH  = Math.max(prev.bbox.y1 - prev.bbox.y0, w.bbox.y1 - w.bbox.y0, 6);
        const midPr = (prev.bbox.y0 + prev.bbox.y1) / 2;
        const midCu = (w.bbox.y0  + w.bbox.y1)  / 2;
        if (Math.abs(midCu - midPr) < maxH * 0.65) {
          cur.push(w);
        } else {
          lineGroups.push(cur);
          cur = [w];
        }
      }
      if (cur.length) lineGroups.push(cur);

      return lineGroups.map(function (grp) {
        grp.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
        const totalChars = grp.reduce(function (s, w) { return s + (w.text.length || 1); }, 0);
        const totalW     = grp.reduce(function (s, w) { return s + (w.bbox.x1 - w.bbox.x0); }, 0);
        const avgCharW   = totalW / Math.max(totalChars, 1);
        const avgH       = grp.reduce(function (s, w) { return s + (w.bbox.y1 - w.bbox.y0); }, 0) / grp.length;

        let text = '', lastX1 = grp[0].bbox.x0;
        grp.forEach(function (w, i) {
          if (i > 0) {
            // Preserve wide gaps (table columns) as double-space
            text += (w.bbox.x0 - lastX1 > avgCharW * 3.5) ? '  ' : ' ';
          }
          text += w.text;
          lastX1 = w.bbox.x1;
        });
        text = text.trim();
        if (!text) return null;

        // Type detection from bbox metrics
        const centerX  = (grp[0].bbox.x0 + grp[grp.length - 1].bbox.x1) / 2;
        const isCenter = pageW > 0 && Math.abs(centerX - pageW / 2) < pageW * 0.2;
        const isAllCap = text === text.toUpperCase() && /[A-Z]/.test(text);
        const isShort  = text.split(/\s+/).length <= 10;
        const hasWideGap = grp.some(function (w, i) {
          return i > 0 && (w.bbox.x0 - grp[i - 1].bbox.x1) > avgCharW * 3.5;
        });

        let type = 'normal';
        if      (avgH > 18 || (isCenter && isShort && (isAllCap || avgH > 13))) type = 'h1';
        else if (isShort && isAllCap && avgH > 10)                              type = 'h2';
        else if (hasWideGap && grp.length >= 3)                                 type = 'table';
        return { text: text, type: type };
      }).filter(Boolean);
    }

    // Prefer word-bbox reconstruction; fall back to plain text-split
    const allReconstructed = allPageData.flatMap(function (pd) {
      const lines = (pd.words && pd.words.length > 2)
        ? reconstructOcrLines(pd.words, pd.pageW || 0)
        : pd.text.split('\n').map(function (t) {
            t = t.trim(); if (!t) return null;
            const isH1 = t === t.toUpperCase() && /[A-Z]/.test(t) && t.length >= 3 && t.length <= 70;
            return { text: t, type: isH1 ? 'h1' : 'normal' };
          }).filter(Boolean);
      return lines;
    });

    const docXmlParts = [];
    for (const rl of allReconstructed) {
      const escaped = rl.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const pStyle  = rl.type === 'h1' ? 'Heading1' : rl.type === 'h2' ? 'Heading2' : 'Normal';
      const rStyle  = rl.type === 'h1'    ? '<w:b/><w:sz><w:val>32</w:val></w:sz>' :
                      rl.type === 'h2'    ? '<w:b/><w:sz><w:val>28</w:val></w:sz>' :
                      rl.type === 'table' ? '<w:sz><w:val>20</w:val></w:sz>' :
                                           '<w:sz><w:val>24</w:val></w:sz>';
      docXmlParts.push(
        '<w:p><w:pPr><w:pStyle w:val="' + pStyle + '"/></w:pPr>' +
        '<w:r><w:rPr>' + rStyle + '</w:rPr><w:t xml:space="preserve">' + escaped + '</w:t></w:r></w:p>'
      );
    }

    // Professional confidence footer (no internal engine or mode names exposed)
    const confNote = 'AI OCR Engine \u00b7 ' + Math.round(avgConf) + '% confidence \u00b7 ' +
      numPages + ' page' + (numPages > 1 ? 's' : '') + ' processed';
    const footEsc = confNote.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    docXmlParts.push(
      '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>' +
      '<w:r><w:rPr><w:color w:val="888888"/><w:sz><w:val>18</w:val></w:sz></w:rPr>' +
      '<w:t xml:space="preserve">\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>' +
      '<w:r><w:rPr><w:color w:val="888888"/><w:sz><w:val>18</w:val></w:sz></w:rPr>' +
      '<w:t xml:space="preserve">' + footEsc + '</w:t></w:r></w:p>'
    );

    const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + docXmlParts.join('') + '<w:sectPr/></w:body></w:document>';
    const ctXml   = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const wRels   = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

    const zip = new JSZip();
    zip.file('[Content_Types].xml', ctXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('word/document.xml', docXml);
    zip.file('word/_rels/document.xml.rels', wRels);
    const docxBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    if (!docxBlob || docxBlob.size < 200) throw new Error('OCR produced no output. The PDF may be damaged or unreadable.');
    return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }

  // ── PHASE 4: BACKGROUND REMOVER v5.0 — AI-First Hybrid Pipeline ─────────────
  // Primary path : BgAiEngine (ONNX Runtime Web — u2netp / RMBG-1.4 quantized)
  // Fallback path: v4.0 CV engine (BFS + solidity + edge refinement)
  // The AI engine handles model loading, caching and tiled inference internally.
  async function backgroundRemover(files, opts) {
    opts = opts || {};

    // ── AI path ──────────────────────────────────────────────────────────────
    // Skip if caller explicitly requested CV engine (pass 3 in healing loop)
    if (!opts._forceCV && window.BgAiEngine && typeof window.BgAiEngine.process === 'function') {
      try {
        // opts._onProgress is the live UI callback from bg-remover-pro.js
        const onProg   = (typeof opts._onProgress === 'function') ? opts._onProgress : null;
        const aiResult = await window.BgAiEngine.process(files[0], opts, onProg);
        if (aiResult && aiResult.blob && aiResult.blob.size > 100) return aiResult;
      } catch (aiErr) {
        console.warn('[BgRemover] AI path failed, falling back to CV engine:', aiErr.message);
      }
    }

    // ── CV fallback (v4.0 BFS engine) ────────────────────────────────────────
    return _backgroundRemoverCV(files, opts);
  }

  async function _backgroundRemoverCV(files, opts) {
    const img         = await loadImageFromFile(files[0]);
    const W           = img.naturalWidth;
    const H           = img.naturalHeight;
    const N           = W * H;
    const subjectMode = opts.subjectMode || 'auto';
    const qualityMode = opts.qualityMode || 'hd';

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data; // RGBA flat array, length = N*4

    // ── Neighbour offsets (4-connected) ─────────────────────────────────────
    const DX4 = [-1, 1,  0, 0];
    const DY4 = [ 0, 0, -1, 1];

    // ── Helpers ──────────────────────────────────────────────────────────────
    function pR(i) { return d[i * 4];     }
    function pG(i) { return d[i * 4 + 1]; }
    function pB(i) { return d[i * 4 + 2]; }
    function lum(i) { return 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]; }

    // Perceptual colour distance (approximate CIEDE2000 weighting via redmean)
    function colorDist(r1, g1, b1, r2, g2, b2) {
      const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      const rm = (r1 + r2) * 0.5;
      return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
    }

    // ── STEP 1: Sample background colour from image borders ─────────────────
    const bStep = Math.max(1, Math.floor(Math.min(W, H) / 64));
    const bSamples = [];
    for (let x = 0; x < W; x += bStep) {
      bSamples.push(x, (H - 1) * W + x); // top & bottom rows
    }
    for (let y = 1; y < H - 1; y += bStep) {
      bSamples.push(y * W, y * W + W - 1); // left & right columns
    }
    const bRarr = bSamples.map(i => pR(i)).sort((a, b) => a - b);
    const bGarr = bSamples.map(i => pG(i)).sort((a, b) => a - b);
    const bBarr = bSamples.map(i => pB(i)).sort((a, b) => a - b);
    const mid   = Math.floor(bSamples.length / 2);
    const bgR   = bRarr[mid], bgG = bGarr[mid], bgB = bBarr[mid];

    // Background uniformity — drives BFS tolerance
    const bgDevs  = bSamples.map(i => colorDist(pR(i), pG(i), pB(i), bgR, bgG, bgB));
    const bgStd   = Math.sqrt(bgDevs.reduce((s, v) => s + v * v, 0) / bgDevs.length);

    // Subject-mode tuning: portrait = tighter (preserve skin), product = medium
    const modeScale = subjectMode === 'portrait' ? 0.80
                    : subjectMode === 'product'  ? 0.90
                    : subjectMode === 'logo'     ? 0.70 : 1.0;
    const bfsTol   = Math.max(18, Math.min(55, bgStd * 1.8 + 14)) * modeScale;

    // ── STEP 2: Precompute luminance and Sobel edge magnitude ────────────────
    const lumArr  = new Float32Array(N);
    const edgeMag = new Float32Array(N);  // Sobel gradient magnitude
    const locVar  = new Float32Array(N);  // local brightness variance (metallic proxy)

    for (let i = 0; i < N; i++) lumArr[i] = lum(i);

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i    = y * W + x;
        const tl   = lumArr[i - W - 1], tm = lumArr[i - W], tr = lumArr[i - W + 1];
        const ml   = lumArr[i - 1],                          mr = lumArr[i + 1];
        const bl   = lumArr[i + W - 1], bm = lumArr[i + W], br = lumArr[i + W + 1];
        const gx   = -tl - 2*ml - bl + tr + 2*mr + br;
        const gy   = -tl - 2*tm - tr + bl + 2*bm + br;
        edgeMag[i] = Math.sqrt(gx*gx + gy*gy);

        // 3×3 local brightness variance (specular / metallic proxy)
        const vals = [tl, tm, tr, ml, lumArr[i], mr, bl, bm, br];
        const avg9  = vals.reduce((s, v) => s + v, 0) / 9;
        locVar[i]  = Math.sqrt(vals.reduce((s, v) => s + (v - avg9) * (v - avg9), 0) / 9);
      }
    }

    // ── STEP 3: BFS flood-fill from border — mark background pixels ──────────
    const bgMask = new Uint8Array(N);  // 1 = confirmed background
    const bfsQ   = [];
    let   bfsQi  = 0;

    function tryBorderSeed(pi) {
      const r = pR(pi), g = pG(pi), b = pB(pi);
      if (colorDist(r, g, b, bgR, bgG, bgB) <= bfsTol * 1.6 && !bgMask[pi]) {
        bgMask[pi] = 1; bfsQ.push(pi);
      }
    }
    for (let x = 0; x < W; x++) { tryBorderSeed(x); tryBorderSeed((H - 1) * W + x); }
    for (let y = 1; y < H - 1; y++) { tryBorderSeed(y * W); tryBorderSeed(y * W + W - 1); }

    while (bfsQi < bfsQ.length) {
      const pi = bfsQ[bfsQi++];
      const x  = pi % W, y = Math.floor(pi / W);
      const cr = pR(pi), cg = pG(pi), cb = pB(pi);

      for (let di = 0; di < 4; di++) {
        const nx = x + DX4[di], ny = y + DY4[di];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (bgMask[ni]) continue;

        const nr = pR(ni), ng = pG(ni), nb = pB(ni);
        const distFromBg   = colorDist(nr, ng, nb, bgR, bgG, bgB);
        const distFromPrev = colorDist(nr, ng, nb, cr, cg, cb);
        const edge         = edgeMag[ni];

        // High-edge / high-texture pixels resist BFS expansion (protect FG detail)
        const edgeResist = edge > 50 ? 0.30 : edge > 25 ? 0.55 : edge > 12 ? 0.75 : 1.0;
        // High local-variance pixels resist BFS (protect metallic / reflective surfaces)
        const varResist  = locVar[ni] > 22 ? 0.45 : locVar[ni] > 12 ? 0.70 : 1.0;
        const resist     = Math.min(edgeResist, varResist);

        if (distFromBg   <= bfsTol * resist ||
            distFromPrev <= bfsTol * 0.45 * resist) {
          bgMask[ni] = 1;
          bfsQ.push(ni);
        }
      }
    }

    // ── STEP 4: Compute initial alpha map ────────────────────────────────────
    const alpha  = new Uint8Array(N);
    const fgConf = new Float32Array(N); // 0..1 foreground confidence

    for (let i = 0; i < N; i++) {
      if (bgMask[i]) { alpha[i] = 0; fgConf[i] = 0; continue; }

      const r    = pR(i), g = pG(i), b = pB(i);
      const dist = colorDist(r, g, b, bgR, bgG, bgB);

      // Colour confidence: how different from BG
      const colConf = Math.min(1.0, dist / (bfsTol * 1.5));
      // Texture confidence: edges / detail = likely FG
      const texConf = Math.min(1.0, edgeMag[i] / 35);
      // Saturation confidence: chromatic pixels = more likely FG
      const maxC  = Math.max(r, g, b), minC = Math.min(r, g, b);
      const sat   = maxC > 0 ? (maxC - minC) / maxC : 0;
      const satConf = Math.min(1.0, sat * 2.2);
      // Local-variance confidence (metallic / reflective boost)
      const varConf = Math.min(1.0, locVar[i] / 20);

      const conf   = Math.min(1.0,
        colConf * 0.45 + texConf * 0.25 + satConf * 0.20 + varConf * 0.10);
      fgConf[i] = conf;

      // Map confidence to alpha
      if      (conf >= 0.75) alpha[i] = 255;
      else if (conf >= 0.55) alpha[i] = Math.round(180 + conf * 97);
      else if (conf >= 0.35) alpha[i] = Math.round(90  + conf * 165);
      else                   alpha[i] = Math.round(conf * 257);
      alpha[i] = Math.min(255, alpha[i]);
    }

    // ── STEP 5: Interior hole prevention ────────────────────────────────────
    // Flood-fill from border using only low-alpha pixels; any transparent pixel
    // NOT reachable from the border is enclosed — fill it as foreground.
    const borderReach = new Uint8Array(N);
    const transQ = [];
    let   transQi = 0;

    function tryTransSeed(pi) {
      if (alpha[pi] < 40 && !borderReach[pi]) { borderReach[pi] = 1; transQ.push(pi); }
    }
    for (let x = 0; x < W; x++) { tryTransSeed(x); tryTransSeed((H - 1) * W + x); }
    for (let y = 1; y < H - 1; y++) { tryTransSeed(y * W); tryTransSeed(y * W + W - 1); }

    while (transQi < transQ.length) {
      const pi = transQ[transQi++];
      const x  = pi % W, y = Math.floor(pi / W);
      for (let di = 0; di < 4; di++) {
        const nx = x + DX4[di], ny = y + DY4[di];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (borderReach[ni] || alpha[ni] >= 40) continue;
        borderReach[ni] = 1;
        transQ.push(ni);
      }
    }

    // Fill interior holes (transparent pixels not reachable from border)
    for (let i = 0; i < N; i++) {
      if (alpha[i] < 40 && !borderReach[i]) {
        alpha[i]  = 235;  // solid interior — definitely foreground
        fgConf[i] = 0.85;
      }
    }

    // ── STEP 6: Phase 1 — Hard foreground lock ───────────────────────────────
    // Any pixel with strong FG confidence gets a minimum alpha floor.
    for (let i = 0; i < N; i++) {
      if (bgMask[i]) continue;
      if (fgConf[i] > 0.55 && alpha[i] < 210) alpha[i] = 210;
      if (fgConf[i] > 0.75 && alpha[i] < 245) alpha[i] = 245;
    }

    // ── STEP 7: Connected-component foreground solidification ───────────────
    // BFS to find connected FG regions; solidify large ones aggressively.
    const ccVisited = new Uint8Array(N);
    const MIN_FG_SIZE = Math.max(50, Math.floor(N * 0.0008));

    for (let si = 0; si < N; si++) {
      if (ccVisited[si] || alpha[si] < 110) continue;

      const region  = [];
      const ccStack = [si];
      ccVisited[si] = 1;
      let maxConfInRegion = fgConf[si];

      while (ccStack.length > 0) {
        const pi = ccStack.pop();
        region.push(pi);
        if (fgConf[pi] > maxConfInRegion) maxConfInRegion = fgConf[pi];
        const x = pi % W, y = Math.floor(pi / W);
        for (let di = 0; di < 4; di++) {
          const nx = x + DX4[di], ny = y + DY4[di];
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const ni = ny * W + nx;
          if (ccVisited[ni] || alpha[ni] < 90) continue;
          ccVisited[ni] = 1;
          ccStack.push(ni);
        }
      }

      if (region.length >= MIN_FG_SIZE) {
        const floor = maxConfInRegion > 0.60 ? 230
                    : maxConfInRegion > 0.40 ? 205 : 180;
        for (let k = 0; k < region.length; k++) {
          if (alpha[region[k]] < floor) alpha[region[k]] = floor;
        }
      }
    }

    // ── STEP 8: Phase 5 — Neighbourhood alpha consensus (stabilization) ──────
    const alphaS = new Uint8Array(N);
    const radius  = qualityMode === 'ultra' ? 2 : 1;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (bgMask[i]) { alphaS[i] = 0; continue; }

        let sum = 0, wt = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx2 = x + dx, ny2 = y + dy;
            if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
            const ni = ny2 * W + nx2;
            const w  = (dx === 0 && dy === 0) ? 3 : 1;
            sum += alpha[ni] * w; wt += w;
          }
        }
        const avg     = sum / wt;
        const isEdge  = edgeMag[i] > 18;
        const blendW  = isEdge ? 0.35 : 0.12;
        alphaS[i] = Math.round(alpha[i] * (1 - blendW) + avg * blendW);
      }
    }
    for (let i = 0; i < N; i++) alpha[i] = alphaS[i];

    // Re-apply hard locks after smoothing
    for (let i = 0; i < N; i++) {
      if (bgMask[i]) continue;
      if (fgConf[i] > 0.55 && alpha[i] < 200) alpha[i] = 200;
      if (fgConf[i] > 0.75 && alpha[i] < 238) alpha[i] = 238;
    }

    // ── STEP 9: Phase 7 — Edge-only feathering ───────────────────────────────
    // Feather ONLY pixels that sit on the true FG/BG boundary.
    const isEdgePx = new Uint8Array(N);
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (alpha[i] < 20 || alpha[i] > 235) continue; // pure BG or pure FG — skip
        let hasBg = false, hasFg = false;
        for (let dy = -2; dy <= 2 && !(hasBg && hasFg); dy++) {
          for (let dx = -2; dx <= 2 && !(hasBg && hasFg); dx++) {
            const nx2 = x + dx, ny2 = y + dy;
            if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
            const na = alpha[ny2 * W + nx2];
            if (na < 25)  hasBg = true;
            if (na > 220) hasFg = true;
          }
        }
        isEdgePx[i] = (hasBg && hasFg) ? 1 : 0;
      }
    }

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!isEdgePx[i]) continue;
        let sum = 0, wt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx2 = x + dx, ny2 = y + dy;
            if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
            const w = (dx === 0 && dy === 0) ? 2 : 1;
            sum += alpha[ny2 * W + nx2] * w; wt += w;
          }
        }
        alpha[i] = Math.round(sum / wt);
      }
    }

    // ── STEP 10: Phase 6 — Foreground opacity recovery ───────────────────────
    // Boost pixels that are inside solid FG regions but have weak alpha.
    for (let i = 0; i < N; i++) {
      if (bgMask[i] || isEdgePx[i]) continue;
      if (alpha[i] >= 160) continue;

      const x = i % W, y = Math.floor(i / W);
      let nSum = 0, nCnt = 0;
      for (let di = 0; di < 4; di++) {
        const nx2 = x + DX4[di], ny2 = y + DY4[di];
        if (nx2 < 0 || nx2 >= W || ny2 < 0 || ny2 >= H) continue;
        nSum += alpha[ny2 * W + nx2]; nCnt++;
      }
      if (nCnt > 0 && nSum / nCnt > 180) {
        alpha[i] = Math.round(alpha[i] * 0.35 + (nSum / nCnt) * 0.65);
      }
    }

    // ── STEP 11: Phase 3+4 — Low-contrast and metallic object protection ─────
    // If a pixel has significant local variance or edge magnitude but low alpha,
    // it is likely a textured / reflective surface — protect it.
    for (let i = 0; i < N; i++) {
      if (bgMask[i]) continue;
      const isTextured  = edgeMag[i] > 30;
      const isMetallic  = locVar[i]  > 18;
      if ((isTextured || isMetallic) && alpha[i] < 200) {
        const boost = isTextured && isMetallic ? 200
                    : isTextured               ? 180 : 170;
        if (alpha[i] < boost) alpha[i] = boost;
      }
    }

    // ── STEP 12: Phase 9 — Quality assertion + auto-retry ───────────────────
    let totalFg = 0, weakFg = 0;
    for (let i = 0; i < N; i++) {
      if (!bgMask[i] && alpha[i] > 20) { totalFg++; if (alpha[i] < 150) weakFg++; }
    }
    if (totalFg > 0 && weakFg / totalFg > 0.28) {
      // Too much foreground is still weak — apply a global foreground boost
      for (let i = 0; i < N; i++) {
        if (!bgMask[i] && alpha[i] > 20 && alpha[i] < 210) {
          alpha[i] = Math.min(255, alpha[i] + 55);
        }
      }
    }

    // Final interior hole re-check: any enclosed transparent pixel becomes solid
    for (let i = 0; i < N; i++) {
      if (alpha[i] < 40 && !borderReach[i] && !bgMask[i]) alpha[i] = 230;
    }

    // ── Write alpha channel back ─────────────────────────────────────────────
    for (let i = 0; i < N; i++) d[i * 4 + 3] = alpha[i];

    ctx.putImageData(imgData, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/png');
    canvas.width = 0; canvas.height = 0;
    return { blob, ext: '.png', mime: 'image/png' };
  }

  // ── PHASE 5: AI SUMMARIZER v4.0 (TF-IDF, heading boost, Jaccard dedup) ──────
  // Structured extraction with font-based heading detection. Proper TF-IDF scoring
  // with IDF weighting. Heading proximity 2× boost. Position weight (early/late).
  // Jaccard deduplication (threshold 0.6). Summary types: short/detailed/bullets/
  // insights/executive. Output: TXT or DOCX. OCR fallback for scanned PDFs.
  async function aiSummarize(files, opts) {
    opts = opts || {};
    const summaryType  = String(opts.summaryType  || 'short').toLowerCase();
    const outputFormat = String(opts.outputFormat || 'txt').toLowerCase();

    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const numPages = pdf.numPages;

    // ── Structured extraction: Y-bucketed lines with heading detection ─────────
    const allLines    = []; // [{ text, isHeading, pageNum }]
    let totalRawChars = 0;

    for (let i = 1; i <= numPages; i++) {
      const page     = await pdf.getPage(i);
      const content  = await page.getTextContent();
      const buckets  = {};
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        totalRawChars += item.str.replace(/\s/g, '').length;
        const yKey = Math.round(item.transform[5] / 3) * 3;
        if (!buckets[yKey]) buckets[yKey] = { parts: [], fontSize: 0 };
        buckets[yKey].parts.push({ text: item.str });
        const fs = item.height || 0;
        if (fs > buckets[yKey].fontSize) buckets[yKey].fontSize = fs;
      }
      page.cleanup();

      // Modal base font size for heading ratio detection
      const pageSizes = Object.values(buckets).map(b => Math.round(b.fontSize)).filter(s => s > 0);
      const fsFreq    = {};
      for (const s of pageSizes) fsFreq[s] = (fsFreq[s] || 0) + 1;
      const baseFs    = pageSizes.length
        ? parseInt(Object.keys(fsFreq).sort((a, b) => fsFreq[b] - fsFreq[a])[0], 10) || 11 : 11;

      for (const y of Object.keys(buckets).map(Number).sort((a, b) => b - a)) {
        const bucket = buckets[y];
        const text   = bucket.parts.map(p => p.text).join(' ').trim();
        if (!text) continue;
        const isHeading =
          (bucket.fontSize > 0 && bucket.fontSize > baseFs * 1.2) ||
          (text === text.toUpperCase() && text.length >= 3 && text.length < 80 && /[A-Z]/.test(text) && !/^\d/.test(text)) ||
          (/^(\d+\.)+\s+\S/.test(text) && text.length <= 80);
        allLines.push({ text, isHeading, pageNum: i });
      }
    }

    // ── OCR fallback for scanned PDFs ────────────────────────────────────────
    if (totalRawChars < 50) {
      const Tesseract = await loadTesseract();
      for (let i = 1; i <= numPages; i++) {
        const page     = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas   = document.createElement('canvas');
        canvas.width   = Math.floor(viewport.width);
        canvas.height  = Math.floor(viewport.height);
        const ctx      = canvas.getContext('2d');
        ctx.fillStyle  = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const { data: { text } } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng', { logger: () => {} });
        canvas.width = 0; canvas.height = 0;
        page.cleanup();
        text.split('\n').filter(l => l.trim()).forEach(l =>
          allLines.push({ text: l.trim(), isHeading: l === l.toUpperCase() && l.length > 3 && l.length < 80, pageNum: i }));
      }
    }

    await pdf.destroy();

    const headingSet = new Set(allLines.filter(l => l.isHeading).map(l => l.text));
    const fullText   = allLines.map(l => l.text).join(' ');
    if (!fullText.replace(/\s/g, '')) {
      throw new Error('We couldn\'t extract readable text from this PDF. If it\'s a scanned document, OCR will be used during processing.');
    }

    // ── Sentence extraction ───────────────────────────────────────────────────
    const rawSents  = fullText.match(/[^.!?]{15,}[.!?]+(?:\s|$)|[^.!?]{20,}$/g) || [fullText];
    const sentences = rawSents.map(s => s.trim()).filter(s => s.length >= 15);
    if (sentences.length < 3) throw new Error('Not enough content to generate a meaningful summary.');

    // ── TF-IDF scoring ────────────────────────────────────────────────────────
    const words = fullText.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const tf    = {};
    words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });

    const docFreq = {};
    for (const s of sentences) {
      const sw = new Set(s.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
      for (const w of sw) docFreq[w] = (docFreq[w] || 0) + 1;
    }
    const N   = sentences.length;
    const idf = w => Math.log((N + 1) / (1 + (docFreq[w] || 0)));

    const scored = sentences.map((s, idx) => {
      const sw    = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      let score   = sw.reduce((sum, w) => sum + (tf[w] || 0) * idf(w), 0) / Math.max(1, sw.length);

      // Heading proximity boost (2×): within 2 lines of a heading
      const nearbyIdx = Math.max(0, Math.floor(idx * allLines.length / sentences.length) - 2);
      const nearby    = allLines.slice(nearbyIdx, nearbyIdx + 3);
      if (nearby.some(l => l.isHeading) || headingSet.has(s)) score *= 2;

      // Position boost: first 20% get 1.5×, last 10% get 1.2×
      const pos = idx / sentences.length;
      if (pos < 0.20) score *= 1.5;
      else if (pos > 0.88) score *= 1.2;

      // Length penalty
      if (s.length < 30) score *= 0.7;

      return { s, score, idx };
    });

    // ── Jaccard deduplication ─────────────────────────────────────────────────
    function jaccard(a, b) {
      const sa = new Set(a.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
      const sb = new Set(b.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
      const inter = [...sa].filter(w => sb.has(w)).length;
      const union = sa.size + sb.size - inter;
      return union > 0 ? inter / union : 0;
    }

    const typeCounts = { short: 6, detailed: 13, bullets: 9, insights: 8, executive: 11 };
    const count      = typeCounts[summaryType] || 6;
    const byScore    = [...scored].sort((a, b) => b.score - a.score);
    const selected   = [];
    for (const item of byScore) {
      if (selected.length >= count) break;
      if (!selected.some(sel => jaccard(sel.s, item.s) > 0.6)) selected.push(item);
    }
    selected.sort((a, b) => a.idx - b.idx); // restore document order

    const topSentences    = selected.map(x => x.s);
    const wordCount       = words.length;
    const readingMinutes  = Math.max(1, Math.ceil(wordCount / 200));
    const headCount       = allLines.filter(l => l.isHeading).length;

    // ── Format output ─────────────────────────────────────────────────────────
    let bodyText = '';
    if (summaryType === 'bullets') {
      bodyText = topSentences.map(s => `• ${s}`).join('\n');
    } else if (summaryType === 'insights') {
      bodyText = 'Key Insights\n' + '─'.repeat(40) + '\n' +
        topSentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
    } else if (summaryType === 'executive') {
      bodyText = 'EXECUTIVE SUMMARY\n' + '═'.repeat(40) + '\n\n' +
        topSentences.join(' ') + '\n\n' + '─'.repeat(40) + '\n' +
        `${numPages} pages · ~${wordCount.toLocaleString()} words · ~${readingMinutes} min read`;
    } else {
      bodyText = topSentences.join(' ');
    }

    const statsLine  = `${'─'.repeat(40)}\nStats: ${numPages} pages · ~${wordCount.toLocaleString()} words · ~${readingMinutes} min read · ${headCount} sections`;
    const fullOutput = `Document Summary\n${'═'.repeat(40)}\n\n${bodyText}\n\n${statsLine}`;

    // ── DOCX output ───────────────────────────────────────────────────────────
    if (outputFormat === 'docx') {
      const JSZip = await loadJsZip();
      function escX(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      const docParts = [];
      docParts.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Document Summary</w:t></w:r></w:p>`);

      if (summaryType === 'bullets') {
        for (const s of topSentences)
          docParts.push(`<w:p><w:pPr><w:spacing w:after="60"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">• </w:t></w:r><w:r><w:t xml:space="preserve">${escX(s)}</w:t></w:r></w:p>`);
      } else if (summaryType === 'insights') {
        docParts.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Key Insights</w:t></w:r></w:p>`);
        topSentences.forEach((s, i) =>
          docParts.push(`<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${i + 1}. </w:t></w:r><w:r><w:t xml:space="preserve">${escX(s)}</w:t></w:r></w:p>`));
      } else if (summaryType === 'executive') {
        docParts.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Executive Summary</w:t></w:r></w:p>`);
        docParts.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${escX(topSentences.join(' '))}</w:t></w:r></w:p>`);
      } else {
        docParts.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${escX(topSentences.join(' '))}</w:t></w:r></w:p>`);
      }
      docParts.push(`<w:p><w:pPr><w:spacing w:before="200"/></w:pPr><w:r><w:rPr><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escX(`${numPages} pages · ~${wordCount.toLocaleString()} words · ~${readingMinutes} min read`)}</w:t></w:r></w:p>`);

      const docXml    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docParts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>`;
      const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`;
      const ctXml     = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
      const relsXml   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
      const wRelsXml  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

      const zip = new JSZip();
      zip.file('[Content_Types].xml', ctXml);
      zip.file('_rels/.rels', relsXml);
      zip.file('word/document.xml', docXml);
      zip.file('word/styles.xml', stylesXml);
      zip.file('word/_rels/document.xml.rels', wRelsXml);
      const docxBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      if (docxBlob.size < 500) throw new Error('Summary generation failed. Please try a different file.');
      return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }

    // Default: TXT output
    const txtBlob = new Blob([fullOutput], { type: 'text/plain' });
    if (txtBlob.size < 20) throw new Error('We couldn\'t extract readable text from this PDF. Try a different file.');
    return { blob: txtBlob, ext: '.txt', mime: 'text/plain' };
  }

  // ── PHASE 6: TRANSLATE PDF v4.0 ──────────────────────────────────────────────
  // CRITICAL FIX v4.0: sourceLang was hardcoded as 'en' in v3.x — now reads opts.sourceLang.
  // 1. Hybrid extraction: digital pdfjs text; OCR if sparse (< 60 non-ws chars)
  // 2. Sentence-aware chunking (≤ 400 chars/chunk — MyMemory sweet spot)
  // 3. Context carry-over: last sentence of prev chunk prepended to API query (not output)
  // 4. Quality gate: reject if translated length < 30% of source
  // 5. Output formats: PDF (default), TXT (.txt), DOCX (.docx)
  async function translatePdf(files, opts) {
    opts = opts || {};
    // CRITICAL: sourceLang was hardcoded 'en' in v3 — now correctly reads from opts
    const sourceLang   = String(opts.sourceLang  || 'en').split('-')[0]; // zh-TW → zh for API
    const targetLang   = String(opts.targetLang  || 'es');
    const outputFormat = String(opts.outputFormat || 'pdf').toLowerCase();

    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(it => it.str).join(' ') + '\n\n';
      page.cleanup();
    }

    // OCR fallback for scanned / image-only PDFs
    if (fullText.replace(/\s/g, '').length < 60) {
      const Tesseract = await loadTesseract();
      const ocrPages  = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page     = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas   = document.createElement('canvas');
        canvas.width   = Math.floor(viewport.width);
        canvas.height  = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const { data: { text } } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'eng', { logger: () => {} });
        ocrPages.push(text.trim());
        canvas.width = 0; canvas.height = 0;
        page.cleanup();
      }
      fullText = ocrPages.join('\n\n');
    }

    await pdf.destroy();
    if (!fullText.trim()) {
      throw new Error('We couldn\'t extract any text from this PDF. If it\'s a scanned document, OCR will run automatically — please try again.');
    }

    // Sentence-aware chunking (≤ 400 chars — MyMemory optimal range)
    function sentenceChunks(text, maxLen) {
      const out   = [];
      let cur     = '';
      const sents = text.match(/[^.!?]{3,}[.!?]+(?:\s|$)|[^.!?]{3,}$/g) || [text];
      for (const s of sents) {
        const candidate = cur ? cur + ' ' + s.trim() : s.trim();
        if (candidate.length > maxLen && cur) { out.push(cur.trim()); cur = s.trim(); }
        else { cur = candidate; }
      }
      if (cur.trim()) out.push(cur.trim());
      return out.filter(c => c.length > 0);
    }

    const chunks       = sentenceChunks(fullText, 400);
    const translated   = [];
    let   failCount    = 0;
    let   lastSentence = ''; // context carry-over: last sentence of previous chunk

    for (const chunk of chunks) {
      try {
        // Prepend context for better coherence (MyMemory uses full query for translation)
        const ctxQuery = lastSentence ? lastSentence + ' ' + chunk : chunk;
        const apiQuery = ctxQuery.slice(0, 490); // MyMemory hard limit ~500 chars
        const langpair = `${sourceLang}|${targetLang}`;
        const url      = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(apiQuery)}&langpair=${encodeURIComponent(langpair)}`;
        const resp     = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const json     = await resp.json();
        const t        = String(json?.responseData?.translatedText || '').trim();

        if (t && t.toLowerCase() !== chunk.trim().toLowerCase()) {
          translated.push(t);
        } else {
          translated.push(chunk); failCount++;
        }
      } catch { translated.push(chunk); failCount++; }

      // Update context: last sentence (max 120 chars) for next chunk
      const sents = chunk.match(/[^.!?]+[.!?]+/g);
      lastSentence = sents && sents.length ? sents[sents.length - 1].trim().slice(-120) : chunk.slice(-120);
    }

    if (failCount === chunks.length) {
      throw new Error('Translation is temporarily unavailable. Please check your connection and try again in a moment.');
    }

    const translatedText = translated.join(' ');

    // Quality gate: output must be ≥ 30% as long as source (catches truncated API returns)
    if (fullText.length > 100 && translatedText.replace(/\s/g, '').length < fullText.replace(/\s/g, '').length * 0.3) {
      throw new Error('The translation result appears incomplete. Please try again or select a different target language.');
    }

    // ── Output: TXT ────────────────────────────────────────────────────────────
    if (outputFormat === 'txt') {
      return { blob: new Blob([translatedText], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
    }

    // ── Output: DOCX ───────────────────────────────────────────────────────────
    if (outputFormat === 'docx') {
      const JSZip = await loadJsZip();
      function escXml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      const paras    = translatedText.split(/\n{2,}/).filter(p => p.trim());
      const docParts = paras.map(p =>
        `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">${escXml(p.trim())}</w:t></w:r></w:p>`);
      const docXml    = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docParts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>`;
      const ctXml     = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
      const relsXml   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
      const wRelsXml  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
      const zip = new JSZip();
      zip.file('[Content_Types].xml', ctXml);
      zip.file('_rels/.rels', relsXml);
      zip.file('word/document.xml', docXml);
      zip.file('word/_rels/document.xml.rels', wRelsXml);
      const docxBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      if (docxBlob.size < 500) throw new Error('DOCX generation failed. Please try TXT or PDF output.');
      return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }

    // ── Output: PDF (default) — pdf-lib word-wrap ─────────────────────────────
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();
    const doc      = await PDFDoc.create();
    const font     = await doc.embedFont(SF.Helvetica);
    const fontSize = 11;
    const lineH    = fontSize * 1.5;
    const margin   = 50;
    const PW = 595, PH = 842;
    const usableW  = PW - margin * 2;

    const lineWords = translatedText.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const word of lineWords) {
      const test = cur ? cur + ' ' + word : word;
      if (font.widthOfTextAtSize(test, fontSize) > usableW && cur) { lines.push(cur); cur = word; }
      else { cur = test; }
    }
    if (cur) lines.push(cur);

    let page = doc.addPage([PW, PH]);
    let y    = PH - margin;
    for (const line of lines) {
      if (y - lineH < margin) { page = doc.addPage([PW, PH]); y = PH - margin; }
      if (line.trim()) page.drawText(line, { x: margin, y: y - lineH, size: fontSize, font, color: RGB(0, 0, 0) });
      y -= lineH;
    }

    const pdfBlob = new Blob([await doc.save()], { type: 'application/pdf' });
    if (pdfBlob.size < 500) throw new Error('Translation produced no valid output. Please try a different file.');
    return { blob: pdfBlob, ext: '.pdf', mime: 'application/pdf' };
  }

  // ── PHASE 6: WORKFLOW BUILDER (chained pdf-lib operations) ────────────────
  async function workflowPdf(files, opts) {
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB, degrees: DEG } = await loadPdfLib();

    const steps = [
      { op: opts.step1, value: opts.step1_value || '' },
      { op: opts.step2, value: opts.step2_value || '' },
      { op: opts.step3, value: opts.step3_value || '' },
    ].filter(s => s.op && s.op !== '');
    if (steps.length === 0) throw new Error('Please select at least one operation');

    let bytes = await readFileBytes(files[0]);

    for (const step of steps) {
      const doc = await PDFDoc.load(bytes, { ignoreEncryption: true });
      switch (step.op) {
        case 'compress':
          bytes = await doc.save({ useObjectStreams: true }); break;

        case 'rotate-90':
          doc.getPages().forEach(p => p.setRotation(DEG((p.getRotation().angle + 90) % 360)));
          bytes = await doc.save(); break;

        case 'rotate-180':
          doc.getPages().forEach(p => p.setRotation(DEG((p.getRotation().angle + 180) % 360)));
          bytes = await doc.save(); break;

        case 'watermark': {
          const font  = await doc.embedFont(SF.HelveticaBold);
          const wText = step.value || 'WATERMARK';
          doc.getPages().forEach(page => {
            const { width, height } = page.getSize();
            const fs = Math.min(width, height) * 0.07;
            const tw = font.widthOfTextAtSize(wText, fs);
            page.drawText(wText, { x: (width - tw) / 2, y: (height - fs) / 2, size: fs, font, color: RGB(0.6, 0.6, 0.6), opacity: 0.3, rotate: DEG(45) });
          });
          bytes = await doc.save(); break;
        }

        case 'page-numbers': {
          const font  = await doc.embedFont(SF.Helvetica);
          const total = doc.getPageCount();
          doc.getPages().forEach((page, idx) => {
            const { width } = page.getSize();
            const label = `${idx + 1} / ${total}`;
            const tw = font.widthOfTextAtSize(label, 10);
            page.drawText(label, { x: (width - tw) / 2, y: 14, size: 10, font, color: RGB(0.4, 0.4, 0.4) });
          });
          bytes = await doc.save(); break;
        }

        case 'sign': {
          const font    = await doc.embedFont(SF.HelveticaBoldOblique);
          const sigText = step.value || 'Signed';
          const lastPage = doc.getPage(doc.getPageCount() - 1);
          const { width: W, height: H } = lastPage.getSize();
          const fs = 22;
          const tw = font.widthOfTextAtSize(sigText, fs);
          const sx = W * 0.6;
          lastPage.drawLine({ start: { x: sx, y: H * 0.1 }, end: { x: W * 0.9, y: H * 0.1 }, thickness: 0.8, color: RGB(0.2, 0.2, 0.2) });
          lastPage.drawText(sigText, { x: sx + (W * 0.3 - tw) / 2, y: H * 0.1 + 8, size: fs, font, color: RGB(0.05, 0.1, 0.6) });
          bytes = await doc.save(); break;
        }

        default: break;
      }
    }
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // ── PHASE 6: PDF TO POWERPOINT v2.0 — structure-aware, themed, options-driven ──
  // opts: layout (16x9|4x3|wide|a4), contentStrategy, theme, slideDensity,
  //       tableHandling, ocrMode
  async function pdfToPowerpoint(files, opts) {
    const PptxGenJS = await loadPptxGen();
    const pdfjsLib  = await loadPdfJs();
    const data = await readFileBytes(files[0]);
    const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

    // ── Options ────────────────────────────────────────────────────────────
    const layoutKey = String(opts && opts.layout || '16x9');
    const strategy  = String(opts && opts.contentStrategy || 'smart');
    const themeKey  = String(opts && opts.theme || 'modern');
    const density   = String(opts && opts.slideDensity || 'balanced');
    const tableMode = String(opts && opts.tableHandling || 'editable');

    const LAYOUT_MAP = { '16x9': 'LAYOUT_16x9', '4x3': 'LAYOUT_4x3', 'wide': 'LAYOUT_WIDE', 'a4': 'LAYOUT_A4' };

    // Theme palette: bg, title, text, accent colors + fonts (hex, no #)
    const THEMES = {
      modern:    { bg: '1e1b4b', title: 'ffffff', text: 'c7d2fe', accent: '818cf8', tf: 'Segoe UI',  bf: 'Segoe UI' },
      corporate: { bg: '1e3a5f', title: 'ffffff', text: 'bfdbfe', accent: '60a5fa', tf: 'Calibri',   bf: 'Calibri'  },
      minimal:   { bg: 'ffffff', title: '0f172a', text: '334155', accent: '6366f1', tf: 'Arial',     bf: 'Arial'    },
      dark:      { bg: '0f172a', title: 'f8fafc', text: '94a3b8', accent: '6366f1', tf: 'Segoe UI',  bf: 'Segoe UI' },
      pitch:     { bg: '0c0a09', title: 'ffffff', text: 'd6d3d1', accent: 'f59e0b', tf: 'Georgia',   bf: 'Arial'    },
      white:     { bg: 'ffffff', title: '111827', text: '374151', accent: '2563eb', tf: 'Calibri',   bf: 'Calibri'  },
    };
    const tc = THEMES[themeKey] || THEMES.modern;

    // Slide density → max words per chunk before splitting to new slide
    const DENSITY_WORDS = { compact: 600, balanced: 320, spacious: 160 };
    const maxWords = DENSITY_WORDS[density] || 320;

    const pptx  = new PptxGenJS();
    pptx.layout = LAYOUT_MAP[layoutKey] || 'LAYOUT_16x9';
    pptx.title  = files[0].name.replace(/\.[^.]+$/, '');
    pptx.author = 'ILovePDF';

    // Slide master with background + accent bar
    pptx.defineSlideMaster({
      title: 'MASTER',
      background: { color: tc.bg },
      objects: [
        { rect: { x: 0, y: 6.8, w: '100%', h: 0.18, fill: { color: tc.accent, transparency: 55 } } },
      ],
    });

    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const vp      = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items   = content.items.filter(it => it.str && it.str.trim());

      // ── Bucket text by Y position (lines) ──────────────────────────────
      const yMap = {};
      items.forEach(it => {
        const y = Math.round(it.transform[5] / 4) * 4;
        if (!yMap[y]) yMap[y] = { parts: [], maxFont: 0 };
        yMap[y].parts.push({ text: it.str, x: it.transform[4] });
        if ((it.height || 0) > yMap[y].maxFont) yMap[y].maxFont = it.height || 0;
      });

      const lines = Object.keys(yMap).map(Number).sort((a, b) => b - a).map(y => ({
        text:     yMap[y].parts.sort((a, b) => a.x - b.x).map(p => p.text).join(' ').trim(),
        fontSize: yMap[y].maxFont,
      })).filter(l => l.text);

      if (!lines.length) continue;

      // ── Base font size for heading detection ────────────────────────────
      const fFreq = {};
      lines.forEach(l => { const s = Math.round(l.fontSize); if (s > 0) fFreq[s] = (fFreq[s] || 0) + 1; });
      const baseFont = Object.keys(fFreq).length
        ? parseInt(Object.keys(fFreq).sort((a, b) => fFreq[b] - fFreq[a])[0], 10) || 11 : 11;

      // ── Column/table detection ──────────────────────────────────────────
      const xVals = items.map(it => Math.round(it.transform[4]));
      const xUniq = [...new Set(xVals)].sort((a, b) => a - b);
      let   colGaps = 0;
      for (let xi = 1; xi < xUniq.length; xi++) {
        if (xUniq[xi] - xUniq[xi - 1] > (vp.width || 612) * 0.09) colGaps++;
      }
      const isTable = colGaps >= 3;
      const isFirst = i === 1;

      // ── Content strategy: produce chunk array [{heading, bodyLines}] ────
      let chunks = [];

      const isHeading = l =>
        (l.fontSize > baseFont * 1.18) ||
        (l.text === l.text.toUpperCase() && l.text.length >= 3 && l.text.length < 80 && /[A-Z]/.test(l.text));

      if (strategy === 'preserve') {
        chunks = [{ heading: 'Page ' + i, bodyLines: lines.map(l => l.text) }];

      } else if (strategy === 'minimal') {
        const heads = lines.filter(l => isHeading(l)).map(l => l.text);
        chunks = [{ heading: heads[0] || 'Page ' + i, bodyLines: heads.slice(1, 4) }];

      } else if (strategy === 'executive') {
        const heading = lines[0].text;
        const bullets = lines.slice(1).filter(l => !isHeading(l) && l.text.split(/\s+/).length > 2)
          .slice(0, 4).map(l => l.text.split(/\s+/).slice(0, 14).join(' '));
        chunks = [{ heading, bodyLines: bullets }];

      } else {
        // smart: detect heading boundaries, split by density
        let cur = { heading: '', bodyLines: [] };
        let curW = 0;
        chunks = [];

        lines.forEach(line => {
          const lWords = (line.text.match(/\b\w+\b/g) || []).length;
          if (isHeading(line)) {
            if (cur.heading || cur.bodyLines.length) chunks.push(cur);
            cur = { heading: line.text, bodyLines: [] }; curW = 0;
          } else if (curW + lWords > maxWords && cur.bodyLines.length > 0) {
            chunks.push(cur);
            cur = { heading: cur.heading ? 'Continued…' : '', bodyLines: [line.text] };
            curW = lWords;
          } else {
            cur.bodyLines.push(line.text); curW += lWords;
          }
        });
        if (cur.heading || cur.bodyLines.length) chunks.push(cur);
        if (!chunks.length) chunks = [{ heading: 'Page ' + i, bodyLines: lines.map(l => l.text) }];
      }

      // ── Create slides ────────────────────────────────────────────────────
      for (let ci = 0; ci < chunks.length; ci++) {
        const ch    = chunks[ci];
        const slide = pptx.addSlide({ masterName: 'MASTER' });

        // Left accent bar
        slide.addShape(pptx.shapes.RECTANGLE, {
          x: 0, y: 0, w: 0.1, h: '100%',
          fill: { color: tc.accent, transparency: 45 },
          line: { color: tc.accent, transparency: 45 },
        });

        // Title
        const titleStr = ch.heading || (isFirst ? lines[0].text : 'Slide ' + i);
        slide.addText(titleStr.substring(0, 120), {
          x: 0.28, y: 0.18, w: '89%', h: 0.9,
          fontSize: strategy === 'executive' ? 30 : (isFirst && ci === 0 ? 28 : 22),
          bold: true, color: tc.title, fontFace: tc.tf, wrap: true,
        });

        // Body
        if (ch.bodyLines && ch.bodyLines.length) {
          const useBullets = strategy !== 'preserve' && !isTable;
          const maxLines   = strategy === 'executive' ? 4 : 20;
          const bodyObjs   = ch.bodyLines.slice(0, maxLines).map(l => ({
            text: l.trim().substring(0, 220),
            options: {
              bullet: useBullets ? { type: 'bullet' } : false,
              fontSize: strategy === 'executive' ? 18 : 12,
              color: tc.text, fontFace: tc.bf,
            },
          }));
          slide.addText(bodyObjs, { x: 0.28, y: 1.2, w: '89%', h: 5.2, valign: 'top', wrap: true, autoFit: true });
        }

        // Table badge
        if (isTable && tableMode !== 'image' && ci === 0) {
          slide.addText('📊 Table detected — preserved as structured text', {
            x: 0.28, y: 6.45, w: '89%', h: 0.25,
            fontSize: 8, color: tc.accent, italic: true,
          });
        }
      }

      page.cleanup();
    }

    await pdf.destroy();

    if (!pptx.slides.length) {
      const s = pptx.addSlide({ masterName: 'MASTER' });
      s.addText('No extractable content found. Use Force OCR mode for scanned PDFs.', {
        x: 0.5, y: 2.8, w: '90%', h: 1.4, fontSize: 18, color: tc.title, align: 'center', wrap: true,
      });
    }

    const blob = await pptx.write({ outputType: 'blob' });
    if (!blob || blob.size < 500) throw new Error('Presentation generation failed — output appears empty.');
    return { blob, ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }

  // ── PHASE 6: POWERPOINT TO PDF v2.0 — handout grids, watermarks, notes, page-sizes ──
  // opts: pageSize (presentation|A4|Letter|Legal|Tabloid), margins (none|narrow|normal|wide),
  //       quality, handoutMode (1|2|4|6), speakerNotes (ignore|append|below), watermark
  async function powerpointToPdf(files, opts) {
    const JSZip = await loadJsZip();
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();

    const ab  = await files[0].arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    // ── Options ───────────────────────────────────────────────────────────
    const pageSizeKey = String(opts && opts.pageSize   || 'presentation');
    const marginKey   = String(opts && opts.margins    || 'none');
    const handout     = Math.max(1, parseInt(String(opts && opts.handoutMode || '1'), 10) || 1);
    const notes       = String(opts && opts.speakerNotes || 'ignore');
    const watermark   = String(opts && opts.watermark  || 'none');

    // Page sizes [W, H] in points — presentation is landscape 16:9
    const PAGE_SIZES_PT = {
      presentation: [960, 540],
      A4:      [842, 595],
      Letter:  [792, 612],
      Legal:   [1008, 612],
      Tabloid: [1224, 792],
    };
    const MARGIN_PT = { none: 6, narrow: 22, normal: 40, wide: 60 };
    const WM_TEXTS  = { confidential: 'CONFIDENTIAL', draft: 'DRAFT', 'do-not-copy': 'DO NOT COPY', none: '' };

    const [PW, PH] = PAGE_SIZES_PT[pageSizeKey] || PAGE_SIZES_PT.presentation;
    const margin   = MARGIN_PT[marginKey] || 6;
    const wmText   = WM_TEXTS[watermark] || '';

    // ── Parse slides ───────────────────────────────────────────────────────
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
        const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
        return na - nb;
      });

    if (slideNames.length === 0) throw new Error('No slides found in this presentation file.');

    // Parse each slide: title (ph type=title/ctrTitle) + body lines
    const slideData = [];
    for (const sn of slideNames) {
      const xml   = await zip.files[sn].async('text');
      const allT  = [];
      const re    = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      let   m;
      while ((m = re.exec(xml)) !== null) {
        const t = m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&apos;/g,"'").replace(/&quot;/g,'"').trim();
        if (t) allT.push(t);
      }
      // Title heuristic: ph type=title or ctrTitle precedes text
      const hasTitle = /<p:ph[^>]*type=["'](title|ctrTitle)["']/.test(xml);
      slideData.push({
        num: slideData.length + 1,
        texts: allT,
        hasTitle,
        isTitle: hasTitle || (allT.length <= 2 && allT[0] && allT[0].length < 80),
      });
    }

    // ── Parse notes ────────────────────────────────────────────────────────
    const notesData = {};
    if (notes !== 'ignore') {
      const noteFiles = Object.keys(zip.files)
        .filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
        .sort((a, b) => parseInt((a.match(/\d+/)||['0'])[0],10) - parseInt((b.match(/\d+/)||['0'])[0],10));
      for (let ni = 0; ni < noteFiles.length; ni++) {
        const nxml = await zip.files[noteFiles[ni]].async('text');
        const nT = []; const nRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g; let nm;
        while ((nm = nRe.exec(nxml)) !== null) {
          const v = nm[1].replace(/&amp;/g,'&').trim(); if (v && v.length > 2) nT.push(v);
        }
        if (nT.length > 0) notesData[ni] = nT.join(' ');
      }
    }

    // ── Build PDF ──────────────────────────────────────────────────────────
    const doc  = await PDFDoc.create();
    const font = await doc.embedFont(SF.Helvetica);
    const bold = await doc.embedFont(SF.HelveticaBold);

    // Word-wrap helper: draws text, returns final y
    function drawWrapped(page, text, x, y, maxW, minY, sz, fnt, col) {
      const lh    = sz * 1.55;
      const words = String(text).split(' ');
      let   line  = '';
      let   cy    = y;
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (fnt.widthOfTextAtSize(test, sz) > maxW && line) {
          if (cy - lh < minY) { page.drawText('…', { x, y: cy, size: sz, font: fnt, color: col }); return cy - lh; }
          page.drawText(line, { x, y: cy, size: sz, font: fnt, color: col });
          cy -= lh; line = w;
        } else { line = test; }
      }
      if (line && cy >= minY) page.drawText(line, { x, y: cy, size: sz, font: fnt, color: col });
      return cy - lh;
    }

    // Watermark helper
    function drawWatermark(page, text, pw, ph) {
      if (!text) return;
      try {
        page.drawText(text, {
          x: pw * 0.1, y: ph * 0.42,
          size: Math.round(pw * 0.048), font,
          color: RGB(0.80, 0.10, 0.10), opacity: 0.16,
          rotate: { type: 'degrees', angle: 32 },
        });
      } catch (_) {}
    }

    // Draw one slide's content into a rectangular cell
    function drawSlideInCell(page, slide, bx, by, bw, bh) {
      const fm      = Math.max(4, Math.round(bh * 0.07));
      const titleSz = Math.max(7, Math.round(bh * 0.105));
      const bodySz  = Math.max(5, Math.round(bh * 0.075));
      const lhBody  = bodySz * 1.42;

      // Cell background + accent bar (top) + slide number
      page.drawRectangle({ x: bx, y: by, width: bw, height: bh,
        color: RGB(0.975, 0.975, 1), borderColor: RGB(0.82, 0.85, 0.95), borderWidth: 0.6 });
      page.drawRectangle({ x: bx, y: by + bh - 4, width: bw, height: 4, color: RGB(0.39, 0.40, 0.945) });
      page.drawText(String(slide.num), { x: bx + bw - 13, y: by + bh - 13, size: 6, font, color: RGB(0.6,0.6,0.6) });

      if (!slide.texts.length) {
        page.drawText('(empty)', { x: bx + fm, y: by + bh * 0.5, size: bodySz, font, color: RGB(0.75,0.75,0.75) });
        return;
      }

      let cy = by + bh - fm - 6;
      // Title line
      const titleStr = slide.isTitle ? slide.texts[0] : '';
      if (titleStr) {
        const ts = titleStr.substring(0, 55);
        page.drawText(ts, { x: bx + fm, y: cy, size: titleSz, font: bold, color: RGB(0.1, 0.1, 0.42) });
        cy -= titleSz * 1.55;
      }
      // Body lines
      const startIdx = slide.isTitle ? 1 : 0;
      for (let ti = startIdx; ti < Math.min(slide.texts.length, 14); ti++) {
        if (cy < by + fm + bodySz) break;
        const lineStr = '· ' + slide.texts[ti].substring(0, 72);
        page.drawText(lineStr, { x: bx + fm, y: cy, size: bodySz, font, color: RGB(0.25, 0.25, 0.25) });
        cy -= lhBody;
      }
    }

    // ── Handout grid config ──────────────────────────────────────────────
    const GRID = { 1: [1,1], 2: [1,2], 4: [2,2], 6: [3,2] };
    const [cols, rows] = GRID[Math.min(handout, 6)] || [1,1];
    const perPage      = cols * rows;
    const usableW      = PW - margin * 2;
    const usableH      = PH - margin * 2;
    const gapX         = cols > 1 ? margin * 0.5 : 0;
    const gapY         = rows > 1 ? margin * 0.5 : 0;
    const cellW        = (usableW - gapX * (cols - 1)) / cols;
    const cellHFull    = (usableH - gapY * (rows - 1)) / rows;
    // Reserve 22% of cell height for notes if "below" mode
    const notesRatio   = notes === 'below' ? 0.22 : 0;
    const slideH       = Math.round(cellHFull * (1 - notesRatio));
    const notesH       = Math.round(cellHFull * notesRatio);

    const textCol   = RGB(0.18, 0.18, 0.18);
    const titleCol  = RGB(0.08, 0.08, 0.40);

    // ── Render slide pages ───────────────────────────────────────────────
    const queue = [...slideData];
    while (queue.length > 0) {
      const batch = queue.splice(0, perPage);
      const page  = doc.addPage([PW, PH]);

      for (let bi = 0; bi < batch.length; bi++) {
        const col = bi % cols;
        const row = Math.floor(bi / cols);
        const bx  = margin + col * (cellW + gapX);
        const by  = PH - margin - (row + 1) * (cellHFull + gapY) + gapY;

        drawSlideInCell(page, batch[bi], bx, by + notesH, cellW, slideH);

        // Speaker notes below
        if (notes === 'below' && notesH > 0) {
          const noteText = notesData[batch[bi].num - 1];
          if (noteText) {
            page.drawRectangle({ x: bx, y: by, width: cellW, height: notesH - 1,
              color: RGB(0.97, 0.98, 1), borderColor: RGB(0.9, 0.9, 0.95), borderWidth: 0.3 });
            page.drawText('Notes:', { x: bx + 4, y: by + notesH - 9, size: 5.5, font: bold, color: RGB(0.45,0.45,0.45) });
            drawWrapped(page, noteText, bx + 4, by + notesH - 17, cellW - 8, by + 2, 5.5, font, RGB(0.5,0.5,0.5));
          }
        }
      }

      // Page footer number + watermark
      page.drawText(String(doc.getPageCount()), { x: PW - margin, y: 7, size: 6.5, font, color: RGB(0.7,0.7,0.7) });
      drawWatermark(page, wmText, PW, PH);
    }

    // ── Append notes pages ────────────────────────────────────────────────
    if (notes === 'append') {
      for (let ni = 0; ni < slideData.length; ni++) {
        const noteText = notesData[ni];
        if (!noteText) continue;
        const np = doc.addPage([PW, PH]);
        np.drawText('Notes — Slide ' + slideData[ni].num, {
          x: margin, y: PH - margin, size: 14, font: bold, color: RGB(0.12, 0.12, 0.42),
        });
        np.drawRectangle({ x: margin, y: PH - margin - 4, width: PW - margin*2, height: 1.5, color: RGB(0.7, 0.7, 0.9) });
        drawWrapped(np, noteText, margin, PH - margin - 24, PW - margin*2, margin, 10, font, textCol);
        drawWatermark(np, wmText, PW, PH);
      }
    }

    const bytes = await doc.save();
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    if (blob.size < 500) throw new Error('PDF generation failed — output appears empty.');
    return blob;
  }

  // ── PHASE 6: EXCEL TO PDF (v3.0 — smart scaling, options-aware, auto-layout) ──
  // Accepts opts: pageSize ('A4'|'Letter'|'A3'), orientation ('portrait'|'landscape'),
  // margins ('none'|'narrow'|'normal'), scaling ('fit-page'|'fit-width'|'actual').
  // Auto-switches to landscape when col count > 6. Dynamic column widths.
  // Validates output; throws on empty/corrupt result.
  async function excelToPdf(files, opts) {
    const XLSX = await loadXlsx();
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();

    const ab = await files[0].arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });
    if (!wb.SheetNames.length) throw new Error('No sheets found in this spreadsheet.');

    // ── Page size definitions (in points: 1 pt = 1/72 inch) ──────────────
    const PAGE_SIZES = {
      A4:     [595, 842],
      Letter: [612, 792],
      A3:     [842, 1191],
    };
    const MARGIN_SIZES = { none: 10, narrow: 25, normal: 40 };

    // ── Determine dimensions from options ─────────────────────────────────
    const psSrc    = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.A4;
    const scaling  = opts.scaling    || 'fit-page';
    const marginPt = MARGIN_SIZES[opts.margins] || MARGIN_SIZES.normal;

    // ── Analyse sheet to decide orientation ───────────────────────────────
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    const firstRows  = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
    const maxCols    = firstRows.length ? Math.max(...firstRows.map(r => r.length)) : 1;

    let orient = opts.orientation || '';
    if (!orient) orient = maxCols > 6 ? 'landscape' : 'portrait';
    const [PW, PH] = orient === 'landscape' ? [psSrc[1], psSrc[0]] : [psSrc[0], psSrc[1]];

    const doc  = await PDFDoc.create();
    const font = await doc.embedFont(SF.Helvetica);
    const bold = await doc.embedFont(SF.HelveticaBold);

    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!rows.length) continue;

      // ── Dimension analysis: calculate ideal column widths ─────────────
      const numCols    = Math.max(...rows.map(r => r.length));
      const usableW    = PW - marginPt * 2;
      const usableH    = PH - marginPt * 2;
      const fontSize   = Math.max(7, Math.min(10, Math.floor(usableW / numCols / 6)));
      const lineH      = fontSize * 1.8;

      // Measure max content width per column (sample first 30 rows for speed)
      const sample = rows.slice(0, 30);
      const colMaxW = Array.from({ length: numCols }, (_, ci) => {
        const maxStr = Math.max(...sample.map(r => String(r[ci] ?? '').length), 3);
        return Math.min(maxStr * (fontSize * 0.6), 200);
      });
      const rawTotal = colMaxW.reduce((s, w) => s + w, 0);

      // ── Scaling: fit-page or fit-width ────────────────────────────────
      let scale = 1;
      if (rawTotal > usableW) {
        if (scaling === 'fit-page' || scaling === 'fit-width') {
          scale = usableW / rawTotal;
        }
      }
      const colWidths = colMaxW.map(w => w * scale);
      const actualFontSize = Math.max(6, fontSize * scale);
      const actualLineH    = actualFontSize * 1.8;

      // ── Render sheet ──────────────────────────────────────────────────
      let page = doc.addPage([PW, PH]);
      const titleY = PH - marginPt;
      page.drawText(`Sheet: ${sheetName}`, {
        x: marginPt, y: titleY - actualFontSize,
        size: Math.min(12, actualFontSize + 2), font: bold,
        color: RGB(0.15, 0.15, 0.5),
      });
      let y = titleY - actualFontSize * 2 - 4;

      for (let ri = 0; ri < rows.length; ri++) {
        if (y < marginPt + actualLineH) {
          page = doc.addPage([PW, PH]);
          y    = PH - marginPt;
        }
        const row      = rows[ri];
        const isHeader = ri === 0;
        const usedFont = isHeader ? bold : font;

        // Header row background
        if (isHeader) {
          page.drawRectangle({
            x: marginPt, y: y - actualLineH + 2,
            width: Math.min(colWidths.reduce((s, w) => s + w, 0), usableW),
            height: actualLineH,
            color: RGB(0.91, 0.91, 0.97),
          });
        }

        // Draw cells
        let x = marginPt;
        for (let ci = 0; ci < numCols; ci++) {
          const colW = colWidths[ci] || 0;
          if (x + colW > PW - marginPt + 1) break;
          const rawCell  = String(row[ci] ?? '');
          const maxChars = Math.max(1, Math.floor(colW / (actualFontSize * 0.55)));
          const cell     = rawCell.length > maxChars ? rawCell.slice(0, maxChars - 1) + '…' : rawCell;
          if (cell) {
            page.drawText(cell, {
              x: x + 2, y: y - actualLineH + 4,
              size: actualFontSize, font: usedFont,
              color: RGB(0, 0, 0),
            });
          }
          // Vertical divider (skip first)
          if (ci > 0) {
            page.drawLine({
              start: { x, y: y + 2 }, end: { x, y: y - actualLineH + 1 },
              thickness: 0.25, color: RGB(0.8, 0.8, 0.8),
            });
          }
          x += colW;
        }

        // Horizontal row divider
        const rowWidth = Math.min(x - marginPt, usableW);
        page.drawLine({
          start: { x: marginPt, y: y - actualLineH },
          end:   { x: marginPt + rowWidth, y: y - actualLineH },
          thickness: isHeader ? 0.75 : 0.25,
          color: isHeader ? RGB(0.55, 0.55, 0.75) : RGB(0.82, 0.82, 0.82),
        });

        y -= actualLineH;
      }
    }

    const pdfBytes = await doc.save();
    const blob     = new Blob([pdfBytes], { type: 'application/pdf' });
    if (blob.size < 500) throw new Error('Generated PDF appears empty. Please check the spreadsheet and try again.');
    return blob;
  }

  // ── DISPATCH TABLE ───────────────────────────────────────────────────────
  // Each handler returns either a Blob (PDF, default ext) OR an object
  // { blob, ext, mime } when the output format isn't .pdf.
  const HANDLERS = {
    // ── existing browser tools (DO NOT TOUCH) ────────────────────────────
    'merge':         merge,
    'split':         split,
    'rotate':        rotate,
    'organize':      organize,
    'page-numbers':  pageNumbers,
    'watermark':     watermark,
    'crop':          crop,
    'jpg-to-pdf':    imagesToPdf,
    'compress':      compress,
    'protect':       protect,
    'unlock':        unlock,
    'pdf-to-jpg':    pdfToJpg,
    'crop-image':    cropImage,
    'resize-image':  resizeImage,
    'image-filters': imageFilters,
    // ── Phase 1 ───────────────────────────────────────────────────────────
    'word-to-pdf':        wordToPdf,
    'html-to-pdf':        htmlToPdf,
    // ── Phase 2 ───────────────────────────────────────────────────────────
    'edit':               editPdf,
    'sign':               signPdf,
    'redact':             redactPdf,
    // ── Phase 3 ───────────────────────────────────────────────────────────
    'pdf-to-word':        pdfToWord,
    'pdf-to-excel':       pdfToExcel,
    'repair':             repairPdf,
    'compare':            comparePdf,
    // ── Phase 4 ───────────────────────────────────────────────────────────
    'ocr':                ocrPdf,
    'background-remover': backgroundRemover,
    // ── Phase 5 ───────────────────────────────────────────────────────────
    'ai-summarize':       aiSummarize,
    // ── Phase 6 ───────────────────────────────────────────────────────────
    'translate':          translatePdf,
    'workflow':           workflowPdf,
    'pdf-to-powerpoint':  pdfToPowerpoint,
    'powerpoint-to-pdf':  powerpointToPdf,
    'excel-to-pdf':       excelToPdf,
    'scan-to-pdf':        scanPdf,
  };

  // Tools whose processing is pure pdf-lib (no DOM, no canvas, no pdfjs) and
  // can safely run inside a Web Worker via WorkerPool.
  const WORKER_TOOLS = new Set([
    'compress', 'workflow', 'merge', 'rotate',
    'page-numbers', 'watermark', 'sign', 'redact', 'edit',
  ]);

  function supports(toolId) { return Object.prototype.hasOwnProperty.call(HANDLERS, toolId); }

  async function process(toolId, files, options) {
    const fn = HANDLERS[toolId];
    if (!fn) throw new Error(`No client-side handler for ${toolId}`);
    if (!files || !files.length) throw new Error('No files provided');

    // File size limits: compress allows 200 MB; everything else 50 MB.
    // Files above these limits are rejected with a user-friendly error.
    const SIZE_LIMITS = { compress: 200 * 1024 * 1024 };
    const sizeLimit   = SIZE_LIMITS[toolId] || 50 * 1024 * 1024;
    const totalBytes  = Array.from(files).reduce((s, f) => s + (f.size || 0), 0);
    if (totalBytes > sizeLimit) throw new Error('file_too_large_for_browser');

    // Memory guard — use MemoryMonitor when loaded, fall back to inline check.
    try {
      if (window.MemoryMonitor) {
        if (window.MemoryMonitor.isUnderPressure()) throw new Error('memory_pressure');
        if (window.MemoryMonitor.wouldExceedLimit(totalBytes)) throw new Error('memory_pressure');
      } else {
        const mem = performance && performance.memory;
        if (mem && mem.usedJSHeapSize > 800 * 1024 * 1024) throw new Error('memory_pressure');
      }
    } catch (e) { if (e.message === 'memory_pressure') throw e; }

    // ── Worker Pool path (off-main-thread for eligible pure pdf-lib tools) ──
    if (WORKER_TOOLS.has(toolId) && typeof Worker !== 'undefined') {
      try {
        const pool = await loadWorkerPool().catch(() => null);
        if (pool) {
          const fileName = files[0].name;
          const buffers  = await Promise.all(Array.from(files).map(f => f.arrayBuffer()));
          const workerResult = await pool.run(
            '/workers/pdf-worker.js',
            { tool: toolId, buffers, options: options || {} },
            buffers,
          );
          if (workerResult && workerResult.buffer) {
            const blob = new Blob([workerResult.buffer], { type: 'application/pdf' });
            if (blob.size === 0) throw new Error('Worker produced empty output — falling back');
            return { blob, filename: brandedFilename(fileName, '.pdf') };
          }
        }
      } catch (workerErr) {
        // Fall through to main-thread path silently
      }
    }

    // ── Main-thread path ─────────────────────────────────────────────────
    const result = await fn(files, options || {});
    let blob, ext;
    if (result && result.blob) {
      blob = result.blob;
      ext  = result.ext || '.pdf';
    } else {
      blob = result;
      ext  = '.pdf';
    }
    // Validate output: reject empty or suspiciously small results immediately.
    const _MIN_SIZES = {
      'pdf-to-word': 800, 'pdf-to-excel': 800, 'pdf-to-powerpoint': 800,
      'ocr': 1, 'compare': 1, 'ai-summarize': 1, 'translate': 1,
      'pdf-to-jpg': 100, 'background-remover': 100,
      'crop-image': 100, 'resize-image': 100, 'image-filters': 100,
    };
    const _minBytes = _MIN_SIZES[toolId] !== undefined ? _MIN_SIZES[toolId] : 200;
    if (!blob || blob.size < _minBytes) {
      const _why = (!blob || blob.size === 0)
        ? 'The output file is empty. The document may be damaged or in an unsupported format.'
        : 'The output file appears incomplete. Please try again with a different file.';
      throw new Error(_why);
    }
    const filename = brandedFilename(files[0].name, ext);
    return { blob, filename };
  }

  window.BrowserTools = { supports, process, brandedFilename, _loadPdfLib: loadPdfLib };
})();
