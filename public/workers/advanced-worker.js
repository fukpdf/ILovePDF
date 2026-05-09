// Advanced Worker v3.3 — persistent off-thread document builder + pixel processor.
// Phase 1: Persistent (handles multiple tasks, no re-spawn).
// Phase 5: CPU pixel processing for remove-bg (WebGPU removed — broken dispatch math).
// v3.2: buildDocx — H1-H4 heading levels, bullet + numbered list support,
//       Calibri default fonts, word/numbering.xml in output ZIP.
// v3.3: buildXlsx — sheet name sanitization (strip / \ ? * [ ] :), numeric type coercion,
//       adaptive column widths (content-length based, 8–60 chars), freeze pane on row 1.
// Operations: build-docx | build-xlsx | build-pptx | remove-bg | chunk-text-score

// ── LAZY LIBRARY LOADING ───────────────────────────────────────────────────────
var _jszip = false, _xlsx = false, _pptx = false;
function ensureJszip() { if (!_jszip) { importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); _jszip = true; } }
function ensureXlsx()  { if (!_xlsx)  { importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); _xlsx = true; } }
function ensurePptx()  { if (!_pptx)  { importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'); _pptx = true; } }

// ── XML ESCAPE ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Strip leading list markers so Word's own numbering renders cleanly.
// isNum=true → strip "1. " / "a. " / "i. " style prefixes
// isNum=false → strip bullet chars like "- ", "• ", "✓ " etc.
function _stripListMarker(text, isNum) {
  if (isNum) {
    return text.replace(/^\s*(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]\s+/, '');
  }
  return text.replace(/^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s*/, '');
}

// ── BUILD DOCX ────────────────────────────────────────────────────────────────
async function buildDocx(pages) {
  ensureJszip();
  var paras = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p = pages[pi];
    var rawText    = (p.text || '').trim();
    var paragraphs = p.paragraphs;

    // Page separator label
    paras.push(
      '<w:p><w:pPr><w:spacing w:before="320" w:after="80"/></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="374151"/></w:rPr>' +
      '<w:t>Page ' + p.pageNum + '</w:t></w:r></w:p>'
    );

    if (paragraphs && paragraphs.length) {
      for (var qi = 0; qi < paragraphs.length; qi++) {
        var para = paragraphs[qi];
        if (!para.text) continue;

        if (para.isHeading) {
          // Map extracted heading levels 1-4 to Word heading styles
          var lvl    = para.level || 1;
          var hStyle, hSz, hColor;
          if      (lvl <= 1) { hStyle = 'Heading1'; hSz = '28'; hColor = '1E3A5F'; }
          else if (lvl === 2) { hStyle = 'Heading2'; hSz = '24'; hColor = '2C4A7A'; }
          else if (lvl === 3) { hStyle = 'Heading3'; hSz = '22'; hColor = '374151'; }
          else                { hStyle = 'Heading4'; hSz = '21'; hColor = '4B5563'; }
          paras.push(
            '<w:p><w:pPr><w:pStyle w:val="' + hStyle + '"/><w:spacing w:before="200" w:after="80"/></w:pPr>' +
            '<w:r><w:rPr><w:b/><w:sz w:val="' + hSz + '"/><w:color w:val="' + hColor + '"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        } else if (para.isNumList) {
          // Numbered list — strip leading "1. " marker; Word adds its own counter
          var numText = _stripListMarker(para.text, true);
          paras.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
            '</w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(numText) + '</w:t></w:r></w:p>'
          );
        } else if (para.isList) {
          // Bullet list — strip leading "• " marker; Word adds its own bullet
          var listText = _stripListMarker(para.text, false);
          paras.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
            '</w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(listText) + '</w:t></w:r></w:p>'
          );
        } else {
          paras.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else if (rawText) {
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

    paras.push('<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>');
  }

  var docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
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
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
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
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '</Relationships>';

  // styles.xml — Normal + H1-H4 + ListParagraph, Calibri as document default font
  var stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml">' +
    '<w:docDefaults>' +
      '<w:rPrDefault><w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
        '<w:sz w:val="22"/><w:lang w:val="en-US"/>' +
      '</w:rPr></w:rPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/>' +
      '<w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
      '<w:name w:val="heading 1"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="80"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1E3A5F"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
      '<w:name w:val="heading 2"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="60"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="2C4A7A"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3">' +
      '<w:name w:val="heading 3"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="60"/></w:pPr>' +
      '<w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="374151"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading4">' +
      '<w:name w:val="heading 4"/>' +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="120" w:after="40"/></w:pPr>' +
      '<w:rPr><w:b/><w:i/><w:sz w:val="21"/><w:color w:val="4B5563"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
      '<w:name w:val="List Paragraph"/>' +
      '<w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:ind w:left="720"/></w:pPr>' +
    '</w:style>' +
    '</w:styles>';

  // numbering.xml — numId=1: bullet list, numId=2: decimal numbered list
  var numberingXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0">' +
      '<w:lvl w:ilvl="0">' +
        '<w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
        '<w:lvlText w:val="\u2022"/>' +
        '<w:lvlJc w:val="left"/>' +
        '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' +
      '</w:lvl>' +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1">' +
      '<w:lvl w:ilvl="0">' +
        '<w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
        '<w:lvlText w:val="%1."/>' +
        '<w:lvlJc w:val="left"/>' +
        '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
      '</w:lvl>' +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';

  var zip = new self.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/numbering.xml', numberingXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  var ab = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return ab;
}

// ── BUILD XLSX ─────────────────────────────────────────────────────────────────
// v3.3 fixes:
//   (1) Sheet name: strip Excel-forbidden chars (/ \ ? * [ ] :) before 31-char cap.
//   (2) Numeric coercion: currency/percent/plain number strings → JS numbers so
//       Excel stores them as numeric cells (sortable, summable, right-aligned).
//   (3) Adaptive column widths: measure max rendered cell length per column
//       (capped 8–60 chars) instead of uniform wch:18.
//   (4) Freeze pane: freeze row 1 so the header stays visible while scrolling.

// Strip characters Excel forbids in sheet names: / \ ? * [ ] :
function _sanitizeSheetName(name) {
  return (name || 'Sheet')
    .replace(/[/\\?*[\]:]/g, '_')  // replace forbidden chars with underscore
    .slice(0, 31)
    .trim() || 'Sheet';
}

// Coerce a cell value: if it looks like a number (including $1,234.56 / 12% / -3.5)
// return a JS number so SheetJS encodes it as a numeric cell type.
function _coerceCell(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return v;
  var s = v.trim();
  if (!s) return s;
  // Strip leading/trailing currency symbols, commas, percent sign
  var cleaned = s.replace(/^[$€£¥\s]+/, '').replace(/[,\s]+/g, '').replace(/%$/, '');
  var n = parseFloat(cleaned);
  if (!isNaN(n) && isFinite(n) && /^-?[\d.,]+%?$/.test(s.replace(/[$€£¥\s,]/g, ''))) {
    // Preserve percent as fraction if original had % suffix
    return s.endsWith('%') ? n / 100 : n;
  }
  return v;
}

function buildXlsx(sheets) {
  ensureXlsx();
  var wb = self.XLSX.utils.book_new();

  for (var i = 0; i < sheets.length; i++) {
    var s    = sheets[i];
    var rows = (s.rows && s.rows.length) ? s.rows : [['(empty)']];

    // (2) Numeric coercion — convert all cells before building the sheet
    var coercedRows = rows.map(function (r) {
      return r.map(function (cell) { return _coerceCell(cell); });
    });

    var ws     = self.XLSX.utils.aoa_to_sheet(coercedRows);
    var maxCol = 0;
    coercedRows.forEach(function (r) { maxCol = Math.max(maxCol, r.length); });

    // (3) Adaptive column widths — measure max rendered cell length per column
    var colWidths = [];
    for (var ci = 0; ci < maxCol; ci++) {
      var maxLen = 8; // minimum width
      for (var ri = 0; ri < coercedRows.length; ri++) {
        var cellVal = coercedRows[ri][ci];
        var cellStr = (cellVal === undefined || cellVal === null) ? '' : String(cellVal);
        if (cellStr.length > maxLen) maxLen = cellStr.length;
      }
      colWidths.push({ wch: Math.min(60, Math.ceil(maxLen * 1.1)) }); // cap at 60, add 10% buffer
    }
    ws['!cols'] = colWidths;

    // (4) Freeze pane on row 1 — keeps header visible during scroll
    if (coercedRows.length > 1) {
      ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
    }

    // (1) Sanitize sheet name — strip Excel-forbidden chars, then cap at 31
    self.XLSX.utils.book_append_sheet(wb, ws, _sanitizeSheetName(s.name));
  }

  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

// ── BUILD PPTX ─────────────────────────────────────────────────────────────────
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

  return await pptx.write({ outputType: 'arraybuffer' });
}

// ── REMOVE BACKGROUND (CPU path, enhanced feathering + multi-pass) ────────────
// Phase 5: threshold-based removal with colour-range sampling, variable feather,
// and a 3×3 neighbourhood smoothing pass.
function removeBg(pixelsBuf, width, height, threshold) {
  var t = Math.max(60, Math.min(255, threshold || 240));
  var d = new Uint8ClampedArray(pixelsBuf);

  // Determine whether the image likely has a light or dark background by
  // sampling 200 evenly-spaced pixels around the image border.
  var borderSum = 0, borderCount = 0;
  var step = Math.max(1, Math.floor((width * 2 + height * 2) / 200));
  for (var bx = 0; bx < width; bx += step) {
    // top row
    var bi0 = bx * 4;
    borderSum += (d[bi0] + d[bi0+1] + d[bi0+2]) / 3; borderCount++;
    // bottom row
    var bi1 = ((height - 1) * width + bx) * 4;
    borderSum += (d[bi1] + d[bi1+1] + d[bi1+2]) / 3; borderCount++;
  }
  for (var by = 0; by < height; by += step) {
    var bi2 = by * width * 4;
    borderSum += (d[bi2] + d[bi2+1] + d[bi2+2]) / 3; borderCount++;
    var bi3 = (by * width + width - 1) * 4;
    borderSum += (d[bi3] + d[bi3+1] + d[bi3+2]) / 3; borderCount++;
  }
  var avgBorder = borderCount > 0 ? borderSum / borderCount : 200;
  var isDark = avgBorder < 80; // dark background detection

  // Feather zone: larger range → softer edges.
  var featherRange = 50;

  // Pass 1: classify pixels and apply feathering.
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (!isDark) {
      // Light background — remove near-white pixels
      if (r >= t && g >= t && b >= t) {
        d[i + 3] = 0;
      } else if (lum >= t - featherRange) {
        var pct   = (lum - (t - featherRange)) / featherRange;
        var alpha = Math.round(255 * (1 - Math.pow(pct, 0.7)));
        alpha = Math.max(0, Math.min(255, alpha));
        if (alpha < d[i + 3]) d[i + 3] = alpha;
      }
    } else {
      // Dark background — remove near-black pixels
      var tDark = 255 - t;
      if (r <= tDark && g <= tDark && b <= tDark) {
        d[i + 3] = 0;
      } else if (lum <= tDark + featherRange) {
        var pct2  = (tDark + featherRange - lum) / featherRange;
        var alpha2 = Math.round(255 * (1 - Math.pow(pct2, 0.7)));
        alpha2 = Math.max(0, Math.min(255, alpha2));
        if (alpha2 < d[i + 3]) d[i + 3] = alpha2;
      }
    }
  }

  // Pass 2: 3×3 neighbourhood alpha smoothing (soften jagged edges).
  var d2 = new Uint8ClampedArray(d);
  for (var py = 1; py < height - 1; py++) {
    for (var px = 1; px < width - 1; px++) {
      var idx = (py * width + px) * 4;
      var a   = d[idx + 3];
      // Only smooth the transition zone (neither fully opaque nor fully transparent)
      if (a > 0 && a < 255) {
        var sum = 0, cnt = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            sum += d[((py + dy) * width + px + dx) * 4 + 3];
            cnt++;
          }
        }
        d2[idx + 3] = Math.round((a * 0.6) + (sum / cnt) * 0.4);
      } else if (a === 255) {
        // Fully opaque pixel on edge: gently inherit from transparent neighbours
        var above = d[((py - 1) * width + px) * 4 + 3];
        var below = d[((py + 1) * width + px) * 4 + 3];
        var left  = d[(py * width + px - 1) * 4 + 3];
        var right = d[(py * width + px + 1) * 4 + 3];
        var minN  = Math.min(above, below, left, right);
        if (minN < 200) d2[idx + 3] = Math.round(a * 0.78 + minN * 0.22);
      }
    }
  }

  return { pixels: d2.buffer, width: width, height: height };
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
    var w = allWords[wi]; freq[w] = (freq[w] || 0) + 1;
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

// ── DISPATCHER (persistent — handles multiple messages) ───────────────────────

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
          { pixels: result.pixels, width: result.width, height: result.height },
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
        throw new Error('Unknown operation: ' + data.op);
    }
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'Processing error' });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error' });
};
