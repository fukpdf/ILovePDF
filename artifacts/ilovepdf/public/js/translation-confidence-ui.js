/**
 * PHASE 42C — TRANSLATION + OCR CONFIDENCE UI
 * window.TranslationConfidenceUI
 *
 * Purely additive overlay system. Non-destructive.
 * Renders confidence visuals as an overlay layer on top of existing UI.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[TCU]', ...a); }

  // ─────────────────────────────────────────────────────────────
  // Stylesheet injection
  // ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tcu-styles')) return;
    const style = document.createElement('style');
    style.id = 'tcu-styles';
    style.textContent = `
      .tcu-overlay { position:absolute; inset:0; pointer-events:none; z-index:900; }
      .tcu-badge { display:inline-flex; align-items:center; gap:4px; border-radius:4px; padding:2px 6px; font:700 10px/14px monospace; color:#fff; cursor:default; pointer-events:auto; }
      .tcu-badge--high   { background:#16a34a; }
      .tcu-badge--medium { background:#ca8a04; }
      .tcu-badge--low    { background:#dc2626; }
      .tcu-badge--repair { background:#7c3aed; }
      .tcu-badge--retry  { background:#0284c7; }
      .tcu-badge--gpu    { background:#0891b2; }
      .tcu-heatmap-cell  { position:absolute; opacity:.25; border-radius:2px; pointer-events:none; transition:opacity .3s; }
      .tcu-heatmap-cell--high   { background:#16a34a; }
      .tcu-heatmap-cell--medium { background:#ca8a04; }
      .tcu-heatmap-cell--low    { background:#dc2626; }
      .tcu-panel { background:#1e1e2e; color:#cdd6f4; border-radius:8px; padding:12px; font:13px/1.5 system-ui,sans-serif; box-shadow:0 4px 24px rgba(0,0,0,.4); max-width:360px; }
      .tcu-panel h4 { margin:0 0 8px; font-size:13px; color:#89b4fa; text-transform:uppercase; letter-spacing:.05em; }
      .tcu-meter { height:6px; border-radius:3px; background:#313244; overflow:hidden; margin:2px 0 6px; }
      .tcu-meter-fill { height:100%; border-radius:3px; transition:width .4s; }
      .tcu-retry-btn { margin:4px 2px 0; padding:4px 10px; border:none; border-radius:4px; background:#313244; color:#cdd6f4; font:12px system-ui; cursor:pointer; pointer-events:auto; }
      .tcu-retry-btn:hover { background:#45475a; }
      .tcu-report { font-size:11px; line-height:1.6; }
      .tcu-report dt { color:#89b4fa; float:left; clear:left; width:140px; }
      .tcu-report dd { margin:0 0 2px 145px; }
    `;
    document.head.appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  function confLevel(v) {
    if (v >= 0.75) return 'high';
    if (v >= 0.45) return 'medium';
    return 'low';
  }

  function confColor(v) {
    if (v >= 0.75) return '#16a34a';
    if (v >= 0.45) return '#ca8a04';
    return '#dc2626';
  }

  function pct(v) { return `${Math.round(v * 100)}%`; }

  // ─────────────────────────────────────────────────────────────
  // 1. ConfidenceOverlay — per-page confidence badges
  // ─────────────────────────────────────────────────────────────
  const ConfidenceOverlay = (() => {
    const panels = new Map(); // containerId → element

    function render(containerId, pageData) {
      injectStyles();
      const container = document.getElementById(containerId) || document.querySelector(containerId);
      if (!container) { log('container not found:', containerId); return; }
      container.style.position = 'relative';

      // Remove previous overlay
      container.querySelector('.tcu-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'tcu-overlay';

      const panel = document.createElement('div');
      panel.className = 'tcu-panel';
      panel.style.cssText = 'position:absolute;top:8px;right:8px;width:220px;';

      panel.innerHTML = `
        <h4>Page Confidence</h4>
        ${_meter('OCR',         pageData.ocrConfidence         ?? 0)}
        ${_meter('Translation', pageData.translationConfidence ?? 0)}
        ${_meter('Layout',      pageData.layoutConfidence      ?? 0)}
        ${_meter('Repair',      pageData.repairConfidence      ?? 0)}
      `;

      overlay.appendChild(panel);
      container.appendChild(overlay);
      panels.set(containerId, panel);
    }

    function _meter(label, value) {
      return `
        <div style="font-size:11px;color:#a6e3a1;">${label}: <b>${pct(value)}</b></div>
        <div class="tcu-meter"><div class="tcu-meter-fill" style="width:${pct(value)};background:${confColor(value)};"></div></div>
      `;
    }

    function update(containerId, pageData) { render(containerId, pageData); }
    function remove(containerId) { panels.get(containerId)?.closest('.tcu-overlay')?.remove(); panels.delete(containerId); }

    return { render, update, remove };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. ChunkStatusBadges
  // ─────────────────────────────────────────────────────────────
  const ChunkStatusBadges = (() => {
    function render(container, chunks) {
      injectStyles();
      const wrap = typeof container === 'string' ? document.querySelector(container) : container;
      if (!wrap) return;
      wrap.querySelectorAll('.tcu-chunk-badges').forEach(el => el.remove());

      const badgeWrap = document.createElement('div');
      badgeWrap.className = 'tcu-chunk-badges';
      badgeWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:6px 0;';

      for (const chunk of (chunks || [])) {
        const badge = document.createElement('span');
        const type  = _badgeType(chunk);
        badge.className = `tcu-badge tcu-badge--${type}`;
        badge.title     = `Chunk ${chunk.index}: ${chunk.status} (conf ${pct(chunk.confidence||0)})`;
        badge.textContent = `#${chunk.index} ${_label(type)}`;
        badgeWrap.appendChild(badge);
      }

      wrap.appendChild(badgeWrap);
    }

    function _badgeType(chunk) {
      if (chunk.repaired)        return 'repair';
      if (chunk.retried)         return 'retry';
      if (chunk.gpuEnhanced)     return 'gpu';
      return confLevel(chunk.confidence || 0);
    }

    function _label(type) {
      return { repair:'✦ repaired', retry:'↺ retried', gpu:'⚡ GPU', high:'✓', medium:'~', low:'✗' }[type] || type;
    }

    return { render };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. TranslationHeatmap
  // ─────────────────────────────────────────────────────────────
  const TranslationHeatmap = (() => {
    function render(container, heatmapData, pageW, pageH) {
      injectStyles();
      const wrap = typeof container === 'string' ? document.querySelector(container) : container;
      if (!wrap) return;
      wrap.querySelectorAll('.tcu-heatmap-cell').forEach(el => el.remove());

      const scaleX = wrap.offsetWidth  / (pageW || wrap.offsetWidth);
      const scaleY = wrap.offsetHeight / (pageH || wrap.offsetHeight);

      for (const cell of (heatmapData || [])) {
        const div = document.createElement('div');
        const lvl = confLevel(cell.confidence);
        div.className = `tcu-heatmap-cell tcu-heatmap-cell--${lvl}`;
        div.style.cssText = `left:${cell.x*scaleX}px;top:${cell.y*scaleY}px;width:${cell.w*scaleX}px;height:${cell.h*scaleY}px;`;
        div.title = `${pct(cell.confidence)} confidence`;
        wrap.appendChild(div);
      }
    }

    /** Build heatmap data from translation chunk results */
    function fromChunks(chunks, pageH) {
      const rowH = pageH / Math.max(chunks.length, 1);
      return chunks.map((c, i) => ({
        x: 0, y: i * rowH, w: 9999, h: rowH,
        confidence: c.confidence ?? 0.5,
      }));
    }

    return { render, fromChunks };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. SmartRetrySuggestions
  // ─────────────────────────────────────────────────────────────
  const SmartRetrySuggestions = (() => {
    function suggest({ ocrConfidence, translationConfidence, pageCount, hasHandwriting, hasTable }) {
      const suggestions = [];

      if ((ocrConfidence ?? 1) < 0.5) {
        suggestions.push({ id: 'rerun-ocr', label: 'Rerun OCR with higher scale', severity: 'high' });
        if (hasHandwriting) suggestions.push({ id: 'hw-mode', label: 'Enable handwriting OCR mode', severity: 'high' });
      }
      if ((ocrConfidence ?? 1) < 0.7) {
        suggestions.push({ id: 'switch-ocr', label: 'Switch to aggressive OCR mode', severity: 'medium' });
      }
      if ((translationConfidence ?? 1) < 0.5) {
        suggestions.push({ id: 'retranslate', label: 'Retry translation with ONNX model', severity: 'high' });
      }
      if (pageCount > 50) {
        suggestions.push({ id: 'split', label: 'Split into smaller chunks for better accuracy', severity: 'low' });
      }
      if (hasTable) {
        suggestions.push({ id: 'table-mode', label: 'Enable AI table extraction mode', severity: 'medium' });
      }

      return suggestions;
    }

    function renderSuggestions(container, suggestions, onRetry) {
      injectStyles();
      const wrap = typeof container === 'string' ? document.querySelector(container) : container;
      if (!wrap) return;
      wrap.querySelectorAll('.tcu-suggestions').forEach(el => el.remove());

      if (!suggestions?.length) return;

      const panel = document.createElement('div');
      panel.className = 'tcu-suggestions tcu-panel';
      panel.innerHTML = `<h4>Smart Suggestions</h4>`;

      for (const s of suggestions) {
        const btn = document.createElement('button');
        btn.className = 'tcu-retry-btn';
        btn.textContent = `${s.severity === 'high' ? '⚠ ' : ''}${s.label}`;
        btn.onclick = () => onRetry?.(s.id, s);
        panel.appendChild(btn);
      }

      wrap.appendChild(panel);
    }

    return { suggest, renderSuggestions };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. ExportQualityReport
  // ─────────────────────────────────────────────────────────────
  const ExportQualityReport = (() => {
    function generate(jobData) {
      const pages = jobData.pages || [];
      const ocrConfs   = pages.map(p => p.ocrConfidence   ?? 0.5);
      const transConfs = pages.map(p => p.translationConfidence ?? 0.5);
      const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

      return {
        summary: {
          totalPages: pages.length,
          avgOcrConfidence: avg(ocrConfs),
          avgTranslationConfidence: avg(transConfs),
          failedPages: pages.filter(p => (p.ocrConfidence??1) < 0.3).length,
          repairedPages: pages.filter(p => p.repaired).length,
          lowConfidencePages: pages.filter(p => (p.ocrConfidence??1) < 0.6).length,
        },
        pages: pages.map((p, i) => ({
          page: i + 1,
          ocrConf: p.ocrConfidence ?? null,
          transConf: p.translationConfidence ?? null,
          repaired: p.repaired || false,
          status: (p.ocrConfidence ?? 1) < 0.3 ? 'failed' : (p.ocrConfidence ?? 1) < 0.6 ? 'low' : 'ok',
        })),
        generated: new Date().toISOString(),
      };
    }

    function renderReport(container, report) {
      injectStyles();
      const wrap = typeof container === 'string' ? document.querySelector(container) : container;
      if (!wrap) return;
      const s = report.summary;
      const panel = document.createElement('div');
      panel.className = 'tcu-panel tcu-report-panel';
      panel.innerHTML = `
        <h4>Quality Report</h4>
        <dl class="tcu-report">
          <dt>Total Pages</dt><dd>${s.totalPages}</dd>
          <dt>Avg OCR Confidence</dt><dd>${pct(s.avgOcrConfidence)}</dd>
          <dt>Avg Translation Conf.</dt><dd>${pct(s.avgTranslationConfidence)}</dd>
          <dt>Failed Pages</dt><dd>${s.failedPages}</dd>
          <dt>Repaired Pages</dt><dd>${s.repairedPages}</dd>
          <dt>Low Confidence</dt><dd>${s.lowConfidencePages}</dd>
          <dt>Generated</dt><dd>${report.generated}</dd>
        </dl>
      `;
      wrap.appendChild(panel);
    }

    function toJSON(report) { return JSON.stringify(report, null, 2); }

    return { generate, renderReport, toJSON };
  })();

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const TranslationConfidenceUI = {
    version: '42c.1.0',
    ConfidenceOverlay,
    ChunkStatusBadges,
    TranslationHeatmap,
    SmartRetrySuggestions,
    ExportQualityReport,

    /** One-shot: render all confidence UI into a container */
    renderAll(containerId, data) {
      injectStyles();
      ConfidenceOverlay.render(containerId, data);
      if (data.chunks) ChunkStatusBadges.render(containerId, data.chunks);
      if (data.heatmap) TranslationHeatmap.render(containerId, data.heatmap);
      const suggestions = SmartRetrySuggestions.suggest(data);
      if (suggestions.length) SmartRetrySuggestions.renderSuggestions(containerId, suggestions, data.onRetry);
    },

    generateReport: ExportQualityReport.generate,
    renderReport: ExportQualityReport.renderReport,

    status() { return { available: true, stylesInjected: !!document.getElementById('tcu-styles') }; },
  };

  window.TranslationConfidenceUI = TranslationConfidenceUI;
  log('Phase 42C ready');
})();
