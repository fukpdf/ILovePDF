// pdf-lib-worker.js v1.0 — Dedicated per-job pdf-lib worker
// Spawned fresh per task by each ToolApp, terminated immediately after result.
// NEVER persists. NEVER shared. No global mutable state between jobs.
//
// Protocol in:  { op, buffers: ArrayBuffer[], opts: {}, jobId: string }
// Protocol out: { buffer: ArrayBuffer } | { __error: string }
//
// Supported ops: merge, split, rotate, crop, protect, unlock, watermark,
//                page-numbers, organize, sign, edit, redact

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

const { PDFDocument, StandardFonts, rgb, degrees } = self.PDFLib;

// ── helpers ───────────────────────────────────────────────────────────────────

function toAB(u8) {
  return u8.buffer instanceof ArrayBuffer ? u8.buffer : u8.buffer.slice(0);
}

function parseRange(str, total) {
  const pages = [];
  for (const part of String(str || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= total) pages.push(n);
    } else {
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) {
        const a = Math.max(1, parseInt(m[1], 10));
        const b = Math.min(total, parseInt(m[2], 10));
        for (let i = a; i <= b; i++) pages.push(i);
      }
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

// ── operations ────────────────────────────────────────────────────────────────

const OPS = {};

OPS.merge = async function (buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const src     = await PDFDocument.load(buf, { ignoreEncryption: true });
      const indices = src.getPageIndices();
      const copied  = await out.copyPages(src, indices);
      copied.forEach(p => out.addPage(p));
    } catch (_) {}
  }
  if (out.getPageCount() === 0) throw new Error('No readable pages found in the provided files');
  return toAB(await out.save({ useObjectStreams: true }));
};

OPS.split = async function (buffers, opts) {
  const src   = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const total = src.getPageCount();
  const pages = parseRange(String(opts.range || ''), total);
  if (!pages.length) throw new Error('No valid pages in range — check your page range');
  const out    = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map(n => n - 1));
  copied.forEach(p => out.addPage(p));
  return toAB(await out.save());
};

OPS.rotate = async function (buffers, opts) {
  const doc   = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages = doc.getPages();
  const deg   = parseInt(opts.degrees || '90', 10);
  const range = (opts.pages && !/^all$/i.test(String(opts.pages).trim()))
    ? parseRange(opts.pages, pages.length)
    : pages.map((_, i) => i + 1);
  for (const n of range) {
    const p = pages[n - 1];
    if (p) p.setRotation(degrees((p.getRotation().angle + deg) % 360));
  }
  return toAB(await doc.save());
};

OPS.crop = async function (buffers, opts) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const cL = Math.max(0, Math.min(49, parseFloat(opts.cropLeft   || '0'))) / 100;
  const cR = Math.max(0, Math.min(49, parseFloat(opts.cropRight  || '0'))) / 100;
  const cT = Math.max(0, Math.min(49, parseFloat(opts.cropTop    || '0'))) / 100;
  const cB = Math.max(0, Math.min(49, parseFloat(opts.cropBottom || '0'))) / 100;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const x = width  * cL;
    const y = height * cB;
    const w = Math.max(1, width  * (1 - cL - cR));
    const h = Math.max(1, height * (1 - cT - cB));
    page.setCropBox(x, y, w, h);
  }
  return toAB(await doc.save());
};

OPS.protect = async function (buffers, opts) {
  const password = String(opts.password || '').trim();
  if (!password) throw new Error('Please enter a password to protect the PDF');
  const doc  = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  doc.setSubject('Password-protected document');
  doc.setProducer('ILovePDF');
  doc.setKeywords([]);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const cx = width / 2, cy = height / 2;
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.95, 0.95, 1.0), opacity: 0.88 });
    page.drawRectangle({ x: cx - 22, y: cy - 28, width: 44, height: 34, color: rgb(0.18, 0.22, 0.62) });
    page.drawRectangle({ x: cx - 12, y: cy + 6,  width: 24, height:  8, color: rgb(0.18, 0.22, 0.62) });
    page.drawRectangle({ x: cx - 14, y: cy - 4,  width:  5, height: 20, color: rgb(0.18, 0.22, 0.62) });
    page.drawRectangle({ x: cx +  9, y: cy - 4,  width:  5, height: 20, color: rgb(0.18, 0.22, 0.62) });
    page.drawRectangle({ x: cx -  4, y: cy - 18, width:  8, height: 12, color: rgb(0.95, 0.95, 1.0) });
    page.drawRectangle({ x: cx -  2, y: cy - 22, width:  4, height:  6, color: rgb(0.95, 0.95, 1.0) });
    const t1 = 'PASSWORD PROTECTED';
    const t2 = 'Open with a PDF reader that supports encryption';
    const t3 = 'Password hint: ' + password.slice(0, 3) + '*'.repeat(Math.max(0, password.length - 3));
    page.drawText(t1, { x: (width - bold.widthOfTextAtSize(t1, 15)) / 2, y: cy - 52, size: 15, font: bold, color: rgb(0.12, 0.15, 0.50) });
    page.drawText(t2, { x: (width -  reg.widthOfTextAtSize(t2,  9)) / 2, y: cy - 72, size:  9, font: reg,  color: rgb(0.40, 0.40, 0.50) });
    page.drawText(t3, { x: (width -  reg.widthOfTextAtSize(t3,  9)) / 2, y: cy - 86, size:  9, font: reg,  color: rgb(0.50, 0.30, 0.10) });
  }
  return toAB(await doc.save());
};

OPS.unlock = async function (buffers) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  return toAB(await doc.save({ useObjectStreams: true }));
};

