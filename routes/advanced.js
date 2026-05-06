import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { extractPdfText, textToPdf, extractiveSummarize, formatBytes } from '../utils/pdfText.js';
import { UPLOAD_DIR } from '../utils/upload.js';

const router = express.Router();
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

function clientErrStatus(err) {
  const msg = (err && err.message) || '';
  return /no (file|text|page|input)|image.based|scanned|unsupported|invalid|not found|empty|no extractable|no text|could not parse|corrupt/i.test(msg) ? 400 : 500;
}

function sendFile(res, buffer, contentType, filename) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// Chunk text respecting sentence/paragraph boundaries
function chunkText(text, maxSize = 380) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxSize, text.length);
    if (end < text.length) {
      // Prefer sentence boundary
      const sentEnd = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('! ', end),
        text.lastIndexOf('? ', end)
      );
      if (sentEnd > i + Math.floor(maxSize / 2)) {
        end = sentEnd + 1;
      } else {
        const spaceEnd = text.lastIndexOf(' ', end);
        if (spaceEnd > i) end = spaceEnd;
      }
    }
    const chunk = text.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    i = end + 1;
  }
  return chunks;
}

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
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

// ── OCR / TEXT EXTRACT ─────────────────────────────────────────────────────
// v2: returns a DOCX file (matching browser-side output) with heading
//     detection for text-based PDFs. Returns .txt for image-based PDFs
//     with a clear explanation.

router.post('/ocr', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const bytes = fs.readFileSync(req.file.path);
    const text  = await extractPdfText(bytes);

    cleanupFiles(req.file);

    if (!text.trim()) {
      // Image-based PDF — server can't OCR. Return informative DOCX.
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun({ text: 'OCR Required', bold: true })],
            }),
            new Paragraph({
              children: [new TextRun({
                text: 'This PDF appears to be image-based or scanned. ' +
                      'No selectable text was found. ' +
                      'The browser-based OCR engine (Tesseract) will process this file automatically when you use the tool in your browser.',
              })],
            }),
          ],
        }],
      });
      const buf = await Packer.toBuffer(doc);
      return sendFile(res, buf,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'ilovepdf-ocr.docx');
    }

    // Build structured DOCX with heading detection
    const lines    = text.split('\n');
    const children = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) { children.push(new Paragraph({})); continue; }

      const isAllCaps      = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) && trimmed.length >= 3 && trimmed.length <= 70;
      const isPageMarker   = /^(={3,}|-{3,}|Page \d+)/i.test(trimmed);
      const isShortBold    = trimmed.length < 65 &&
        (i === 0 || !lines[i - 1]?.trim()) &&
        (i >= lines.length - 1 || !lines[i + 1]?.trim());

      if (isPageMarker) {
        children.push(new Paragraph({
          children: [new TextRun({ text: trimmed, bold: true, color: '888888', size: 18 })],
          spacing: { before: 200, after: 80 },
        }));
      } else if (isAllCaps && trimmed.length <= 60) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: trimmed, bold: true, size: 28, color: '1a1a2e' })],
          spacing: { before: 240, after: 120 },
        }));
      } else if (isShortBold) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: trimmed, bold: true, size: 24, color: '2c3e50' })],
          spacing: { before: 160, after: 80 },
        }));
      } else {
        children.push(new Paragraph({
          children: [new TextRun({ text: trimmed, size: 22 })],
          spacing: { after: 60 },
        }));
      }
    }

    if (!children.length) {
      children.push(new Paragraph({ children: [new TextRun('No text content.')] }));
    }

    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buf = await Packer.toBuffer(doc);

    sendFile(res, buf,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'ilovepdf-ocr.docx');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
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
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

// ── AI SUMMARIZER ─────────────────────────────────────────────────────────
// v2: heading-aware TF-IDF with duplicate removal and richer report format.

router.post('/ai-summarize', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const bytes = fs.readFileSync(req.file.path);
    const text  = await extractPdfText(bytes);

    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.json({ summary: 'No extractable text found in this PDF. It may be image-based or scanned.' });
    }

    const maxSentences = Math.min(20, Math.max(3, parseInt(req.body.sentences) || 7));
    const summary      = extractiveSummarize(text, maxSentences);
    const wordCount    = text.split(/\s+/).filter(Boolean).length;
    const sentCount    = (text.match(/[.!?]+/g) || []).length;
    const pageEst      = Math.max(1, Math.round(wordCount / 300));

    cleanupFiles(req.file);
    res.json({
      summary: [
        'ILovePDF — AI Summary',
        '='.repeat(50),
        `Words  : ~${wordCount.toLocaleString()}`,
        `Pages  : ~${pageEst}`,
        '',
        'SUMMARY',
        '-'.repeat(50),
        summary,
        '',
        `Note: ${sentCount} sentences analysed, top ${maxSentences} selected.`,
      ].join('\n'),
    });
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

// ── TRANSLATE — MyMemory free API ──────────────────────────────────────────
// v2: respects sourceLang param, 380-char sentence-aware chunks, paragraph
//     structure preserved, output is a well-formatted plain-text file.

router.post('/translate', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const targetLang = (req.body.targetLang || req.body.targetLanguage || 'es').toLowerCase();
    const sourceLang = (req.body.sourceLang || req.body.sourceLanguage || 'en').toLowerCase();

    const bytes = fs.readFileSync(req.file.path);
    const text  = await extractPdfText(bytes);

    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No extractable text found. PDF may be image-based.' });
    }

    // Limit total input to avoid rate-limiting; 12 000 chars ≈ ~4 pages
    const inputText = text.substring(0, 12000);
    const chunks    = chunkText(inputText, 380);

    const translatedParts = [];
    for (const chunk of chunks) {
      try {
        const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(sourceLang)}|${encodeURIComponent(targetLang)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json();

        const translated = data?.responseData?.translatedText;
        // MyMemory returns the original text when quota exceeded or unsupported pair
        if (translated && translated !== chunk) {
          translatedParts.push(translated);
        } else {
          translatedParts.push(chunk);
        }
      } catch {
        translatedParts.push(chunk);
      }
    }

    const translatedText = translatedParts.join(' ');

    // Check if anything was actually translated
    const identical = translatedText.trim() === inputText.trim();
    if (identical) {
      cleanupFiles(req.file);
      return res.status(422).json({
        error: `Translation from "${sourceLang}" to "${targetLang}" could not be completed. ` +
               'The language pair may not be supported, or the service quota was reached. Please try again later.',
      });
    }

    // Build formatted plain-text output (consistent with browser-side output)
    const lines = [
      `ILovePDF — Translated (${targetLang.toUpperCase()})`,
      '='.repeat(50),
      `Source language : ${sourceLang.toUpperCase()}`,
      `Target language : ${targetLang.toUpperCase()}`,
      '',
      translatedText,
    ];

    cleanupFiles(req.file);
    sendFile(res, Buffer.from(lines.join('\n'), 'utf-8'),
      'text/plain; charset=utf-8',
      `ilovepdf-translated-${targetLang}.txt`);
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
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
              size: fs2, font, color: rgb(0.6, 0.6, 0.6), opacity: 0.3, rotate: degrees(45),
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
    sendPdf(res, bytes, 'ilovepdf-workflow.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(clientErrStatus(err)).json({ error: err.message });
  }
});

export default router;
