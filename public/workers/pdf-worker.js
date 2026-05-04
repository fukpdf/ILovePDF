// PDF Worker — classic Web Worker for CPU-intensive PDF operations.
// Loaded by WorkerPool; communicates via postMessage (no DOM access).
// Receives: { tool, buffers: ArrayBuffer[], options: {} }
// Responds: { buffer: ArrayBuffer } | { __error: 'message' }

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

// pdf-lib UMD sets self.PDFLib in a worker context
const { PDFDocument, StandardFonts, rgb, degrees } = self.PDFLib;

// ── helpers ──────────────────────────────────────────────────────────────────

function parsePageRange(rangeStr, total) {
  const pages = [];
  const parts = String(rangeStr || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= total) pages.push(n);
    } else if (/^(\d+)-(\d+)$/.test(part)) {
      let [, a, b] = part.match(/^(\d+)-(\d+)$/);
      a = Math.max(1, parseInt(a, 10));
      b = Math.min(total, parseInt(b, 10));
      for (let i = a; i <= b; i++) pages.push(i);
    }
  }
  return [...new Set(pages)].sort((x, y) => x - y);
}

// ── operations ───────────────────────────────────────────────────────────────

const OPS = {};

OPS.compress = async function (buffers) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.repair = async function (buffers) {
  const doc = await PDFDocument.load(buffers[0], {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  doc.setTitle(doc.getTitle() || 'Repaired Document');
  const out = await doc.save({ useObjectStreams: false });
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.merge = async function (buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const indices = src.getPageIndices();
      const copied = await merged.copyPages(src, indices);
      copied.forEach(p => merged.addPage(p));
    } catch (_) { /* skip unreadable PDFs */ }
  }
  const out = await merged.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.rotate = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages = doc.getPages();
  const deg = parseInt(opts.degrees || '90', 10);
  const pageRange = (opts.pages && !/^all$/i.test(String(opts.pages).trim()))
    ? parsePageRange(opts.pages, pages.length)
    : pages.map((_, i) => i + 1);
  for (const n of pageRange) {
    const p = pages[n - 1];
    if (p) p.setRotation(degrees((p.getRotation().angle + deg) % 360));
  }
  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS['page-numbers'] = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  const startFrom = Math.max(1, parseInt(opts.startFrom || '1', 10));
  const position = opts.position || 'bottom-center';

  pages.forEach((page, idx) => {
    const { width, height } = page.getSize();
    const label = String(startFrom + idx);
    const tw = font.widthOfTextAtSize(label, 10);
    let x = (width - tw) / 2;
    let y = 14;
    if (position === 'bottom-right') { x = width - tw - 20; y = 14; }
    else if (position === 'bottom-left') { x = 20; y = 14; }
    else if (position === 'top-center') { x = (width - tw) / 2; y = height - 24; }
    else if (position === 'top-right') { x = width - tw - 20; y = height - 24; }
    else if (position === 'top-left') { x = 20; y = height - 24; }
    page.drawText(label, { x, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });

  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.watermark = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = opts.text || 'WATERMARK';
  const opacity = Math.max(0.05, Math.min(0.9, parseFloat(opts.opacity || '0.3')));
  const position = opts.position || 'center';

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.07;
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x, y, rot;
    if (position === 'center')       { x = (width - tw) / 2; y = (height - fontSize) / 2; rot = degrees(45); }
    else if (position === 'top-left')     { x = 20; y = height - fontSize - 20; rot = degrees(0); }
    else if (position === 'top-right')    { x = width - tw - 20; y = height - fontSize - 20; rot = degrees(0); }
    else if (position === 'bottom-left')  { x = 20; y = 20; rot = degrees(0); }
    else                                  { x = width - tw - 20; y = 20; rot = degrees(0); }
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.5, 0.5, 0.5), opacity, rotate: rot });
  }
  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.sign = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const text = String(opts.signatureText || opts.text || 'Signed').slice(0, 100);
  const pages = doc.getPages();
  const pageNum = parseInt(opts.page || pages.length, 10) || pages.length;
  const page = pages[Math.max(0, Math.min(pages.length - 1, pageNum - 1))];
  const { width } = page.getSize();
  const fontSize = 26;
  const tw = font.widthOfTextAtSize(text, fontSize);
  const x = Math.max(10, width - tw - 40);
  const y = 36;
  page.drawLine({ start: { x: x - 4, y: y - 5 }, end: { x: x + tw + 4, y: y - 5 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.1, 0.1, 0.55) });
  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.redact = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages = doc.getPages();
  const total = pages.length;
  const xPct = Math.max(0, parseFloat(opts.x || '10')) / 100;
  const yPct = Math.max(0, parseFloat(opts.y || '40')) / 100;
  const wPct = Math.max(0.01, parseFloat(opts.width || '30')) / 100;
  const hPct = Math.max(0.01, parseFloat(opts.height || '10')) / 100;
  const targets = (!opts.pages || /^all$/i.test(String(opts.pages).trim()))
    ? pages
    : parsePageRange(String(opts.pages), total).map(n => pages[n - 1]).filter(Boolean);
  for (const page of targets) {
    const { width, height } = page.getSize();
    page.drawRectangle({
      x: width * xPct,
      y: height * (1 - yPct - hPct),
      width: width * wPct,
      height: height * hPct,
      color: rgb(0, 0, 0),
    });
  }
  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.edit = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const text = String(opts.text || '');
  if (!text) throw new Error('No text provided');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const allPages = doc.getPages();
  const fontSize = Math.max(6, Math.min(96, parseFloat(opts.fontSize || '14')));
  const xPct = Math.max(0, Math.min(100, parseFloat(opts.x || '50'))) / 100;
  const yPct = Math.max(0, Math.min(100, parseFloat(opts.y || '50'))) / 100;
  const pageParam = String(opts.page || '1').trim().toLowerCase();
  const targets = pageParam === 'all'
    ? allPages
    : [allPages[Math.max(0, parseInt(pageParam, 10) - 1)]].filter(Boolean);
  for (const page of targets) {
    const { width, height } = page.getSize();
    page.drawText(text, { x: width * xPct, y: height * (1 - yPct), size: fontSize, font, color: rgb(0, 0, 0) });
  }
  const out = await doc.save();
  return out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
};

