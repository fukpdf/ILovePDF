// fidelity-debug.js — PDF Fidelity Debug System
// Phase 12 of PDF→Word Fidelity Pipeline
// Activated by: window.PDF_FIDELITY_DEBUG = true  (before page load)
// Shows: pipeline chosen, OCR zones, columns, tables, reconstruction stages,
//        fallback reasons, confidence scores, validation failures.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  // Capture the flag state at load time
  const ENABLED = !!(window.PDF_FIDELITY_DEBUG);

  if (!ENABLED) {
    // Lightweight no-op stubs so callers don't need to guard every call
    window.PDFFidelityDebug = {
      start:          () => {},
      stage:          () => {},
      logPage:        () => {},
      logTables:      () => {},
      logColumns:     () => {},
      logOcrZones:    () => {},
      logValidation:  () => {},
      logFallback:    () => {},
      finish:         () => {},
      panel:          () => null,
    };
    return;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    sessionId:  Date.now(),
    startTime:  0,
    pipeline:   'unknown',
    stages:     [],
    pages:      [],
    validation: null,
    fallback:   null,
    modules:    [],
  };

  // ── Core API ───────────────────────────────────────────────────────────────

  function start(fileName, pipelineMode) {
    state.startTime = performance.now();
    state.pipeline  = pipelineMode || 'enhanced';
    state.stages    = [];
    state.pages     = [];
    state.validation= null;
    state.fallback  = null;

    const mods = [];
    const FP   = window.PDFPipeline || {};
    if (FP.FontMapper)          mods.push('FontMapper');
    if (FP.ColumnEngine)        mods.push('ColumnEngine');
    if (FP.FormReconstruction)  mods.push('FormReconstruction');
    if (FP.LayoutGraph)         mods.push('LayoutGraph');
    if (FP.VisualReconstruction)mods.push('VisualReconstruction');
    if (FP.DocxEngine)          mods.push('DocxEngine');
    if (FP.OcrZoning)           mods.push('OcrZoning');
    if (FP.ImageAnchor)         mods.push('ImageAnchor');
    if (FP.FidelityValidator)   mods.push('FidelityValidator');
    state.modules = mods;

    console.group(
      `%c[PDF Fidelity Debug] %c${fileName || 'unknown'}`,
      'color:#7C3AED;font-weight:bold',
      'color:#374151'
    );
    console.log(`Pipeline: %c${state.pipeline}`, 'color:#059669;font-weight:bold');
    console.log(`Modules loaded: %c${mods.join(', ') || 'none'}`, 'color:#2563EB');
  }

  function stage(name, detail) {
    const t = Math.round(performance.now() - state.startTime);
    state.stages.push({ name, detail, t });
    console.log(`%c  ▸ ${name}%c +${t}ms`, 'color:#6D28D9', 'color:#9CA3AF', detail || '');
  }

  function logPage(pageNum, info) {
    state.pages.push({ pageNum, ...info });
    const parts = [
      `p${pageNum}:`,
      info.charCount != null ? `chars=${info.charCount}` : '',
      info.needsOcr  ? 'OCR' : 'digital',
      info.tables    != null ? `tables=${info.tables}` : '',
      info.columns   != null ? `cols=${info.columns}` : '',
    ].filter(Boolean).join(' ');
    console.log(`%c  📄 ${parts}`, 'color:#374151');
  }

  function logTables(pageNum, tables) {
    if (!tables || !tables.length) return;
    console.group(`%c  📊 Page ${pageNum}: ${tables.length} table(s) detected`, 'color:#B45309');
    tables.forEach((t, i) => {
      console.log(`    Table ${i+1}: ${t.rows ? t.rows.length : '?'}r × ${t.colCount || '?'}c${t.isForm ? ' [FORM]' : ''} yStart=${Math.round(t.yStart||0)}`);
    });
    console.groupEnd();
  }

  function logColumns(pageNum, colResult) {
    if (!colResult || colResult.columnCount <= 1) return;
    console.log(
      `%c  📰 Page ${pageNum}: ${colResult.columnCount}-column layout detected (confidence=${(colResult.confidence*100).toFixed(0)}%)`,
      'color:#0369A1'
    );
  }

  function logOcrZones(pageNum, zones) {
    if (!zones || !zones.length) return;
    console.group(`%c  🔍 Page ${pageNum}: ${zones.length} OCR zone(s)`, 'color:#7C3AED');
    zones.forEach(z => console.log(`    ${z.type} y=${z.y} h=${z.h}`));
    console.groupEnd();
  }

  function logValidation(result) {
    state.validation = result;
    const col = result.score >= 80 ? '#059669' : result.score >= 55 ? '#D97706' : '#DC2626';
    console.group(`%c  ✅ Fidelity score: ${result.score}/100`, `color:${col};font-weight:bold`);
    if (result.issues && result.issues.length) {
      result.issues.forEach(iss => console.warn('    ⚠', iss));
    }
    if (result.fallbackMode) console.warn(`    → Fallback recommended: ${result.fallbackMode}`);
    console.groupEnd();
  }

  function logFallback(reason, mode) {
    state.fallback = { reason, mode };
    console.warn(`%c  ↩ Fallback triggered: ${mode} — ${reason}`, 'color:#DC2626');
  }

  function finish(docxSizeBytes) {
    const elapsed = Math.round(performance.now() - state.startTime);
    console.log(
      `%c[PDF Fidelity Debug] Done in ${elapsed}ms | DOCX: ${_fmt(docxSizeBytes)}`,
      'color:#7C3AED;font-weight:bold'
    );
    console.groupEnd();

    // Store last session on window for post-hoc inspection
    window._pdfFidelityLastSession = { ...state, elapsed, docxSizeBytes };
  }

  /** Attach a floating debug panel to the page DOM (call after conversion) */
  function panel() {
    try {
      const existing = document.getElementById('_pdf-fidelity-panel');
      if (existing) existing.remove();

      const sess = window._pdfFidelityLastSession || state;
      const scoreColor = !sess.validation ? '#6B7280'
        : sess.validation.score >= 80 ? '#059669'
        : sess.validation.score >= 55 ? '#D97706' : '#DC2626';

      const el = document.createElement('div');
      el.id = '_pdf-fidelity-panel';
      el.style.cssText = [
        'position:fixed;bottom:16px;right:16px;z-index:99999',
        'background:#1F2937;color:#F9FAFB;font-family:monospace;font-size:11px',
        'padding:12px 14px;border-radius:8px;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,.5)',
        'border:1px solid #374151;line-height:1.5',
      ].join(';');

      const score = sess.validation ? sess.validation.score : '—';
      const mods  = (sess.modules || []).join(', ') || 'none';
      const pages = (sess.pages || []).map(p => `p${p.pageNum}:${p.needsOcr?'OCR':'dig'}`).join(' ');
      const issues = sess.validation && sess.validation.issues.length
        ? sess.validation.issues.map(i => `<li style="color:#FCA5A5">⚠ ${i}</li>`).join('')
        : '<li style="color:#6EE7B7">✓ No issues</li>';

      el.innerHTML = `
        <div style="font-weight:bold;color:#A78BFA;margin-bottom:6px">PDF Fidelity Debug</div>
        <div>Pipeline: <b style="color:#34D399">${sess.pipeline||'?'}</b></div>
        <div>Score: <b style="color:${scoreColor}">${score}/100</b>${sess.fallback?` &nbsp;<span style="color:#F87171">↩ ${sess.fallback.mode}</span>`:''}</div>
        <div>Modules: <span style="color:#93C5FD">${mods}</span></div>
        <div>Pages: <span style="color:#D1D5DB">${pages||'—'}</span></div>
        <ul style="margin:4px 0 0 12px;padding:0">${issues}</ul>
        <div style="margin-top:6px;text-align:right">
          <button onclick="document.getElementById('_pdf-fidelity-panel').remove()" style="background:#374151;color:#F9FAFB;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:10px">close</button>
        </div>`;
      document.body.appendChild(el);
      return el;
    } catch (_) { return null; }
  }

  function _fmt(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(2) + 'MB';
  }

  const API = { start, stage, logPage, logTables, logColumns, logOcrZones, logValidation, logFallback, finish, panel };
  window.PDFFidelityDebug = API;
  window.PDFPipeline.Debug = API;

  console.log('%c[PDFFidelityDebug] v1.0 active — window.PDF_FIDELITY_DEBUG = true', 'color:#7C3AED;font-weight:bold');
})();
