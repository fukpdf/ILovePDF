// ocr-zoning.js — Zone-Aware OCR Engine
// Phase 3 of PDF→Word Fidelity Pipeline
// Splits scanned pages into semantic zones (header, body, table, footer, sidebar)
// and applies per-zone Tesseract PSM modes for higher accuracy.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  /**
   * Detect text zones in a rendered page canvas using pixel-density analysis.
   * Returns an array of zone objects: { x, y, w, h, type }.
   * type: 'header' | 'footer' | 'body' | 'table' | 'sidebar'
   */
  function detectTextZones(canvas, scale) {
    scale = scale || 1;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return [{ x: 0, y: 0, w: W, h: H, type: 'body' }];

    let pixelData;
    try {
      const ctx = canvas.getContext('2d');
      pixelData = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      return [{ x: 0, y: 0, w: W, h: H, type: 'body' }];
    }

    // Build row-level dark-pixel density (0–1)
    const SAMPLE_STEP = Math.max(1, Math.floor(W / 300)); // sample every ~2px col
    const rowDensity  = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let dark = 0, total = 0;
      for (let x = 0; x < W; x += SAMPLE_STEP) {
        const i   = (y * W + x) * 4;
        const lum = 0.299 * pixelData[i] + 0.587 * pixelData[i + 1] + 0.114 * pixelData[i + 2];
        if (lum < 200) dark++;
        total++;
      }
      rowDensity[y] = total > 0 ? dark / total : 0;
    }

    // Smooth density with a 5-row moving average
    const smoothed = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let sum = 0, cnt = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ry = y + dy;
        if (ry >= 0 && ry < H) { sum += rowDensity[ry]; cnt++; }
      }
      smoothed[y] = cnt > 0 ? sum / cnt : 0;
    }

    // Segment into zones: runs where smoothed density > threshold
    const THRESHOLD = 0.007; // 0.7% dark pixels
    const MIN_ZONE_H = Math.max(4, Math.floor(H * 0.008));
    const zones = [];
    let zStart = -1;

    for (let y = 0; y <= H; y++) {
      const active = y < H && smoothed[y] > THRESHOLD;
      if (active && zStart === -1) { zStart = y; }
      else if (!active && zStart !== -1) {
        const zH = y - zStart;
        if (zH >= MIN_ZONE_H) {
          const yRel = zStart / H;
          const type = yRel < 0.09 ? 'header'
                     : yRel > 0.91 ? 'footer'
                     : _isTableZone(pixelData, W, H, zStart, y) ? 'table'
                     : 'body';
          zones.push({ x: 0, y: zStart, w: W, h: zH, type });
        }
        zStart = -1;
      }
    }

    // Fallback: if no zones found, treat whole page as body
    if (!zones.length) return [{ x: 0, y: 0, w: W, h: H, type: 'body' }];

    // Merge adjacent body zones separated by very small gaps
    const merged = [zones[0]];
    for (let i = 1; i < zones.length; i++) {
      const prev = merged[merged.length - 1];
      const gap  = zones[i].y - (prev.y + prev.h);
      if (gap < MIN_ZONE_H * 2 && prev.type === zones[i].type) {
        prev.h = zones[i].y + zones[i].h - prev.y;
      } else {
        merged.push(zones[i]);
      }
    }

    return merged;
  }

  /** Heuristic: does this zone look like a table (many vertical lines)? */
  function _isTableZone(pixelData, W, H, y0, y1) {
    const zH = y1 - y0;
    if (zH < 20) return false;
    const STEP = Math.max(1, Math.floor(W / 100));
    let vertLines = 0;
    for (let x = STEP; x < W - STEP; x += STEP) {
      let run = 0, maxRun = 0;
      for (let y = y0; y < y1; y++) {
        const i   = (y * W + x) * 4;
        const lum = 0.299 * pixelData[i] + 0.587 * pixelData[i + 1] + 0.114 * pixelData[i + 2];
        if (lum < 120) { run++; maxRun = Math.max(maxRun, run); }
        else run = 0;
      }
      if (maxRun > zH * 0.55) vertLines++;
    }
    return vertLines >= 3;
  }

  /**
   * Crop a sub-canvas from a source canvas for a zone.
   */
  function extractZoneCanvas(src, zone) {
    try {
      const c   = document.createElement('canvas');
      c.width   = zone.w;
      c.height  = zone.h;
      c.getContext('2d').drawImage(src, zone.x, zone.y, zone.w, zone.h, 0, 0, zone.w, zone.h);
      return c;
    } catch (_) { return null; }
  }

  /**
   * Group raw Tesseract word results into line objects compatible with
   * the existing groupIntoLines() output format.
   *
   * @param {Array}  words     - Tesseract word objects with bbox + text + confidence
   * @param {number} scale     - render scale used (to convert px → pts)
   * @param {number} pageWidth - PDF page width in pts
   * @param {number} pageHeight - PDF page height in pts
   * @param {Object} zone      - { x, y, w, h } of the source zone (in canvas px)
   */
  function groupOcrWordsIntoLines(words, scale, pageWidth, pageHeight, zone) {
    if (!words || !words.length) return [];
    const sc  = scale || 2;
    const zo  = zone || { x: 0, y: 0 };

    // Convert bbox → PDF coordinate space (flip Y axis)
    const pts = words
      .filter(w => w.text && w.text.trim() && w.confidence > 22)
      .map(w => ({
        text:   w.text.trim(),
        x:      (zo.x + w.bbox.x0) / sc,
        y:      pageHeight - (zo.y + w.bbox.y1) / sc,
        h:      Math.max(1, (w.bbox.y1 - w.bbox.y0) / sc),
        conf:   w.confidence / 100,
      }));

    if (!pts.length) return [];

    // Adaptive Y-bucket
    const hs  = pts.map(p => p.h).filter(h => h > 0).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || 8;
    const BKT  = Math.max(2, Math.round(medH * 0.45));

    const bkts = {};
    for (const p of pts) {
      const k = Math.round(p.y / BKT) * BKT;
      if (!bkts[k]) bkts[k] = { y: p.y, items: [] };
      bkts[k].items.push(p);
    }

    return Object.values(bkts)
      .sort((a, b) => b.y - a.y)
      .map(bkt => {
        const sorted = bkt.items.sort((a, b) => a.x - b.x);
        const text   = sorted.map(p => p.text).join(' ').trim();
        const avgConf = sorted.reduce((s, p) => s + p.conf, 0) / sorted.length;
        return {
          text,
          runs:        sorted.map(p => ({ text: p.text, x: p.x, y: p.y, fontSize: p.h, bold: false, italic: false, mono: false, width: 0, fontName: '' })),
          xPositions:  sorted.map(p => p.x),
          fontSize:    sorted[0].h || 10,
          y:           bkt.y,
          pageWidth,
          ocrConfidence: avgConf,
        };
      })
      .filter(l => l.text.length > 0);
  }

  window.PDFPipeline.OcrZoning = { detectTextZones, extractZoneCanvas, groupOcrWordsIntoLines };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[OcrZoning] v1.0 loaded');
  }
})();
