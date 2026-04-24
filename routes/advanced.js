import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { extractPdfText, textToPdf, extractiveSummarize, formatBytes } from '../utils/pdfText.js';
import { summariseText, translateText, isHfConfigured } from '../utils/ai.js';

const router = express.Router();
import { UPLOAD_DIR } from '../utils/upload.js';
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

// ── REPAIR ────────────────────────────────────────────────────────────────

router.post('/repair', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const bytes = fs.readFileSync(req.file.path);
    let pdfDoc;
    try {
      pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (loadErr) {
      throw new Error(`Could not parse PDF structure: ${loadErr.message}`);
    }

    pdfDoc.setTitle(pdfDoc.getTitle() || 'Repaired Document');
    const outBytes = await pdfDoc.save({ useObjectStreams: false });

    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-repair.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── OCR / TEXT EXTRACT ─────────────────────────────────────────────────────

router.post('/ocr', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const bytes = fs.readFileSync(req.file.path);
    const text = await extractPdfText(bytes);

    cleanupFiles(req.file);

    if (!text.trim()) {
      return res.json({
        text: '[No extractable text found]\n\nThis PDF appears to contain only scanned images. ' +
              'For true image-based OCR, Tesseract integration is needed. ' +
              'Text-based PDFs will have their content extracted here.'
      });
    }

    res.json({ text: text.trim() });
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── COMPARE ───────────────────────────────────────────────────────────────

router.post('/compare', upload.array('pdfs'), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2)
      return res.status(400).json({ error: 'Please upload exactly 2 PDF files to compare.' });

    const [f1, f2] = req.files;
    const bytes1 = fs.readFileSync(f1.path);
    const bytes2 = fs.readFileSync(f2.path);

    const [doc1, doc2] = await Promise.all([
      PDFDocument.load(bytes1, { ignoreEncryption: true }).catch(() => null),
      PDFDocument.load(bytes2, { ignoreEncryption: true }).catch(() => null),
    ]);

    const [text1, text2] = await Promise.all([
      extractPdfText(bytes1),
      extractPdfText(bytes2),
    ]);

    const words1 = new Set((text1.toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    const words2 = new Set((text2.toLowerCase().match(/\b[a-z]{2,}\b/g) || []));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    const similarity = union.size > 0 ? Math.round((intersection.size / union.size) * 100) : 0;

    const pages1 = doc1 ? doc1.getPageCount() : '?';
    const pages2 = doc2 ? doc2.getPageCount() : '?';

    const report = {
      'File 1': f1.originalname,
      'File 2': f2.originalname,
      'File 1 Size': formatBytes(f1.size),
      'File 2 Size': formatBytes(f2.size),
      'File 1 Pages': String(pages1),
      'File 2 Pages': String(pages2),
      'Same Page Count': pages1 === pages2 ? '✓ Yes' : '✗ No',
      'File 1 Words': String(words1.size),
      'File 2 Words': String(words2.size),
      'Content Similarity': `${similarity}% word overlap`,
      'Unique to File 1': String([...words1].filter(w => !words2.has(w)).length) + ' words',
      'Unique to File 2': String([...words2].filter(w => !words1.has(w)).length) + ' words',
    };

    if (doc1 && doc2) {
      report['PDF Version Match'] = (doc1.getProducer() === doc2.getProducer()) ? '✓ Same producer' : '✗ Different';
    }

    cleanupFiles(req.files);
    res.json({ report });
  } catch (err) {
    cleanupFiles(req.files);
    res.status(500).json({ error: err.message });
  }
});

// ── AI SUMMARIZER ─────────────────────────────────────────────────────────

router.post('/ai-summarize', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const bytes = fs.readFileSync(req.file.path);
    const text = await extractPdfText(bytes);

    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.json({ summary: 'No extractable text found in this PDF. It may be image-based.' });
    }

    const maxSentences = Math.min(20, Math.max(3, parseInt(req.body.sentences) || 7));

    // Prefer Hugging Face when available; fall back to local extractive summary.
    let summary = '';
    let engine = 'local-extractive';
    if (isHfConfigured()) {
      try {
        summary = await summariseText(text, { sentences: maxSentences });
        engine = 'huggingface:bart-large-cnn';
      } catch (e) {
        console.error('[ai-summarize] HF fallback:', e.message);
      }
    }
    if (!summary) summary = extractiveSummarize(text, maxSentences);

    const wordCount = text.split(/\s+/).length;
    const sentenceCount = (text.match(/[.!?]+/g) || []).length;

    cleanupFiles(req.file);
    res.json({
      summary: `📄 Document Summary  (engine: ${engine})\n${'─'.repeat(40)}\n${summary}\n\n${'─'.repeat(40)}\n📊 Stats: ~${wordCount.toLocaleString()} words · ~${sentenceCount} sentences`
    });
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSLATE ─────────────────────────────────────────────────────────────

router.post('/translate', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const targetLang = req.body.targetLang || 'es';
    const bytes = fs.readFileSync(req.file.path);
    const text = await extractPdfText(bytes);

    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No extractable text found. PDF may be image-based.' });
    }

    let translatedText = '';
    if (isHfConfigured()) {
      try {
        translatedText = await translateText(text.substring(0, 12000), targetLang);
      } catch (e) {
        console.error('[translate] HF failed, falling back to MyMemory:', e.message);
      }
    }
    if (!translatedText) {
      const chunks = chunkText(text.substring(0, 8000), 450);
      const translated = [];
      for (const chunk of chunks) {
        try {
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${targetLang}`;
          const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const data = await resp.json();
          translated.push(data?.responseData?.translatedText || chunk);
        } catch {
          translated.push(chunk);
        }
      }
      translatedText = translated.join(' ');
    }
    const outBytes = await textToPdf(translatedText, PDFDocument, StandardFonts, rgb);

    cleanupFiles(req.file);
    sendPdf(res, outBytes, `fukpdf-translated-${targetLang}.pdf`);
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── WORKFLOW BUILDER ──────────────────────────────────────────────────────

router.post('/workflow', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    let bytes = fs.readFileSync(req.file.path);

    const steps = [
      { op: req.body.step1, value: req.body.step1_value || '' },
      { op: req.body.step2, value: req.body.step2_value || '' },
      { op: req.body.step3, value: req.body.step3_value || '' },
    ].filter(s => s.op && s.op !== '');

    if (steps.length === 0) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'Please select at least one operation.' });
    }

    for (const step of steps) {
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

      switch (step.op) {
        case 'compress':
          bytes = await pdfDoc.save({ useObjectStreams: true });
          break;

        case 'rotate-90':
          pdfDoc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 90) % 360)));
          bytes = await pdfDoc.save();
          break;

        case 'rotate-180':
          pdfDoc.getPages().forEach(p => p.setRotation(degrees((p.getRotation().angle + 180) % 360)));
          bytes = await pdfDoc.save();
          break;

        case 'watermark': {
          const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
          const wText = step.value || 'WATERMARK';
          pdfDoc.getPages().forEach(page => {
            const { width, height } = page.getSize();
            const fs2 = Math.min(width, height) * 0.07;
            const tw = font.widthOfTextAtSize(wText, fs2);
            page.drawText(wText, {
              x: (width - tw) / 2, y: (height - fs2) / 2,
              size: fs2, font, color: rgb(0.6, 0.6, 0.6), opacity: 0.3, rotate: degrees(45)
            });
          });
          bytes = await pdfDoc.save();
          break;
        }

        case 'page-numbers': {
          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          const total = pdfDoc.getPageCount();
          pdfDoc.getPages().forEach((page, idx) => {
            const { width } = page.getSize();
            const label = `${idx + 1} / ${total}`;
            const tw = font.widthOfTextAtSize(label, 10);
            page.drawText(label, { x: (width - tw) / 2, y: 14, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
          });
          bytes = await pdfDoc.save();
          break;
        }

        case 'sign': {
          const font = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
          const sigText = step.value || 'Signed';
          const lastPage = pdfDoc.getPage(pdfDoc.getPageCount() - 1);
          const { width, height } = lastPage.getSize();
          const sigFontSize = 22;
          const tw = font.widthOfTextAtSize(sigText, sigFontSize);
          const sx = width * 0.6;
          lastPage.drawLine({ start: { x: sx, y: height * 0.1 }, end: { x: width * 0.9, y: height * 0.1 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
          lastPage.drawText(sigText, { x: sx + (width * 0.3 - tw) / 2, y: height * 0.1 + 8, size: sigFontSize, font, color: rgb(0.05, 0.1, 0.6) });
          bytes = await pdfDoc.save();
          break;
        }

        default:
          break;
      }
    }

    cleanupFiles(req.file);
    sendPdf(res, bytes, 'fukpdf-workflow.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

function chunkText(text, size) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const ls = text.lastIndexOf(' ', end);
      if (ls > i) end = ls;
    }
    chunks.push(text.slice(i, end).trim());
    i = end + 1;
  }
  return chunks.filter(c => c);
}

export default router;
function toggleSidebar(){document.querySelector(".sidebar").classList.toggle("active")}
