// Advanced Worker v2.1 — off-thread document builder
// Operations: build-docx | build-xlsx | build-pptx | remove-bg | chunk-text-score

// ── LAZY LIBRARY LOADING ──────────────────────────────────────────────────────
var _jszip = false, _xlsx = false, _pptx = false;
function ensureJszip() { if (!_jszip) { importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); _jszip = true; } }
function ensureXlsx()  { if (!_xlsx)  { importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); _xlsx = true; } }
function ensurePptx()  { if (!_pptx)  { importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'); _pptx = true; } }

// ── XML ESCAPE ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,  '&amp;').replace(/</g,  '&lt;').replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── BUILD DOCX ────────────────────────────────────────────────────────────────
// Accepts two formats:
//   v1: pages = [{ pageNum, text }]                          — simple text
//   v2: pages = [{ pageNum, paragraphs: [{text, isHeading}] }] — structured
async function buildDocx(pages) {
  ensureJszip();
  var paras = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p = pages[pi];
    var rawText = (p.text || '').trim();
    var paragraphs = p.paragraphs; // v2 structured format

    // Page divider heading
    paras.push(
      '<w:p><w:pPr><w:spacing w:before="320" w:after="80"/></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="374151"/></w:rPr>' +
      '<w:t>Page ' + p.pageNum + '</w:t></w:r></w:p>'
    );

    if (paragraphs && paragraphs.length) {
      // v2: structured paragraphs with heading detection
      for (var qi = 0; qi < paragraphs.length; qi++) {
        var para = paragraphs[qi];
        if (!para.text) continue;

        if (para.isHeading) {
          // Heading: bold, slightly larger, coloured
          paras.push(
            '<w:p><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>' +
            '<w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1E3A5F"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        } else {
          // Body paragraph: normal weight, good leading
          paras.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else if (rawText) {
      // v1 fallback: split on newlines into separate paragraphs
      var lines = rawText.split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (line) {
          paras.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(line) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else {
      paras.push('<w:p/>');
    }

    // Page separator
    paras.push('<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>');
  }

  var docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras.join('') +
    '<w:sectPr>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml"  ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml"   ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
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
    '<w:name w:val="Normal"/>' +
    '<w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '</w:styles>';

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

// ── BUILD XLSX ────────────────────────────────────────────────────────────────
// sheets: [{ name, rows: Array<Array> }]
function buildXlsx(sheets) {
  ensureXlsx();
  var wb = self.XLSX.utils.book_new();
  for (var i = 0; i < sheets.length; i++) {
    var s  = sheets[i];
    var ws = self.XLSX.utils.aoa_to_sheet(s.rows && s.rows.length ? s.rows : [['(empty)']]);
    // Auto-width hint (cosmetic)
    var maxCol = 0;
    (s.rows || []).forEach(function (r) { maxCol = Math.max(maxCol, r.length); });
    ws['!cols'] = Array.from({ length: maxCol }, function () { return { wch: 18 }; });
    self.XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 31));
  }
  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

// ── BUILD PPTX ────────────────────────────────────────────────────────────────
// slides: [{ pageNum, title, text }], docTitle: String
async function buildPptx(slides, docTitle) {
  ensurePptx();
  var pptx     = new self.PptxGenJS();
  pptx.layout  = 'LAYOUT_16x9';
  pptx.subject = docTitle || 'Converted Presentation';

  for (var i = 0; i < slides.length; i++) {
    var s     = slides[i];
    var slide = pptx.addSlide();

    slide.addText(String(s.title || 'Slide ' + s.pageNum).substring(0, 80), {
      x: 0.4, y: 0.15, w: 9.2, h: 0.65,
      fontSize: 20, bold: true, color: '1E293B', wrap: true,
    });

    var bodyText = (s.text || '').trim();
    if (bodyText) {
      slide.addText(bodyText.substring(0, 1200), {
        x: 0.4, y: 0.9, w: 9.2, h: 4.4,
        fontSize: 11, color: '475569', wrap: true, valign: 'top',
      });
    } else {
      slide.addText('(No text content)', {
        x: 0.4, y: 2.5, w: 9.2, h: 0.5,
        fontSize: 11, color: '94A3B8', italic: true,
      });
    }

    slide.addText(String(s.pageNum), {
      x: 9.2, y: 5.15, w: 0.4, h: 0.25,
      fontSize: 9, color: 'CBD5E1', align: 'right',
    });
  }

  var buf = await pptx.write({ outputType: 'arraybuffer' });
  return buf;
}

// ── REMOVE BACKGROUND ─────────────────────────────────────────────────────────
// pixels: ArrayBuffer (RGBA, row-major). threshold 100–255.
// Feathers edges in the range [threshold-30 … threshold] for smooth output.
function removeBg(pixelsBuf, width, height, threshold) {
  var t = Math.max(100, Math.min(255, threshold || 240));
  var d = new Uint8ClampedArray(pixelsBuf);
  var changed = 0;
  var featherRange = 35; // px brightness range for soft edge

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    var avg = (r + g + b) / 3;

    if (r >= t && g >= t && b >= t) {
      // Hard transparent
      d[i + 3] = 0;
      changed++;
    } else if (avg >= t - featherRange) {
      // Feather zone: smooth alpha gradient so edges are not harsh
      var alpha = Math.round(255 * (1 - (avg - (t - featherRange)) / featherRange));
      alpha = Math.max(0, Math.min(255, alpha));
      if (alpha < d[i + 3]) {
        d[i + 3] = alpha;
        changed++;
      }
    }
  }

  // Second pass: dilate the feather into adjacent opaque pixels for smoother border
  // (lightweight 1-pixel erosion — only processes actual edge pixels)
  var d2 = new Uint8ClampedArray(d); // copy so reads are stable during writes
  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var idx = (y * width + x) * 4;
      var a   = d[idx + 3];
      if (a === 255) {
        // Check if any orthogonal neighbour is semi-transparent (edge pixel)
        var above = d[((y-1)*width + x) * 4 + 3];
        var below = d[((y+1)*width + x) * 4 + 3];
        var left  = d[(y*width + x - 1) * 4 + 3];
        var right = d[(y*width + x + 1) * 4 + 3];
        var minNeighbour = Math.min(above, below, left, right);
        if (minNeighbour < 230) {
          // Soften this pixel slightly so the hard edge blends
          d2[idx + 3] = Math.round(a * 0.85 + minNeighbour * 0.15);
        }
      }
    }
  }

  return { pixels: d2.buffer, width: width, height: height, changed: changed };
}

// ── CHUNK TEXT SCORING (extractive summarisation, TF-IDF) ─────────────────────
function chunkTextScore(text, maxSentences) {
  var max = Math.min(25, Math.max(3, parseInt(maxSentences || 7, 10)));

  var sentences = (text.match(/[^.!?\n]{10,}[.!?]/g) || [])
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length >= 15; });

  if (!sentences.length) {
    sentences = text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  var allWords = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  var freq = {};
  for (var wi = 0; wi < allWords.length; wi++) {
    var w = allWords[wi];
    freq[w] = (freq[w] || 0) + 1;
  }

  var scored = sentences.map(function (s) {
    var sWords = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    var score  = 0;
    for (var si = 0; si < sWords.length; si++) score += (freq[sWords[si]] || 0);
    return { s: s, score: sWords.length ? score / sWords.length : 0 };
  });

  var top = scored.slice()
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

// ── DISPATCHER ────────────────────────────────────────────────────────────────
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
        if (!(data.pixels instanceof ArrayBuffer)) throw new Error('pixels must be ArrayBuffer');
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
        throw new Error('Unknown operation');
    }
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'Processing error' });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message error' });
};
