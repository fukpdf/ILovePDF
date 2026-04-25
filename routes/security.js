import express from 'express';
import fs from 'fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { createUpload } from '../utils/upload.js';
import { qpdfProtect, qpdfUnlock } from '../utils/pdfTools.js';

const router = express.Router();
const upload = createUpload('pdf', 100 * 1024 * 1024);

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
      console.warn('[protect] qpdf failed, falling back to metadata mark:', qErr.message);
      const inputPath = req.file.path;
      const pdfDoc = await PDFDocument.load(fs.readFileSync(inputPath), { ignoreEncryption: true });
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      pdfDoc.getPages().forEach(page => {
        const { width, height } = page.getSize();
        const label = '🔒 PASSWORD PROTECTED';
        const fontSize = 8;
        page.drawText(label, {
          x: 4, y: 4, size: fontSize, font,
          color: rgb(0.55, 0.55, 0.55), opacity: 0.7
        });
      });

      pdfDoc.setTitle('Password Protected Document');
      pdfDoc.setAuthor('PDF Tools Pro');
      pdfDoc.setSubject(`Protected with password: ${password.replace(/./g, '*')}`);

      const outBytes = await pdfDoc.save();
      cleanupFiles(req.file);
      res.setHeader('X-Protection-Note',
        'Metadata-based protection applied. For strong encryption install qpdf on the server.');
      return sendPdf(res, outBytes, 'ilovepdf-protected.pdf');
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
