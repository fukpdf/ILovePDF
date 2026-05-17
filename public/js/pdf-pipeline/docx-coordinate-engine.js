// docx-coordinate-engine.js — Coordinate-Aware DOCX Rendering Engine
// Phase 4 of PDF→Word Fidelity Pipeline
// Generates high-fidelity OOXML from visually-enhanced structure blocks.
// Uses FontMapper for family/weight, VisualReconstruction for spacing,
// and FormReconstruction for label:value form rendering.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  /**
   * Render an array of enhanced structure blocks to OOXML body content.
   *
   * @param {Array}  blocks - enhanced blocks (from VisualReconstruction.enhanceBlocks)
   * @param {Object} opts   - {
   *   basePt, pageWidth, escXml, normalizeSymbols, isRtl,
   *   fontMapper, visualReconstruction, formReconstruction
   * }
   * @returns {string} joined OOXML paragraph/table elements (no <w:document> wrapper)
   */
  function renderBlocks(blocks, opts) {
    opts   = opts   || {};
    const FM = opts.fontMapper          || (window.PDFPipeline && window.PDFPipeline.FontMapper);
    const VR = opts.visualReconstruction|| (window.PDFPipeline && window.PDFPipeline.VisualReconstruction);
    const FR = opts.formReconstruction  || (window.PDFPipeline && window.PDFPipeline.FormReconstruction);

    const ctx = {
      basePt:  opts.basePt    || 11,
      pageWidth: opts.pageWidth || 612,
      esc:     opts.escXml         || _esc,
      norm:    opts.normalizeSymbols|| (s => s),
      rtl:     opts.isRtl          || _isRtl,
      FM, VR, FR,
    };
    ctx.sz = Math.round(ctx.basePt * 2);

    const xmlParts = [];

    // Detect consecutive form-like paragraphs and batch them
    let i = 0;
    while (i < blocks.length) {
      const block = blocks[i];

      // Batch form sections through FormReconstruction
      if (FR && block.type === 'p' && _isFormLike(block.text)) {
        const batch = [block];
        let j = i + 1;
        while (j < blocks.length && blocks[j].type === 'p' && _isFormLike(blocks[j].text)) {
          batch.push(blocks[j]); j++;
        }
        if (batch.length >= 2) {
          const fakeLines = batch.map(b => ({ text: b.text, xPositions: b.xPositions || [0], pageWidth: b.pageWidth || ctx.pageWidth }));
          const fd = FR.detectFormSection(fakeLines);
          if (fd) {
            xmlParts.push(FR.renderFormToXml(fd, ctx.pageWidth, ctx.esc, ctx.norm));
            i = j; continue;
          }
        }
      }

      xmlParts.push(_renderBlock(block, ctx));
      i++;
    }

    return xmlParts.join('');
  }

  // ── Single block renderer ──────────────────────────────────────────────────

  function _renderBlock(block, ctx) {
    const { basePt, pageWidth, esc, norm, rtl, FM, VR, sz } = ctx;

    if (block.type === 'pageBreak') return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

    if (block.type === 'signature') {
      const before = block.spacingBefore || 160;
      const after  = block.spacingAfter  || 60;
      return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/></w:pPr>` +
             `<w:r><w:rPr><w:color w:val="888888"/><w:sz w:val="20"/><w:szCs w:val="20"/>` +
             `<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>` +
             `</w:rPr><w:t xml:space="preserve">${esc(block.text)}</w:t></w:r></w:p>`;
    }

    // Tables are handled by the caller (buildDocXml); we return null signal
    if (block.type === 'table') return null;

    if (block.type === 'list') {
      const numId = block.listType === 'number' ? '2' : '1';
      return (block.items || []).map(item => {
        const txt  = norm(item.text || '');
        const r    = rtl(txt);
        const jc   = r ? '<w:jc w:val="right"/>' : '';
        const bidi = r ? '<w:bidi/>' : '';
        const runs = item.runs && item.runs.length
          ? _runsXml(item.runs, basePt, esc, norm, rtl, FM)
          : `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(txt)}</w:t></w:r>`;
        return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` +
               `<w:spacing w:after="${block.spacingAfter || 60}"/>${bidi}${jc}</w:pPr>${runs}</w:p>`;
      }).join('');
    }

    if (['h1','h2','h3'].includes(block.type)) {
      const level   = parseInt(block.type[1]);
      const scales  = [1.70, 1.40, 1.20];
      const mins    = [14, 12, 11];
      const hPt     = Math.max(mins[level-1], basePt * scales[level-1]);
      const hSz     = Math.round(hPt * 2);
      const color   = FM ? FM.headingColor(level) : (['1F3864','2E4057','404040'])[level-1];
      const before  = block.spacingBefore || ([280,200,160])[level-1];
      const after   = block.spacingAfter  || ([80,60,40])[level-1];
      const ls      = block.lineSpacing   || ([288,264,252])[level-1];
      const r       = rtl(block.text || '');
      const jcAlign = r ? '<w:jc w:val="right"/>' : ((VR && block.alignment && block.alignment !== 'left') ? VR.alignmentXml(block.alignment) : '');
      const bidi    = r ? '<w:bidi/>' : '';

      let runs;
      if (block.runs && block.runs.length) {
        runs = _runsXml(block.runs, hPt, esc, norm, rtl, FM, true);
      } else {
        const rFonts = FM ? FM.rFontsXml(FM.parseFont('').family) : '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>';
        runs = `<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="${hSz}"/><w:szCs w:val="${hSz}"/>` +
               `<w:color w:val="${color}"/>${rFonts}${r?'<w:rtl/>':''}</w:rPr>` +
               `<w:t xml:space="preserve">${esc(norm(block.text||''))}</w:t></w:r>`;
      }
      return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/>` +
             `<w:spacing w:before="${before}" w:after="${after}" w:line="${ls}" w:lineRule="auto"/>` +
             `<w:keepNext/>${bidi}${jcAlign}</w:pPr>${runs}</w:p>`;
    }

    // Regular paragraph
    if (block.type === 'p' && block.text) {
      const txt    = norm(block.text || '');
      const r      = rtl(txt);
      const align  = r ? 'right' : (block.alignment || 'left');
      const jc     = align !== 'left' && VR ? VR.alignmentXml(align) : (align === 'center' ? '<w:jc w:val="center"/>' : align === 'right' ? '<w:jc w:val="right"/>' : '');
      const bidi   = r ? '<w:bidi/>' : '';
      const before = block.spacingBefore != null ? block.spacingBefore : 40;
      const after  = block.spacingAfter  != null ? block.spacingAfter  : 80;
      const ls     = block.lineSpacing   || 276;
      const indent = (VR && block.indentTwips) ? VR.indentXml(block.indentTwips) : (block.indentLevel ? `<w:ind w:left="${block.indentLevel * 720}"/>` : '');

      let runs;
      if (block.runs && block.runs.length) {
        runs = _runsXml(block.runs, basePt, esc, norm, rtl, FM, false);
      } else {
        const rFonts = FM ? FM.rFontsXml('Calibri') : '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>';
        runs = `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>${rFonts}${r?'<w:rtl/>':''}</w:rPr>` +
               `<w:t xml:space="preserve">${esc(txt)}</w:t></w:r>`;
      }
      return `<w:p><w:pPr>` +
             `<w:spacing w:before="${before}" w:after="${after}" w:line="${ls}" w:lineRule="auto"/>` +
             `${bidi}${jc}${indent}</w:pPr>${runs}</w:p>`;
    }

    return '';
  }

  // ── Run-level OOXML generator ──────────────────────────────────────────────

  function _runsXml(runs, sizePt, esc, norm, rtl, FM, forceHeading) {
    if (!runs || !runs.length) return '';
    const out = [];
    for (const run of runs) {
      const txt = norm(run.text || '');
      if (!txt.trim()) continue;

      let fp;
      if (FM) {
        fp = FM.parseFont(run.fontName || run.fontFamily || '');
      } else {
        const fn = (run.fontName || run.fontFamily || '').toLowerCase();
        fp = {
          family:   fn.includes('times') ? 'Times New Roman' : fn.includes('courier') ? 'Courier New' : 'Calibri',
          bold:     /bold|heavy|black/.test(fn) || run.bold,
          italic:   /italic|oblique/.test(fn)   || run.italic,
          mono:     /mono|courier|consol/.test(fn) || run.mono,
        };
      }

      const fam  = fp.mono ? 'Courier New' : (fp.family || 'Calibri');
      const bold = forceHeading || fp.bold || run.bold;
      const ital = fp.italic || run.italic;
      const fs   = run.fontSize || sizePt;
      const szV  = FM ? FM.mapFontSize(fs, sizePt) : Math.round(Math.max(12, Math.min(192, fs)) * 2);
      const r    = rtl(txt);
      const rFonts = FM ? FM.rFontsXml(fam) : `<w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:cs="Arial"/>`;

      let rpr = `<w:sz w:val="${szV}"/><w:szCs w:val="${szV}"/>${rFonts}`;
      if (bold) rpr += '<w:b/><w:bCs/>';
      if (ital) rpr += '<w:i/><w:iCs/>';
      if (r)    rpr += '<w:rtl/>';

      out.push(`<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(txt)}</w:t></w:r>`);
    }
    return out.join('');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _isRtl(s) {
    return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(s||'');
  }
  function _isFormLike(text) {
    return /^[^:]{2,50}:\s*/.test(text||'') || /^[^.]{2,50}\.{4,}/.test(text||'') || /^[☐□☑✓✔☒]\s+/.test(text||'');
  }

  window.PDFPipeline.DocxEngine = { renderBlocks, _renderBlock, _runsXml };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[DocxEngine] v1.0 loaded');
  }
})();
