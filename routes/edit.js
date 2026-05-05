import express from 'express';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import fs from 'fs';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { createUpload } from '../utils/upload.js';
import { gsCompress } from '../utils/pdfTools.js';

const router = express.Router();
const upload = createUpload('pdf', 100 * 1024 * 1024);

// Returns 400 for known client-input errors, 500 for genuine server faults.
function clientErrStatus(err) {
  const msg = (err && err.message) || '';
  return /no (file|text|page|input)|invalid|not found|empty|corrupt|no text/i.test(msg) ? 400 : 500;
}

// Compress — Ghostscript first (real size reduction), pdf-lib fallback
router.post('/compress', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
  try {
    const LEVEL_MAP = { 'low': 'printer', 'medium': 'ebook', 'high': 'screen' };
    const quality = ['screen','ebook','printer','prepress'].includes(req.body.quality)
      ? req.body.quality
      : (LEVEL_MAP[String(req.body.level)] || 'ebook');
    try {
      const buf = await gsCompress(req.file.path, quality);
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-compress.pdf');
    } catch (_gErr) {
      // Ghostscript unavailable — fall through to pdf-lib path
    }
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const outBytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-compress.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

router.post('/edit', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const text     = req.body.text || 'Text overlay';
    const xPct     = clamp(parseFloat(req.body.x)        || 50, 0, 100) / 100;
    const yPct     = clamp(parseFloat(req.body.y)        || 50, 0, 100) / 100;
    const fontSize = clamp(parseInt(req.body.fontSize)   || 14, 6, 96);
    const pageParam = (req.body.page || '1').trim().toLowerCase();

    const allPages = doc.getPages();
    const targets = pageParam === 'all'
      ? allPages.map((_, i) => i)
      : [Math.max(0, parseInt(pageParam) - 1)].filter(i => i < allPages.length);

    targets.forEach(i => {
      const page = allPages[i];
      const { width, height } = page.getSize();
      page.drawText(text, { x: width * xPct, y: height * yPct, size: fontSize, font, color: rgb(0, 0, 0) });
    });

    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-edit.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

router.post('/watermark', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    const text     = req.body.text || 'CONFIDENTIAL';
    const opacity  = clamp(parseFloat(req.body.opacity) || 0.3, 0.05, 0.95);
    const position = req.body.position || 'center';

    doc.getPages().forEach(page => {
      const { width, height } = page.getSize();
      const fontSize = Math.min(width, height) * 0.07;
      const textWidth = font.widthOfTextAtSize(text, fontSize);

      let x, y, rotate;
      switch (position) {
        case 'top-left':     x = 20; y = height - fontSize - 20; rotate = degrees(0); break;
        case 'top-right':    x = width - textWidth - 20; y = height - fontSize - 20; rotate = degrees(0); break;
        case 'bottom-left':  x = 20; y = 20; rotate = degrees(0); break;
        case 'bottom-right': x = width - textWidth - 20; y = 20; rotate = degrees(0); break;
        default:
          x = (width - textWidth) / 2;
          y = (height - fontSize) / 2;
          rotate = degrees(45);
      }

      page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.6, 0.6, 0.6), opacity, rotate });
    });

    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-watermark.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

router.post('/sign', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.TimesRomanItalic);

    const sigText = req.body.signatureText || 'Signature';
    const rawPage = parseInt(req.body.page);
    const pageIdx = isNaN(rawPage) ? doc.getPageCount() - 1 : clamp(rawPage - 1, 0, doc.getPageCount() - 1);
    const page = doc.getPage(pageIdx);
    const { width, height } = page.getSize();

    const fontSize = 28;
    const textWidth = font.widthOfTextAtSize(sigText, fontSize);
    const lineX1 = width * 0.6;
    const lineX2 = width * 0.92;
    const lineY  = height * 0.1;

    page.drawLine({ start: { x: lineX1, y: lineY }, end: { x: lineX2, y: lineY }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(sigText, {
      x: lineX1 + (lineX2 - lineX1 - textWidth) / 2,
      y: lineY + 8,
      size: fontSize,
      font,
      color: rgb(0.05, 0.1, 0.5),
    });

    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-sign.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

router.post('/page-numbers', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const position  = req.body.position  || 'bottom-center';
    const startFrom = Math.max(1, parseInt(req.body.startFrom) || 1);
    const fontSize  = 11;

    doc.getPages().forEach((page, idx) => {
      const { width, height } = page.getSize();
      const label = `${idx + startFrom}`;
      const tw = font.widthOfTextAtSize(label, fontSize);

      let x, y;
      switch (position) {
        case 'top-center':    x = (width - tw) / 2; y = height - 24; break;
        case 'top-right':     x = width - tw - 20;  y = height - 24; break;
        case 'top-left':      x = 20;               y = height - 24; break;
        case 'bottom-right':  x = width - tw - 20;  y = 14;          break;
        case 'bottom-left':   x = 20;               y = 14;          break;
        default:              x = (width - tw) / 2; y = 14;
      }
      page.drawText(label, { x, y, size: fontSize, font, color: rgb(0.35, 0.35, 0.35) });
    });

    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-page-numbers.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

router.post('/redact', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const bytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(bytes);

    const xPct  = clamp(parseFloat(req.body.x)      || 10, 0, 90) / 100;
    const yPct  = clamp(parseFloat(req.body.y)       || 40, 0, 90) / 100;
    const wPct  = clamp(parseFloat(req.body.width)   || 30, 1, 90) / 100;
    const hPct  = clamp(parseFloat(req.body.height)  || 10, 1, 50) / 100;
    const pagesParam = (req.body.pages || '1').trim().toLowerCase();

    const allPages = doc.getPages();
    const targets = pagesParam === 'all'
      ? allPages.map((_, i) => i)
      : pagesParam.split(',').map(s => parseInt(s.trim()) - 1).filter(n => !isNaN(n) && n >= 0 && n < allPages.length);

    targets.forEach(i => {
      const page = allPages[i];
      const { width, height } = page.getSize();
      page.drawRectangle({ x: width * xPct, y: height * yPct, width: width * wPct, height: height * hPct, color: rgb(0, 0, 0), opacity: 1 });
    });

    const outBytes = await doc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-redact.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export default router;
