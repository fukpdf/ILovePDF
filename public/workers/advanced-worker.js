// Advanced Worker — disposable off-thread processor for document building.
// Receives: { op, ...payload }  Responds: { buffer } | { text } | { __error }
//
// Operations:
//   build-docx        – build DOCX from extracted text pages (JSZip)
//   build-xlsx        – build XLSX from table row data (xlsx.js)
//   build-pptx        – build PPTX from slide data (PptxGenJS)
//   remove-bg         – remove near-white pixels from RGBA ArrayBuffer
//   chunk-text-score  – TF-IDF extractive summarisation
//
// TRANSFER PROTOCOL for remove-bg:
//   Send:    { op:'remove-bg', pixels: ArrayBuffer, width, height, threshold }
//            transferables: [pixels]
//   Receive: { pixels: ArrayBuffer, width, height, changed }
//            transferables: [pixels]
//   (Worker wraps ArrayBuffer with Uint8ClampedArray internally — never
//    construct a typed-array view on the sender side before transfer.)

// ── LAZY LIBRARY LOADING ─────────────────────────────────────────────────────
var _jszip  = false;
var _xlsx   = false;
var _pptx   = false;

function ensureJszip() {
  if (_jszip) return;
  importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  _jszip = true;
}

function ensureXlsx() {
  if (_xlsx) return;
  importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  _xlsx = true;
}

function ensurePptx() {
  if (_pptx) return;
  importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
  _pptx = true;
}

// ── XML ESCAPE ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;')
    // Strip control characters that make Word reject the file
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── BUILD DOCX ───────────────────────────────────────────────────────────────
// pages: [{ pageNum: Number, text: String }]
async function buildDocx(pages) {
  ensureJszip();

  var paras = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p = pages[pi];
    // Page heading paragraph
    paras.push(
      '<w:p><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="2D3748"/></w:rPr>' +
      '<w:t>Page ' + p.pageNum + '</w:t></w:r></w:p>'
    );

    var rawText = (p.text || '').trim();
    if (!rawText) {
      paras.push('<w:p/>');
      continue;
    }

    // Split on newlines; each line becomes a paragraph
    var lines = rawText.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (line) {
        paras.push('<w:p><w:r><w:t xml:space="preserve">' + esc(line) + '</w:t></w:r></w:p>');
      }
    }
    // Blank separator
    paras.push('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>');
  }

  var docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras.join('') +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  var rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  var wordRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  var stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style></w:styles>';

  var zip = new self.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  var ab = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 5 },
  });
  return ab;
}

// ── BUILD XLSX ───────────────────────────────────────────────────────────────
// sheets: [{ name: String, rows: Array<Array> }]
function buildXlsx(sheets) {
  ensureXlsx();
  var wb = self.XLSX.utils.book_new();
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    var ws = self.XLSX.utils.aoa_to_sheet(s.rows || [['(empty)']]);
    self.XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 31));
  }
  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

// ── BUILD PPTX ───────────────────────────────────────────────────────────────
// slides: [{ pageNum, title, text }], docTitle: String
async function buildPptx(slides, docTitle) {
  ensurePptx();
  var pptx = new self.PptxGenJS();
  pptx.layout  = 'LAYOUT_16x9';
  pptx.subject = docTitle || 'Converted Presentation';

  for (var i = 0; i < slides.length; i++) {
    var s     = slides[i];
    var slide = pptx.addSlide();

    // Title bar
    slide.addText(String(s.title || 'Page ' + s.pageNum).substring(0, 80), {
      x: 0.4, y: 0.15, w: 9.2, h: 0.6,
      fontSize: 20, bold: true, color: '1E293B',
      wrap: true,
    });

    // Body
    var bodyText = (s.text || '').trim();
    if (bodyText) {
      slide.addText(bodyText.substring(0, 1200), {
        x: 0.4, y: 0.9, w: 9.2, h: 4.4,
        fontSize: 11, color: '475569',
        wrap: true, valign: 'top',
      });
    } else {
      slide.addText('(No text content)', {
        x: 0.4, y: 2.5, w: 9.2, h: 0.5,
        fontSize: 11, color: '94A3B8', italic: true,
      });
    }

    // Page-number chip (bottom-right)
    slide.addText(String(s.pageNum), {
      x: 9.2, y: 5.15, w: 0.4, h: 0.25,
      fontSize: 9, color: 'CBD5E1', align: 'right',
    });
  }

  var buf = await pptx.write({ outputType: 'arraybuffer' });
  return buf;
}

