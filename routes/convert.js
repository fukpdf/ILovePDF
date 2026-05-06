import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
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
const upload    = createUpload('pdf',   100 * 1024 * 1024);
const imgUpload = createUpload('image', 100 * 1024 * 1024);
const anyUpload = createUpload('any',   100 * 1024 * 1024);

// ── HELPERS ────────────────────────────────────────────────────────────────

function sendFile(res, buffer, contentType, filename) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
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
// v2: heading detection via ALL-CAPS / numeric prefix / short-line heuristics

router.post('/pdf-to-word', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const buffer = fs.readFileSync(req.file.path);
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No extractable text found. The PDF may be image-based or scanned.' });
    }

    const lines = text.split('\n');
    const children = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const trimmed = line.trim();

      if (!trimmed) {
        children.push(new Paragraph({}));
        continue;
      }

      // Heading detection heuristics
      const isAllCaps = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) && trimmed.length >= 3 && trimmed.length <= 80;
      const isNumericSection = /^(\d+\.)+\s+\S/.test(trimmed) && trimmed.length < 100;
      const isShortIsolated  = trimmed.length < 70 &&
        (idx === 0 || !lines[idx - 1].trim()) &&
        (idx >= lines.length - 1 || !lines[idx + 1].trim());

      if (isAllCaps && trimmed.length <= 60) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: trimmed, bold: true, size: 28, color: '1a1a2e' })],
          spacing: { before: 240, after: 120 },
        }));
      } else if (isNumericSection || isShortIsolated) {
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
    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No extractable text found. The PDF may be image-based.' });
    }

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
        align: 'left', valign: 'top', breakLine: true,
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
// v2: column detection via X-position clustering (whitespace-split lines)

router.post('/pdf-to-excel', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });

    const buffer = fs.readFileSync(req.file.path);
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No extractable text found. The PDF may be image-based.' });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ILovePDF';

    const sheet = workbook.addWorksheet('PDF Content');

    // Column detection: split lines by 2+ consecutive spaces to find columns
    const rawLines = text.split('\n').filter(l => l.trim());
    const rows = rawLines.map(line => {
      // Split on 2 or more whitespace chars to separate columns
      const cols = line.split(/\s{2,}/).map(c => c.trim()).filter(c => c.length > 0);
      return cols.length >= 2 ? cols : [line.trim()];
    });

    // Determine max column count
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

    // Set columns with auto-width
    sheet.columns = Array.from({ length: Math.max(1, maxCols) }, (_, i) => ({
      key: `col${i}`,
      width: 25,
    }));

    // Add rows
    rows.forEach((cols, rowIdx) => {
      const rowData = {};
      cols.forEach((val, colIdx) => { rowData[`col${colIdx}`] = val; });
      const rowObj = sheet.addRow(rowData);
      // Bold first row if it looks like a header
      if (rowIdx === 0) rowObj.font = { bold: true };
    });

    // Auto-fit column widths based on content
    sheet.columns.forEach((col, colIdx) => {
      let maxLen = 10;
      rows.forEach(r => {
        if (r[colIdx]) maxLen = Math.max(maxLen, r[colIdx].length + 2);
      });
      col.width = Math.min(50, maxLen);
    });

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
// v2: mammoth.convertToHtml → parse HTML tree → structured PDF with
//     headings, tables, lists, bold/italic — preserving document formatting.

