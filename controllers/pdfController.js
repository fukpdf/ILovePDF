import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';

export async function mergePdf(req, res) {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'Please upload at least 2 PDF files.' });
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
    sendPdf(res, outBytes, 'merged.pdf');
  } catch (err) {
    cleanupFiles(req.files);
    res.status(500).json({ error: err.message });
  }
}