// ── REMOVE BACKGROUND ────────────────────────────────────────────────────────
// pixels: ArrayBuffer (RGBA, row-major)
// threshold: 0-255 (pixels brighter than this on all channels → transparent)
function removeBg(pixelsBuf, width, height, threshold) {
  var t = Math.max(100, Math.min(255, threshold || 240));
  var d = new Uint8ClampedArray(pixelsBuf); // view over transferred buffer
  var changed = 0;

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];

    if (r >= t && g >= t && b >= t) {
      // Fully transparent
      d[i + 3] = 0;
      changed++;
    } else if (r > 180 && g > 180 && b > 180) {
      // Soft-edge semi-transparent feather zone (t-30 … t range)
      var avg = (r + g + b) / 3;
      var featherStart = t - 30;
      if (avg >= featherStart) {
        var alpha = Math.round(255 * (1 - (avg - featherStart) / 30));
        d[i + 3] = Math.min(d[i + 3], alpha);
        changed++;
      }
    }
  }

  // Return the same underlying ArrayBuffer (already modified via the view)
  return { pixels: pixelsBuf, width: width, height: height, changed: changed };
}

// ── CHUNK TEXT SCORING (extractive summarisation) ────────────────────────────
function chunkTextScore(text, maxSentences) {
  var max = Math.min(25, Math.max(3, parseInt(maxSentences || 7, 10)));

  // Split into sentences (≥15 chars, end with .?!)
  var sentences = (text.match(/[^.!?\n]{10,}[.!?]/g) || [])
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length >= 15; });

  if (!sentences.length) {
    // Fallback: split on double-newline
    sentences = text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // Term frequency over whole document
  var allWords = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  var freq = {};
  for (var wi = 0; wi < allWords.length; wi++) {
    var w = allWords[wi];
    freq[w] = (freq[w] || 0) + 1;
  }

  // Score each sentence
  var scored = sentences.map(function (s) {
    var sWords = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    var score  = 0;
    for (var si = 0; si < sWords.length; si++) score += (freq[sWords[si]] || 0);
    // Normalize by sentence word count to avoid long-sentence bias
    return { s: s, score: sWords.length ? score / sWords.length : 0 };
  });

  var top = scored
    .slice()
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, max)
    .map(function (x) { return x.s; });

  return {
    summary:       top.join(' '),
    wordCount:     allWords.length,
    sentenceCount: sentences.length,
    topCount:      top.length,
  };
}

// ── DISPATCHER ───────────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  var data = e.data || {};
  try {
    switch (data.op) {

      case 'build-docx': {
        if (!data.pages || !data.pages.length) throw new Error('No pages provided');
        var buf = await buildDocx(data.pages);
        self.postMessage({ buffer: buf }, [buf]);
        break;
      }

      case 'build-xlsx': {
        if (!data.sheets || !data.sheets.length) throw new Error('No sheets provided');
        var buf2 = buildXlsx(data.sheets);
        self.postMessage({ buffer: buf2 }, [buf2]);
        break;
      }

      case 'build-pptx': {
        if (!data.slides || !data.slides.length) throw new Error('No slides provided');
        var buf3 = await buildPptx(data.slides, data.docTitle);
        self.postMessage({ buffer: buf3 }, [buf3]);
        break;
      }

      case 'remove-bg': {
        // data.pixels is an ArrayBuffer (transferred from main thread)
        if (!(data.pixels instanceof ArrayBuffer)) {
          throw new Error('pixels must be an ArrayBuffer');
        }
        var result = removeBg(data.pixels, data.width, data.height, data.threshold);
        self.postMessage(
          { pixels: result.pixels, width: result.width, height: result.height, changed: result.changed },
          [result.pixels]
        );
        break;
      }

      case 'chunk-text-score': {
        if (!data.text) throw new Error('No text provided');
        var scored = chunkTextScore(data.text, data.maxSentences);
        self.postMessage(scored);
        break;
      }

      default:
        throw new Error('Unknown op: ' + String(data.op));
    }
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || String(err) });
  }
};

// Handle deserialization failures
self.onmessageerror = function (e) {
  self.postMessage({ __error: 'Message deserialization failed: ' + String(e) });
};
