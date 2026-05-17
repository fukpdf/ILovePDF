// pdf-word-docx-worker.js — Dedicated DOCX builder for PdfToWordApp (Phase 2)
// Terminate-after-job: caller spawns this worker fresh per conversion job and
// terminates it once the result is received (or on error/timeout).
// Contains the full build-docx pipeline extracted from advanced-worker.js.
// This worker does NOT share the global WorkerPool slot — it is completely isolated.
//
// Protocol:
//   IN  { op: 'build-docx', pages: Array<PageObj>, jobId: string }
//   OUT { buffer: ArrayBuffer, jobId: string }  (transferable)
//   ERR { __error: string, jobId: string }

// ── LAZY LIBRARY LOADING ──────────────────────────────────────────────────────
var _jszipLoaded = false;
function _ensureJsZip() {
  if (!_jszipLoaded) {
    importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    _jszipLoaded = true;
  }
}

// ── XML ESCAPE ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── RTL DETECTION ─────────────────────────────────────────────────────────────
function isRtl(s) {
  if (!s) return false;
  var rtlChars = (s.match(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0800-\u083F\u0840-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  return rtlChars > 0 && rtlChars / s.replace(/\s/g, '').length > 0.15;
}

// ── SYMBOL / CHECKBOX NORMALIZATION ──────────────────────────────────────────
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

// ── FORM LINE DETECTION ───────────────────────────────────────────────────────
function _isFormLine(text) {
  return /^[A-Za-z\u0600-\u06FF\s]{2,40}:\s*\S/.test(text) ||
         /^[A-Za-z\u0600-\u06FF\s]{2,40}[.]{5,}\s*\S/.test(text);
}

// ── LIST MARKER STRIP ─────────────────────────────────────────────────────────
function _stripListMarker(text, isNum) {
  if (isNum) return text.replace(/^\s*(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]\s+/, '');
  return text.replace(/^\s*[-\u2022\u2023\u25aa\u25b8\u25ba\u2192\u2713\u2714\u25cf\u25cb]\s*/, '');
}

function _listLevel(text) {
  var match = text.match(/^(\s+)/);
  return Math.min(8, Math.floor(((match && match[1].length) || 0) / 2));
}

// ── INLINE RUNS XML ───────────────────────────────────────────────────────────
function _buildRunsXml(para, baseSz) {
  var sz = baseSz || 22;
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
  var txt  = _normalizeSymbols(para.text || '');
  var rPr2 = '';
  if (para.bold)   rPr2 += '<w:b/><w:bCs/>';
  if (para.italic) rPr2 += '<w:i/><w:iCs/>';
  if (isRtl(txt))  rPr2 += '<w:rtl/>';
  rPr2 += '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:color w:val="374151"/>';
  return '<w:r><w:rPr>' + rPr2 + '</w:rPr><w:t xml:space="preserve">' + esc(txt) + '</w:t></w:r>';
}

// ── TAB STOPS XML ─────────────────────────────────────────────────────────────
function _buildTabStopsXml(xPositions, pageWidth) {
  if (!xPositions || xPositions.length < 2) return '';
  var gap  = (pageWidth || 612) * 0.04;
  var tabs = [];
  for (var k = 1; k < xPositions.length; k++) {
    if (xPositions[k] - xPositions[k - 1] >= gap) {
      var pos = Math.round(xPositions[k] * 20);
      if (pos > 0 && pos < 120000) tabs.push('<w:tab w:val="left" w:pos="' + pos + '"/>');
    }
  }
  return tabs.length ? '<w:tabs>' + tabs.join('') + '</w:tabs>' : '';
}

// ── TABLE XML ─────────────────────────────────────────────────────────────────
function buildTableXml(rows, numCols, isOcrTable, colWidths, isForm) {
  if (!rows || !rows.length) return '';
  var nc = numCols || rows.reduce(function (m, r) { return Math.max(m, r ? r.length : 0); }, 1);
  if (nc < 1) nc = 1;
  var USABLE = 10080;
  var colW_arr;
  if (colWidths && colWidths.length === nc) {
    var spanTotal = colWidths.reduce(function (s, v) { return s + (v || 30); }, 0) || 1;
    colW_arr = colWidths.map(function (span) { return Math.max(600, Math.round(USABLE * (span || 30) / spanTotal)); });
    var assigned = colW_arr.reduce(function (s, v) { return s + v; }, 0);
    if (assigned !== USABLE) colW_arr[colW_arr.length - 1] += (USABLE - assigned);
  } else if (isForm && nc === 2) {
    colW_arr = [Math.round(USABLE * 0.35), Math.round(USABLE * 0.65)];
  } else {
    var eqW = Math.max(600, Math.floor(USABLE / nc));
    colW_arr = [];
    for (var ei = 0; ei < nc; ei++) colW_arr.push(eqW);
  }
  var totalW = colW_arr.reduce(function (s, v) { return s + v; }, 0);
  var allCellText = rows.map(function (r) { return (r || []).join(' '); }).join(' ');
  var tableIsRtl  = isRtl(allCellText);
  var xml = '<w:tbl>';
  xml += '<w:tblPr>' +
    '<w:tblStyle w:val="TableGrid"/>' +
    '<w:tblW w:w="' + totalW + '" w:type="dxa"/>' +
    '<w:tblLayout w:type="fixed"/>' +
    (tableIsRtl ? '<w:bidiVisual/>' : '') +
    '<w:tblCellMar>' +
      '<w:top w:w="80" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
    '</w:tblCellMar>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
  '</w:tblPr>';
  xml += '<w:tblGrid>';
  for (var gi = 0; gi < nc; gi++) xml += '<w:gridCol w:w="' + colW_arr[gi] + '"/>';
  xml += '</w:tblGrid>';
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri] || [];
    var isHeader = (ri === 0 && !isOcrTable && !isForm);
    var rowFill  = isHeader ? 'EFF6FF' : (isForm ? 'FFFFFF' : (ri % 2 === 0 ? 'FFFFFF' : 'F9FAFB'));
    xml += '<w:tr>';
    var trPr = '<w:trPr>';
    if (isHeader) trPr += '<w:tblHeader/>';
    trPr += '<w:trHeight w:val="340" w:hRule="atLeast"/></w:trPr>';
    xml += trPr;
    for (var ci = 0; ci < nc; ci++) {
      var cellVal   = (row[ci] !== undefined && row[ci] !== null) ? String(row[ci]) : '';
      var cellNorm  = _normalizeSymbols(cellVal);
      var cellIsRtl = isRtl(cellNorm);
      var cellClr   = isHeader ? '1E3A5F' : (isForm && ci === 0 ? '1E3A5F' : '374151');
      var bold      = (isHeader || (isForm && ci === 0)) ? '<w:b/>' : '';
      var cw        = colW_arr[ci] || Math.max(600, Math.floor(USABLE / nc));
      var cellJc    = cellIsRtl ? '<w:jc w:val="right"/>' : '';
      var cellBidi  = cellIsRtl ? '<w:bidi/>' : '';
      var runRtl    = cellIsRtl ? '<w:rtl/>' : '';
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
          (cellNorm ? '<w:r><w:rPr>' + bold + runRtl + '<w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="' + cellClr + '"/></w:rPr><w:t xml:space="preserve">' + esc(cellNorm) + '</w:t></w:r>' : '') +
        '</w:p>' +
      '</w:tc>';
    }
    xml += '</w:tr>';
  }
  xml += '</w:tbl>';
  xml += '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>';
  return xml;
}

