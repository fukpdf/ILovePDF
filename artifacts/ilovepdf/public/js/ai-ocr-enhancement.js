/**
 * PHASE 42B — AI OCR ENHANCEMENT ENGINE
 * window.AiOcrEnhancement
 *
 * Purely additive. Wraps / extends existing OCR systems.
 * Degrades gracefully when dependencies are absent.
 */
(function () {
  'use strict';

  function log(...a)  { console.log('[AOE]', ...a); }
  function warn(...a) { console.warn('[AOE]', ...a); }

  // ─────────────────────────────────────────────────────────────
  // 1. LayoutDetectionEngine
  // ─────────────────────────────────────────────────────────────
  const LayoutDetectionEngine = (() => {
    const REGION_TYPES = ['heading','paragraph','table','column','footnote','form','signature','stamp','figure','page-number'];

    /**
     * Analyse a canvas ImageData or raw image to produce layout regions.
     * Falls back to heuristic line-density analysis when no model is present.
     */
    async function detectRegions(imageData, pageWidth, pageHeight) {
      const regions = [];

      if (!imageData) return regions;

      const { data, width, height } = imageData;
      const rowDensity = [];

      // Row-density pass: count non-white pixels per row
      for (let y = 0; y < height; y++) {
        let dark = 0;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
          if (lum < 200) dark++;
        }
        rowDensity.push(dark / width);
      }

      // Find text bands (density > threshold)
      const THR = 0.03;
      let inBand = false, bandStart = 0;
      for (let y = 0; y <= height; y++) {
        const dense = y < height && rowDensity[y] > THR;
        if (dense && !inBand) { inBand = true; bandStart = y; }
        if (!dense && inBand) {
          inBand = false;
          const bandH = y - bandStart;
          if (bandH < 5) continue;
          // Classify band by height / density ratio
          const avgDensity = rowDensity.slice(bandStart, y).reduce((s,v)=>s+v,0) / bandH;
          let type = 'paragraph';
          if (bandH < height * 0.03 && avgDensity > 0.1) type = 'heading';
          else if (avgDensity > 0.15 && bandH > height * 0.1) type = 'table';
          else if (bandStart > height * 0.9) type = 'footnote';
          regions.push({
            type,
            x: 0, y: bandStart,
            w: width, h: bandH,
            confidence: Math.min(0.6 + avgDensity, 0.95),
          });
        }
      }

      return regions;
    }

    /** Detect column layout (1-col, 2-col, 3-col) */
    function detectColumns(imageData) {
      if (!imageData) return { columns: 1, confidence: 0 };
      const { data, width, height } = imageData;
      const colDensity = new Array(width).fill(0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
          if (lum < 180) colDensity[x]++;
        }
      }
      // Normalize
      const max = Math.max(...colDensity) || 1;
      const norm = colDensity.map(v => v / max);
      // Count deep valleys in the middle third
      const mid = norm.slice(Math.floor(width*0.1), Math.floor(width*0.9));
      const valleys = mid.filter(v => v < 0.05).length;
      const columns = valleys > width * 0.15 ? 2 : valleys > width * 0.3 ? 3 : 1;
      return { columns, confidence: 0.7 };
    }

    /** Detect form-like structure */
    function detectForms(regions) {
      const formLike = regions.filter(r => r.type === 'paragraph').length;
      return { hasForm: formLike > 3, confidence: formLike > 3 ? 0.65 : 0.3 };
    }

    return { detectRegions, detectColumns, detectForms, REGION_TYPES };
  })();

  // ─────────────────────────────────────────────────────────────
  // 2. HandwritingDetector
  // ─────────────────────────────────────────────────────────────
  const HandwritingDetector = (() => {
    /**
     * Heuristic handwriting detection based on stroke irregularity.
     * Real models would use ONNX classifier — gracefully stubs here.
     */
    function detectHandwriting(imageData) {
      if (!imageData) return { hasHandwriting: false, confidence: 0 };
      const { data, width, height } = imageData;

      // Measure horizontal stroke irregularity (variance in run-lengths)
      let runLengths = [];
      for (let y = 0; y < Math.min(height, 200); y += 5) {
        let run = 0, inDark = false;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
          const dark = lum < 150;
          if (dark && !inDark) { inDark = true; run = 1; }
          else if (dark && inDark) run++;
          else if (!dark && inDark) { runLengths.push(run); inDark = false; }
        }
      }

      if (runLengths.length < 5) return { hasHandwriting: false, confidence: 0.3 };
      const mean = runLengths.reduce((a,b)=>a+b,0) / runLengths.length;
      const variance = runLengths.reduce((s,v)=>s+(v-mean)**2,0) / runLengths.length;
      const cv = Math.sqrt(variance) / mean; // coefficient of variation

      // Handwriting tends to have high variation
      const hasHandwriting = cv > 1.5;
      return { hasHandwriting, cv, confidence: Math.min(0.4 + cv * 0.2, 0.9) };
    }

    function detectSignature(region) {
      // Signatures are typically narrow bands with high variation and low density
      return {
        isSignature: region?.type === 'signature' || (region?.h < 80 && region?.confidence > 0.5),
        confidence: 0.6,
      };
    }

    function detectAnnotations(regions) {
      return regions.filter(r => r.type === 'paragraph' && r.w < 200);
    }

    return { detectHandwriting, detectSignature, detectAnnotations };
  })();

  // ─────────────────────────────────────────────────────────────
  // 3. SmartDocumentClassifier
  // ─────────────────────────────────────────────────────────────
  const SmartDocumentClassifier = (() => {
    const CLASSES = ['invoice','receipt','form','book','contract','newspaper','academic','scanned','multilingual'];

    function classify(text, layoutRegions, hwResult) {
      const lower = (text || '').toLowerCase();
      const scores = {};

      const keywords = {
        invoice:     ['invoice','bill to','amount due','tax','subtotal','total','payment'],
        receipt:     ['receipt','thank you','change','cash','card','store','qty'],
        form:        ['name:','date:','signature','address:','please fill'],
        book:        ['chapter','page','index','contents','bibliography','isbn'],
        contract:    ['agreement','party','clause','whereas','herein','jurisdiction'],
        newspaper:   ['headline','correspondent','edition','journalist','press'],
        academic:    ['abstract','introduction','references','doi','methodology','conclusions'],
        scanned:     [],
        multilingual:[],
      };

      for (const cls of CLASSES) {
        const kw = keywords[cls] || [];
        const hits = kw.filter(k => lower.includes(k)).length;
        scores[cls] = kw.length ? hits / kw.length : 0;
      }

      // Table-heavy → invoice/form boost
      const tableCount = (layoutRegions||[]).filter(r=>r.type==='table').length;
      if (tableCount > 2) { scores.invoice = Math.max(scores.invoice, 0.4); scores.form = Math.max(scores.form, 0.35); }

      // Handwriting boost → form/receipt
      if (hwResult?.hasHandwriting) {
        scores.form   = Math.max(scores.form, 0.5);
        scores.receipt= Math.max(scores.receipt, 0.4);
      }

      const best = CLASSES.reduce((a,b) => scores[a]>=scores[b]?a:b);
      return { type: best, scores, confidence: Math.min(0.4 + scores[best], 0.97) };
    }

    return { classify, CLASSES };
  })();

  // ─────────────────────────────────────────────────────────────
  // 4. AdaptiveOcrRouter
  // ─────────────────────────────────────────────────────────────
  const AdaptiveOcrRouter = (() => {
    function route({ docType, hasHandwriting, hasTable, columns, lowRam }) {
      const config = {
        mode: 'standard',
        renderScale: 2.0,
        preprocessing: 'auto',
        languagePack: 'eng',
        tableMode: false,
        handwritingMode: false,
      };

      if (lowRam)           config.renderScale = 1.5;
      if (hasHandwriting)   { config.mode = 'handwriting'; config.handwritingMode = true; config.renderScale = 3.0; }
      if (hasTable)         { config.tableMode = true; }
      if (columns > 1)      { config.preprocessing = 'deskew+denoise'; }
      if (docType === 'scanned') { config.preprocessing = 'aggressive'; config.renderScale = 3.0; }
      if (docType === 'multilingual') { config.languagePack = 'multilingual'; }
      if (docType === 'newspaper')    { config.preprocessing = 'deskew+columns'; }

      return config;
    }

    return { route };
  })();

  // ─────────────────────────────────────────────────────────────
  // 5. AI Table Extraction
  // ─────────────────────────────────────────────────────────────
  const AiTableExtractor = (() => {
    /**
     * Extract table structure from OCR text + layout regions.
     * Returns { rows: [[cell,...]], headers: [...] }
     */
    function extractTables(ocrText, layoutRegions) {
      const tables = [];
      const tableRegions = (layoutRegions||[]).filter(r => r.type === 'table');

      // Heuristic: find pipe-separated or tab-separated rows in OCR text
      const lines = (ocrText||'').split('\n').map(l => l.trim()).filter(Boolean);
      let tableLines = [];
      let inTable = false;

      for (const line of lines) {
        const cells = line.split(/\t|\s{2,}|\|/).map(s=>s.trim()).filter(Boolean);
        if (cells.length >= 2) {
          tableLines.push(cells);
          inTable = true;
        } else {
          if (inTable && tableLines.length >= 2) {
            tables.push(_parseTableLines(tableLines));
          }
          tableLines = [];
          inTable = false;
        }
      }
      if (inTable && tableLines.length >= 2) tables.push(_parseTableLines(tableLines));

      return tables;
    }

    function _parseTableLines(lines) {
      const maxCols = Math.max(...lines.map(l => l.length));
      // Pad rows to same width
      const rows = lines.map(l => { while(l.length<maxCols) l.push(''); return l; });
      const headers = rows[0] || [];
      return { headers, rows: rows.slice(1), cols: maxCols };
    }

    /** Convert extracted table to CSV string */
    function toCSV(table) {
      const allRows = [table.headers, ...table.rows];
      return allRows.map(row => row.map(c => `"${(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    }

    /** Convert to JSON */
    function toJSON(table) {
      return table.rows.map(row => {
        const obj = {};
        table.headers.forEach((h,i) => { obj[h||`col${i}`] = row[i] || ''; });
        return obj;
      });
    }

    /** Produce XLSX-ready structure (array of arrays) */
    function toXLSXData(table) {
      return [table.headers, ...table.rows];
    }

    return { extractTables, toCSV, toJSON, toXLSXData };
  })();

  // ─────────────────────────────────────────────────────────────
  // Unified enhance() — main entry point
  // ─────────────────────────────────────────────────────────────
  async function enhance(ocrResult, imageData, options = {}) {
    const { pageWidth = 0, pageHeight = 0 } = options;

    // 1. Layout detection
    const regions    = await LayoutDetectionEngine.detectRegions(imageData, pageWidth, pageHeight);
    const columnInfo = LayoutDetectionEngine.detectColumns(imageData);
    const formInfo   = LayoutDetectionEngine.detectForms(regions);

    // 2. Handwriting
    const hwResult   = HandwritingDetector.detectHandwriting(imageData);
    const annotations= HandwritingDetector.detectAnnotations(regions);

    // 3. Classify document
    const docClass   = SmartDocumentClassifier.classify(ocrResult?.text || '', regions, hwResult);

    // 4. Route OCR config
    const ocrConfig  = AdaptiveOcrRouter.route({
      docType: docClass.type,
      hasHandwriting: hwResult.hasHandwriting,
      hasTable: regions.some(r=>r.type==='table'),
      columns: columnInfo.columns,
      lowRam: (navigator.deviceMemory||4) <= 2,
    });

    // 5. Table extraction
    const tables = AiTableExtractor.extractTables(ocrResult?.text || '', regions);

    // Hook into existing OCR cleanup if available
    let cleanText = ocrResult?.text || '';
    if (window.UniversalOcrCleanup?.clean) {
      try { cleanText = await window.UniversalOcrCleanup.clean(cleanText); } catch {}
    }

    return {
      text: cleanText,
      regions,
      columns: columnInfo,
      form: formInfo,
      handwriting: hwResult,
      annotations,
      documentClass: docClass,
      ocrConfig,
      tables,
      confidence: _computeOverallConfidence(regions, hwResult, docClass),
    };
  }

  function _computeOverallConfidence(regions, hw, docClass) {
    const regionConf = regions.length ? regions.reduce((s,r)=>s+r.confidence,0)/regions.length : 0.5;
    const hwPenalty  = hw.hasHandwriting ? 0.1 : 0;
    return Math.max(0, Math.min(1, regionConf - hwPenalty + docClass.confidence * 0.1));
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────
  const AiOcrEnhancement = {
    version: '42b.1.0',
    LayoutDetectionEngine,
    HandwritingDetector,
    SmartDocumentClassifier,
    AdaptiveOcrRouter,
    AiTableExtractor,

    enhance,

    async processPage(imageData, existingOcrText, options) {
      return enhance({ text: existingOcrText }, imageData, options);
    },

    status() {
      return {
        available: true,
        ocrCleanupAvailable: !!(window.UniversalOcrCleanup?.clean),
      };
    },
  };

  window.AiOcrEnhancement = AiOcrEnhancement;
  log('Phase 42B ready');

  function log(...a) { console.log('[AOE]', ...a); }
})();
