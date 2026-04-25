import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { parse as parseHtml } from 'node-html-parser';
import { createRequire } from 'module';
import { cleanupFiles, sendPdf } from '../utils/cleanup.js';
import { extractPdfText, wrapText, textToPdf } from '../utils/pdfText.js';
import { createUpload } from '../utils/upload.js';
import { magickImagesToPdf } from '../utils/pdfTools.js';

const require = createRequire(import.meta.url);
const execAsync = promisify(exec);
const router = express.Router();
const upload   = createUpload('pdf',   100 * 1024 * 1024);
const imgUpload = createUpload('image', 100 * 1024 * 1024);

// ── HELPERS ────────────────────────────────────────────────────────────────

function sendFile(res, buffer, contentType, filename) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

function chunkText(text, size = 450) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > i) end = lastSpace;
    }
    chunks.push(text.slice(i, end).trim());
    i = end + 1;
  }
  return chunks.filter(c => c.length > 0);
}

// ── IMAGES → PDF (existing, working) ──────────────────────────────────────

async function imagesToPdf(files, res, filename) {
  const doc = await PDFDocument.create();
  for (const file of files) {
    const imgBytes = fs.readFileSync(file.path);
    const mime = file.mimetype;
    let image;
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      image = await doc.embedJpg(imgBytes);
    } else {
      image = await doc.embedPng(imgBytes);
    }
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const outBytes = await doc.save();
  cleanupFiles(files);
  sendPdf(res, outBytes, filename);
}

router.post('/jpg-to-pdf', imgUpload.array('images'), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'Please upload at least one image.' });
  try {
    try {
      const buf = await magickImagesToPdf(req.files.map(f => f.path));
      cleanupFiles(req.files);
      return sendPdf(res, buf, 'ilovepdf-jpg-to-pdf.pdf');
    } catch (mErr) {
      console.warn('[jpg-to-pdf] ImageMagick failed, falling back to pdf-lib:', mErr.message);
    }
    await imagesToPdf(req.files, res, 'ilovepdf-jpg-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.files); res.status(500).json({ error: err.message }); }
});

router.post('/scan-to-pdf', imgUpload.array('images'), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'Please upload at least one scanned image.' });
  try {
    try {
      const buf = await magickImagesToPdf(req.files.map(f => f.path));
      cleanupFiles(req.files);
      return sendPdf(res, buf, 'ilovepdf-scan-to-pdf.pdf');
    } catch (mErr) {
      console.warn('[scan-to-pdf] ImageMagick failed, falling back to pdf-lib:', mErr.message);
    }
    await imagesToPdf(req.files, res, 'ilovepdf-scan-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.files); res.status(500).json({ error: err.message }); }
});

// ── PDF → WORD ─────────────────────────────────────────────────────────────

router.post('/pdf-to-word', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const buffer = fs.readFileSync(req.file.path);
    const text = await extractPdfText(buffer);
    if (!text.trim()) throw new Error('No extractable text found. The PDF may be image-based or scanned.');

    const children = text.split('\n').map(line =>
      new Paragraph({ children: [new TextRun({ text: line || '', break: line.trim() ? 0 : 1 })] })
    );

    const doc = new Document({
      sections: [{ properties: {}, children: children.length ? children : [new Paragraph({ children: [new TextRun('No text content.')] })] }]
    });

    const buf = await Packer.toBuffer(doc);
    cleanupFiles(req.file);
    sendFile(res, buf,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'ilovepdf-pdf-to-word.docx');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── PDF → POWERPOINT ───────────────────────────────────────────────────────

router.post('/pdf-to-powerpoint', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const buffer = fs.readFileSync(req.file.path);
    const text = await extractPdfText(buffer);
    if (!text.trim()) throw new Error('No extractable text found. The PDF may be image-based.');

    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';

    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim());
    const chunksPerSlide = Math.max(1, Math.ceil(paragraphs.length / Math.max(1, pageCount)));

    for (let i = 0; i < paragraphs.length; i += chunksPerSlide) {
      const slide = pptx.addSlide();
      const content = paragraphs.slice(i, i + chunksPerSlide).join('\n\n');
      slide.addText(content, {
        x: 0.5, y: 0.5, w: '90%', h: '85%',
        fontSize: 14, color: '222222', fontFace: 'Calibri',
        align: 'left', valign: 'top', breakLine: true
      });
    }

    if (pptx.slides.length === 0) {
      const slide = pptx.addSlide();
      slide.addText(text.substring(0, 2000), { x: 0.5, y: 0.5, w: '90%', h: '85%', fontSize: 14 });
    }

    const buf = await pptx.write({ outputType: 'nodebuffer' });
    cleanupFiles(req.file);
    sendFile(res, buf,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'ilovepdf-pdf-to-ppt.pptx');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── PDF → EXCEL ─────────────────────────────────────────────────────────────

router.post('/pdf-to-excel', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const buffer = fs.readFileSync(req.file.path);
    const text = await extractPdfText(buffer);
    if (!text.trim()) throw new Error('No extractable text found. The PDF may be image-based.');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PDF Tools Pro';
    const sheet = workbook.addWorksheet('PDF Content');

    sheet.columns = [
      { header: 'Line #', key: 'num', width: 8 },
      { header: 'Content', key: 'content', width: 80 }
    ];
    sheet.getRow(1).font = { bold: true };

    const lines = text.split('\n').filter(l => l.trim());
    lines.forEach((line, i) => sheet.addRow({ num: i + 1, content: line.trim() }));

    const buf = await workbook.xlsx.writeBuffer();
    cleanupFiles(req.file);
    sendFile(res, buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ilovepdf-pdf-to-excel.xlsx');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── PDF → JPG ──────────────────────────────────────────────────────────────

router.post('/pdf-to-jpg', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const inputPath = req.file.path;
    const outputDir = `${inputPath}-pages`;
    fs.mkdirSync(outputDir, { recursive: true });

    const density = req.body.quality === 'high' ? 200 : 150;
    const outputPattern = path.join(outputDir, 'page-%04d.jpg');

    await execAsync(
      `magick -density ${density} "${inputPath}" -quality 85 -background white -alpha remove "${outputPattern}"`
    );

    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.jpg')).sort();
    if (files.length === 0) throw new Error('No pages could be converted.');

    if (files.length === 1) {
      const imgBuf = fs.readFileSync(path.join(outputDir, files[0]));
      fs.rmSync(outputDir, { recursive: true, force: true });
      cleanupFiles(req.file);
      return sendFile(res, imgBuf, 'image/jpeg', 'ilovepdf-pdf-to-jpg.jpg');
    }

    const zip = new JSZip();
    files.forEach(f => zip.file(f, fs.readFileSync(path.join(outputDir, f))));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    fs.rmSync(outputDir, { recursive: true, force: true });
    cleanupFiles(req.file);
    sendFile(res, zipBuf, 'application/zip', 'ilovepdf-pdf-to-jpg.zip');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: `PDF to JPG failed: ${err.message}. Ensure the PDF is not corrupted.` });
  }
});

