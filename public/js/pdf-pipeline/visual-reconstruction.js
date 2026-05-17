// visual-reconstruction.js — Visual Spacing & Alignment Engine
// Phase 2 of PDF→Word Fidelity Pipeline
// Enhances structure blocks with computed spacing, indentation, and alignment
// so DOCX output matches the original document's visual rhythm.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  /**
   * Enhance structure blocks with visual properties.
   * Analyses spacing patterns, indentation, and text alignment.
   *
   * @param {Array}  blocks  - structure blocks from buildStructure()
   * @param {Object} opts    - { basePt, pageWidth }
   * @returns {Array} blocks with added: spacingBefore, spacingAfter, lineSpacing,
   *                  alignment, indentLevel, indentTwips
   */
  function enhanceBlocks(blocks, opts) {
    opts = opts || {};
    const basePt    = opts.basePt    || 11;
    const pageWidth = opts.pageWidth || 612;
    if (!blocks || !blocks.length) return blocks;

    return blocks.map((block, i) => {
      const b    = Object.assign({}, block);
      const prev = blocks[i - 1];
      const next = blocks[i + 1];

      // Alignment
      if (!b.alignment) b.alignment = _inferAlignment(b, pageWidth);

      // Indentation
      if (!b.indentLevel) {
        b.indentLevel = _inferIndentLevel(b, pageWidth);
      }
      b.indentTwips = b.indentLevel * 720; // 0.5" per level

      // Spacing calibration
      b.spacingBefore = _spacingBefore(b, prev, basePt);
      b.spacingAfter  = _spacingAfter(b, next, basePt);

      // Line height
      b.lineSpacing = _lineSpacing(b);

      return b;
    });
  }

  // ── OOXML helpers ──────────────────────────────────────────────────────────

  function alignmentXml(alignment) {
    if (alignment === 'center')  return '<w:jc w:val="center"/>';
    if (alignment === 'right')   return '<w:jc w:val="right"/>';
    if (alignment === 'justify') return '<w:jc w:val="both"/>';
    return '';
  }

  function indentXml(twips) {
    if (!twips || twips <= 0) return '';
    return `<w:ind w:left="${twips}"/>`;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  function _inferAlignment(block, pageWidth) {
    const pw   = pageWidth || 612;
    const runs = block.runs || [];
    const xPos = block.xPositions;

    // Check first run or first xPosition
    const x0 = (runs.length && runs[0].x != null) ? runs[0].x
              : (xPos && xPos.length)              ? xPos[0]
              : null;

    if (x0 == null) return 'left';

    const centerTol  = pw * 0.10;
    const rightStart = pw * 0.82;

    if (Math.abs(x0 - pw / 2) < centerTol) return 'center';
    if (x0 > rightStart)                   return 'right';

    // Short centred headings are often truly centred even if x0 is slightly left
    if (['h1','h2'].includes(block.type) && x0 > pw * 0.15 && x0 < pw * 0.55) {
      const text   = block.text || '';
      const approxW = text.length * (block.fontSize || 11) * 0.6;
      const endX    = x0 + approxW;
      if (endX < pw * 0.90 && Math.abs(x0 + approxW / 2 - pw / 2) < pw * 0.12) return 'center';
    }

    return 'left';
  }

  function _inferIndentLevel(block, pageWidth) {
    if (!['p','list'].includes(block.type)) return 0;
    const xPos = block.xPositions;
    if (!xPos || !xPos.length) return 0;
    const x0  = xPos[0];
    const pct = x0 / (pageWidth || 612);
    if (pct < 0.06) return 0;
    if (pct < 0.12) return 1;
    if (pct < 0.20) return 2;
    return 3;
  }

  function _spacingBefore(block, prev, basePt) {
    const bt = basePt * 20; // 1pt = 20 twips
    const t  = block.type;
    const pt = prev ? prev.type : null;

    if (t === 'h1') return pt ? Math.round(bt * 1.8) : Math.round(bt * 0.5);
    if (t === 'h2') return pt ? Math.round(bt * 1.4) : Math.round(bt * 0.4);
    if (t === 'h3') return pt ? Math.round(bt * 1.0) : Math.round(bt * 0.3);

    // After any heading, tight gap before first content block
    if (pt === 'h1' || pt === 'h2' || pt === 'h3') return Math.round(bt * 0.25);

    if (t === 'table' || pt === 'table') return Math.round(bt * 0.5);

    // Consecutive same-type paragraphs: tight
    if (t === 'p' && pt === 'p') return Math.round(bt * 0.08);

    return Math.round(bt * 0.15);
  }

  function _spacingAfter(block, next, basePt) {
    const bt = basePt * 20;
    const t  = block.type;

    if (t === 'h1') return Math.round(bt * 0.45);
    if (t === 'h2') return Math.round(bt * 0.35);
    if (t === 'h3') return Math.round(bt * 0.28);
    if (t === 'p')  return Math.round(bt * 0.28);
    if (t === 'list') return Math.round(bt * 0.18);
    if (t === 'table') return Math.round(bt * 0.4);
    return Math.round(bt * 0.25);
  }

  function _lineSpacing(block) {
    // OOXML line values (240 = single-space, 276 ≈ 1.15×, 360 = 1.5×)
    switch (block.type) {
      case 'h1':    return 288;
      case 'h2':    return 264;
      case 'h3':    return 252;
      case 'list':  return 252;
      case 'table': return 240;
      default:      return 276; // body text at 1.15×
    }
  }

  window.PDFPipeline.VisualReconstruction = { enhanceBlocks, alignmentXml, indentXml };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[VisualReconstruction] v1.0 loaded');
  }
})();