router.post('/word-to-pdf', anyUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a Word document.' });

    const mammoth = require('mammoth');
    const { value: html, messages } = await mammoth.convertToHtml({ path: req.file.path });

    if (!html || !html.trim()) {
      throw new Error('Could not extract content from the Word document.');
    }

    const root = parseHtml(html);
    const pdfDoc = await PDFDocument.create();
    const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontItal = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const margin  = 55;
    const pageW   = 612;
    const pageH   = 792;
    const contentW = pageW - margin * 2;

    let page = pdfDoc.addPage([pageW, pageH]);
    let y = pageH - margin;

    // Colour palette
    const C_BODY    = rgb(0.05, 0.05, 0.05);
    const C_H1      = rgb(0.08, 0.16, 0.42);
    const C_H2      = rgb(0.12, 0.26, 0.55);
    const C_H3      = rgb(0.18, 0.35, 0.60);
    const C_TABLE_H = rgb(0.92, 0.93, 0.97);
    const C_TABLE_B = rgb(0.0,  0.0,  0.0);
    const C_RULE    = rgb(0.75, 0.75, 0.80);

    function newPage() {
      page = pdfDoc.addPage([pageW, pageH]);
      y = pageH - margin;
    }

    function ensureSpace(needed) {
      if (y - needed < margin) newPage();
    }

    // Draw a horizontal rule
    function drawRule(thickness = 0.5, color = C_RULE) {
      ensureSpace(8);
      page.drawLine({
        start: { x: margin, y },
        end:   { x: pageW - margin, y },
        thickness, color,
      });
      y -= 6;
    }

    // Draw wrapped text, return lines used
    function drawWrappedText(text, { font, size, color, indent = 0, lineSpacing = 1.4 }) {
      if (!text.trim()) return;
      const usableW = contentW - indent;
      const lines = [];
      const paragraphs = text.split('\n');
      for (const para of paragraphs) {
        const words = para.split(/\s+/).filter(Boolean);
        let line = '';
        for (const word of words) {
          const test = line ? `${line} ${word}` : word;
          try {
            if (font.widthOfTextAtSize(test, size) > usableW && line) {
              lines.push(line);
              line = word;
            } else {
              line = test;
            }
          } catch { line = test; }
        }
        if (line) lines.push(line);
      }
      const lineH = size * lineSpacing;
      for (const ln of lines) {
        ensureSpace(lineH + 2);
        if (ln.trim()) {
          page.drawText(ln, { x: margin + indent, y, size, font, color });
        }
        y -= lineH;
      }
    }

    // Collect all block-level nodes and render
    const blockNodes = root.childNodes.filter(n => n.nodeType === 1 || n.nodeType === 3);

    function getNodeText(node) {
      if (node.nodeType === 3) return node.rawText || '';
      return node.structuredText || node.text || node.rawText || '';
    }

    function renderNode(node) {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const text = getNodeText(node).replace(/\s+/g, ' ').trim();

      switch (tag) {
        case 'h1':
          ensureSpace(32);
          drawRule(0.8, C_H1);
          drawWrappedText(text, { font: fontBold, size: 17, color: C_H1, lineSpacing: 1.3 });
          y -= 6;
          break;
        case 'h2':
          ensureSpace(26);
          drawWrappedText(text, { font: fontBold, size: 14, color: C_H2, lineSpacing: 1.3 });
          y -= 4;
          break;
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          ensureSpace(22);
          drawWrappedText(text, { font: fontBold, size: 12, color: C_H3, lineSpacing: 1.3 });
          y -= 3;
          break;
        case 'p':
          if (text) {
            ensureSpace(16);
            drawWrappedText(text, { font: fontReg, size: 10.5, color: C_BODY });
            y -= 3;
          } else {
            y -= 8;
          }
          break;
        case 'strong':
        case 'b':
          if (text) drawWrappedText(text, { font: fontBold, size: 10.5, color: C_BODY });
          break;
        case 'em':
        case 'i':
          if (text) drawWrappedText(text, { font: fontItal, size: 10.5, color: C_BODY });
          break;
        case 'ul':
        case 'ol': {
          const items = node.querySelectorAll('li');
          items.forEach((li, idx) => {
            const liText = (li.structuredText || li.text || '').replace(/\s+/g, ' ').trim();
            if (liText) {
              const bullet = tag === 'ol' ? `${idx + 1}.  ` : '\u2022  ';
              ensureSpace(16);
              drawWrappedText(bullet + liText, { font: fontReg, size: 10.5, color: C_BODY, indent: 10 });
            }
          });
          y -= 4;
          break;
        }
        case 'table': {
          const rows = node.querySelectorAll('tr');
          if (!rows.length) break;

          // Determine column count
          const maxCols = rows.reduce((m, r) => Math.max(m, r.querySelectorAll('td,th').length), 0);
          if (!maxCols) break;

          const colW = Math.min(120, Math.floor(contentW / maxCols));
          const rowH = 14;
          const fontSize = 8.5;

          rows.forEach((row, ri) => {
            const cells = row.querySelectorAll('td,th');
            const isHeader = ri === 0 || cells.some(c => c.tagName && c.tagName.toLowerCase() === 'th');

            ensureSpace(rowH + 4);

            // Row background for header
            if (isHeader) {
              page.drawRectangle({
                x: margin, y: y - rowH + 2,
                width: Math.min(maxCols * colW, contentW),
                height: rowH + 2,
                color: C_TABLE_H,
              });
            }

            cells.forEach((cell, ci) => {
              if (ci >= maxCols) return;
              const cText = (cell.structuredText || cell.text || '').replace(/\s+/g, ' ').trim().substring(0, 40);
              const f = isHeader ? fontBold : fontReg;
              if (cText) {
                page.drawText(cText, {
                  x: margin + ci * colW + 3,
                  y: y - rowH + 4,
                  size: fontSize,
                  font: f,
                  color: C_TABLE_B,
                  maxWidth: colW - 6,
                });
              }
            });

            // Row border
            page.drawLine({
              start: { x: margin, y: y - rowH + 2 },
              end:   { x: margin + Math.min(maxCols * colW, contentW), y: y - rowH + 2 },
              thickness: 0.3, color: C_RULE,
            });

            y -= rowH + 2;
          });
          y -= 6;
          break;
        }
        case 'hr':
          drawRule(0.8, C_RULE);
          break;
        case 'br':
          y -= 10;
          break;
        default:
          // Recurse into unknown containers
          node.childNodes.forEach(child => renderNode(child));
      }
    }

    root.childNodes.forEach(child => renderNode(child));

    const outBytes = await pdfDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-word-to-pdf.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── POWERPOINT → PDF ──────────────────────────────────────────────────────

router.post('/powerpoint-to-pdf', anyUpload.single('pdf'), async (req, res) => {
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

    if (!allText.trim()) {
      cleanupFiles(req.file);
      return res.status(400).json({ error: 'No text found in the presentation.' });
    }

    const outBytes = await textToPdf(allText, PDFDocument, StandardFonts, rgb);
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-ppt-to-pdf.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── EXCEL → PDF ───────────────────────────────────────────────────────────
// v2: dynamic column widths with fit-to-page scaling; auto landscape for
//     wide sheets (>6 columns); multi-sheet support.

router.post('/excel-to-pdf', anyUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an Excel file.' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const pdfDoc = await PDFDocument.create();
    const fontReg  = await pdfDoc.embedFont(StandardFonts.Courier);
    const fontBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

    const MARGIN   = 36;
    const ROW_H    = 13;
    const FONT_SZ  = 8;
    const HEADER_SZ = 9;
    const MIN_COL  = 28;
    const MAX_COL  = 160;
    const CHARS_TO_PT = 6.0;  // approx pt per character at Courier 8pt

    workbook.eachSheet(sheet => {
      // ── Pass 1: measure natural column widths from cell content ────────────
      const colMaxChars = {};  // 1-indexed

      sheet.eachRow({ includeEmpty: false }, row => {
        row.eachCell({ includeEmpty: true }, (cell, colIdx) => {
          const val = String(cell.value ?? '').substring(0, 60);
          if (!colMaxChars[colIdx] || val.length > colMaxChars[colIdx]) {
            colMaxChars[colIdx] = val.length;
          }
        });
      });

      const colIndices = Object.keys(colMaxChars).map(Number).sort((a, b) => a - b);
      const numCols    = colIndices.length;
      if (!numCols) return;

      // Natural widths (pt) clamped between MIN_COL and MAX_COL
      const naturalWidths = colIndices.map(ci =>
        Math.max(MIN_COL, Math.min(MAX_COL, colMaxChars[ci] * CHARS_TO_PT + 8))
      );

      // ── Decide orientation ────────────────────────────────────────────────
      // Landscape (792×612) for sheets wider than portrait usable width
      const totalNatural = naturalWidths.reduce((s, w) => s + w, 0);
      const useLandscape = numCols > 6 || totalNatural > (612 - MARGIN * 2);
      const pageW  = useLandscape ? 792 : 612;
      const pageH  = useLandscape ? 612 : 792;
      const usableW = pageW - MARGIN * 2;

      // ── Scale all columns to fit exactly one page width ──────────────────
      const scale = totalNatural > usableW ? usableW / totalNatural : 1.0;
      const colWidths = naturalWidths.map(w => Math.max(20, Math.floor(w * scale)));

      // ── Pass 2: render ───────────────────────────────────────────────────
      let page = pdfDoc.addPage([pageW, pageH]);
      let y    = pageH - MARGIN;

      // Sheet title
      page.drawText(`Sheet: ${sheet.name}`, {
        x: MARGIN, y, size: 11, font: fontBold, color: rgb(0.08, 0.15, 0.50),
      });
      y -= 18;

      // Column header rule
      page.drawLine({
        start: { x: MARGIN, y: y + ROW_H },
        end:   { x: MARGIN + usableW, y: y + ROW_H },
        thickness: 0.4, color: rgb(0.6, 0.6, 0.7),
      });

      let isFirstRow = true;

      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (y < MARGIN + ROW_H + 4) {
          page = pdfDoc.addPage([pageW, pageH]);
          y = pageH - MARGIN;
          isFirstRow = false;
        }

        // Header row background
        if (rowNumber === 1 || isFirstRow) {
          page.drawRectangle({
            x: MARGIN, y: y - ROW_H + 2,
            width: usableW, height: ROW_H + 1,
            color: rgb(0.92, 0.93, 0.97),
          });
        }

        let x = MARGIN;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const ci = colIndices.indexOf(colNumber);
          if (ci === -1) return;
          const cw  = colWidths[ci];
          // Truncate cell value to fit column
          const maxChars = Math.max(3, Math.floor(cw / (CHARS_TO_PT * scale)));
          const val  = String(cell.value ?? '').substring(0, maxChars + 5);
          const font = (rowNumber === 1 || isFirstRow) ? fontBold : fontReg;
          const sz   = (rowNumber === 1 || isFirstRow) ? HEADER_SZ : FONT_SZ;
          if (val.trim()) {
            try {
              page.drawText(val, { x: x + 2, y: y - ROW_H + 3, size: sz, font, color: rgb(0.08, 0.08, 0.08), maxWidth: cw - 4 });
            } catch (_) {}
          }
          x += cw;
        });

        // Row separator line (light)
        page.drawLine({
          start: { x: MARGIN, y: y - ROW_H + 2 },
          end:   { x: MARGIN + usableW, y: y - ROW_H + 2 },
          thickness: 0.2, color: rgb(0.85, 0.85, 0.88),
        });

        y -= ROW_H + 1;
        isFirstRow = false;
      });
    });

    const outBytes = await pdfDoc.save();
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-excel-to-pdf.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

// ── HTML → PDF ─────────────────────────────────────────────────────────────

router.post('/html-to-pdf', anyUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an HTML file.' });

    const html = fs.readFileSync(req.file.path, 'utf-8');
    const root = parseHtml(html);

    root.querySelectorAll('script, style, noscript').forEach(el => el.remove());

    const text = root.structuredText || root.text || root.rawText;
    if (!text.trim()) throw new Error('No readable content found in the HTML file.');

    const outBytes = await textToPdf(text, PDFDocument, StandardFonts, rgb);
    cleanupFiles(req.file);
    sendPdf(res, outBytes, 'ilovepdf-html-to-pdf.pdf');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
});

export default router;
