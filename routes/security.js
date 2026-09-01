import express from 'express';
import fs from 'fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { createUpload } from '../utils/upload.js';
import { qpdfProtect, qpdfUnlock } from '../utils/pdfTools.js';

const router = express.Router();
const upload = createUpload('pdf');

router.post('/protect', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const password = (req.body.password || '').trim();
    if (!password) return res.status(400).json({ error: 'Please provide a password.' });

    try {
      const buf = await qpdfProtect(req.file.path, password);
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-protected.pdf');
    } catch (qErr) {
      cleanupFiles(req.file);
      console.error('[protect] qpdf encryption failed:', qErr.message);
      return res.status(503).json({
        error: 'PDF encryption is temporarily unavailable. Please try again later.',
        code: 'PDF_ENCRYPTION_UNAVAILABLE',
      });
    }
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

router.post('/unlock', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
  const password = req.body.password || '';
  try {
    try {
      const buf = await qpdfUnlock(req.file.path, password);
      cleanupFiles(req.file);
      return sendPdf(res, buf, 'ilovepdf-unlocked.pdf');
    } catch (qErr) {
      console.warn('[unlock] qpdf failed, falling back to pdf-lib:', qErr.message);
    }
    const bytes = fs.readFileSync(req.file.path);
    const pdfDoc = await PDFDocument.load(bytes, { password, ignoreEncryption: true });
    const outBytes = await pdfDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-unlocked.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({
      error: err.message.includes('password')
        ? 'Incorrect password. Please try again.'
        : `Could not unlock: ${err.message}`
    });
  }
});

export default router;
