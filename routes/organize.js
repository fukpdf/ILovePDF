import express from 'express';
import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { createUpload } from '../utils/upload.js';
import { qpdfMerge, qpdfSplit, qpdfRotate, qpdfReorder } from '../utils/pdfTools.js';

const router = express.Router();
const upload = createUpload('pdf', 100 * 1024 * 1024);

/* ── MERGE — qpdf with pdf-lib fallback ─────────────────────────────────── */
router.post('/merge', upload.array('pdfs'), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ error: 'Please upload at least 2 PDF files.' });
  }
  try {
    try {
      const buf = await qpdfMerge(req.files.map(f => f.path));
      cleanupFiles(req.files);
      return sendPdf(res, buf, 'ilovepdf-merge.pdf');
    } catch (qErr) {
      console.warn('[merge] qpdf failed, falling back to pdf-lib:', qErr.message);
    }
    const merged = await PDFDocument.create();
    for (const file of req.files) {
      const bytes = fs.readFileSync(file.path);
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(page => merged.addPage(page));
    }
    const outBytes = await merged.save();
    cleanupFiles(req.files);
    sendPdf(res, outBytes, 'ilovepdf-merge.pdf');
  } catch (err) {
    cleanupFiles(req.files);
    res.status(500).json({ error: err.message });
  }
});

/* ── SPLIT — qpdf with pdf-lib fallback ─────────────────────────────────── */
router.post('/split', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
  try {
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const totalPages = doc.getPageCount();
    const rangeStr = req.body.range || `1-${totalPages}`;

    try {
      const buf = await qpdfSplit(req.file.path, rangeStr.replace(/\s+/g, ''));
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-split.pdf');
    } catch (qErr) {
      console.warn('[split] qpdf failed, falling back to pdf-lib:', qErr.message);
    }

    const pageIndices = parsePageRange(rangeStr, totalPages);
    if (pageIndices.length === 0) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'Invalid page range. Use format: 1-3, 5, 7-9' });
    }
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(doc, pageIndices);
    pages.forEach(page => newDoc.addPage(page));
    const outBytes = await newDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-split.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

/* ── ROTATE — qpdf with pdf-lib fallback ────────────────────────────────── */
router.post('/rotate', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
  try {
    const rotDegrees = parseInt(req.body.degrees) || 90;
    const pagesParam = (req.body.pages || 'all').trim();

    try {
      const scope = pagesParam.toLowerCase() === 'all' ? 'all' : pagesParam.replace(/\s+/g, '');
      const buf = await qpdfRotate(req.file.path, rotDegrees, scope);
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-rotate.pdf');
    } catch (qErr) {
      console.warn('[rotate] qpdf failed, falling back to pdf-lib:', qErr.message);
    }

    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const totalPages = doc.getPageCount();
    const pageIndices = pagesParam.toLowerCase() === 'all'
      ? Array.from({ length: totalPages }, (_, i) => i)
      : parsePageRange(pagesParam, totalPages);
    pageIndices.forEach(i => {
      if (i >= 0 && i < totalPages) {
        const page = doc.getPage(i);
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + rotDegrees) % 360));
      }
    });
    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-rotate.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

/* ── ORGANIZE / REORDER — qpdf with pdf-lib fallback ────────────────────── */
router.post('/organize', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
  try {
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const totalPages = doc.getPageCount();
    const orderStr = req.body.pageOrder ||
      Array.from({ length: totalPages }, (_, i) => i + 1).join(',');
    const order = orderStr.split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n) && n >= 1 && n <= totalPages);
    if (order.length === 0) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'Invalid page order. Use comma-separated 1-indexed page numbers.' });
    }

    try {
      const buf = await qpdfReorder(req.file.path, order);
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-organize.pdf');
    } catch (qErr) {
      console.warn('[organize] qpdf failed, falling back to pdf-lib:', qErr.message);
    }

    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(doc, order.map(n => n - 1));
    pages.forEach(page => newDoc.addPage(page));
    const outBytes = await newDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-organize.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

/* ── CROP (unchanged — pdf-lib is correct here) ─────────────────────────── */
router.post('/crop', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const cropLeft   = clamp(parseFloat(req.body.cropLeft)   || 0, 0, 49) / 100;
    const cropRight  = clamp(parseFloat(req.body.cropRight)  || 0, 0, 49) / 100;
    const cropTop    = clamp(parseFloat(req.body.cropTop)    || 0, 0, 49) / 100;
    const cropBottom = clamp(parseFloat(req.body.cropBottom) || 0, 0, 49) / 100;
    doc.getPages().forEach(page => {
      const { width, height } = page.getSize();
      page.setCropBox(
        width  * cropLeft,
        height * cropBottom,
        width  * (1 - cropLeft - cropRight),
        height * (1 - cropTop - cropBottom)
      );
    });
    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-crop.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

function parsePageRange(rangeStr, totalPages) {
  const indices = new Set();
  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [s, e] = trimmed.split('-').map(n => parseInt(n.trim()));
      if (!isNaN(s) && !isNaN(e)) {
        for (let i = Math.max(1, s); i <= Math.min(e, totalPages); i++) indices.add(i - 1);
      }
    } else {
      const n = parseInt(trimmed);
      if (!isNaN(n) && n >= 1 && n <= totalPages) indices.add(n - 1);
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}
function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

export default router;
