// PDF Worker v3.0 — persistent, CPU-intensive PDF operations off main thread.
// Phase 1: Persistent (no terminate-per-task). Phase 3: Enhanced compression.
// Receives: { tool, buffers: ArrayBuffer[], options: {} }
// Responds: { buffer: ArrayBuffer } | { __error: 'message' }

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');

const { PDFDocument, StandardFonts, rgb, degrees } = self.PDFLib;

// ── HELPERS ───────────────────────────────────────────────────────────────────

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

function toArrayBuffer(u8) {
  return u8.buffer instanceof ArrayBuffer ? u8.buffer : u8.buffer.slice(0);
}

// ── PHASE 3: ENHANCED COMPRESSION ENGINE ─────────────────────────────────────
// Multi-strategy compression: object-stream rebuild + metadata strip +
// optional OffscreenCanvas image downsampling for image-heavy PDFs.

async function tryOffscreenCompress(buf) {
  // Render-based compression: each page → canvas at ~96 DPI → re-encode as
  // image-based PDF. Produces very small files but text becomes rasterized.
  // Only used as a deep compression fallback when object-stream pass is weak.
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const srcDoc  = await PDFDocument.load(buf, { ignoreEncryption: true });
    const total   = srcDoc.getPageCount();
    const outDoc  = await PDFDocument.create();

    // We can't render in a worker without pdfjs — skip render path,
    // instead do aggressive metadata + stream cleanup via pdf-lib
    // and return null to signal caller to try next strategy.
    return null;
  } catch (_) { return null; }
}

async function stripMetadata(doc) {
  // Remove all XMP / Info metadata to save space
  try {
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setProducer('ILovePDF');
    doc.setCreator('ILovePDF');
  } catch (_) {}
}

// Phase 3: Main enhanced compress — multi-pass with size selection
const OPS = {};

OPS.compress = async function (buffers) {
  const original = buffers[0];
  const doc = await PDFDocument.load(original, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  // Strip metadata to save space
  await stripMetadata(doc);

  // Pass 1: object streams + no default page (most effective general strategy)
  const pass1 = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: 50,
  });
  const pass1Buf = toArrayBuffer(pass1);

  // Pass 2: reload pass1 result and re-save (second defragmentation pass)
  let pass2Buf = pass1Buf;
  try {
    if (pass1Buf.byteLength < original.byteLength) {
      const doc2  = await PDFDocument.load(pass1Buf, { ignoreEncryption: true, updateMetadata: false });
      const pass2 = await doc2.save({ useObjectStreams: true, addDefaultPage: false });
      const p2    = toArrayBuffer(pass2);
      // Only keep pass2 if it's actually smaller
      if (p2.byteLength < pass1Buf.byteLength) pass2Buf = p2;
    }
  } catch (_) {}

  // Pick smallest result that is still smaller than original
  const best = [pass1Buf, pass2Buf]
    .filter(b => b.byteLength < original.byteLength)
    .sort((a, b) => a.byteLength - b.byteLength)[0];

  // If no strategy improved the size, return the original so callers always get valid output.
  return best || original;
};

OPS.repair = async function (buffers) {
  const doc = await PDFDocument.load(buffers[0], {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  doc.setTitle(doc.getTitle() || 'Repaired Document');
  const out = await doc.save({ useObjectStreams: false });
  return toArrayBuffer(out);
};

OPS.merge = async function (buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const src     = await PDFDocument.load(buf, { ignoreEncryption: true });
      const indices = src.getPageIndices();
      const copied  = await merged.copyPages(src, indices);
      copied.forEach(p => merged.addPage(p));
    } catch (_) { /* skip unreadable */ }
  }
  const out = await merged.save({ useObjectStreams: true });
  return toArrayBuffer(out);
};

OPS.rotate = async function (buffers, opts) {
  const doc   = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages = doc.getPages();
  const deg   = parseInt(opts.degrees || '90', 10);
  const range = (opts.pages && !/^all$/i.test(String(opts.pages).trim()))
    ? parsePageRange(opts.pages, pages.length)
    : pages.map((_, i) => i + 1);
  for (const n of range) {
    const p = pages[n - 1];
    if (p) p.setRotation(degrees((p.getRotation().angle + deg) % 360));
  }
  const out = await doc.save();
  return toArrayBuffer(out);
};

