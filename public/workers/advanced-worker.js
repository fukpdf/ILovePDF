// Advanced Worker — disposable worker for CPU-heavy document building tasks.
// Loaded by advanced-engine.js; communicates via postMessage.
// Receives: { op, ...payload }
// Responds: { buffer } | { buffers: [...] } | { text } | { __error }
//
// Operations:
//   build-docx   — build DOCX from extracted text pages
//   build-xlsx   — build XLSX from extracted row data
//   build-pptx   — build PPTX from extracted slide data
//   remove-bg    — remove near-white background from ImageData pixels
//   chunk-text   — split+score text for extractive summarization

importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');

// XLSX and PptxGenJS loaded lazily inside their ops to avoid always loading all libs
let _xlsxLoaded = false;
let _pptxLoaded = false;

function ensureXlsx() {
  if (_xlsxLoaded || typeof self.XLSX !== 'undefined') { _xlsxLoaded = true; return; }
  importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  _xlsxLoaded = true;
}

function ensurePptx() {
  if (_pptxLoaded || typeof self.PptxGenJS !== 'undefined') { _pptxLoaded = true; return; }
  importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
  _pptxLoaded = true;
}

// ── BUILD DOCX ──────────────────────────────────────────────────────────────
// Input: { pages: [{pageNum, text, items?}], filename }
// Returns: { buffer: ArrayBuffer }
async function buildDocx({ pages, filename }) {
  const zip = new self.JSZip();

  // Escape XML special chars
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Build Word paragraphs from pages
  const paras = [];

  for (const p of pages) {
    // Page heading
    paras.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>` +
      `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Page ${p.pageNum}</w:t></w:r></w:p>`
    );

    const rawText = (p.text || '').trim();
    if (!rawText) {
      paras.push('<w:p><w:r><w:t></w:t></w:r></w:p>');
      continue;
    }

    // Split by newlines and wrap each line in a paragraph
    const lines = rawText.split(/\n+/).filter(Boolean);
    for (const line of lines) {
      const words = line.split(/\s+/).filter(Boolean);
      // Group into sentences for better formatting
      let cur = '';
      for (const word of words) {
        cur = cur ? cur + ' ' + word : word;
      }
      if (cur) {
        paras.push(
          `<w:p><w:r><w:t xml:space="preserve">${esc(cur)}</w:t></w:r></w:p>`
        );
      }
    }
    // Spacing paragraph between pages
    paras.push('<w:p/>');
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>${paras.join('')}<w:sectPr>
    <w:pgSz w:w="12240" w:h="15840"/>
    <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
  </w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="2E3338"/></w:rPr>
  </w:style>
</w:styles>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  const ab = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer: ab };
}

// ── BUILD XLSX ──────────────────────────────────────────────────────────────
// Input: { sheets: [{name, rows: [[cell, cell, ...], ...]}] }
// Returns: { buffer: ArrayBuffer }
function buildXlsx({ sheets }) {
  ensureXlsx();
  const XLSX = self.XLSX;
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows || []);
    const safeName = (sheet.name || 'Sheet').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  const arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  // arr is already a regular Array of numbers, convert to ArrayBuffer
  const ab = new Uint8Array(arr).buffer;
  return { buffer: ab };
}

// ── BUILD PPTX ──────────────────────────────────────────────────────────────
// Input: { slides: [{title, text, pageNum}], docTitle }
// Returns: { buffer: ArrayBuffer }
async function buildPptx({ slides, docTitle }) {
  ensurePptx();
  const PptxGenJS = self.PptxGenJS;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = docTitle || 'Converted Presentation';

  for (const s of slides) {
    const slide = pptx.addSlide();
    // Title
    slide.addText(s.title || `Page ${s.pageNum}`, {
      x: 0.4, y: 0.15, w: '90%', h: 0.5,
      fontSize: 22, bold: true, color: '1E293B',
    });
    // Body text
    if (s.text && s.text.trim()) {
      slide.addText(s.text.substring(0, 1000), {
        x: 0.4, y: 0.85, w: '90%', h: 4.0,
        fontSize: 12, color: '475569', wrap: true,
        valign: 'top',
      });
    } else {
      slide.addText('(No text content on this page)', {
        x: 0.4, y: 2.5, w: '90%', h: 0.5,
        fontSize: 12, color: '94A3B8', italic: true,
      });
    }
    // Page number chip
    slide.addText(`${s.pageNum}`, {
      x: 9.1, y: 5.15, w: 0.5, h: 0.3,
      fontSize: 9, color: 'CBD5E1',
    });
  }

  const blob = await pptx.write({ outputType: 'arraybuffer' });
  return { buffer: blob };
}

// ── REMOVE BACKGROUND (pixel manipulation) ──────────────────────────────────
// Input: { imageData: { data: Uint8ClampedArray, width, height }, threshold }
// Works without OffscreenCanvas — operates directly on pixel data
// Returns: { data: Uint8ClampedArray (modified in place), width, height }
function removeBg({ pixels, width, height, threshold }) {
  const t = Math.max(100, Math.min(255, threshold || 240));
  const d = pixels; // Uint8ClampedArray
  let changed = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Near-white check
    if (r >= t && g >= t && b >= t) {
      d[i + 3] = 0; // transparent
      changed++;
    }
    // Near-white with slight colour tint (tolerate ±30 on each channel if overall bright)
    else if (r > 180 && g > 180 && b > 180) {
      const avg = (r + g + b) / 3;
      if (avg >= t - 20) {
        d[i + 3] = Math.round(255 * ((avg - (t - 20)) / 20));
        changed++;
      }
    }
  }

  return { pixels, width, height, changed };
}

// ── CHUNK TEXT SCORING (extractive summarization) ────────────────────────────
// Input: { text, maxSentences }
// Returns: { summary, stats }
function chunkTextScore({ text, maxSentences }) {
  const max = Math.min(20, Math.max(3, parseInt(maxSentences || 7, 10)));
  const sentences = (text.match(/[^.!?]{15,}[.!?]+/g) || [text])
    .map(s => s.trim()).filter(Boolean);
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  const scored = sentences.map(s => ({
    s,
    score: (s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [])
      .reduce((sum, w) => sum + (freq[w] || 0), 0),
  }));

  const top = scored
    .slice().sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.s);

  return {
    summary: top.join(' '),
    wordCount: words.length,
    sentenceCount: sentences.length,
  };
}

// ── DISPATCHER ──────────────────────────────────────────────────────────────

self.onmessage = async function (e) {
  const data = e.data || {};
  try {
    switch (data.op) {
      case 'build-docx': {
        const result = await buildDocx(data);
        self.postMessage({ buffer: result.buffer }, [result.buffer]);
        break;
      }
      case 'build-xlsx': {
        const result = buildXlsx(data);
        self.postMessage({ buffer: result.buffer }, [result.buffer]);
        break;
      }
      case 'build-pptx': {
        const result = await buildPptx(data);
        self.postMessage({ buffer: result.buffer }, [result.buffer]);
        break;
      }
      case 'remove-bg': {
        const result = removeBg(data);
        // Transfer the pixel buffer back
        self.postMessage({ pixels: result.pixels, width: result.width, height: result.height, changed: result.changed },
          [result.pixels.buffer]);
        break;
      }
      case 'chunk-text-score': {
        const result = chunkTextScore(data);
        self.postMessage(result);
        break;
      }
      default:
        throw new Error('Unknown op: ' + data.op);
    }
  } catch (err) {
    self.postMessage({ __error: err.message || String(err) });
  }
};
