// form-reconstruction.js — Form / Invoice / Contract Reconstruction Engine
// Phase 9 of PDF→Word Fidelity Pipeline
// Handles: HR forms, invoices, applications, contracts, government forms
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  // ── Classifiers ─────────────────────────────────────────────────────────────

  const SIG_RE    = /^[_]{6,}$|^[-]{8,}$|^[=]{8,}$|^\.{8,}$|^_{3,}\s*(Date|Sign(?:ature)?|Name|Title|Witness|Authorized|Representative|Initials)[:\s]*_{0,}$/i;
  const LV_RE     = /^([^:\n]{2,50}):\s*(.{0,200})$/;
  const DOT_LV_RE = /^([^.\n]{2,50})\s*\.{4,}\s*(.{0,200})$/;
  const CB_RE     = /^[☐□☑✓✔☒✗✘\[\]\(o\)]\s+/;
  const BLANK_RE  = /_{4,}/;

  /**
   * Classify a single text line as a form element.
   * Returns { type: 'label-value'|'checkbox'|'signature'|'input-field'|null, ... }
   */
  function classifyFormElement(text) {
    const t = (text || '').trim();
    if (!t) return null;

    if (SIG_RE.test(t))    return { type: 'signature', text: t };

    if (CB_RE.test(t)) {
      const body = t.replace(/^[☐□☑✓✔☒✗✘\[\]\(o\)x]\s+/i, '').trim();
      const checked = /[☑✓✔☒✗✘\[x\]]/i.test(t[0] + (t[1] || ''));
      return { type: 'checkbox', text: body, checked };
    }

    const lv = t.match(LV_RE);
    if (lv && lv[1].trim().length >= 2 && lv[1].trim().length <= 50) {
      return { type: 'label-value', label: lv[1].trim(), value: lv[2].trim() };
    }

    const dv = t.match(DOT_LV_RE);
    if (dv) return { type: 'label-value', label: dv[1].trim(), value: dv[2].trim() };

    if (BLANK_RE.test(t)) return { type: 'input-field', text: t };

    return null;
  }

  /**
   * Scan a block of lines and return a form descriptor if ≥50% are form elements.
   */
  function detectFormSection(lines) {
    if (!lines || lines.length < 2) return null;
    const classified = lines.map(l => classifyFormElement(l.text || ''));
    const formCount  = classified.filter(Boolean).length;
    if (formCount / lines.length < 0.5) return null;
    return { type: 'form-section', elements: classified, lines, density: formCount / lines.length };
  }

  /**
   * Render a form section to OOXML.
   * Label:Value pairs → borderless 2-column table (label bold, shaded).
   * Checkboxes → indented paragraphs.
   * Signature lines → light-coloured paragraphs.
   * Input fields → mono-style paragraphs.
   *
   * @param {Object} formSection   - from detectFormSection()
   * @param {number} pageWidth     - PDF page width in pts
   * @param {Function} escXml      - XML escape helper
   * @param {Function} normSyms    - symbol normaliser
   */
  function renderFormToXml(formSection, pageWidth, escXml, normSyms) {
    escXml   = escXml   || (s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
    normSyms = normSyms || (s => s);
    const USABLE = 9360; // twips (A4 with standard margins)
    const LW     = Math.round(USABLE * 0.38);
    const RW     = USABLE - LW;

    const bdr = s => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;
    const noBdr = `<w:tcBorders>${['top','left','bottom','right'].map(bdr).join('')}</w:tcBorders>`;

    const xmlParts = [];
    let lvBuf = [];

    const flushLv = () => {
      if (!lvBuf.length) return;
      let tbl = `<w:tbl><w:tblPr>`;
      tbl += `<w:tblW w:w="${USABLE}" w:type="dxa"/>`;
      tbl += `<w:tblLayout w:type="fixed"/>`;
      tbl += `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>`;
      tbl += `<w:bottom w:w="60" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>`;
      tbl += `</w:tblPr>`;
      tbl += `<w:tblGrid><w:gridCol w:w="${LW}"/><w:gridCol w:w="${RW}"/></w:tblGrid>`;

      for (const lv of lvBuf) {
        const lbl = escXml(normSyms(lv.label || ''));
        const val = escXml(normSyms(lv.value || ''));
        tbl += `<w:tr><w:trPr><w:trHeight w:val="320" w:hRule="atLeast"/></w:trPr>`;
        // Label cell
        tbl += `<w:tc><w:tcPr><w:tcW w:w="${LW}" w:type="dxa"/>${noBdr}`;
        tbl += `<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:tcPr>`;
        tbl += `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>`;
        tbl += `<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="20"/><w:szCs w:val="20"/>`;
        tbl += `<w:color w:val="374151"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>`;
        tbl += `</w:rPr><w:t xml:space="preserve">${lbl}</w:t></w:r></w:p></w:tc>`;
        // Value cell
        tbl += `<w:tc><w:tcPr><w:tcW w:w="${RW}" w:type="dxa"/>${noBdr}`;
        tbl += `<w:shd w:val="clear" w:color="auto" w:fill="FFFFFF"/></w:tcPr>`;
        tbl += `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>`;
        tbl += `<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/>`;
        tbl += `<w:color w:val="1F2937"/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>`;
        tbl += `</w:rPr><w:t xml:space="preserve">${val}</w:t></w:r></w:p></w:tc>`;
        tbl += `</w:tr>`;
      }
      tbl += `</w:tbl><w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>`;
      xmlParts.push(tbl);
      lvBuf = [];
    };

    for (let i = 0; i < (formSection.elements || []).length; i++) {
      const el   = formSection.elements[i];
      const line = formSection.lines[i];
      const rawText = (line && line.text) ? line.text : '';

      if (!el) {
        flushLv();
        xmlParts.push(
          `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>` +
          `<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>` +
          `<w:t xml:space="preserve">${escXml(normSyms(rawText))}</w:t></w:r></w:p>`
        );
        continue;
      }

      if (el.type === 'label-value') { lvBuf.push(el); continue; }

      flushLv();

      if (el.type === 'signature') {
        xmlParts.push(
          `<w:p><w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr>` +
          `<w:r><w:rPr><w:color w:val="9CA3AF"/><w:sz w:val="20"/><w:szCs w:val="20"/>` +
          `<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>` +
          `</w:rPr><w:t xml:space="preserve">${escXml(el.text)}</w:t></w:r></w:p>`
        );
        continue;
      }

      if (el.type === 'checkbox') {
        const sym = el.checked ? '☑' : '☐';
        xmlParts.push(
          `<w:p><w:pPr><w:ind w:left="360" w:hanging="360"/><w:spacing w:after="60"/></w:pPr>` +
          `<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>` +
          `<w:t xml:space="preserve">${escXml(sym + ' ' + normSyms(el.text))}</w:t></w:r></w:p>`
        );
        continue;
      }

      if (el.type === 'input-field') {
        xmlParts.push(
          `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>` +
          `<w:r><w:rPr><w:color w:val="6B7280"/><w:sz w:val="20"/><w:szCs w:val="20"/>` +
          `<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>` +
          `</w:rPr><w:t xml:space="preserve">${escXml(normSyms(el.text))}</w:t></w:r></w:p>`
        );
        continue;
      }
    }
    flushLv();
    return xmlParts.join('');
  }

  window.PDFPipeline.FormReconstruction = { classifyFormElement, detectFormSection, renderFormToXml };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[FormReconstruction] v1.0 loaded');
  }
})();