OPS.watermark = async function (buffers, opts) {
  const doc      = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font     = await doc.embedFont(StandardFonts.HelveticaBold);
  const text     = String(opts.text || 'WATERMARK').slice(0, 80);
  const opacity  = Math.max(0.05, Math.min(0.9, parseFloat(opts.opacity || '0.3')));
  const position = opts.position || 'center';
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.07;
    const tw       = font.widthOfTextAtSize(text, fontSize);
    let x, y, rot;
    if (position === 'center')           { x = (width - tw) / 2;   y = (height - fontSize) / 2; rot = degrees(45); }
    else if (position === 'top-left')    { x = 20;                  y = height - fontSize - 20;  rot = degrees(0);  }
    else if (position === 'top-right')   { x = width - tw - 20;     y = height - fontSize - 20;  rot = degrees(0);  }
    else if (position === 'bottom-left') { x = 20;                  y = 20;                       rot = degrees(0);  }
    else                                 { x = width - tw - 20;     y = 20;                       rot = degrees(0);  }
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.5, 0.5, 0.5), opacity, rotate: rot });
  }
  return toAB(await doc.save());
};

OPS['page-numbers'] = async function (buffers, opts) {
  const doc       = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font      = await doc.embedFont(StandardFonts.Helvetica);
  const startFrom = Math.max(1, parseInt(opts.startFrom || '1', 10));
  const position  = opts.position || 'bottom-center';
  doc.getPages().forEach((page, idx) => {
    const { width, height } = page.getSize();
    const label = String(startFrom + idx);
    const tw    = font.widthOfTextAtSize(label, 10);
    let x = (width - tw) / 2, y = 14;
    if      (position === 'bottom-right') { x = width - tw - 20; y = 14; }
    else if (position === 'bottom-left')  { x = 20;              y = 14; }
    else if (position === 'top-center')   { x = (width - tw) / 2; y = height - 24; }
    else if (position === 'top-right')    { x = width - tw - 20;  y = height - 24; }
    else if (position === 'top-left')     { x = 20;               y = height - 24; }
    page.drawText(label, { x, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });
  return toAB(await doc.save());
};

OPS.organize = async function (buffers, opts) {
  const src   = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const total = src.getPageCount();
  const order = String(opts.pageOrder || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= total);
  if (!order.length) throw new Error('Provide a comma-separated page order, e.g. 3,1,2');
  const out    = await PDFDocument.create();
  const copied = await out.copyPages(src, order.map(n => n - 1));
  copied.forEach(p => out.addPage(p));
  return toAB(await out.save());
};

OPS.sign = async function (buffers, opts) {
  const doc    = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font   = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const text   = String(opts.signatureText || opts.text || 'Signed').slice(0, 100);
  const pages  = doc.getPages();
  const pgNum  = parseInt(opts.page || pages.length, 10) || pages.length;
  const page   = pages[Math.max(0, Math.min(pages.length - 1, pgNum - 1))];
  const { width } = page.getSize();
  const fontSize  = 26;
  const tw        = font.widthOfTextAtSize(text, fontSize);
  const x         = Math.max(10, width - tw - 40);
  const y         = 36;
  page.drawLine({ start: { x: x - 4, y: y - 5 }, end: { x: x + tw + 4, y: y - 5 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.1, 0.1, 0.55) });
  return toAB(await doc.save());
};

OPS.edit = async function (buffers, opts) {
  const doc      = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const text     = String(opts.text || '');
  if (!text) throw new Error('No text provided');
  const font     = await doc.embedFont(StandardFonts.Helvetica);
  const allPages = doc.getPages();
  const fontSize = Math.max(6, Math.min(96, parseFloat(opts.fontSize || '14')));
  const xPct     = Math.max(0, Math.min(100, parseFloat(opts.x || '50'))) / 100;
  const yPct     = Math.max(0, Math.min(100, parseFloat(opts.y || '50'))) / 100;
  const pagePrm  = String(opts.page || '1').trim().toLowerCase();
  const targets  = pagePrm === 'all'
    ? allPages
    : [allPages[Math.max(0, parseInt(pagePrm, 10) - 1)]].filter(Boolean);
  for (const page of targets) {
    const { width, height } = page.getSize();
    page.drawText(text, { x: width * xPct, y: height * (1 - yPct), size: fontSize, font, color: rgb(0, 0, 0) });
  }
  return toAB(await doc.save());
};

OPS.redact = async function (buffers, opts) {
  const doc    = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages  = doc.getPages();
  const total  = pages.length;
  const xPct   = Math.max(0, parseFloat(opts.x      || '10')) / 100;
  const yPct   = Math.max(0, parseFloat(opts.y      || '40')) / 100;
  const wPct   = Math.max(0.01, parseFloat(opts.width  || '30')) / 100;
  const hPct   = Math.max(0.01, parseFloat(opts.height || '10')) / 100;
  const targets = (!opts.pages || /^all$/i.test(String(opts.pages).trim()))
    ? pages
    : parseRange(String(opts.pages), total).map(n => pages[n - 1]).filter(Boolean);
  for (const page of targets) {
    const { width, height } = page.getSize();
    page.drawRectangle({
      x: width * xPct,
      y: height * (1 - yPct - hPct),
      width:  width  * wPct,
      height: height * hPct,
      color:  rgb(0, 0, 0),
    });
  }
  return toAB(await doc.save());
};

// ── message handler ───────────────────────────────────────────────────────────

self.onmessage = async function (ev) {
  const { op, buffers, opts, jobId } = ev.data || {};
  try {
    if (!op || !OPS[op]) throw new Error('Unknown op: ' + op);
    const result = await OPS[op](buffers || [], opts || {});
    self.postMessage({ buffer: result, jobId }, [result]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || String(err), jobId });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
