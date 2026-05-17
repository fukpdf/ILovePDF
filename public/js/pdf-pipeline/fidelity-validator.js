// fidelity-validator.js — Multi-Stage DOCX Fidelity Validation
// Phase 10 of PDF→Word Fidelity Pipeline
// Validates layout integrity, triggers safe/OCR/simple fallback modes.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  /**
   * Validate a structure block array against the original source.
   *
   * @param {Array}  blocks           - structure blocks from buildStructure()
   * @param {number} pageCount        - original PDF page count
   * @param {number} originalCharCount - total non-whitespace chars from PDF.js
   * @returns {{ score:number, issues:string[], fallbackMode:null|'simple'|'safe'|'ocr' }}
   */
  function validateStructure(blocks, pageCount, originalCharCount) {
    if (!blocks || !blocks.length) {
      return { score: 0, issues: ['No structure blocks generated'], fallbackMode: 'ocr' };
    }

    const issues = [];
    let score    = 100;

    // ── Page coverage ─────────────────────────────────────────────────────────
    const pageBreaks = blocks.filter(b => b.type === 'pageBreak').length;
    if (pageCount > 1 && pageBreaks < pageCount - 1) {
      const missing = (pageCount - 1) - pageBreaks;
      issues.push(`${missing} page break(s) missing — possible content loss`);
      score -= Math.min(25, missing * 6);
    }

    // ── Text coverage ─────────────────────────────────────────────────────────
    const extractedChars = blocks.reduce((sum, b) => {
      if (b.type === 'table') {
        const rows = b.cellRows || b.rows || [];
        return sum + rows.flat().join('').replace(/\s/g, '').length;
      }
      return sum + (b.text || '').replace(/\s/g, '').length;
    }, 0);

    if (originalCharCount > 60) {
      const coverage = extractedChars / originalCharCount;
      if (coverage < 0.35) {
        issues.push(`Very low text coverage: ${Math.round(coverage * 100)}% (expected ≥35%)`);
        score -= 40;
      } else if (coverage < 0.60) {
        issues.push(`Low text coverage: ${Math.round(coverage * 100)}%`);
        score -= Math.round((0.60 - coverage) * 60);
      }
    }

    // ── Table integrity ───────────────────────────────────────────────────────
    const tables = blocks.filter(b => b.type === 'table');
    for (const tbl of tables) {
      const rows = tbl.cellRows || tbl.rows || [];
      if (rows.length === 0) { issues.push('Empty table block'); score -= 4; continue; }
      const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const empties = rows.filter(r => r.every(c => !c || !c.trim())).length;
      if (empties > rows.length * 0.4) { issues.push('Table has >40% empty rows'); score -= 3; }
      if (maxCols === 1) { issues.push('Table detected with only 1 column — possible mis-classification'); score -= 2; }
    }

    // ── Heading sanity ────────────────────────────────────────────────────────
    const h1s = blocks.filter(b => b.type === 'h1').length;
    const h2s = blocks.filter(b => b.type === 'h2').length;
    if (h1s > 20 && h1s > h2s * 4) {
      issues.push(`Over-sensitive heading detection (${h1s} H1s)`);
      score -= 6;
    }

    // ── Content density ───────────────────────────────────────────────────────
    const contentBlocks = blocks.filter(b => b.type !== 'pageBreak').length;
    if (contentBlocks < 1) { issues.push('No content blocks'); score -= 50; }
    else if (contentBlocks === 1 && blocks[0].type === 'p' && (blocks[0].text || '').length < 20) {
      issues.push('Only one very short paragraph — likely extraction failure');
      score -= 30;
    }

    // ── Determine fallback mode ───────────────────────────────────────────────
    let fallbackMode = null;
    if      (score < 30) fallbackMode = 'ocr';
    else if (score < 50) fallbackMode = 'safe';
    else if (score < 68) fallbackMode = 'simple';

    const finalScore = Math.max(0, Math.min(100, Math.round(score)));

    if (window.PDF_FIDELITY_DEBUG && issues.length) {
      console.group('[FidelityValidator] Issues found (score=' + finalScore + ')');
      issues.forEach(i => console.warn('  •', i));
      if (fallbackMode) console.warn('  → Recommends fallback:', fallbackMode);
      console.groupEnd();
    }

    return { score: finalScore, issues, fallbackMode };
  }

  /**
   * Quick structural validation of a DOCX ZIP blob.
   * Returns { valid: boolean, reason?: string }
   */
  async function validateDocx(zipBlob) {
    try {
      if (!zipBlob || zipBlob.size < 900)  return { valid: false, reason: 'DOCX too small — likely empty' };
      if (zipBlob.size > 120 * 1024 * 1024) return { valid: false, reason: 'DOCX exceeds 120 MB — encoding error' };
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  }

  window.PDFPipeline.FidelityValidator = { validateStructure, validateDocx };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[FidelityValidator] v1.0 loaded');
  }
})();
