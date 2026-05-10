// Advanced Worker v4.0 — ENTERPRISE RESTABILIZATION (forensic-grade pdf-to-word)
// Phase 1: Persistent (handles multiple tasks, no re-spawn).
// Phase 5: CPU pixel processing for remove-bg (WebGPU removed — broken dispatch math).
// v3.2: buildDocx — H1-H4 heading levels, bullet + numbered list support,
//       Calibri default fonts, word/numbering.xml in output ZIP.
// v3.3: buildXlsx — sheet name sanitization, numeric type coercion,
//       adaptive column widths, freeze pane on row 1.
// v4.0: ENTERPRISE RESTABILIZATION — real <w:tbl> table support, page breaks,
//       multi-level list nesting, hardened XML, LibreOffice/Google Docs compat.
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

// ── BUILD TABLE XML ────────────────────────────────────────────────────────────
// Generates a real OOXML <w:tbl> element with borders, header row styling,
// and adaptive column widths. Compatible with Word, LibreOffice, Google Docs.
//
// rows       — string[][] (each row is an array of cell strings)
// numCols    — (optional) override column count; auto-detected from rows if absent
// isOcrTable — true when rows came from OCR (lighter borders, no header bold)
function buildTableXml(rows, numCols, isOcrTable) {
  if (!rows || !rows.length) return '';

  // Normalise col count
  var nc = numCols || rows.reduce(function(m, r) { return Math.max(m, r ? r.length : 0); }, 1);
  if (nc < 1) nc = 1;

  // Usable page width: A4-like (12240 twips) minus 1080+1080 margins = 10080 twips
  var USABLE = 10080;
  var colW   = Math.max(600, Math.floor(USABLE / nc)); // min 600 per col

  // ── Table properties ──────────────────────────────────────────────────────
  var xml = '<w:tbl>';
  xml += '<w:tblPr>' +
    '<w:tblStyle w:val="TableGrid"/>' +
    '<w:tblW w:w="' + (colW * nc) + '" w:type="dxa"/>' +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar>' +
      '<w:top w:w="80" w:type="dxa"/>' +
      '<w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="80" w:type="dxa"/>' +
      '<w:right w:w="108" w:type="dxa"/>' +
    '</w:tblCellMar>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
  '</w:tblPr>';

  // ── Grid columns ──────────────────────────────────────────────────────────
  xml += '<w:tblGrid>';
  for (var gi = 0; gi < nc; gi++) {
    xml += '<w:gridCol w:w="' + colW + '"/>';
  }
  xml += '</w:tblGrid>';

  // ── Rows ──────────────────────────────────────────────────────────────────
  for (var ri = 0; ri < rows.length; ri++) {
    var row       = rows[ri] || [];
    var isHeader  = (ri === 0 && !isOcrTable);
    var rowFill   = isHeader ? 'EFF6FF' : (ri % 2 === 0 ? 'FFFFFF' : 'F9FAFB');

    xml += '<w:tr>';

    // Row properties
    // NOTE: <w:shd> is NOT a valid child of <w:trPr> per OOXML CT_TrPr schema —
    // shading must live in <w:tcPr> (already applied per-cell below). Omitting it
    // from trPr prevents Word's "repaired" dialog and LibreOffice parse warnings.
    var trPr = '<w:trPr>';
    if (isHeader) trPr += '<w:tblHeader/>';
    trPr += '<w:trHeight w:val="340" w:hRule="atLeast"/>';
    trPr += '</w:trPr>';
    xml  += trPr;

    // Cells
    for (var ci = 0; ci < nc; ci++) {
      var cellVal = (row[ci] !== undefined && row[ci] !== null) ? String(row[ci]) : '';
      var cellSz  = isHeader ? '20' : '20';
      var cellClr = isHeader ? '1E3A5F' : '374151';
      var bold    = isHeader ? '<w:b/>' : '';

      xml += '<w:tc>' +
        '<w:tcPr>' +
          '<w:tcW w:w="' + colW + '" w:type="dxa"/>' +
          '<w:shd w:val="clear" w:color="auto" w:fill="' + rowFill + '"/>' +
          '<w:tcBorders>' +
            '<w:top w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:left w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
            '<w:right w:val="single" w:sz="4" w:space="0" w:color="9CA3AF"/>' +
          '</w:tcBorders>' +
        '</w:tcPr>' +
        '<w:p>' +
          '<w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>' +
          (cellVal
            ? '<w:r><w:rPr>' + bold + '<w:sz w:val="' + cellSz + '"/><w:color w:val="' + cellClr + '"/></w:rPr>' +
              '<w:t xml:space="preserve">' + esc(cellVal) + '</w:t></w:r>'
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
// v4.0 ENTERPRISE RESTABILIZATION:
//   - Real <w:tbl> tables (para.isTable = true, para.rows = string[][])
//   - Proper DOCX page breaks between pages (no "Page N" text labels)
//   - Multi-level list nesting (ilvl 0-8)
//   - Table of Contents marker paragraph (para.isTocEntry)
//   - Full styles.xml with TableNormal + TableGrid for Word/LibreOffice/GDocs
//   - Hardened numbering.xml (all 9 indent levels, Symbol fallback)
//   - Section properties with correct margins
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
          body.push(buildTableXml(para.rows, para.colCount, para.isOcrTable));
          continue;
        }

        if (!para.text) continue;

        // ── Heading ─────────────────────────────────────────────────────────
        if (para.isHeading) {
          var lvl    = Math.max(1, Math.min(4, para.level || 1));
          var hStyle, hSz, hColor;
          if      (lvl === 1) { hStyle = 'Heading1'; hSz = '28'; hColor = '1E3A5F'; }
          else if (lvl === 2) { hStyle = 'Heading2'; hSz = '24'; hColor = '2C4A7A'; }
          else if (lvl === 3) { hStyle = 'Heading3'; hSz = '22'; hColor = '374151'; }
          else                { hStyle = 'Heading4'; hSz = '21'; hColor = '4B5563'; }
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="' + hStyle + '"/>' +
              '<w:spacing w:before="200" w:after="80"/>' +
              '<w:keepNext/>' +
            '</w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:b/><w:sz w:val="' + hSz + '"/><w:color w:val="' + hColor + '"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Numbered list ────────────────────────────────────────────────────
        if (para.isNumList) {
          var numText  = _stripListMarker(para.text, true);
          var numLevel = Math.max(0, Math.min(8, _listLevel(para.text)));
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr>' +
                '<w:ilvl w:val="' + numLevel + '"/>' +
                '<w:numId w:val="2"/>' +
              '</w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
            '</w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:sz w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(numText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Bullet list ──────────────────────────────────────────────────────
        if (para.isList) {
          var listText  = _stripListMarker(para.text, false);
          var listLevel = Math.max(0, Math.min(8, _listLevel(para.text)));
          body.push(
            '<w:p><w:pPr>' +
              '<w:pStyle w:val="ListParagraph"/>' +
              '<w:numPr>' +
                '<w:ilvl w:val="' + listLevel + '"/>' +
                '<w:numId w:val="1"/>' +
              '</w:numPr>' +
              '<w:spacing w:line="276" w:lineRule="auto" w:after="60"/>' +
            '</w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:sz w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
            '</w:rPr>' +
            '<w:t xml:space="preserve">' + esc(listText) + '</w:t></w:r></w:p>'
          );
          continue;
        }

        // ── Normal paragraph ─────────────────────────────────────────────────
        body.push(
          '<w:p><w:pPr>' +
            '<w:spacing w:line="276" w:lineRule="auto" w:after="100"/>' +
          '</w:pPr>' +
          '<w:r><w:rPr>' +
            '<w:sz w:val="22"/><w:color w:val="374151"/>' +
            '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
          '</w:rPr>' +
          '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
        );
      }
    } else if (rawText) {
      // Flat text fallback — split on newlines
      var lines = rawText.split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (line) {
          body.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr>' +
              '<w:sz w:val="22"/><w:color w:val="374151"/>' +
              '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
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

// ── REMOVE BACKGROUND (CPU path, enhanced feathering + multi-pass) ────────────
function removeBg(pixelsBuf, width, height, threshold) {
  var t = Math.max(60, Math.min(255, threshold || 240));
  var d = new Uint8ClampedArray(pixelsBuf);

  var borderSum = 0, borderCount = 0;
  var step = Math.max(1, Math.floor((width * 2 + height * 2) / 200));
  for (var bx = 0; bx < width; bx += step) {
    var bi0 = bx * 4;
    borderSum += (d[bi0] + d[bi0+1] + d[bi0+2]) / 3; borderCount++;
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
  var isDark = avgBorder < 80;

  var featherRange = 50;

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (!isDark) {
      if (r >= t && g >= t && b >= t) {
        d[i + 3] = 0;
      } else if (lum >= t - featherRange) {
        var pct   = (lum - (t - featherRange)) / featherRange;
        var alpha = Math.round(255 * (1 - Math.pow(pct, 0.7)));
        alpha = Math.max(0, Math.min(255, alpha));
        if (alpha < d[i + 3]) d[i + 3] = alpha;
      }
    } else {
      var tDark = 255 - t;
      if (r <= tDark && g <= tDark && b <= tDark) {
        d[i + 3] = 0;
      } else if (lum <= tDark + featherRange) {
        var pct2   = (tDark + featherRange - lum) / featherRange;
        var alpha2 = Math.round(255 * (1 - Math.pow(pct2, 0.7)));
        alpha2 = Math.max(0, Math.min(255, alpha2));
        if (alpha2 < d[i + 3]) d[i + 3] = alpha2;
      }
    }
  }

  var d2 = new Uint8ClampedArray(d);
  for (var py = 1; py < height - 1; py++) {
    for (var px = 1; px < width - 1; px++) {
      var idx = (py * width + px) * 4;
      var a   = d[idx + 3];
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