OPS.workflow = async function (buffers, opts) {
  const steps = [
    { op: opts.step1, value: opts.step1_value || '' },
    { op: opts.step2, value: opts.step2_value || '' },
    { op: opts.step3, value: opts.step3_value || '' },
  ].filter(s => s.op && s.op !== '');

  if (steps.length === 0) throw new Error('Please select at least one operation');

  let currentBuf = buffers[0];

  for (const step of steps) {
    const doc = await PDFDocument.load(currentBuf, { ignoreEncryption: true });

    switch (step.op) {
      case 'compress': {
        const out = await doc.save({ useObjectStreams: true });
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      case 'rotate-90': {
        doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 90) % 360)));
        const out = await doc.save();
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      case 'rotate-180': {
        doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 180) % 360)));
        const out = await doc.save();
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      case 'watermark': {
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        const wText = step.value || 'WATERMARK';
        doc.getPages().forEach(page => {
          const { width, height } = page.getSize();
          const fs = Math.min(width, height) * 0.07;
          const tw = font.widthOfTextAtSize(wText, fs);
          page.drawText(wText, {
            x: (width - tw) / 2, y: (height - fs) / 2,
            size: fs, font, color: rgb(0.6, 0.6, 0.6), opacity: 0.3, rotate: degrees(45),
          });
        });
        const out = await doc.save();
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      case 'page-numbers': {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const total = doc.getPageCount();
        doc.getPages().forEach((page, idx) => {
          const { width } = page.getSize();
          const label = `${idx + 1} / ${total}`;
          const tw = font.widthOfTextAtSize(label, 10);
          page.drawText(label, { x: (width - tw) / 2, y: 14, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
        });
        const out = await doc.save();
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      case 'sign': {
        const font = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
        const sigText = step.value || 'Signed';
        const lastPage = doc.getPage(doc.getPageCount() - 1);
        const { width: W, height: H } = lastPage.getSize();
        const fs = 22;
        const tw = font.widthOfTextAtSize(sigText, fs);
        const sx = W * 0.6;
        lastPage.drawLine({ start: { x: sx, y: H * 0.1 }, end: { x: W * 0.9, y: H * 0.1 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
        lastPage.drawText(sigText, { x: sx + (W * 0.3 - tw) / 2, y: H * 0.1 + 8, size: fs, font, color: rgb(0.05, 0.1, 0.6) });
        const out = await doc.save();
        currentBuf = out.buffer instanceof ArrayBuffer ? out.buffer : out.buffer.slice(0);
        break;
      }
      default:
        break;
    }
  }

  return currentBuf instanceof ArrayBuffer ? currentBuf : currentBuf;
};

// ── dispatcher ───────────────────────────────────────────────────────────────

self.onmessage = async function (e) {
  const { tool, buffers, options } = e.data || {};
  try {
    const op = OPS[tool];
    if (!op) throw new Error('Unknown tool: ' + tool);
    if (!buffers || !buffers.length) throw new Error('No file buffers provided');

    const resultBuffer = await op(buffers, options || {});

    // Transfer the result back (zero-copy)
    self.postMessage({ buffer: resultBuffer }, [resultBuffer]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err) });
  }
};