// ── WORD → PDF ─────────────────────────────────────────────────────────────

router.post('/word-to-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a Word document.' });

    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: req.file.path });
    const text = result.value || '';
    if (!text.trim()) throw new Error('Could not extract text from the Word document.');

    const outBytes = await textToPdf(text, PDFDocument, StandardFonts, rgb);
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-word-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── POWERPOINT → PDF ──────────────────────────────────────────────────────

router.post('/powerpoint-to-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PowerPoint file.' });

    const zip = await JSZip.loadAsync(fs.readFileSync(req.file.path));
    let allText = '';

    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)[0]);
        const nb = parseInt(b.match(/\d+/)[0]);
        return na - nb;
      });

    for (const sf of slideFiles) {
      const xml = await zip.files[sf].async('string');
      const textNodes = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
      const slideText = textNodes.join(' ').replace(/\s+/g, ' ').trim();
      if (slideText) allText += `[Slide]\n${slideText}\n\n`;
    }

    if (!allText.trim()) throw new Error('No text found in the presentation.');

    const outBytes = await textToPdf(allText, PDFDocument, StandardFonts, rgb);
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-ppt-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── EXCEL → PDF ───────────────────────────────────────────────────────────

router.post('/excel-to-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an Excel file.' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    const bold = await pdfDoc.embedFont(StandardFonts.CourierBold);
    const margin = 40;
    const pageW = 792;
    const pageH = 612;
    const colWidth = 100;
    const rowH = 14;
    const fontSize = 8;

    workbook.eachSheet(sheet => {
      let page = pdfDoc.addPage([pageW, pageH]);
      let y = pageH - margin;

      page.drawText(`Sheet: ${sheet.name}`, {
        x: margin, y, size: 11, font: bold, color: rgb(0.1, 0.1, 0.7)
      });
      y -= 20;

      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (y < margin + rowH) {
          page = pdfDoc.addPage([pageW, pageH]);
          y = pageH - margin;
        }

        let x = margin;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (x + colWidth > pageW - margin) return;
          const val = String(cell.value ?? '').substring(0, 18);
          const f = rowNumber === 1 ? bold : font;
          page.drawText(val, { x, y, size: fontSize, font: f, color: rgb(0.1, 0.1, 0.1) });
          x += colWidth;
        });
        y -= rowH;
      });
    });

    const outBytes = await pdfDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-excel-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

// ── HTML → PDF ─────────────────────────────────────────────────────────────

router.post('/html-to-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an HTML file.' });

    const html = fs.readFileSync(req.file.path, 'utf-8');
    const root = parseHtml(html);

    // Remove scripts and styles
    root.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    const text = root.structuredText || root.text || root.rawText;
    if (!text.trim()) throw new Error('No readable content found in the HTML file.');

    const outBytes = await textToPdf(text, PDFDocument, StandardFonts, rgb);
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-html-to-pdf.pdf');
  } catch (err) { cleanupFiles(req.file); res.status(500).json({ error: err.message }); }
});

export default router;
