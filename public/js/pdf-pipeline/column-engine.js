// column-engine.js — Multi-Column Layout Detection Engine
// Phase 5 of PDF→Word Fidelity Pipeline
// Detects newspapers, brochures, academic 2–4-column layouts
// using vertical-river analysis (sustained whitespace runs across lines).
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  /**
   * Detect column layout from an array of text lines.
   * Each line must have { xPositions: number[], y: number, text: string }.
   *
   * Returns:
   *   { columnCount, columns: [{xMin,xMax,xMid,items}], rivers: number[], confidence: 0–1 }
   */
  function detectColumns(lines, pageWidth) {
    pageWidth = pageWidth || 612;
    const pw = pageWidth;
    const EMPTY = { columnCount: 1, columns: [{ xMin: 0, xMax: pw, xMid: pw / 2, items: lines || [] }], rivers: [], confidence: 1.0 };

    if (!lines || lines.length < 8) return EMPTY;

    const BUCKET = Math.max(2, Math.floor(pw / 200)); // ~3pt buckets
    const bucketCount = Math.ceil(pw / BUCKET);

    // Build X-occupancy map: for each bucket, count lines that have text there
    const occupancy = new Float32Array(bucketCount);
    for (const line of lines) {
      if (!line.xPositions || !line.xPositions.length) continue;
      // Mark the range from first to last X as occupied
      const x0 = Math.floor(line.xPositions[0] / BUCKET);
      const x1 = Math.min(bucketCount - 1, Math.floor((line.xPositions[line.xPositions.length - 1] || line.xPositions[0]) / BUCKET) + 2);
      for (let b = x0; b <= x1; b++) occupancy[b] += 1;
    }

    // Normalise to 0–1 occupancy ratio
    for (let b = 0; b < bucketCount; b++) occupancy[b] /= lines.length;

    // Find "rivers": contiguous runs of very-low occupancy that span the page vertically
    // A river must be ≥ 3% of page width and not at the page margins
    const MIN_RIVER_W    = Math.ceil(pw * 0.035 / BUCKET); // min river width in buckets
    const MARGIN_BUCKETS = Math.floor(pw * 0.06 / BUCKET); // ignore first/last 6%
    const THRESHOLD      = 0.12; // ≤12% of lines may have text in river zone

    const rivers = [];
    let start = -1;
    for (let b = MARGIN_BUCKETS; b < bucketCount - MARGIN_BUCKETS; b++) {
      if (occupancy[b] <= THRESHOLD) {
        if (start === -1) start = b;
      } else {
        if (start !== -1) {
          const width = b - start;
          if (width >= MIN_RIVER_W) {
            rivers.push({ b0: start, b1: b, center: (start + b) / 2 * BUCKET, width: width * BUCKET });
          }
          start = -1;
        }
      }
    }
    if (start !== -1 && (bucketCount - MARGIN_BUCKETS - start) >= MIN_RIVER_W) {
      rivers.push({ b0: start, b1: bucketCount - MARGIN_BUCKETS, center: (start + bucketCount - MARGIN_BUCKETS) / 2 * BUCKET, width: (bucketCount - MARGIN_BUCKETS - start) * BUCKET });
    }

    if (!rivers.length) return EMPTY;

    // Sort rivers by width (widest first = strongest)
    rivers.sort((a, b) => b.width - a.width);

    // Determine column count: keep top N rivers that are spread across the page
    const MAX_COLS = 4;
    const usedRivers = [];
    for (const r of rivers) {
      if (usedRivers.length >= MAX_COLS - 1) break;
      // Don't add two rivers that are too close to each other
      if (usedRivers.every(u => Math.abs(r.center - u.center) > pw * 0.15)) {
        usedRivers.push(r);
      }
    }
    if (!usedRivers.length) return EMPTY;

    usedRivers.sort((a, b) => a.center - b.center); // left→right
    const columnCount = usedRivers.length + 1;

    // Build column boundaries
    const bounds = [0, ...usedRivers.map(r => r.center), pw];
    const columns = [];
    for (let ci = 0; ci < columnCount; ci++) {
      columns.push({ xMin: bounds[ci], xMax: bounds[ci + 1], xMid: (bounds[ci] + bounds[ci + 1]) / 2, items: [] });
    }

    // Assign lines to columns
    for (const line of lines) {
      const x = (line.xPositions && line.xPositions[0]) != null ? line.xPositions[0] : 0;
      let assigned = false;
      for (const col of columns) {
        if (x >= col.xMin - BUCKET * 2 && x < col.xMax + BUCKET * 2) {
          col.items.push(line); assigned = true; break;
        }
      }
      if (!assigned) columns[0].items.push(line);
    }

    // Confidence: balanced column fill AND sufficient lines per column
    const counts    = columns.map(c => c.items.length);
    const total     = counts.reduce((s, v) => s + v, 0) || 1;
    const avg       = total / columnCount;
    const maxDev    = Math.max(...counts.map(c => Math.abs(c - avg)));
    const balance   = Math.max(0, 1 - (maxDev / (avg || 1)) * 0.6);
    const enoughLines = avg >= 4 ? 1 : avg / 4;
    const confidence  = Math.min(1, balance * enoughLines);

    if (confidence < 0.35 || columnCount < 2) return EMPTY;

    return { columnCount, columns, rivers: usedRivers.map(r => r.center), confidence };
  }

  /**
   * Convert a multi-column result into reading-order lines.
   * LTR: column[0] top→bottom, column[1] top→bottom, …
   * RTL: reversed order
   */
  function mergeColumnsToReadingOrder(columnResult, isRtl) {
    if (!columnResult || columnResult.columnCount <= 1) {
      return (columnResult && columnResult.columns[0] && columnResult.columns[0].items) || [];
    }
    const cols = isRtl ? [...columnResult.columns].reverse() : columnResult.columns;
    return cols.flatMap(c => c.items);
  }

  window.PDFPipeline.ColumnEngine = { detectColumns, mergeColumnsToReadingOrder };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[ColumnEngine] v1.0 loaded');
  }
})();
