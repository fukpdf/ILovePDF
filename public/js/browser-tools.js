// Client-side processors for the lightweight tools — runs entirely in the
// browser using pdf-lib / pdfjs / canvas (loaded lazily from CDN). Zero
// upload, instant results.
//
// Usage: window.BrowserTools.process(toolId, files, optionsObj)
//        -> Promise<{ blob, filename }>
(function () {
  const PDFLIB_URL  = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const PDFJS_URL   = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  const PDFJS_WORKER= 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
  const JSZIP_URL   = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

  // ── lazy CDN loaders (cached) ────────────────────────────────────────────
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFLIB_URL; s.async = true;
      s.onload  = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib failed to load'));
      s.onerror = () => reject(new Error('pdf-lib failed to load'));
      document.head.appendChild(s);
    });
    return pdfLibPromise;
  }

  let pdfJsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = (async () => {
      const mod = await import(PDFJS_URL);
      const pdfjsLib = mod && (mod.default || mod);
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      window.pdfjsLib = pdfjsLib;
      return pdfjsLib;
    })();
    return pdfJsPromise;
  }

  let jsZipPromise = null;
  function loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jsZipPromise) return jsZipPromise;
    jsZipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSZIP_URL; s.async = true;
      s.onload  = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip failed to load'));
      s.onerror = () => reject(new Error('JSZip failed to load'));
      document.head.appendChild(s);
    });
    return jsZipPromise;
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

  // ── JPG/PNG -> PDF ───────────────────────────────────────────────────────
  async function imagesToPdf(files) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    for (const f of files) {
      const bytes = await readFileBytes(f);
      const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);
      const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── COMPRESS (basic, browser-side) ───────────────────────────────────────
  // Re-saves the PDF using object streams + dropping XFA so it's typically
  // smaller. If the result is somehow LARGER than the original, we bubble
  // up an error so the caller can fall back to the heavier path.
  async function compress(files) {
    const { PDFDocument } = await loadPdfLib();
    const original = await readFileBytes(files[0]);
    const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
    const out = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 200,
    });
    if (out.byteLength >= original.byteLength) {
      // Browser pass made no improvement — let the caller fall back.
      const e = new Error('No browser-side compression possible');
      e.code = 'NO_BROWSER_GAIN';
      throw e;
    }
    return new Blob([out], { type: 'application/pdf' });
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
    const scale   = quality === 'high' ? 2.7 : 2.0;
    const jpegQ   = quality === 'high' ? 0.92 : 0.85;

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
      pages.push(await canvasToBlob(canvas, 'image/jpeg', jpegQ));
      // Free the canvas explicitly to keep memory bounded on big PDFs.
      canvas.width = 0; canvas.height = 0;
    }

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

  // ── DISPATCH TABLE ───────────────────────────────────────────────────────
  // Each handler returns either a Blob (PDF, default ext) OR an object
  // { blob, ext, mime } when the output format isn't .pdf.
  const HANDLERS = {
    'merge':         merge,
    'split':         split,
    'rotate':        rotate,
    'organize':      organize,
    'page-numbers':  pageNumbers,
    'watermark':     watermark,
    'crop':          crop,
    'jpg-to-pdf':    imagesToPdf,
    'compress':      compress,
    'unlock':        unlock,
    'pdf-to-jpg':    pdfToJpg,
    'crop-image':    cropImage,
    'resize-image':  resizeImage,
    'image-filters': imageFilters,
  };

  function supports(toolId) { return Object.prototype.hasOwnProperty.call(HANDLERS, toolId); }

  async function process(toolId, files, options) {
    const fn = HANDLERS[toolId];
    if (!fn) throw new Error(`No client-side handler for ${toolId}`);
    if (!files || !files.length) throw new Error('No files provided');
    const result = await fn(files, options || {});
    // Normalise: handlers may return a Blob (PDF) or { blob, ext, mime }.
    let blob, ext;
    if (result && result.blob) {
      blob = result.blob;
      ext  = result.ext || '.pdf';
    } else {
      blob = result;
      ext  = '.pdf';
    }
    const filename = brandedFilename(files[0].name, ext);
    return { blob, filename };
  }

  window.BrowserTools = { supports, process, brandedFilename, _loadPdfLib: loadPdfLib };
})();
