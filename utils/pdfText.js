import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export async function extractPdfText(buffer) {
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch {
    return '';
  }
}

export function wrapText(text, font, size, maxWidth) {
  const result = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      try {
        const w = font.widthOfTextAtSize(testLine, size);
        if (w > maxWidth && line) { result.push(line); line = word; }
        else { line = testLine; }
      } catch { line = testLine; }
    }
    if (line) result.push(line);
  }
  return result;
}

export async function textToPdf(text, PDFDocument, StandardFonts, rgb) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 10.5;
  const lineH = fontSize * 1.45;
  const margin = 55;
  const pageW = 612;
  const pageH = 792;
  const contentW = pageW - margin * 2;

  const lines = wrapText(text, font, fontSize, contentW);

  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;

  for (const line of lines) {
    if (y < margin + lineH) {
      page = pdfDoc.addPage([pageW, pageH]);
      y = pageH - margin;
    }
    if (line.trim()) {
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.05, 0.05, 0.05) });
    }
    y -= lineH;
  }

  return await pdfDoc.save();
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extractiveSummarize(text, maxSentences = 5) {
  const sentences = text.match(/[^.!?\n]+[.!?]+/g) || [];
  if (sentences.length <= maxSentences) return text.trim();

  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  const scored = sentences.map((s, i) => {
    const score = (s.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
      .reduce((sum, w) => sum + (freq[w] || 0), 0);
    return { s: s.trim(), score, i };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map(t => t.s)
    .join(' ');
}
function toggleSidebar(){document.querySelector(".sidebar").classList.toggle("active")}