// ── BUILD DOCX ────────────────────────────────────────────────────────────────
async function buildDocx(pages) {
  _ensureJsZip();
  var body = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p          = pages[pi];
    var rawText    = (p.text || '').trim();
    var paragraphs = p.paragraphs;

    if (pi > 0) {
      body.push(
        '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
        '<w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:br w:type="page"/></w:r></w:p>'
      );
    }

    if (paragraphs && paragraphs.length) {
      for (var qi = 0; qi < paragraphs.length; qi++) {
        var para = paragraphs[qi];

        if (para.isTable && para.rows && para.rows.length) {
          body.push(buildTableXml(para.rows, para.colCount, para.isOcrTable, para.colWidths, para.isForm));
          continue;
        }
        if (!para.text) continue;

        if (para.isSignature || _isSignatureLine(para.text)) {
          body.push(
            '<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr>' +
            '<w:r><w:rPr><w:color w:val="888888"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(_normalizeSymbols(para.text)) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        if (para.isHeading) {
          var lvl    = Math.max(1, Math.min(4, para.level || 1));
          var hStyle = lvl === 1 ? 'Heading1' : lvl === 2 ? 'Heading2' : lvl === 3 ? 'Heading3' : 'Heading4';
          var hSz    = lvl === 1 ? '28' : lvl === 2 ? '24' : lvl === 3 ? '22' : '21';
          var hColor = lvl === 1 ? '1E3A5F' : lvl === 2 ? '2C4A7A' : lvl === 3 ? '374151' : '4B5563';
          var hText  = _normalizeSymbols(para.text);
          var hIsRtl = isRtl(hText);
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="' + hStyle + '"/>' +
              '<w:spacing w:before="200" w:after="80"/><w:keepNext/>' +
              (hIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '') +
            '</w:pPr>' +
            '<w:r><w:rPr><w:b/><w:bCs/>' +
              (hIsRtl ? '<w:rtl/>' : '') +
              '<w:sz w:val="' + hSz + '"/><w:szCs w:val="' + hSz + '"/><w:color w:val="' + hColor + '"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr><w:t xml:space="preserve">' + esc(hText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        if (para.isNumList) {
          var numText  = _normalizeSymbols(_stripListMarker(para.text, true));
          var numLevel = Math.max(0, Math.min(8, _listLevel(para.text)));
          var numIsRtl = isRtl(numText);
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr><w:ilvl w:val="' + numLevel + '"/><w:numId w:val="2"/></w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
              (numIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '') +
            '</w:pPr>' +
            '<w:r><w:rPr>' + (numIsRtl ? '<w:rtl/>' : '') +
              '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr><w:t xml:space="preserve">' + esc(numText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        if (para.isList) {
          var listText  = _normalizeSymbols(_stripListMarker(para.text, false));
          var listLevel = Math.max(0, Math.min(8, _listLevel(para.text)));
          var listIsRtl = isRtl(listText);
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr><w:ilvl w:val="' + listLevel + '"/><w:numId w:val="1"/></w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
              (listIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '') +
            '</w:pPr>' +
            '<w:r><w:rPr>' + (listIsRtl ? '<w:rtl/>' : '') +
              '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
            '</w:rPr><w:t xml:space="preserve">' + esc(listText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        var pText  = _normalizeSymbols(para.text);
        var pIsRtl = isRtl(pText);
        var pBidi  = pIsRtl ? '<w:bidi/><w:jc w:val="right"/>' : '';
        var pBaseSz = (para.fontSize && para.fontSize > 0)
          ? Math.max(16, Math.min(144, Math.round(para.fontSize * 2)))
          : 22;
        var tabXml  = (para.xPositions && para.xPositions.length > 1)
          ? _buildTabStopsXml(para.xPositions, para.pageWidth || 612)
          : '';
        body.push(
          '<w:p><w:pPr>' +
            '<w:spacing w:line="276" w:lineRule="auto" w:after="100"/>' +
            pBidi + tabXml +
          '</w:pPr>' +
          _buildRunsXml(para, pBaseSz) +
          '</w:p>'
        );
      }
    } else if (rawText) {
      rawText.split(/\r?\n/).forEach(function (line) {
        var ln = _normalizeSymbols(line.trim());
        if (!ln) return;
        var lnRtl = isRtl(ln);
        body.push(
          '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/>' +
            (lnRtl ? '<w:bidi/><w:jc w:val="right"/>' : '') +
          '</w:pPr>' +
          '<w:r><w:rPr>' + (lnRtl ? '<w:rtl/>' : '') +
            '<w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/>' +
            '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
          '</w:rPr><w:t xml:space="preserve">' + esc(ln) + '</w:t></w:r></w:p>'
        );
      });
    } else {
      body.push('<w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>');
    }
  }

  var docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"' +
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
    ' xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"' +
    ' mc:Ignorable="w14 w15 wp14"' +
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<w:body>' + body.join('') +
    '<w:sectPr>' +
      '<w:pgSz w:w="12240" w:h="15840"/>' +
      '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/>' +
      '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/>' +
    '</w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
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
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '</Relationships>';

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

  var stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"' +
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="80"/><w:keepNext/><w:keepLines/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/><w:color w:val="1E3A5F"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="60"/><w:keepNext/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="2C4A7A"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="60"/><w:keepNext/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="374151"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:outlineLvl w:val="3"/><w:spacing w:before="120" w:after="40"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:b/><w:i/><w:bCs/><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="4B5563"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720"/><w:spacing w:after="60" w:line="276" w:lineRule="auto"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>' +
    '</w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar>' +
        '<w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
        '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
      '</w:tblCellMar></w:tblPr>' +
    '</w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>' +
      '<w:tblPr><w:tblBorders>' +
        '<w:top    w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
        '<w:left   w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
        '<w:right  w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
      '</w:tblBorders></w:tblPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
    '</w:style>' +
    '</w:styles>';

  function _numLevel(ilvl, isBullet) {
    var indent  = 720 + ilvl * 360;
    var hanging = 360;
    var bullets = ['\u2022', '\u25e6', '\u25aa', '\u2022', '\u25e6', '\u25aa', '\u2022', '\u25e6', '\u25aa'];
    if (isBullet) {
      return '<w:lvl w:ilvl="' + ilvl + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
        '<w:lvlText w:val="' + bullets[ilvl % bullets.length] + '"/><w:lvlJc w:val="left"/>' +
        '<w:pPr><w:ind w:left="' + indent + '" w:hanging="' + hanging + '"/></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:hint="default"/><w:sz w:val="20"/></w:rPr>' +
        '</w:lvl>';
    }
    return '<w:lvl w:ilvl="' + ilvl + '"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
      '<w:lvlText w:val="%' + (ilvl + 1) + '."/><w:lvlJc w:val="left"/>' +
      '<w:pPr><w:ind w:left="' + indent + '" w:hanging="' + hanging + '"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>' +
      '</w:lvl>';
  }
  var bulletLevels = '', decimalLevels = '';
  for (var nli = 0; nli < 9; nli++) { bulletLevels += _numLevel(nli, true); decimalLevels += _numLevel(nli, false); }

  var numberingXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + bulletLevels + '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>' + decimalLevels + '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';

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

  body = null; docXml = null; stylesXml = null; numberingXml = null;
  return ab;
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  var data   = e.data || {};
  var jobId  = data.jobId || '';
  try {
    if (data.op !== 'build-docx') throw new Error('Unknown op: ' + data.op);
    if (!data.pages || !data.pages.length) throw new Error('No pages provided');
    var buf = await buildDocx(data.pages);
    self.postMessage({ buffer: buf, jobId: jobId }, [buf]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'DOCX build error', jobId: jobId });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error', jobId: '' });
};
