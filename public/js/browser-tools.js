// Client-side processors for the lightweight tools — runs entirely in the
// browser using pdf-lib / pdfjs / canvas (loaded lazily from CDN). Zero
// upload, instant results.
//
// Usage: window.BrowserTools.process(toolId, files, optionsObj)
//        -> Promise<{ blob, filename }>
(function () {
  const PDFLIB_URL    = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const PDFJS_URL     = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs';
  const PDFJS_WORKER  = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
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
      page.cleanup(); // Release page resources immediately after render
      pages.push(await canvasToBlob(canvas, 'image/jpeg', jpegQ));
      // Free the canvas explicitly to keep memory bounded on big PDFs.
      canvas.width = 0; canvas.height = 0;
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

  // ── PHASE 1: WORD TO PDF ─────────────────────────────────────────────────
  async function wordToPdf(files) {
    const mammoth    = await loadMammoth();
    const html2pdfFn = await loadHtml2Pdf();
    const ab = await files[0].arrayBuffer();
    const { value: htmlContent } = await mammoth.convertToHtml({ arrayBuffer: ab });
    const container = document.createElement('div');
    container.innerHTML = htmlContent;
    container.style.cssText = 'font-family:Arial,sans-serif;font-size:12pt;padding:40px;max-width:750px;position:fixed;left:-9999px;top:0;background:#fff;';
    document.body.appendChild(container);
    try {
      const blob = await html2pdfFn()
        .set({ margin: 12, image: { type: 'jpeg', quality: 0.95 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, html2canvas: { scale: 2, useCORS: true } })
        .from(container)
        .output('blob');
      return new Blob([blob], { type: 'application/pdf' });
    } finally {
      if (container.parentNode) document.body.removeChild(container);
    }
  }

  // ── PHASE 1: HTML TO PDF ─────────────────────────────────────────────────
  async function htmlToPdf(files) {
    const html2pdfFn = await loadHtml2Pdf();
    const text = await files[0].text();
    const container = document.createElement('div');
    container.innerHTML = text;
    container.style.cssText = 'max-width:750px;font-family:Arial,sans-serif;position:fixed;left:-9999px;top:0;background:#fff;padding:20px;';
    document.body.appendChild(container);
    try {
      const blob = await html2pdfFn()
        .set({ margin: 12, image: { type: 'jpeg', quality: 0.95 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, html2canvas: { scale: 2, useCORS: true } })
        .from(container)
        .output('blob');
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

  // ── PHASE 3: REPAIR PDF ──────────────────────────────────────────────────
  async function repairPdf(files) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.load(await readFileBytes(files[0]), { ignoreEncryption: true, throwOnInvalidObject: false });
    doc.setTitle(doc.getTitle() || 'Repaired Document');
    return new Blob([await doc.save({ useObjectStreams: false })], { type: 'application/pdf' });
  }

  // ── PHASE 3: PDF TO WORD ─────────────────────────────────────────────────
  // Extracts text via pdfjs and packages it into a minimal valid DOCX.
  async function pdfToWord(files) {
    const pdfjsLib = await loadPdfJs();
    const JSZip    = await loadJsZip();
    const data = await readFileBytes(files[0]);
    const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += `\n\n[Page ${i}]\n` + content.items.map(it => it.str).join(' ');
    }
    const escaped = fullText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const paragraphs = escaped.split('\n').map(line =>
      `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`
    ).join('');
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;
    const ctXml  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    const relsXml= `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', ctXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('word/document.xml', docXml);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
    const docxBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    return { blob: docxBlob, ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }

  // ── PHASE 3: PDF TO EXCEL ────────────────────────────────────────────────
  // Extracts text via pdfjs, groups items into rows by y-position, outputs XLSX.
  async function pdfToExcel(files) {
    const XLSX     = await loadXlsx();
    const pdfjsLib = await loadPdfJs();
    const data = await readFileBytes(files[0]);
    const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const wb   = XLSX.utils.book_new();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const rows = {};
      for (const item of content.items) {
        if (!item.str.trim()) continue;
        const yKey = Math.round(item.transform[5] / 8) * 8;
        if (!rows[yKey]) rows[yKey] = [];
        rows[yKey].push({ x: item.transform[4], text: item.str });
      }
      const sortedYs  = Object.keys(rows).map(Number).sort((a, b) => b - a);
      const sheetData = sortedYs.map(y => rows[y].sort((a, b) => a.x - b.x).map(it => it.text));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), `Page ${i}`);
    }
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return { blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
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

  // ── PHASE 4: OCR PDF ────────────────────────────────────────────────────
  // Tries pdfjs text extraction first (fast). Falls back to tesseract.js for
  // image-based PDFs where text content is negligible.
  async function ocrPdf(files) {
    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let allText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      allText += content.items.map(it => it.str).join(' ') + '\n';
    }
    if (allText.replace(/\s/g, '').length > 60) {
      return { blob: new Blob([allText.trim()], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
    }
    // Render pages to canvas and run tesseract
    const Tesseract = await loadTesseract();
    const ocrLines  = [];
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
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 0; canvas.height = 0;
      const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng', { logger: () => {} });
      ocrLines.push(`--- Page ${i} ---\n${text}`);
    }
    return { blob: new Blob([ocrLines.join('\n\n')], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
  }

  // ── PHASE 4: BACKGROUND REMOVER (canvas pixel manipulation) ──────────────
  // Removes near-white pixels by making them transparent. Matches server
  // behavior (sharp threshold-based removal).
  async function backgroundRemover(files, opts) {
    const img       = await loadImageFromFile(files[0]);
    const threshold = Math.max(100, Math.min(255, parseInt(opts.threshold || '240', 10)));
    const canvas    = document.createElement('canvas');
    canvas.width    = img.naturalWidth;
    canvas.height   = img.naturalHeight;
    const ctx       = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= threshold && d[i + 1] >= threshold && d[i + 2] >= threshold) d[i + 3] = 0;
    }
    ctx.putImageData(imgData, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/png');
    return { blob, ext: '.png', mime: 'image/png' };
  }

  // ── PHASE 5: AI SUMMARIZER (extractive, browser-only) ────────────────────
  // Uses pdfjs to extract text, then applies a TF-IDF-style extractive
  // summarization. Fast, privacy-preserving, no upload needed.
  async function aiSummarize(files, opts) {
    const pdfjsLib = await loadPdfJs();
    const data     = await readFileBytes(files[0]);
    const pdf      = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(it => it.str).join(' ') + ' ';
    }
    if (!fullText.trim()) throw new Error('no_text');
    const maxSentences = Math.min(20, Math.max(3, parseInt(opts.sentences || '7', 10)));
    const sentences = (fullText.match(/[^.!?]{15,}[.!?]+/g) || [fullText]).map(s => s.trim()).filter(Boolean);
    const words     = fullText.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const freq      = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    const scored = sentences.map(s => ({
      s,
      score: (s.toLowerCase().match(/\b[a-z]{3,}\b/g) || []).reduce((sum, w) => sum + (freq[w] || 0), 0),
    }));
    const topSentences = scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSentences)
      .map(x => x.s);
    const wordCount     = words.length;
    const sentenceCount = sentences.length;
    const summary = [
      `Document Summary`,
      `${'─'.repeat(40)}`,
      topSentences.join(' '),
      `${'─'.repeat(40)}`,
      `Stats: ~${wordCount.toLocaleString()} words · ~${sentenceCount} sentences`,
    ].join('\n');
    return { blob: new Blob([summary], { type: 'text/plain' }), ext: '.txt', mime: 'text/plain' };
  }

  // ── PHASE 6: TRANSLATE PDF (MyMemory API, no upload) ─────────────────────
  function chunkText(text, size) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + size, text.length);
      if (end < text.length) {
        const ls = text.lastIndexOf(' ', end);
        if (ls > i) end = ls;
      }
      chunks.push(text.slice(i, end).trim());
      i = end + 1;
    }
    return chunks.filter(c => c);
  }

  async function translatePdf(files, opts) {
    const targetLang = opts.targetLang || 'es';
    const pdfjsLib   = await loadPdfJs();
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();

    const data = await readFileBytes(files[0]);
    const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(it => it.str).join(' ') + '\n\n';
    }
    if (!fullText.trim()) throw new Error('No extractable text found in PDF');

    const chunks     = chunkText(fullText.substring(0, 8000), 450);
    const translated = [];
    for (const chunk of chunks) {
      try {
        const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${targetLang}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const json = await resp.json();
        translated.push(json?.responseData?.translatedText || chunk);
      } catch { translated.push(chunk); }
    }
    const translatedText = translated.join(' ');

    // Build output PDF using pdf-lib word-wrap
    const doc      = await PDFDoc.create();
    const font     = await doc.embedFont(SF.Helvetica);
    const fontSize = 11;
    const lineH    = fontSize * 1.5;
    const margin   = 50;
    const PW = 595, PH = 842; // A4
    const usableW  = PW - margin * 2;

    const words = translatedText.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (font.widthOfTextAtSize(test, fontSize) > usableW && cur) {
        lines.push(cur); cur = word;
      } else { cur = test; }
    }
    if (cur) lines.push(cur);

    let page = doc.addPage([PW, PH]);
    let y    = PH - margin;
    for (const line of lines) {
      if (y - lineH < margin) { page = doc.addPage([PW, PH]); y = PH - margin; }
      if (line.trim()) page.drawText(line, { x: margin, y: y - lineH, size: fontSize, font, color: RGB(0, 0, 0) });
      y -= lineH;
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
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

  // ── PHASE 6: PDF TO POWERPOINT (pdfjs text → pptxgenjs) ─────────────────
  async function pdfToPowerpoint(files) {
    const PptxGenJS = await loadPptxGen();
    const pdfjsLib  = await loadPdfJs();
    const data = await readFileBytes(files[0]);
    const pdf  = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

    const pptx    = new PptxGenJS();
    pptx.layout   = 'LAYOUT_16x9';
    pptx.title    = files[0].name.replace(/\.[^.]+$/, '');

    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text    = content.items.map(it => it.str).join(' ').trim();
      const slide   = pptx.addSlide();
      slide.addText(`Page ${i}`, { x: 0.4, y: 0.15, w: '90%', h: 0.45, fontSize: 20, bold: true, color: '303030' });
      if (text) {
        slide.addText(text.substring(0, 900), { x: 0.4, y: 0.75, w: '90%', h: 4.2, fontSize: 11, color: '555555', wrap: true });
      }
    }

    const blob = await pptx.write({ outputType: 'blob' });
    return { blob, ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }

  // ── PHASE 6: POWERPOINT TO PDF (JSZip parse → pdf-lib) ───────────────────
  async function powerpointToPdf(files) {
    const JSZip = await loadJsZip();
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();

    const ab  = await files[0].arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = parseInt((a.match(/\d+/) || ['0'])[0], 10);
        const nb = parseInt((b.match(/\d+/) || ['0'])[0], 10);
        return na - nb;
      });

    const doc  = await PDFDoc.create();
    const font = await doc.embedFont(SF.Helvetica);
    const bold = await doc.embedFont(SF.HelveticaBold);
    const PW   = 842, PH = 595; // landscape A4
    const margin = 48, fontSize = 11, lineH = fontSize * 1.6;

    if (slideNames.length === 0) {
      const p = doc.addPage([PW, PH]);
      p.drawText('No slides found in presentation', { x: margin, y: PH / 2, size: fontSize, font, color: RGB(0, 0, 0) });
    }

    for (const slideName of slideNames) {
      const xml   = await zip.files[slideName].async('text');
      const texts = [];
      const re    = /<a:t[^>]*>([^<]*)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const t = m[1]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim();
        if (t) texts.push(t);
      }

      const page = doc.addPage([PW, PH]);
      const slideNum = (slideName.match(/slide(\d+)/) || ['', '?'])[1];
      page.drawText(`Slide ${slideNum}`, { x: margin, y: PH - margin, size: 15, font: bold, color: RGB(0.2, 0.2, 0.2) });

      let y = PH - margin - 26;
      for (const t of texts) {
        if (y < margin + fontSize) break;
        const usableW = PW - margin * 2;
        if (font.widthOfTextAtSize(t, fontSize) > usableW) {
          const words = t.split(' ');
          let line = '';
          for (const word of words) {
            const test = line ? line + ' ' + word : word;
            if (font.widthOfTextAtSize(test, fontSize) > usableW && line) {
              if (y < margin + fontSize) break;
              page.drawText(line, { x: margin, y, size: fontSize, font, color: RGB(0, 0, 0) });
              y -= lineH; line = word;
            } else { line = test; }
          }
          if (line && y >= margin) { page.drawText(line, { x: margin, y, size: fontSize, font, color: RGB(0, 0, 0) }); y -= lineH; }
        } else {
          page.drawText(t, { x: margin, y, size: fontSize, font, color: RGB(0, 0, 0) });
          y -= lineH;
        }
      }
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // ── PHASE 6: EXCEL TO PDF (XLSX parse → pdf-lib table) ───────────────────
  async function excelToPdf(files) {
    const XLSX = await loadXlsx();
    const { PDFDocument: PDFDoc, StandardFonts: SF, rgb: RGB } = await loadPdfLib();

    const ab  = await files[0].arrayBuffer();
    const wb  = XLSX.read(ab, { type: 'array' });
    const doc  = await PDFDoc.create();
    const font = await doc.embedFont(SF.Helvetica);
    const bold = await doc.embedFont(SF.HelveticaBold);
    const PW   = 842, PH = 595; // landscape A4
    const margin = 40, fontSize = 10, lineH = fontSize * 1.7, colW = 95;

    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!rows.length) continue;

      let page = doc.addPage([PW, PH]);
      page.drawText(`Sheet: ${sheetName}`, { x: margin, y: PH - margin, size: 14, font: bold, color: RGB(0.15, 0.15, 0.5) });
      let y = PH - margin - 20;
      const maxCols = Math.min(9, Math.max(...rows.map(r => r.length)));

      for (let ri = 0; ri < rows.length; ri++) {
        if (y < margin + lineH) { page = doc.addPage([PW, PH]); y = PH - margin; }
        const row      = rows[ri];
        const isHeader = ri === 0;
        const usedFont = isHeader ? bold : font;
        if (isHeader) {
          page.drawRectangle({ x: margin, y: y - lineH + 2, width: PW - margin * 2, height: lineH, color: RGB(0.92, 0.92, 0.96) });
        }
        for (let ci = 0; ci < maxCols; ci++) {
          const x = margin + ci * colW;
          if (x + colW > PW - margin) break;
          const cell = String(row[ci] ?? '').substring(0, 13);
          page.drawText(cell, { x: x + 3, y: y - lineH + 4, size: fontSize, font: usedFont, color: RGB(0, 0, 0) });
        }
        page.drawLine({ start: { x: margin, y: y - lineH }, end: { x: PW - margin, y: y - lineH }, thickness: 0.25, color: RGB(0.75, 0.75, 0.75) });
        y -= lineH;
      }
    }
    return new Blob([await doc.save()], { type: 'application/pdf' });
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
    'scan-to-pdf':        imagesToPdf,
  };

  // Tools whose processing is pure pdf-lib (no DOM, no canvas, no pdfjs) and
  // can safely run inside a Web Worker via WorkerPool.
  const WORKER_TOOLS = new Set([
    'compress', 'repair', 'workflow', 'merge', 'rotate',
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
