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

// ── EXTRACTIVE SUMMARIZE v2 ────────────────────────────────────────────────
// Improvements over v1:
//  • Heading-line detection → 2× score boost for heading sentences
//  • Near-duplicate removal via Jaccard similarity (threshold 0.60)
//  • Sentence ordering preserved in final output (position-stable)
//  • Minimum sentence length filter (≥15 chars) removes noise fragments
//  • Fallback to paragraph-split when sentence count is very low

export function extractiveSummarize(text, maxSentences = 7) {
  // ── 1. Extract sentences ─────────────────────────────────────────────────
  let sentences = (text.match(/[^.!?\n]{10,}[.!?]+["'\u2019]?/g) || [])
    .map(s => s.trim())
    .filter(s => s.length >= 15);

  // Fallback: paragraph-split when almost no sentences detected
  if (sentences.length < 3) {
    sentences = text
      .split(/\n{2,}/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 15);
  }

  if (!sentences.length) return text.trim().substring(0, 500);
  if (sentences.length <= maxSentences) return sentences.join(' ');

  // ── 2. Build word frequency table (TF) ───────────────────────────────────
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const freq  = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  // ── 3. Detect heading lines for score boost ───────────────────────────────
  const headingSet = new Set(
    text.split('\n')
      .map(l => l.trim())
      .filter(l => {
        if (!l || l.length < 3 || l.length > 80) return false;
        return (
          (l === l.toUpperCase() && /[A-Z]/.test(l)) ||         // ALL-CAPS
          /^(\d+\.)+\s+\S/.test(l) ||                           // 1.2. Section
          /^[A-Z][^.!?]{3,60}$/.test(l)                         // Title-case short line
        );
      })
      .map(l => l.toLowerCase())
  );

  // ── 4. Score each sentence ────────────────────────────────────────────────
  const scored = sentences.map((s, i) => {
    const sw    = s.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const base  = sw.reduce((n, w) => n + (freq[w] || 0), 0) / (sw.length || 1);
    const boost = headingSet.has(s.trim().toLowerCase()) ? 2.0 : 1.0;
    return { s, score: base * boost, i };
  });

  // ── 5. Sort by score, remove near-duplicates (Jaccard > 0.60) ────────────
  const sorted  = scored.slice().sort((a, b) => b.score - a.score);
  const seen    = [];
  const deduped = [];

  for (const candidate of sorted) {
    if (deduped.length >= maxSentences) break;
    const cWords = new Set(candidate.s.toLowerCase().split(/\s+/));
    const isDup  = seen.some(prev => {
      const pWords = new Set(prev.toLowerCase().split(/\s+/));
      let inter = 0;
      cWords.forEach(w => { if (pWords.has(w)) inter++; });
      const union = cWords.size + pWords.size - inter;
      return union > 0 && inter / union > 0.60;
    });
    if (!isDup) {
      deduped.push(candidate);
      seen.push(candidate.s.toLowerCase());
    }
  }

  // ── 6. Restore original order for readability ────────────────────────────
  deduped.sort((a, b) => a.i - b.i);
  return deduped.map(d => d.s).join(' ');
}