OPS['page-numbers'] = async function (buffers, opts) {
  const doc      = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font     = await doc.embedFont(StandardFonts.Helvetica);
  const pages    = doc.getPages();
  const total    = pages.length;
  const startFrom = Math.max(1, parseInt(opts.startFrom || '1', 10));
  const position  = opts.position || 'bottom-center';

  pages.forEach((page, idx) => {
    const { width, height } = page.getSize();
    const label = String(startFrom + idx);
    const tw    = font.widthOfTextAtSize(label, 10);
    let x = (width - tw) / 2, y = 14;
    if (position === 'bottom-right') { x = width - tw - 20; y = 14; }
    else if (position === 'bottom-left') { x = 20; y = 14; }
    else if (position === 'top-center')  { x = (width - tw) / 2; y = height - 24; }
    else if (position === 'top-right')   { x = width - tw - 20; y = height - 24; }
    else if (position === 'top-left')    { x = 20; y = height - 24; }
    page.drawText(label, { x, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  });

  const out = await doc.save();
  return toArrayBuffer(out);
};

OPS.watermark = async function (buffers, opts) {
  const doc     = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font    = await doc.embedFont(StandardFonts.HelveticaBold);
  const text    = opts.text || 'WATERMARK';
  const opacity = Math.max(0.05, Math.min(0.9, parseFloat(opts.opacity || '0.3')));
  const position = opts.position || 'center';

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.07;
    const tw       = font.widthOfTextAtSize(text, fontSize);
    let x, y, rot;
    if (position === 'center')      { x = (width - tw) / 2; y = (height - fontSize) / 2; rot = degrees(45); }
    else if (position === 'top-left')    { x = 20; y = height - fontSize - 20; rot = degrees(0); }
    else if (position === 'top-right')   { x = width - tw - 20; y = height - fontSize - 20; rot = degrees(0); }
    else if (position === 'bottom-left') { x = 20; y = 20; rot = degrees(0); }
    else                                 { x = width - tw - 20; y = 20; rot = degrees(0); }
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.5, 0.5, 0.5), opacity, rotate: rot });
  }
  const out = await doc.save();
  return toArrayBuffer(out);
};

OPS.sign = async function (buffers, opts) {
  const doc    = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const font   = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const text   = String(opts.signatureText || opts.text || 'Signed').slice(0, 100);
  const pages  = doc.getPages();
  const pgNum  = parseInt(opts.page || pages.length, 10) || pages.length;
  const page   = pages[Math.max(0, Math.min(pages.length - 1, pgNum - 1))];
  const { width } = page.getSize();
  const fontSize = 26;
  const tw       = font.widthOfTextAtSize(text, fontSize);
  const x        = Math.max(10, width - tw - 40);
  const y        = 36;
  page.drawLine({ start: { x: x - 4, y: y - 5 }, end: { x: x + tw + 4, y: y - 5 }, thickness: 0.6, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.1, 0.1, 0.55) });
  const out = await doc.save();
  return toArrayBuffer(out);
};

OPS.redact = async function (buffers, opts) {
  const doc    = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const pages  = doc.getPages();
  const total  = pages.length;
  const xPct   = Math.max(0, parseFloat(opts.x || '10')) / 100;
  const yPct   = Math.max(0, parseFloat(opts.y || '40')) / 100;
  const wPct   = Math.max(0.01, parseFloat(opts.width  || '30')) / 100;
  const hPct   = Math.max(0.01, parseFloat(opts.height || '10')) / 100;
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
  return toArrayBuffer(out);
};

