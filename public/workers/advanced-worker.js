// Advanced Worker v5.0 — ENTERPRISE FORENSIC STABILIZATION (pdf-to-word)
// Phase 1: Persistent (handles multiple tasks, no re-spawn).
// Phase 5: CPU pixel processing for remove-bg.
// v5.0: RTL/multilingual support, inline run-level typography, checkbox normalization,
//       signature line detection, font size preservation, tab stops, form layout,
//       RTL table support, underline/strikethrough, per-run bold/italic/size,
//       improved OOXML compatibility for Word/LibreOffice/Google Docs/WPS.
// Operations: build-docx | build-xlsx | build-pptx | remove-bg | chunk-text-score

// ── LAZY LIBRARY LOADING ───────────────────────────────────────────────────────
var _jszip = false, _xlsx = false, _pptx = false;
function ensureJszip() { if (!_jszip) { importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); _jszip = true; } }
function ensureXlsx()  { if (!_xlsx)  { importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); _xlsx = true; } }
function ensurePptx()  { if (!_pptx)  { importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'); _pptx = true; } }

// ── XML ESCAPE ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── RTL DETECTION (Arabic, Hebrew, Syriac, Thaana, NKo, Samaritan, …) ──────────
// Returns true if text contains significant RTL script content.
function isRtl(s) {
  if (!s) return false;
  var rtlChars = (s.match(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0800-\u083F\u0840-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  return rtlChars > 0 && rtlChars / s.replace(/\s/g, '').length > 0.15;
}

// ── SYMBOL / CHECKBOX NORMALIZATION ───────────────────────────────────────────
function _normalizeSymbols(text) {
  return (text || '')
    .replace(/[☑✓✔☒✗✘]/g, '[x]')
    .replace(/[☐□]/g, '[ ]')
    .replace(/[\u2610]/g, '[ ]')
    .replace(/[\u2611\u2612]/g, '[x]');
}

// ── SIGNATURE LINE DETECTION ──────────────────────────────────────────────────
function _isSignatureLine(text) {
  var t = (text || '').trim();
  return /^[_]{6,}$/.test(t) ||
         /^[-]{8,}$/.test(t) ||
         /^[=]{8,}$/.test(t) ||
         /^\.{8,}$/.test(t)  ||
         /^_{3,}\s*(Date|Sign|Name|Title|Signature|Witness|Authorized|Representative)[:\s]*_{0,}$/i.test(t);
}

// ── FORM LABEL-VALUE DETECTION ────────────────────────────────────────────────
// Returns true for lines that look like "Label: Value" or "Label ........... Value"
function _isFormLine(text) {
  return /^[A-Za-z\u0600-\u06FF\s]{2,40}:\s*\S/.test(text) ||
         /^[A-Za-z\u0600-\u06FF\s]{2,40}[.]{5,}\s*\S/.test(text);
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

// Detect list indent level from leading whitespace / prefix
function _listLevel(text) {
  var match = text.match(/^(\s+)/);
  var spaces = match ? match[1].length : 0;
  var level  = Math.min(8, Math.floor(spaces / 2)); // cap at 8 (Word max)
  return level;
}

// ── BUILD INLINE RUNS XML ─────────────────────────────────────────────────────
// Generates per-run <w:r> elements preserving bold/italic/underline/size/RTL/mono.
// If runs data is unavailable falls back to single-run from para text.
// para: { text, runs[], bold, italic, fontSize, isRtl }
// baseSz: half-point font size (e.g. 22 = 11pt)
function _buildRunsXml(para, baseSz) {
  var sz = baseSz || 22;
  // If per-run data available, emit one <w:r> per run
  if (para.runs && para.runs.length > 0) {
    var parts = [];
    for (var ri = 0; ri < para.runs.length; ri++) {
      var run = para.runs[ri];
      if (!run || (!run.text && run.text !== '0')) continue;
      var runText = _normalizeSymbols(String(run.text));
      if (!runText) continue;
      var runSz = run.fontSize > 0 ? Math.max(16, Math.min(144, Math.round(run.fontSize * 2))) : sz;
      var rPr = '';
      if (run.bold   || para.bold)   rPr += '<w:b/><w:bCs/>';
      if (run.italic || para.italic) rPr += '<w:i/><w:iCs/>';
      if (run.underline)             rPr += '<w:u w:val="single"/>';
      if (run.strikethrough)         rPr += '<w:strike/>';
      if (run.mono)                  rPr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
      if (isRtl(runText))            rPr += '<w:rtl/>';
      rPr += '<w:sz w:val="' + runSz + '"/><w:szCs w:val="' + runSz + '"/>';
      rPr += '<w:color w:val="374151"/>';
      parts.push('<w:r><w:rPr>' + rPr + '</w:rPr><w:t xml:space="preserve">' + esc(runText) + '</w:t></w:r>');
    }
    if (parts.length) return parts.join('');
  }
  // Fallback: single run from para.text
  var txt  = _normalizeSymbols(para.text || '');
  var rPr2 = '';
  if (para.bold)   rPr2 += '<w:b/><w:bCs/>';
  if (para.italic) rPr2 += '<w:i/><w:iCs/>';
  if (isRtl(txt))  rPr2 += '<w:rtl/>';
  rPr2 += '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:color w:val="374151"/>';
  return '<w:r><w:rPr>' + rPr2 + '</w:rPr><w:t xml:space="preserve">' + esc(txt) + '</w:t></w:r>';
}

// ── BUILD TAB STOPS XML ───────────────────────────────────────────────────────
// Generates <w:tabs> from x-position array for tab-aligned content (forms, schedules).
function _buildTabStopsXml(xPositions, pageWidth) {
  if (!xPositions || xPositions.length < 2) return '';
  var gap  = (pageWidth || 612) * 0.04;
  var tabs = [];
  for (var k = 1; k < xPositions.length; k++) {
    if (xPositions[k] - xPositions[k - 1] >= gap) {
      var pos = Math.round(xPositions[k] * 20);
      if (pos > 0 && pos < 120000) {
        tabs.push('<w:tab w:val="left" w:pos="' + pos + '"/>');
      }
    }
  }
  return tabs.length ? '<w:tabs>' + tabs.join('') + '</w:tabs>' : '';
}

// ── BUILD TABLE XML ────────────────────────────────────────────────────────────
// v5.0: RTL table support, form-table detection, per-cell RTL bidi, improved borders.
// rows       — string[][] (each row is an array of cell strings)
// numCols    — (optional) override column count; auto-detected from rows if absent
// isOcrTable — true when rows came from OCR (lighter borders, no header bold)
// colWidths  — (optional) number[] of proportional x-spans from clusterCellsByXandY
// isForm     — true when table represents a label/value form layout
function buildTableXml(rows, numCols, isOcrTable, colWidths, isForm) {
  if (!rows || !rows.length) return '';

  // Normalise col count
  var nc = numCols || rows.reduce(function(m, r) { return Math.max(m, r ? r.length : 0); }, 1);
  if (nc < 1) nc = 1;

  // Usable page width: A4-like (12240 twips) minus 1080+1080 margins = 10080 twips
  var USABLE = 10080;

  // Compute per-column widths (twips): proportional from x-spans or equal
  var colW_arr;
  if (colWidths && colWidths.length === nc) {
    var spanTotal = colWidths.reduce(function(s, v) { return s + (v || 30); }, 0) || 1;
    colW_arr = colWidths.map(function(span) {
      return Math.max(600, Math.round(USABLE * (span || 30) / spanTotal));
    });
    var assigned = colW_arr.reduce(function(s, v) { return s + v; }, 0);
    if (assigned !== USABLE) colW_arr[colW_arr.length - 1] += (USABLE - assigned);
  } else {
    // Form tables: give label col 35%, value col 65% (better for label:value forms)
    if (isForm && nc === 2) {
      colW_arr = [Math.round(USABLE * 0.35), Math.round(USABLE * 0.65)];
    } else {
      var eqW = Math.max(600, Math.floor(USABLE / nc));
      colW_arr = [];
      for (var ei = 0; ei < nc; ei++) colW_arr.push(eqW);
    }
  }
  var totalW = colW_arr.reduce(function(s, v) { return s + v; }, 0);

  // Detect if table content is predominantly RTL
  var allCellText = rows.map(function(r) { return (r || []).join(' '); }).join(' ');
  var tableIsRtl  = isRtl(allCellText);

  // ── Table properties ──────────────────────────────────────────────────────
  var xml = '<w:tbl>';
  xml += '<w:tblPr>' +
    '<w:tblStyle w:val="TableGrid"/>' +
    '<w:tblW w:w="' + totalW + '" w:type="dxa"/>' +
    '<w:tblLayout w:type="fixed"/>' +
    (tableIsRtl ? '<w:bidiVisual/>' : '') +
    '<w:tblCellMar>' +
      '<w:top w:w="80" w:type="dxa"/>' +
      '<w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="80" w:type="dxa"/>' +
      '<w:right w:w="108" w:type="dxa"/>' +
    '</w:tblCellMar>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
  '</w:tblPr>';

  // ── Grid columns (proportional widths) ────────────────────────────────────
  xml += '<w:tblGrid>';
  for (var gi = 0; gi < nc; gi++) {
    xml += '<w:gridCol w:w="' + colW_arr[gi] + '"/>';
  }
  xml += '</w:tblGrid>';

  // ── Rows ──────────────────────────────────────────────────────────────────
  for (var ri = 0; ri < rows.length; ri++) {
    var row      = rows[ri] || [];
    var isHeader = (ri === 0 && !isOcrTable && !isForm);
    var rowFill  = isHeader ? 'EFF6FF' : (isForm ? 'FFFFFF' : (ri % 2 === 0 ? 'FFFFFF' : 'F9FAFB'));

    xml += '<w:tr>';

    var trPr = '<w:trPr>';
    if (isHeader) trPr += '<w:tblHeader/>';
    trPr += '<w:trHeight w:val="340" w:hRule="atLeast"/>';
    trPr += '</w:trPr>';
    xml  += trPr;

    // Cells — each with its own proportional width
    for (var ci = 0; ci < nc; ci++) {
      var cellVal    = (row[ci] !== undefined && row[ci] !== null) ? String(row[ci]) : '';
      var cellNorm   = _normalizeSymbols(cellVal);
      var cellIsRtl  = isRtl(cellNorm);
      var cellSz     = '20';
      var cellClr    = isHeader ? '1E3A5F' : (isForm && ci === 0 ? '1E3A5F' : '374151');
      var bold       = (isHeader || (isForm && ci === 0)) ? '<w:b/>' : '';
      var cw         = colW_arr[ci] || Math.max(600, Math.floor(USABLE / nc));
      var cellJc     = cellIsRtl ? '<w:jc w:val="right"/>' : '';
      var cellBidi   = cellIsRtl ? '<w:bidi/>' : '';
      var runRtl     = cellIsRtl ? '<w:rtl/>' : '';

      xml += '<w:tc>' +
        '<w:tcPr>' +
          '<w:tcW w:w="' + cw + '" w:type="dxa"/>' +
          '<w:shd w:val="clear" w:color="auto" w:fill="' + rowFill + '"/>' +
          '<w:tcBorders>' +
            '<w:top w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:left w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:right w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '</w:tcBorders>' +
        '</w:tcPr>' +
        '<w:p>' +
          '<w:pPr><w:spacing w:before="40" w:after="40"/>' + cellBidi + cellJc + '</w:pPr>' +
          (cellNorm
            ? '<w:r><w:rPr>' + bold + runRtl + '<w:sz w:val="' + cellSz + '"/><w:szCs w:val="' + cellSz + '"/><w:color w:val="' + cellClr + '"/></w:rPr>' +
              '<w:t xml:space="preserve">' + esc(cellNorm) + '</w:t></w:r>'
            : '') +
        '</w:p>' +
      '</w:tc>';
    }

    xml += '</w:tr>';
  }

  xml += '</w:tbl>';
  // Separator paragraph after table (required for Word compatibility)
  xml += '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>';
  return xml;
}

// ── BUILD DOCX ────────────────────────────────────────────────────────────────
// v5.0 ENTERPRISE FORENSIC STABILIZATION:
//   - Full RTL support: <w:bidi/> on all paragraph types, headings, lists, tables
//   - Per-run inline typography: bold/italic/underline/strikethrough/size from PDF
//   - Checkbox/symbol normalization: ☑ → [x], ☐ → [ ]
//   - Signature line detection: ___ → styled underline paragraph
//   - Font size preservation: para.fontSize drives actual output pt size
//   - Tab stop generation: para.xPositions drives <w:tabs> alignment
//   - Form layout: para.isForm → label/value table rendering
//   - Word/LibreOffice/Google Docs/WPS compatible OOXML
async function buildDocx(pages) {
  ensureJszip();
  var body = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p          = pages[pi];
    var rawText    = (p.text || '').trim();
    var paragraphs = p.paragraphs;

    // Page break before each page EXCEPT the first
    if (pi > 0) {
      body.push(
        '<w:p>' +
          '<w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
          '<w:r><w:rPr><w:sz w:val="2"/></w:rPr>' +
            '<w:br w:type="page"/>' +
          '</w:r>' +
        '</w:p>'
      );
    }

    if (paragraphs && paragraphs.length) {
      for (var qi = 0; qi < paragraphs.length; qi++) {
        var para = paragraphs[qi];

        // ── Real table ──────────────────────────────────────────────────────
        if (para.isTable && para.rows && para.rows.length) {
          body.push(buildTableXml(para.rows, para.colCount, para.isOcrTable, para.colWidths, para.isForm));
          continue;
        }

        if (!para.text) continue;

        // ── Signature line (explicit flag OR text pattern detection) ──────────
        if (para.isSignature || _isSignatureLine(para.text)) {
          var sigText = _normalizeSymbols(para.text);
          body.push(
            '<w:p><w:pPr>' +
              '<w:spacing w:before="120" w:after="120"/>' +
            '</w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:color w:val="888888"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(sigText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Heading ─────────────────────────────────────────────────────────
        if (para.isHeading) {
          var lvl    = Math.max(1, Math.min(4, para.level || 1));
          var hStyle, hSz, hColor;
          if      (lvl === 1) { hStyle = 'Heading1'; hSz = '28'; hColor = '1E3A5F'; }
          else if (lvl === 2) { hStyle = 'Heading2'; hSz = '24'; hColor = '2C4A7A'; }
          else if (lvl === 3) { hStyle = 'Heading3'; hSz = '22'; hColor = '374151'; }
          else                { hStyle = 'Heading4'; hSz = '21'; hColor = '4B5563'; }
          var hText     = _normalizeSymbols(para.text);
          var hIsRtl    = isRtl(hText);
          var hBidi     = hIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';
          var hRunRtl   = hIsRtl ? '<w:rtl/>' : '';
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="' + hStyle + '"/>' +
              '<w:spacing w:before="200" w:after="80"/>' +
              '<w:keepNext/>' + hBidi +
            '</w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:b/><w:bCs/>' + hRunRtl +
              '<w:sz w:val="' + hSz + '"/><w:szCs w:val="' + hSz + '"/>' +
              '<w:color w:val="' + hColor + '"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(hText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Numbered list ────────────────────────────────────────────────────
        if (para.isNumList) {
          var numText   = _normalizeSymbols(_stripListMarker(para.text, true));
          var numLevel  = Math.max(0, Math.min(8, _listLevel(para.text)));
          var numIsRtl  = isRtl(numText);
          var numBidi   = numIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';
          var numRunRtl = numIsRtl ? '<w:rtl/>' : '';
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr>' +
                '<w:ilvl w:val="' + numLevel + '"/>' +
                '<w:numId w:val="2"/>' +
              '</w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' + numBidi +
            '</w:pPr>' +
            '<w:r><w:rPr>' + numRunRtl +
              '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(numText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Bullet list ──────────────────────────────────────────────────────
        if (para.isList) {
          var listText   = _normalizeSymbols(_stripListMarker(para.text, false));
          var listLevel  = Math.max(0, Math.min(8, _listLevel(para.text)));
          var listIsRtl  = isRtl(listText);
          var listBidi   = listIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';
          var listRunRtl = listIsRtl ? '<w:rtl/>' : '';
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr>' +
                '<w:ilvl w:val="' + listLevel + '"/>' +
                '<w:numId w:val="1"/>' +
              '</w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' + listBidi +
            '</w:pPr>' +
            '<w:r><w:rPr>' + listRunRtl +
              '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(listText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Normal paragraph ─────────────────────────────────────────────────
        // v5.0: RTL support, inline runs, tab stops, font size from PDF metadata.
        var pText   = _normalizeSymbols(para.text);
        var pIsRtl  = isRtl(pText);
        var pBidi   = pIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';

        // Font size: use para.fontSize if provided (half-points), else default 22 (11pt)
        var pBaseSz = (para.fontSize && para.fontSize > 0)
          ? Math.max(16, Math.min(144, Math.round(para.fontSize * 2)))
          : 22;

        // Tab stops from positional data (forms, schedules, financial tables)
        var tabXml  = (para.xPositions && para.xPositions.length > 1)
          ? _buildTabStopsXml(para.xPositions, para.pageWidth || 612)
          : '';

        // Inline runs with per-run typography (bold/italic/underline/size/RTL)
        var runsXml = _buildRunsXml(para, pBaseSz);

        body.push(
          '<w:p><w:pPr>' +
            '<w:spacing w:line="276" w:lineRule="auto" w:after="100"/>' +
            pBidi + tabXml +
          '</w:pPr>' +
          runsXml +
          '</w:p>'
        );
      }
    } else if (rawText) {
      // Flat text fallback — split on newlines
      var lines = rawText.split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var line = _normalizeSymbols(lines[li].trim());
        if (line) {
          var lineIsRtl = isRtl(line);
          var lineBidi  = lineIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';
          var lineRtl   = lineIsRtl ? '<w:rtl/>' : '';
          body.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/>' + lineBidi + '</w:pPr>' +
            '<w:r><w:rPr>' + lineRtl +
              '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(line) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else {
      body.push('<w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>');
    }
  }

  // ── document.xml ─────────────────────────────────────────────────────────
  var docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"' +
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
    ' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"' +
    ' mc:Ignorable="w14 w15 wp14"' +
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<w:body>' +
    body.join('') +
    '<w:sectPr>' +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"' +
      ' w:header="720" w:footer="720" w:gutter="0"/>' +
      '<w:cols w:space="720"/>' +
      '<w:docGrid w:linePitch="360"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>';

  // ── [Content_Types].xml ───────────────────────────────────────────────────
  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '</Types>';

  // ── _rels/.rels ───────────────────────────────────────────────────────────
  var rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
    ' Target="word/document.xml"/>' +
    '</Relationships>';

  // ── word/_rels/document.xml.rels ─────────────────────────────────────────
  var wordRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"' +
    ' Target="styles.xml"/>' +
    '<Relationship Id="rId2"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering"' +
    ' Target="numbering.xml"/>' +
    '<Relationship Id="rId3"' +
    ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"' +
    ' Target="settings.xml"/>' +
    '</Relationships>';

  // ── word/settings.xml ─────────────────────────────────────────────────────
  var settingsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:defaultTabStop w:val="720"/>' +
    '<w:compat>' +
      '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
      '<w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
      '<w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
      '<w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
      '<w:compatSetting w:name="differentiateMultirowTableHeaders" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
    '</w:compat>' +
    '</w:settings>';

  // ── word/styles.xml ───────────────────────────────────────────────────────
  // Includes: Normal, Heading1-4, ListParagraph, TableNormal, TableGrid
  // TableGrid is required for <w:tbl w:tblStyle="TableGrid"> to render correctly
  // in Microsoft Word, LibreOffice Writer, and Google Docs.
  var stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
    ' mc:Ignorable="w14">' +

    // Document defaults — Calibri 11pt
    '<w:docDefaults>' +
      '<w:rPrDefault><w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
        '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr>' +
        '<w:spacing w:after="160" w:line="259" w:lineRule="auto"/>' +
      '</w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +

    // Normal
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
        '<w:lang w:val="en-US"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // Heading 1
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
      '<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr>' +
        '<w:outlineLvl w:val="0"/>' +
        '<w:spacing w:before="240" w:after="80"/>' +
        '<w:keepNext/><w:keepLines/>' +
      '</w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/>' +
        '<w:color w:val="1E3A5F"/><w:lang w:val="en-US"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // Heading 2
    '<w:style w:type="paragraph" w:styleId="Heading2">' +
      '<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr>' +
        '<w:outlineLvl w:val="1"/>' +
        '<w:spacing w:before="200" w:after="60"/>' +
        '<w:keepNext/>' +
      '</w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
        '<w:color w:val="2C4A7A"/><w:lang w:val="en-US"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // Heading 3
    '<w:style w:type="paragraph" w:styleId="Heading3">' +
      '<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr>' +
        '<w:outlineLvl w:val="2"/>' +
        '<w:spacing w:before="160" w:after="60"/>' +
        '<w:keepNext/>' +
      '</w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
        '<w:color w:val="374151"/><w:lang w:val="en-US"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // Heading 4
    '<w:style w:type="paragraph" w:styleId="Heading4">' +
      '<w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr>' +
        '<w:outlineLvl w:val="3"/>' +
        '<w:spacing w:before="120" w:after="40"/>' +
      '</w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:b/><w:i/><w:bCs/><w:sz w:val="21"/><w:szCs w:val="21"/>' +
        '<w:color w:val="4B5563"/><w:lang w:val="en-US"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // List Paragraph
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
      '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
      '<w:qFormat/>' +
      '<w:pPr>' +
        '<w:ind w:left="720"/>' +
        '<w:spacing w:after="60" w:line="276" w:lineRule="auto"/>' +
      '</w:pPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
      '</w:rPr>' +
    '</w:style>' +

    // Table Normal (required base for all table styles)
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal">' +
      '<w:name w:val="Normal Table"/>' +
      '<w:tblPr>' +
        '<w:tblInd w:w="0" w:type="dxa"/>' +
        '<w:tblCellMar>' +
          '<w:top w:w="0" w:type="dxa"/>' +
          '<w:left w:w="108" w:type="dxa"/>' +
          '<w:bottom w:w="0" w:type="dxa"/>' +
          '<w:right w:w="108" w:type="dxa"/>' +
        '</w:tblCellMar>' +
      '</w:tblPr>' +
    '</w:style>' +

    // Table Grid — the style referenced by buildTableXml
    '<w:style w:type="table" w:styleId="TableGrid">' +
      '<w:name w:val="Table Grid"/>' +
      '<w:basedOn w:val="TableNormal"/>' +
      '<w:uiPriority w:val="39"/>' +
      '<w:tblPr>' +
        '<w:tblBorders>' +
          '<w:top    w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '<w:left   w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '<w:right  w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
          '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
        '</w:tblBorders>' +
      '</w:tblPr>' +
      '<w:rPr>' +
        '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
        '<w:sz w:val="20"/><w:szCs w:val="20"/>' +
      '</w:rPr>' +
    '</w:style>' +

    '</w:styles>';

  // ── word/numbering.xml ────────────────────────────────────────────────────
  // abstractNumId=0 → bullet   (numId=1)
  // abstractNumId=1 → decimal  (numId=2)
  // Each has 9 indent levels (Word maximum). Bullet uses Wingdings/Arial Unicode
  // fallback chain so it renders on all platforms.
  function _numLevel(ilvl, isBullet) {
    var indent  = 720 + ilvl * 360;  // progressive indent
    var hanging = 360;
    var bullets = ['\u2022', '\u25e6', '\u25aa', '\u2022', '\u25e6', '\u25aa', '\u2022', '\u25e6', '\u25aa'];
    if (isBullet) {
      return (
        '<w:lvl w:ilvl="' + ilvl + '">' +
          '<w:start w:val="1"/>' +
          '<w:numFmt w:val="bullet"/>' +
          '<w:lvlText w:val="' + bullets[ilvl % bullets.length] + '"/>' +
          '<w:lvlJc w:val="left"/>' +
          '<w:pPr><w:ind w:left="' + indent + '" w:hanging="' + hanging + '"/></w:pPr>' +
          '<w:rPr>' +
            '<w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS"' +
            ' w:hint="default"/>' +
            '<w:sz w:val="20"/>' +
          '</w:rPr>' +
        '</w:lvl>'
      );
    } else {
      return (
        '<w:lvl w:ilvl="' + ilvl + '">' +
          '<w:start w:val="1"/>' +
          '<w:numFmt w:val="decimal"/>' +
          '<w:lvlText w:val="%' + (ilvl + 1) + '."/>' +
          '<w:lvlJc w:val="left"/>' +
          '<w:pPr><w:ind w:left="' + indent + '" w:hanging="' + hanging + '"/></w:pPr>' +
          '<w:rPr>' +
            '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
            '<w:sz w:val="22"/>' +
          '</w:rPr>' +
        '</w:lvl>'
      );
    }
  }

  var bulletLevels  = '';
  var decimalLevels = '';
  for (var nli = 0; nli < 9; nli++) {
    bulletLevels  += _numLevel(nli, true);
    decimalLevels += _numLevel(nli, false);
  }

  var numberingXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +

    '<w:abstractNum w:abstractNumId="0">' +
      '<w:multiLevelType w:val="hybridMultilevel"/>' +
      bulletLevels +
    '</w:abstractNum>' +

    '<w:abstractNum w:abstractNumId="1">' +
      '<w:multiLevelType w:val="multilevel"/>' +
      decimalLevels +
    '</w:abstractNum>' +

    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +

    '</w:numbering>';

  // ── Assemble ZIP ──────────────────────────────────────────────────────────
  var zip = new self.JSZip();
  zip.file('[Content_Types].xml',          contentTypes);
  zip.file('_rels/.rels',                  rels);
  zip.file('word/document.xml',            docXml);
  zip.file('word/styles.xml',              stylesXml);
  zip.file('word/numbering.xml',           numberingXml);
  zip.file('word/settings.xml',            settingsXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  var ab = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Memory: null heavy string refs before returning
  body      = null;
  docXml    = null;
  stylesXml = null;
  numberingXml = null;

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
    .replace(/[/\\?*[\]:]/g, '_')
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
  var cleaned = s.replace(/^[$€£¥\s]+/, '').replace(/[,\s]+/g, '').replace(/%$/, '');
  var n = parseFloat(cleaned);
  if (!isNaN(n) && isFinite(n) && /^-?[\d.,]+%?$/.test(s.replace(/[$€£¥\s,]/g, ''))) {
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

    var coercedRows = rows.map(function (r) {
      return r.map(function (cell) { return _coerceCell(cell); });
    });

    var ws     = self.XLSX.utils.aoa_to_sheet(coercedRows);
    var maxCol = 0;
    coercedRows.forEach(function (r) { maxCol = Math.max(maxCol, r.length); });

    var colWidths = [];
    for (var ci = 0; ci < maxCol; ci++) {
      var maxLen = 8;
      for (var ri = 0; ri < coercedRows.length; ri++) {
        var cellVal = coercedRows[ri][ci];
        var cellStr = (cellVal === undefined || cellVal === null) ? '' : String(cellVal);
        if (cellStr.length > maxLen) maxLen = cellStr.length;
      }
      colWidths.push({ wch: Math.min(60, Math.ceil(maxLen * 1.1)) });
    }
    ws['!cols'] = colWidths;

    if (coercedRows.length > 1) {
      ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
    }

    self.XLSX.utils.book_append_sheet(wb, ws, _sanitizeSheetName(s.name));
  }

  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

// ── BUILD PPTX (v3.4) ──────────────────────────────────────────────────────────
async function buildPptx(slides, docTitle) {
  ensurePptx();
  var pptx     = new self.PptxGenJS();
  pptx.layout  = 'LAYOUT_16x9';
  pptx.subject = docTitle || 'Converted Presentation';
  pptx.author  = 'ILovePDF';
  pptx.title   = docTitle || 'Converted Presentation';

  var TC = { bg: '1E3A5F', title: 'FFFFFF', text: 'BFDBFE', accent: '60A5FA', muted: '7BA5C9' };

  pptx.defineSlideMaster({
    title: 'MASTER',
    background: { color: TC.bg },
    objects: [
      { rect: { x: 0, y: 0, w: 0.08, h: '100%', fill: { color: TC.accent } } },
      { rect: { x: 0, y: 6.82, w: '100%', h: 0.12, fill: { color: TC.accent, transparency: 55 } } },
    ],
  });

  for (var i = 0; i < slides.length; i++) {
    var s     = slides[i];
    var slide = pptx.addSlide({ masterName: 'MASTER' });

    slide.addText(String(s.title || 'Slide ' + s.pageNum).substring(0, 120), {
      x: 0.28, y: 0.14, w: 9.3, h: 0.72,
      fontSize: 22, bold: true, color: TC.title, fontFace: 'Calibri',
      wrap: true, charSpacing: 0.5,
    });

    var bodyText = (s.text || '').trim();
    if (bodyText) {
      var bodyLines = bodyText.split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0; });

      var maxLines    = 22;
      var usedLines   = bodyLines.slice(0, maxLines);
      var wasTruncated = bodyLines.length > maxLines;

      var bodyObjs = usedLines.map(function (line) {
        return {
          text: line.substring(0, 220),
          options: { bullet: { type: 'bullet' }, fontSize: 11, color: TC.text, fontFace: 'Calibri' },
        };
      });

      if (wasTruncated) {
        bodyObjs.push({
          text: '\u2026 (' + (bodyLines.length - maxLines) + ' more lines)',
          options: { fontSize: 9, color: TC.muted, italic: true, fontFace: 'Calibri' },
        });
      }

      slide.addText(bodyObjs, { x: 0.28, y: 1.05, w: 9.3, h: 5.5, valign: 'top', wrap: true, autoFit: true });
    } else {
      slide.addText('(No text content)', {
        x: 0.28, y: 3.0, w: 9.3, h: 0.5,
        fontSize: 11, color: TC.muted, italic: true, fontFace: 'Calibri', align: 'center',
      });
    }

    slide.addText(String(s.pageNum), {
      x: 9.1, y: 6.6, w: 0.55, h: 0.25,
      fontSize: 8, color: TC.muted, align: 'right', fontFace: 'Calibri',
    });
  }

  return await pptx.write({ outputType: 'arraybuffer' });
}

// ── REMOVE BACKGROUND v3.0 — Confidence-Based Foreground Preservation ────────
//
// DESIGN PRINCIPLE: PRESERVE FOREGROUND AGGRESSIVELY, REMOVE BACKGROUND CONSERVATIVELY
//
// 12-phase pipeline:
//  P1:  Auto-classify subject type from pixel statistics
//  P2:  Multi-corner stratified background sampling (border + 3% inward layer)
//  P3:  K-means++ background clustering (k=6-8, 10 iterations)
//  P4:  Per-pixel 5-factor confidence scoring:
//         • Color distance to background clusters (normalized)
//         • Center-proximity Gaussian boost (near center = protect)
//         • Saturation protection (vivid pixels resist removal)
//         • Skin-tone protection (warm mid-tones = foreground)
//         • Vivid hue protection (blue/red/green objects preserved)
//  P5:  Conservative BFS flood from borders (only very-low-confidence pixels)
//  P6:  Smooth S-curve alpha from confidence + BFS mask + rescue override
//  P7:  Connected foreground region protection (saves small objects)
//  P8:  Color-weighted edge feathering (respects color boundaries, no bleed)
//  P9:  Halo/spill decontamination (defringe semi-transparent edges)
//  P10: Alpha sharpening / detail recovery (Ultra mode)
//  P11: Apply alpha channel to pixel buffer
//  P12: Quality gate — throw if no foreground detected (triggers outer retry)
//
// qualityMode: 'fast' | 'hd' | 'ultra'   (default: 'hd')
// subjectMode: 'auto'|'portrait'|'product'|'logo'|'object'  (default: 'auto')
// threshold (50–255): higher = tighter bg tolerance, lower = more aggressive removal

// Pre-computed neighbor offsets for feathering loop (dx, dy, positional-weight)
var _FN = [
  [-1,-1, 0.5], [0,-1, 1.0], [1,-1, 0.5],
  [-1, 0, 1.0],               [1, 0, 1.0],
  [-1, 1, 0.5], [0, 1, 1.0], [1, 1, 0.5]
];
var _BFS4X = [-1, 1, 0, 0];
var _BFS4Y = [0, 0, -1, 1];

function removeBg(pixelsBuf, width, height, threshold, qualityMode, subjectMode) {
  var d = new Uint8ClampedArray(pixelsBuf);
  var n = width * height;
  qualityMode  = qualityMode  || 'hd';
  subjectMode  = subjectMode  || 'auto';

  var isFast   = (qualityMode === 'fast');
  var isUltra  = (qualityMode === 'ultra');
  var isHd     = !isFast;
  var isHuge   = (n > 3000000); // > ~1732×1732 px — skip expensive passes on mobile

  // ── P1: Auto-classify subject ───────────────────────────────────────────
  if (subjectMode === 'auto') subjectMode = _bgClassify(d, width, height);

  // Per-mode parameters — tuned for foreground preservation
  var centerWeight, satWeight, skinWeight, bfsLo, bfsHi, alphaLo, alphaHi, edgePow;
  if (subjectMode === 'portrait') {
    centerWeight = 0.48; satWeight = 0.32; skinWeight = 0.22;
    bfsLo = 0.12; bfsHi = 0.24; alphaLo = 0.18; alphaHi = 0.62; edgePow = 0.70;
  } else if (subjectMode === 'product') {
    centerWeight = 0.42; satWeight = 0.48; skinWeight = 0.10;
    bfsLo = 0.13; bfsHi = 0.26; alphaLo = 0.16; alphaHi = 0.58; edgePow = 0.55;
  } else if (subjectMode === 'logo') {
    centerWeight = 0.22; satWeight = 0.28; skinWeight = 0.05;
    bfsLo = 0.16; bfsHi = 0.28; alphaLo = 0.22; alphaHi = 0.68; edgePow = 0.40;
  } else { // auto / object
    centerWeight = 0.40; satWeight = 0.42; skinWeight = 0.14;
    bfsLo = 0.13; bfsHi = 0.25; alphaLo = 0.18; alphaHi = 0.60; edgePow = 0.60;
  }

  // Scale by user threshold (50→conservative/keep-more, 255→aggressive/remove-more)
  var t = Math.max(50, Math.min(255, threshold || 235));
  var tScale = 0.72 + (t - 50) / 205 * 0.58; // 50→0.72, 235→1.15, 255→1.30
  bfsLo  = Math.max(0.04, bfsLo  * tScale);
  bfsHi  = Math.max(0.08, bfsHi  * tScale);
  alphaLo = Math.max(0.04, alphaLo * tScale);
  alphaHi = Math.min(0.96, alphaHi * tScale * 1.05);

  // ── P2: Multi-corner stratified background sampling ─────────────────────
  var bgSamples = _bgSample(d, width, height);

  // ── P3: K-means++ background clustering ─────────────────────────────────
  var K         = isFast ? 4 : (isUltra ? 8 : 6);
  var centroids = _bgKmeans(bgSamples, K, isFast ? 6 : 10);
  bgSamples     = null;

  // Average background saturation (used in saturation protection)
  var bgSatSum = 0;
  for (var ksi = 0; ksi < K; ksi++) {
    var kcR = centroids[ksi][0], kcG = centroids[ksi][1], kcB = centroids[ksi][2];
    var kcMax = kcR > kcG ? (kcR > kcB ? kcR : kcB) : (kcG > kcB ? kcG : kcB);
    var kcMin = kcR < kcG ? (kcR < kcB ? kcR : kcB) : (kcG < kcB ? kcG : kcB);
    bgSatSum += kcMax > 0 ? (kcMax - kcMin) / kcMax : 0;
  }
  var bgSatAvg = bgSatSum / K;

  // Pre-compute dominant background color (weighted average across all centroids)
  var bgDomR = 0, bgDomG = 0, bgDomB = 0;
  for (var kdi = 0; kdi < K; kdi++) {
    bgDomR += centroids[kdi][0]; bgDomG += centroids[kdi][1]; bgDomB += centroids[kdi][2];
  }
  bgDomR /= K; bgDomG /= K; bgDomB /= K;

  // ── P4: Per-pixel 5-factor confidence scoring ────────────────────────────
  // confidence[i] = 0 (definitely bg) → 1 (definitely fg)
  var confidence = new Float32Array(n);
  var cxC  = width  / 2;
  var cyC  = height / 2;
  // Normalize center distance: max radius = distance from center to corner
  var maxR = Math.sqrt(cxC * cxC + cyC * cyC);
  var invR = maxR > 0 ? 1 / maxR : 0;
  // Color scale: max RGB Euclidean = sqrt(3)*255 ≈ 441.7
  var invColorMax = 1 / (Math.sqrt(3) * 255);

  for (var pi = 0; pi < n; pi++) {
    var ri0 = pi * 4;
    var pR  = d[ri0], pG = d[ri0 + 1], pB = d[ri0 + 2];
    var pX  = pi % width, pY = (pi / width) | 0;

    // 4a. Color distance to nearest background centroid (0=identical, 1=completely different)
    var minCD = Infinity;
    for (var kci = 0; kci < K; kci++) {
      var dR = pR - centroids[kci][0], dG = pG - centroids[kci][1], dB = pB - centroids[kci][2];
      var cd = dR * dR + dG * dG + dB * dB;
      if (cd < minCD) minCD = cd;
    }
    var colorConf = Math.min(1.0, Math.sqrt(minCD) * invColorMax * 2.4);

    // 4b. Center-proximity Gaussian boost — subjects near center are protected
    var dx = (pX - cxC) * invR, dy = (pY - cyC) * invR;
    var centerBoost = centerWeight * Math.exp(-(dx * dx + dy * dy) * 2.8);

    // 4c. Saturation protection — vivid pixels are likely foreground not background
    var pMax = pR > pG ? (pR > pB ? pR : pB) : (pG > pB ? pG : pB);
    var pMin = pR < pG ? (pR < pB ? pR : pB) : (pG < pB ? pG : pB);
    var pSat = pMax > 0 ? (pMax - pMin) / pMax : 0;
    var satExcess = pSat - bgSatAvg - 0.07;
    var satBoost  = satExcess > 0 ? Math.min(satWeight, satExcess * satWeight * 2.2) : 0;

    // 4d. Skin-tone protection (warm mid-tones: R>G>B, moderate saturation)
    var skinBoost = 0;
    if (pR > 115 && pR < 245 && pG > 65 && pG < 215 && pB > 45 && pB < 190
        && pR > pG + 8 && pG > pB && pSat > 0.06 && pSat < 0.65) {
      skinBoost = skinWeight;
    }

    // 4e. Vivid hue protection — saturated non-neutral colors (blue products, red items, etc.)
    var vividBoost = 0;
    if (pSat > 0.38 && pMax > 70) {
      vividBoost = 0.11;
    }

    confidence[pi] = Math.min(1.0, Math.max(0.0, colorConf + centerBoost + satBoost + skinBoost + vividBoost));
  }

  // ── P5: Conservative BFS flood from borders ──────────────────────────────
  // Seed ONLY pixels with confidence < bfsLo (unambiguous background).
  // Flood propagates to confidence < bfsHi neighbors only.
  // This prevents leaking into foreground when colors are similar.
  var bgMask = new Uint8Array(n);
  var bfsQ   = new Int32Array(n);
  var bfsH   = 0, bfsT = 0;

  function _seed(idx) {
    if (!bgMask[idx] && confidence[idx] < bfsLo) {
      bgMask[idx] = 1; bfsQ[bfsT++] = idx;
    }
  }
  for (var bx = 0; bx < width;  bx++) { _seed(bx); _seed((height - 1) * width + bx); }
  for (var by = 0; by < height; by++) { _seed(by * width); _seed(by * width + width - 1); }

  while (bfsH < bfsT) {
    var qI  = bfsQ[bfsH++];
    var qX  = qI % width, qY = (qI / width) | 0;
    for (var d4 = 0; d4 < 4; d4++) {
      var nX = qX + _BFS4X[d4], nY = qY + _BFS4Y[d4];
      if (nX < 0 || nX >= width || nY < 0 || nY >= height) continue;
      var nI = nY * width + nX;
      if (bgMask[nI]) continue;
      if (confidence[nI] < bfsHi) { bgMask[nI] = 1; bfsQ[bfsT++] = nI; }
    }
  }

  // ── P6: Build smooth alpha from confidence + BFS mask ───────────────────
  // BFS-confirmed bg → 0 alpha, UNLESS confidence is high (center pixel
  // accidentally flooded) → partial rescue to prevent object destruction.
  var alpha = new Uint8Array(n);
  for (var i6 = 0; i6 < n; i6++) {
    var c6 = confidence[i6];
    if (bgMask[i6]) {
      // BFS confirmed: background.
      // Rescue pass: if confidence is high despite BFS flood, partially preserve.
      if (c6 > 0.55) {
        alpha[i6] = Math.round((c6 - 0.55) / 0.45 * 180); // 0–180 rescue range
      } else {
        alpha[i6] = 0;
      }
    } else if (c6 >= alphaHi) {
      alpha[i6] = 255;
    } else if (c6 <= alphaLo) {
      alpha[i6] = 0;
    } else {
      // Smooth S-curve in the uncertainty zone
      var ratio = (c6 - alphaLo) / (alphaHi - alphaLo);
      ratio = ratio * ratio * (3 - 2 * ratio); // smoothstep
      ratio = Math.pow(ratio, edgePow);          // edge softness curve
      alpha[i6] = Math.round(ratio * 255);
    }
  }
  confidence = null; bgMask = null;

  // ── P7: Connected foreground region protection ───────────────────────────
  // Find connected islands of foreground (alpha > 100) and ensure they
  // survive. Especially protects small objects, jewelry, logos, thin items.
  if (isHd && !isHuge) {
    _protectFgRegions(alpha, n, width, height);
  }

  // ── P8: Color-weighted edge feathering ──────────────────────────────────
  // Unlike plain Gaussian blur, this weights neighbor contributions by color
  // similarity — prevents color bleed across hard subject/background edges.
  var featherPasses = isFast ? 0 : (isUltra ? (isHuge ? 3 : 5) : (isHuge ? 2 : 3));
  for (var fp = 0; fp < featherPasses; fp++) {
    var alpha2 = new Uint8Array(alpha);
    for (var fy = 1; fy < height - 1; fy++) {
      for (var fx = 1; fx < width - 1; fx++) {
        var fi   = fy * width + fx;
        var fa   = alpha[fi];
        if (fa === 0 || fa === 255) continue; // definite pixels — skip
        var cR2  = d[fi * 4], cG2 = d[fi * 4 + 1], cB2 = d[fi * 4 + 2];
        var wSum = 4.0, aSum = fa * 4.0; // center pixel has 4× weight
        for (var ni = 0; ni < 8; ni++) {
          var nfDx = _FN[ni][0], nfDy = _FN[ni][1], posW = _FN[ni][2];
          var nf = fi + nfDy * width + nfDx;
          var nR2 = d[nf * 4], nG2 = d[nf * 4 + 1], nB2 = d[nf * 4 + 2];
          var cdSq = (cR2 - nR2) * (cR2 - nR2) + (cG2 - nG2) * (cG2 - nG2) + (cB2 - nB2) * (cB2 - nB2);
          // Color similarity: sigma=38 in color space; similar pixels → high weight
          var cW   = posW * Math.exp(-cdSq / 2888); // 2888 = 2*38^2
          aSum += alpha[nf] * cW;
          wSum += cW;
        }
        alpha2[fi] = Math.min(255, Math.max(0, Math.round(aSum / wSum)));
      }
    }
    alpha = alpha2;
  }

  // ── P9: Halo / spill decontamination (defringing) ───────────────────────
  // Semi-transparent edge pixels that are close to the dominant background
  // color are partially cleaned up — removes white glow / edge contamination.
  if (isHd) {
    for (var di = 0; di < n; di++) {
      var da = alpha[di];
      if (da === 0 || da === 255) continue;
      var riD = di * 4;
      var pRd = d[riD], pGd = d[riD + 1], pBd = d[riD + 2];
      // Distance to dominant background color
      var bdR = pRd - bgDomR, bdG = pGd - bgDomG, bdB = pBd - bgDomB;
      var bgDist = Math.sqrt(bdR * bdR + bdG * bdG + bdB * bdB);
      if (bgDist < 75) {
        // Pixel is suspiciously close to bg color — likely halo spill.
        // Reduce alpha proportionally to how close it is to bg.
        var contamination = (1 - bgDist / 75);
        var transparency  = 1 - da / 255;
        var reduction     = Math.round(contamination * transparency * 55);
        alpha[di] = Math.max(0, da - reduction);
      }
    }
  }

  // ── P10: Alpha sharpening / detail recovery (Ultra) ─────────────────────
  // Push transitional pixels toward their nearest hard state (255 or 0),
  // recovering crisp product edges and sharp logo outlines.
  if (isUltra) {
    var alpha3 = new Uint8Array(alpha);
    for (var sy = 1; sy < height - 1; sy++) {
      for (var sx = 1; sx < width - 1; sx++) {
        var si2 = sy * width + sx;
        var sa  = alpha[si2];
        if (sa < 8 || sa > 247) continue;
        var maxN = 0, minN = 255;
        for (var sdy = -1; sdy <= 1; sdy++) {
          for (var sdx = -1; sdx <= 1; sdx++) {
            if (sdx === 0 && sdy === 0) continue;
            var sn = alpha[si2 + sdy * width + sdx];
            if (sn > maxN) maxN = sn;
            if (sn < minN) minN = sn;
          }
        }
        if (sa > 128) {
          alpha3[si2] = Math.min(255, sa + Math.round((maxN - sa) * 0.38));
        } else {
          alpha3[si2] = Math.max(0,   sa - Math.round((sa - minN) * 0.38));
        }
      }
    }
    alpha = alpha3;
  }

  // ── P11: Apply alpha channel ─────────────────────────────────────────────
  for (var ai = 0; ai < n; ai++) d[ai * 4 + 3] = alpha[ai];
  alpha = null;

  // ── P12: Quality gate ────────────────────────────────────────────────────
  var fgPx = 0;
  for (var qi = 3; qi < n * 4; qi += 4) if (d[qi] > 64) fgPx++;
  if (fgPx / n < 0.004) {
    throw new Error('No background detected. Try a different image or quality setting.');
  }

  return { pixels: d.buffer, width: width, height: height };
}

// ── Auto-classify subject from pixel statistics ───────────────────────────────
// Samples a coarse grid to identify dominant subject type.
function _bgClassify(d, width, height) {
  var S  = 56; // grid size for sampling
  var sX = width  / S, sY = height / S;
  var skinPx = 0, brightPx = 0, lowSatPx = 0, vividPx = 0, total = S * S;
  for (var sy2 = 0; sy2 < S; sy2++) {
    for (var sx2 = 0; sx2 < S; sx2++) {
      var px  = Math.min(width  - 1, Math.floor(sx2 * sX));
      var py  = Math.min(height - 1, Math.floor(sy2 * sY));
      var idx = (py * width + px) * 4;
      var r2  = d[idx], g2 = d[idx + 1], b2 = d[idx + 2];
      var br  = (r2 + g2 + b2) / 3;
      var mx  = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
      var mn  = r2 < g2 ? (r2 < b2 ? r2 : b2) : (g2 < b2 ? g2 : b2);
      var sat = mx > 0 ? (mx - mn) / mx : 0;
      if (br > 185) brightPx++;
      if (sat < 0.10) lowSatPx++;
      if (sat > 0.42 && mx > 75) vividPx++;
      if (r2 > 115 && r2 < 245 && g2 > 65 && g2 < 215 && b2 > 45 && b2 < 190
          && r2 > g2 + 8 && g2 > b2 && sat > 0.07) skinPx++;
    }
  }
  if (skinPx  / total > 0.08) return 'portrait';
  if (lowSatPx / total > 0.60 && brightPx / total < 0.40) return 'logo';
  if (vividPx  / total > 0.24 || brightPx / total > 0.54) return 'product';
  return 'auto';
}

// ── Stratified background sampling (border + inner border layer) ──────────────
function _bgSample(d, width, height) {
  var samples = [];
  var step = Math.max(1, Math.floor((width * 2 + height * 2) / 900));

  // Outer border
  for (var bx = 0; bx < width; bx += step) {
    var it = bx * 4;
    samples.push([d[it], d[it + 1], d[it + 2]]);
    var ib = ((height - 1) * width + bx) * 4;
    samples.push([d[ib], d[ib + 1], d[ib + 2]]);
  }
  for (var by = 0; by < height; by += step) {
    var il = by * width * 4;
    samples.push([d[il], d[il + 1], d[il + 2]]);
    var ir = (by * width + width - 1) * 4;
    samples.push([d[ir], d[ir + 1], d[ir + 2]]);
  }

  // Inner border (3% inward) — catches vignettes, gradients, shadows
  var iX = Math.max(1, Math.round(width  * 0.03));
  var iY = Math.max(1, Math.round(height * 0.03));
  var iS = Math.max(1, Math.floor((width + height) / 220));
  for (var ix = iX; ix < width - iX; ix += iS) {
    var itT = (iY * width + ix) * 4;
    samples.push([d[itT], d[itT + 1], d[itT + 2]]);
    var itB = ((height - 1 - iY) * width + ix) * 4;
    samples.push([d[itB], d[itB + 1], d[itB + 2]]);
  }
  for (var iy = iY; iy < height - iY; iy += iS) {
    var itL = (iy * width + iX) * 4;
    samples.push([d[itL], d[itL + 1], d[itL + 2]]);
    var itR = (iy * width + (width - 1 - iX)) * 4;
    samples.push([d[itR], d[itR + 1], d[itR + 2]]);
  }

  return samples;
}

// ── K-means++ background clustering ──────────────────────────────────────────
// Uses k-means++ initialization for better coverage of multi-color backgrounds.
function _bgKmeans(samples, K, iters) {
  var ns = samples.length;
  if (ns === 0) return [[128, 128, 128]];
  K = Math.min(K, ns);

  // K-means++ init: each centroid is the sample farthest from existing set
  var cents = [samples[0].slice()];
  for (var ci = 1; ci < K; ci++) {
    var best = samples[0], bestD = 0;
    for (var si = 0; si < ns; si++) {
      var minD = Infinity;
      for (var cj = 0; cj < cents.length; cj++) {
        var dr = samples[si][0] - cents[cj][0], dg = samples[si][1] - cents[cj][1], db = samples[si][2] - cents[cj][2];
        var d2 = dr * dr + dg * dg + db * db;
        if (d2 < minD) minD = d2;
      }
      if (minD > bestD) { bestD = minD; best = samples[si]; }
    }
    cents.push(best.slice());
  }

  // Iterate
  for (var it = 0; it < iters; it++) {
    var sums = [];
    for (var ki = 0; ki < K; ki++) sums.push([0, 0, 0, 0]);
    for (var pi = 0; pi < ns; pi++) {
      var s = samples[pi], minDi = Infinity, bk = 0;
      for (var ki2 = 0; ki2 < K; ki2++) {
        var drK = s[0]-cents[ki2][0], dgK = s[1]-cents[ki2][1], dbK = s[2]-cents[ki2][2];
        var d2K = drK*drK + dgK*dgK + dbK*dbK;
        if (d2K < minDi) { minDi = d2K; bk = ki2; }
      }
      sums[bk][0] += s[0]; sums[bk][1] += s[1]; sums[bk][2] += s[2]; sums[bk][3]++;
    }
    for (var ki3 = 0; ki3 < K; ki3++) {
      if (sums[ki3][3] > 0) {
        cents[ki3] = [sums[ki3][0]/sums[ki3][3], sums[ki3][1]/sums[ki3][3], sums[ki3][2]/sums[ki3][3]];
      }
    }
  }
  return cents;
}

// ── Connected foreground region protection ────────────────────────────────────
// BFS to find foreground islands (alpha > 100). Any island whose pixels have an
// average confidence that would imply foreground gets a minimum alpha floor of 160.
// Prevents small objects (jewelry, handles, logos, fingers) from vanishing.
function _protectFgRegions(alpha, n, width, height) {
  var THRESH   = 100;
  var minSize  = Math.max(40, Math.round(n * 0.00008)); // 0.008% of pixels
  var visited  = new Uint8Array(n);
  var queue    = new Int32Array(n);

  for (var start = 0; start < n; start++) {
    if (visited[start] || alpha[start] < THRESH) continue;
    // BFS the connected region
    var region = [];
    var qH = 0, qT = 0;
    queue[qT++] = start;
    visited[start] = 1;
    while (qH < qT) {
      var idx = queue[qH++];
      region.push(idx);
      var x = idx % width, y = (idx / width) | 0;
      for (var dd = 0; dd < 4; dd++) {
        var nx = x + _BFS4X[dd], ny = y + _BFS4Y[dd];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        var ni = ny * width + nx;
        if (visited[ni] || alpha[ni] < THRESH) continue;
        visited[ni] = 1;
        queue[qT++] = ni;
      }
    }
    // Protect the region if it meets minimum size
    if (region.length >= minSize) {
      for (var ri = 0; ri < region.length; ri++) {
        if (alpha[region[ri]] < 160) alpha[region[ri]] = 160;
      }
    }
  }
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

// ── Phase 7A: Stream-Reader Protocol (advanced-worker) ────────────────────────
// Mirrors the protocol in pdf-worker.js. Allows RuntimeStreamBridge to stream
// large files into this worker without full-buffer accumulation in the main thread.
// Advanced-worker ops are data-message based (op field), not buffer-based,
// so the stream protocol primarily supports future large-input ops.

var _awStreamState = new Map();

function _awMergeChunks(chunks) {
  var total  = chunks.reduce(function (s, c) { return s + c.byteLength; }, 0);
  var merged = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    merged.set(new Uint8Array(chunks[i]), offset);
    offset += chunks[i].byteLength;
  }
  return merged.buffer;
}

// ── DISPATCHER (persistent — handles multiple messages) ───────────────────────

self.onmessage = async function (e) {
  var data = e.data || {};

  // Phase 7A: chunk-ack streaming protocol
  if (data.type === 'stream-init') {
    _awStreamState.set(data.streamId, { chunks: [], op: data.op, options: data.options, totalSize: data.totalSize || 0 });
    return;
  }
  if (data.type === 'stream-chunk') {
    var _awState = _awStreamState.get(data.streamId);
    if (!_awState) {
      self.postMessage({ type: 'stream-error', streamId: data.streamId, __error: 'stream-init-not-received' });
      return;
    }
    _awState.chunks.push(data.chunk);
    self.postMessage({ type: 'stream-ack', streamId: data.streamId, chunkIndex: data.chunkIndex });
    if (data.isLast) {
      var _awBuf = _awMergeChunks(_awState.chunks);
      _awState.chunks = [];
      _awStreamState.delete(data.streamId);
      try {
        self.postMessage({ type: 'stream-done', streamId: data.streamId, receivedBytes: _awBuf.byteLength });
      } catch (err) {
        self.postMessage({ type: 'stream-error', streamId: data.streamId, __error: err.message || String(err) });
      }
    }
    return;
  }
  if (data.type === 'stream-cancel') { _awStreamState.delete(data.streamId); return; }
  if (data.type === 'stream-pipe') {
    try {
      var _awReader = data.stream.getReader();
      var _awChunks = [];
      while (true) {
        var _awR = await _awReader.read();
        if (_awR.done) break;
        _awChunks.push(_awR.value instanceof ArrayBuffer ? _awR.value : (_awR.value.buffer || _awR.value));
      }
      var _awTotal = _awMergeChunks(_awChunks);
      self.postMessage({ type: 'stream-done', streamId: data.streamId, receivedBytes: _awTotal.byteLength });
    } catch (_awErr) {
      self.postMessage({ type: 'stream-error', streamId: data.streamId, __error: _awErr.message || String(_awErr) });
    }
    return;
  }

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
        var result = removeBg(data.pixels, data.width, data.height, data.threshold, data.qualityMode, data.subjectMode);
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

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
