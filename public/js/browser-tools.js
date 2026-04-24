// Client-side processors for the lightweight tools — runs entirely in the
// browser using pdf-lib (loaded from CDN). Zero upload, instant results.
//
// Usage: window.BrowserTools.process(toolId, files, optionsObj) -> Promise<Blob | { blob, filename }>
(function () {
  const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFLIB_URL; s.async = true;
      s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib failed to load'));
      s.onerror = () => reject(new Error('pdf-lib failed to load'));
      document.head.appendChild(s);
    });
    return pdfLibPromise;
  }

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

  // ── MERGE ────────────────────────────────────────────────────────────
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

  // ── SPLIT — returns single PDF if range collapses to one part, else ZIP ──
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

  // ── ROTATE ────────────────────────────────────────────────────────────
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

  // ── ORGANIZE (reorder) ───────────────────────────────────────────────
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

  // ── PAGE NUMBERS ─────────────────────────────────────────────────────
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

  // ── WATERMARK ────────────────────────────────────────────────────────
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

  // ── CROP ─────────────────────────────────────────────────────────────
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

  // ── JPG/PNG -> PDF ───────────────────────────────────────────────────
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

  const HANDLERS = {
    'merge':         merge,
    'split':         split,
    'rotate':        rotate,
    'organize':      organize,
    'page-numbers':  pageNumbers,
    'watermark':     watermark,
    'crop':          crop,
    'jpg-to-pdf':    imagesToPdf,
  };

  function supports(toolId) { return Object.prototype.hasOwnProperty.call(HANDLERS, toolId); }

  async function process(toolId, files, options) {
    const fn = HANDLERS[toolId];
    if (!fn) throw new Error(`No client-side handler for ${toolId}`);
    if (!files || !files.length) throw new Error('No files provided');
    const blob = await fn(files, options || {});
    const filename = brandedFilename(files[0].name, '.pdf');
    return { blob, filename };
  }

  window.BrowserTools = { supports, process, brandedFilename };
})();
