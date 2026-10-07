import { PDFParse } from 'pdf-parse';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function extractPdfText(buffer) {
  try {
    const parser = new PDFParse(buffer);
    await parser.load();
    const res = await parser.getText();
    return res?.text || (typeof res === 'string' ? res : '');
  } catch (e) {
    return '';
  }
}

export function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.slice(0, 5).toString('ascii') === '%PDF-';
}

export function wrapText(text, maxChars = 80) {
  if (!text) return [];
  const lines = [];
  const rawLines = text.split('\n');
  for (const raw of rawLines) {
    if (raw.length <= maxChars) {
      lines.push(raw);
    } else {
      let cur = '';
      for (const word of raw.split(' ')) {
        if ((cur + ' ' + word).trim().length > maxChars) {
          lines.push(cur);
          cur = word;
        } else {
          cur = cur ? cur + ' ' + word : word;
        }
      }
      if (cur) lines.push(cur);
    }
  }
  return lines;
}

export async function textToPdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapText(text || '', 85);
  let page = doc.addPage([595.28, 841.89]);
  let y = 800;

  for (const line of lines) {
    if (y < 50) {
      page = doc.addPage([595.28, 841.89]);
      y = 800;
    }
    page.drawText(line, { x: 50, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;
  }
  return await doc.save();
}

export function extractiveSummarize(text, maxSentences = 5) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, maxSentences).map(s => s.trim()).join(' ');
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
