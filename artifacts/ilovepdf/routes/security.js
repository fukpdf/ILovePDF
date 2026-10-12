import express from 'express';
import { cleanupFiles, sendEncryptedPdf, sendPdf } from '../utils/cleanup.js';
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
      return sendEncryptedPdf(res, buf, 'ilovepdf-protected.pdf');
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
    const outBytes = await qpdfUnlock(req.file.path, password);
    cleanupFiles(req.file);
    return sendPdf(res, outBytes, 'ilovepdf-unlocked.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    const detail = `${err.message || ''} ${err.stderr || ''}`;
    if (/password.*(incorrect|invalid|wrong)|incorrect.*password|invalid password/i.test(detail)) {
      return res.status(400).json({ error: 'Incorrect password. Please try again.' });
    }
    console.error('[unlock] qpdf decryption failed:', err.message);
    return res.status(err.code === 'ENOENT' ? 503 : 400).json({
      error: err.code === 'ENOENT'
        ? 'PDF decryption is temporarily unavailable.'
        : 'Could not unlock the PDF. Check the password and make sure the file is valid.',
    });
  }
});

export default router;