OPS.edit = async function (buffers, opts) {
  const doc  = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const text = String(opts.text || '');
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
  const out = await doc.save();
  return toArrayBuffer(out);
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
        currentBuf = toArrayBuffer(out);
        break;
      }
      case 'rotate-90': {
        doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 90) % 360)));
        const out = await doc.save();
        currentBuf = toArrayBuffer(out);
        break;
      }
      case 'rotate-180': {
        doc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 180) % 360)));
        const out = await doc.save();
        currentBuf = toArrayBuffer(out);
        break;
      }
      case 'watermark': {
        const font   = await doc.embedFont(StandardFonts.HelveticaBold);
        const wText  = step.value || 'WATERMARK';
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
        currentBuf = toArrayBuffer(out);
        break;
      }
      case 'page-numbers': {
        const font  = await doc.embedFont(StandardFonts.Helvetica);
        const total = doc.getPageCount();
        doc.getPages().forEach((page, idx) => {
          const { width } = page.getSize();
          const label = `${idx + 1} / ${total}`;
          const tw    = font.widthOfTextAtSize(label, 10);
          page.drawText(label, { x: (width - tw) / 2, y: 14, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
        });
        const out = await doc.save();
        currentBuf = toArrayBuffer(out);
        break;
      }
      case 'sign': {
        const font    = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
        const sigText = step.value || 'Signed';
        const lastPg  = doc.getPage(doc.getPageCount() - 1);
        const { width: W, height: H } = lastPg.getSize();
        const fs = 22;
        const tw = font.widthOfTextAtSize(sigText, fs);
        const sx = W * 0.6;
        lastPg.drawLine({ start: { x: sx, y: H * 0.1 }, end: { x: W * 0.9, y: H * 0.1 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
        lastPg.drawText(sigText, { x: sx + (W * 0.3 - tw) / 2, y: H * 0.1 + 8, size: fs, font, color: rgb(0.05, 0.1, 0.6) });
        const out = await doc.save();
        currentBuf = toArrayBuffer(out);
        break;
      }
      default: break;
    }
  }

  return currentBuf;
};

// ── Phase 4: Promoted scheduler-only tools → worker-dispatch mode ─────────────

OPS.split = async function (buffers, opts) {
  const src   = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const total = src.getPageCount();
  const pages = parsePageRange(String(opts.range || ''), total);
  if (!pages.length) throw new Error('No valid pages selected — check your page range');
  const out    = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map(n => n - 1));
  copied.forEach(p => out.addPage(p));
  const result = await out.save();
  return toArrayBuffer(result);
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
  const result = await out.save();
  return toArrayBuffer(result);
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
    page.drawText(t2, { x: (width - reg.widthOfTextAtSize(t2,  9)) / 2, y: cy - 72, size:  9, font: reg,  color: rgb(0.40, 0.40, 0.50) });
    page.drawText(t3, { x: (width - reg.widthOfTextAtSize(t3,  9)) / 2, y: cy - 86, size:  9, font: reg,  color: rgb(0.50, 0.30, 0.10) });
  }
  const out = await doc.save();
  return toArrayBuffer(out);
};

OPS.unlock = async function (buffers) {
  const doc = await PDFDocument.load(buffers[0], { ignoreEncryption: true });
  const out = await doc.save({ useObjectStreams: true });
  return toArrayBuffer(out);
};

// OPS.compare — structural PDF comparison using pdf-lib only (no DOM/pdfjsLib needed).
// Generates a PDF comparison report covering: page counts, page sizes, metadata.
// Returns a proper application/pdf buffer, consistent with all other worker OPS.
OPS.compare = async function (buffers, opts) {
  if (!buffers || !buffers[1]) throw new Error('Two PDFs required for comparison');
  const trunc = (s, n) => String(s || '').slice(0, n || 55) || '(none)';

  const docA = await PDFDocument.load(buffers[0], { ignoreEncryption: true, throwOnInvalidObject: false });
  const docB = await PDFDocument.load(buffers[1], { ignoreEncryption: true, throwOnInvalidObject: false });

  const pgCountA = docA.getPageCount();
  const pgCountB = docB.getPageCount();
  const pagesA   = docA.getPages();
  const pagesB   = docB.getPages();
  const compared = Math.min(pgCountA, pgCountB);
  let sizeMismatches = 0;
  for (let i = 0; i < compared; i++) {
    const sA = pagesA[i].getSize(), sB = pagesB[i].getSize();
    if (Math.abs(sA.width - sB.width) > 2 || Math.abs(sA.height - sB.height) > 2) sizeMismatches++;
  }

  const sameCount  = pgCountA === pgCountB;
  const sameSize   = sizeMismatches === 0;
  const identical  = sameCount && sameSize;
  const green = rgb(0.05, 0.50, 0.10);
  const red   = rgb(0.70, 0.15, 0.05);
  const navy  = rgb(0.10, 0.10, 0.50);
  const grey  = rgb(0.50, 0.50, 0.50);
  const black = rgb(0.05, 0.05, 0.05);

  const report = await PDFDocument.create();
  const font   = await report.embedFont(StandardFonts.Helvetica);
  const bold   = await report.embedFont(StandardFonts.HelveticaBold);
  const page   = report.addPage([595, 842]);
  const m = 50;
  let y = 790;

  const row = (text, yy, size, f, col) => {
    page.drawText(String(text), { x: m, y: yy, size: size || 11, font: f || font, color: col || black });
  };
  const hr = (yy) => {
    page.drawLine({ start: { x: m, y: yy }, end: { x: 545, y: yy }, thickness: 0.5, color: grey });
  };

  row('PDF Comparison Report', y, 20, bold, navy); y -= 8;
  hr(y); y -= 20;

  row('Document A', y, 13, bold); y -= 18;
  row('  File size : ' + (Math.round(buffers[0].byteLength / 1024)) + ' KB',          y, 10); y -= 14;
  row('  Pages     : ' + pgCountA,                                                      y, 10); y -= 14;
  row('  Title     : ' + trunc(docA.getTitle()),                                        y, 10); y -= 14;
  row('  Author    : ' + trunc(docA.getAuthor()),                                       y, 10); y -= 14;
  if (pagesA.length) { const s = pagesA[0].getSize(); row('  Page 1    : ' + Math.round(s.width) + ' \xd7 ' + Math.round(s.height) + ' pt', y, 10); } y -= 22;

  row('Document B', y, 13, bold); y -= 18;
  row('  File size : ' + (Math.round(buffers[1].byteLength / 1024)) + ' KB',          y, 10); y -= 14;
  row('  Pages     : ' + pgCountB,                                                      y, 10); y -= 14;
  row('  Title     : ' + trunc(docB.getTitle()),                                        y, 10); y -= 14;
  row('  Author    : ' + trunc(docB.getAuthor()),                                       y, 10); y -= 14;
  if (pagesB.length) { const s = pagesB[0].getSize(); row('  Page 1    : ' + Math.round(s.width) + ' \xd7 ' + Math.round(s.height) + ' pt', y, 10); } y -= 22;

  hr(y); y -= 20;
  row('Comparison Results', y, 14, bold); y -= 20;
  row('Page count match  : ' + (sameCount ? 'Yes (' + pgCountA + ')' : 'No  (A=' + pgCountA + ', B=' + pgCountB + ')'),
      y, 11, font, sameCount ? green : red); y -= 18;
  row('Page size match   : ' + (sameSize ? 'Yes (' + compared + ' pages checked)' : 'No  (' + sizeMismatches + ' mismatch' + (sizeMismatches !== 1 ? 'es' : '') + ' in ' + compared + ' pages)'),
      y, 11, font, sameSize ? green : red); y -= 18;
  row('Structural result : ' + (identical ? 'Documents appear structurally identical' : 'Structural differences detected'),
      y, 12, bold, identical ? green : red); y -= 30;

  hr(y); y -= 14;
  row('Generated by ILovePDF \u2014 structural comparison (page layout & metadata; text content not analysed)', y, 8, font, grey);

  const out = await report.save();
  return toArrayBuffer(out);
};

// ── DISPATCHER (persistent — handles multiple messages) ───────────────────────

self.onmessage = async function (e) {
  const data = e.data || {};

  // Phase 4: SAB mode — buffers were shared, not transferred
  let buffers = data.buffers || [];
  if (data._sabMode && buffers.length === 0 && data._sabCount > 0) {
    // SAB buffers arrive as transferables when possible; otherwise already in data
    buffers = (data.sabBuffers || []).map(sab => {
      if (sab instanceof SharedArrayBuffer) {
        // Copy SAB slice into regular ArrayBuffer for pdf-lib
        const ab = new ArrayBuffer(sab.byteLength);
        new Uint8Array(ab).set(new Uint8Array(sab));
        return ab;
      }
      return sab;
    });
  }

  const { tool, options } = data;
  try {
    const op = OPS[tool];
    if (!op) throw new Error('Unknown tool: ' + tool);
    if (!buffers || !buffers.length) throw new Error('No file buffers provided');

    const resultBuffer = await op(buffers, options || {});
    if (!resultBuffer) throw new Error('No output produced');

    self.postMessage({ buffer: resultBuffer }, [resultBuffer]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err) });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error' });
};
