// layout-graph.js — Semantic Layout Graph Builder
// Phase 1 of PDF→Word Fidelity Pipeline
// Converts PDF.js page items into a structured semantic node graph:
// heading, paragraph, list, table, form-field, signature, header, footer, image
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  // ── Node type constants ──────────────────────────────────────────────────
  const NT = {
    H1:'h1', H2:'h2', H3:'h3',
    P:'paragraph', LIST:'list', TABLE:'table',
    FORM:'form-field', SIG:'signature',
    HEADER:'header', FOOTER:'footer',
    IMAGE:'image', PAGE_BREAK:'pageBreak',
  };

  /**
   * Build a semantic graph from an array of page descriptors.
   *
   * @param {Array}  pages   - [{ items, pageWidth, pageHeight, pageNum }]
   * @param {Object} options - { fontMapper, columnEngine }
   * @returns {Object} graph - { nodes, edges, metadata }
   */
  function buildLayoutGraph(pages, options) {
    options = options || {};
    const FM = options.fontMapper  || (window.PDFPipeline && window.PDFPipeline.FontMapper);
    const CE = options.columnEngine|| (window.PDFPipeline && window.PDFPipeline.ColumnEngine);

    const graph = {
      nodes: [],
      edges: [],
      metadata: {
        pageCount:    pages.length,
        hasColumns:   false,
        hasTables:    false,
        hasForms:     false,
        baseFontSize: 11,
        pageWidth:    (pages[0] || {}).pageWidth  || 612,
        pageHeight:   (pages[0] || {}).pageHeight || 792,
      },
    };
    let nid = 0;

    const addNode = n => { n.id = nid++; graph.nodes.push(n); return n; };
    const addEdge = (a, b, type) => { if (a && b) graph.edges.push({ from: a.id, to: b.id, type }); };

    // Compute global base font size (median of all items, excluding outliers)
    const allHeights = pages.flatMap(p => (p.items || []).map(it => it.height || 0).filter(h => h > 2 && h < 72));
    if (allHeights.length) {
      const sorted = allHeights.slice().sort((a, b) => a - b);
      graph.metadata.baseFontSize = sorted[Math.floor(sorted.length * 0.5)] || 11;
    }

    for (const page of pages) {
      const { items = [], pageWidth = 612, pageHeight = 792, pageNum = 1 } = page;

      // Skip page entirely if no text items
      const valid = items.filter(it => it.str && it.str.trim() && it.height > 0);
      if (!valid.length) continue;

      const medH   = _median(valid.map(it => it.height || 0).filter(h => h > 0)) || 10;
      const rowTol = Math.max(2, medH * 0.55);
      const basePt = graph.metadata.baseFontSize;

      // Separate header / body / footer by Y zone
      const HY = pageHeight * 0.91;  // above → header
      const FY = pageHeight * 0.09;  // below → footer

      const headerItems = valid.filter(it => it.transform[5] > HY);
      const footerItems = valid.filter(it => it.transform[5] < FY);
      const bodyItems   = valid.filter(it => it.transform[5] >= FY && it.transform[5] <= HY);

      // Header node
      if (headerItems.length) {
        const text = headerItems.map(it => it.str.trim()).join(' ').trim();
        if (text) addNode({ type: NT.HEADER, text, runs: _runs(headerItems, FM), page: pageNum, confidence: 0.85, children: [], relations: [] });
      }

      // Footer node
      if (footerItems.length) {
        const text = footerItems.map(it => it.str.trim()).join(' ').trim();
        if (text) addNode({ type: NT.FOOTER, text, runs: _runs(footerItems, FM), page: pageNum, confidence: 0.85, children: [], relations: [] });
      }

      if (!bodyItems.length) continue;

      // Detect table regions from body items (same algorithm as browser-tools.js pre-pass)
      const { tableItems, tables } = _detectTables(bodyItems, pageWidth, medH);
      if (tables.length) graph.metadata.hasTables = true;

      // Create table nodes
      for (const tbl of tables) {
        if (tbl.isForm) graph.metadata.hasForms = true;
        addNode({
          type:      NT.TABLE,
          rows:      tbl.rows,
          colCount:  tbl.colCount,
          colWidths: tbl.colWidths,
          isForm:    tbl.isForm,
          yStart:    tbl.yStart,
          yEnd:      tbl.yEnd,
          page:      pageNum,
          confidence: 0.9,
          children: [],
          relations: [],
        });
      }

      // Group non-table body items into lines
      const nonTableItems = bodyItems.filter(it => !tableItems.has(it));
      if (!nonTableItems.length) continue;

      const lines = _groupLines(nonTableItems, pageWidth, rowTol, FM);

      // Column detection
      let orderedLines = lines;
      if (CE && lines.length >= 8) {
        const cr = CE.detectColumns(lines, pageWidth);
        if (cr.columnCount > 1 && cr.confidence > 0.55) {
          graph.metadata.hasColumns = true;
          orderedLines = CE.mergeColumnsToReadingOrder(cr);
        }
      }

      // Create content nodes
      let prev = null;
      let paraBuf = [];

      const flushPara = () => {
        if (!paraBuf.length) return;
        const text  = paraBuf.map(l => l.text).join(' ').trim();
        const first = paraBuf[0];
        const node  = addNode({
          type:      NT.P,
          text,
          runs:      paraBuf.flatMap(l => l.runs),
          xPositions: first.xPositions,
          fontSize:  first.fontSize,
          alignment: first.alignment,
          indent:    first.indentLevel || 0,
          page:      pageNum,
          confidence: 0.85,
          children: [],
          relations: [],
          y: first.y,
        });
        if (prev) addEdge(prev, node, 'follows');
        prev = node;
        paraBuf = [];
      };

      for (let i = 0; i < orderedLines.length; i++) {
        const line = orderedLines[i];
        const nType = _classifyLine(line, basePt);

        if (nType !== NT.P) {
          flushPara();
          const node = addNode({
            type:      nType,
            text:      line.text,
            runs:      line.runs,
            xPositions: line.xPositions,
            fontSize:  line.fontSize,
            alignment: line.alignment,
            page:      pageNum,
            confidence: 0.88,
            children: [],
            relations: [],
            y: line.y,
          });
          if (prev) addEdge(prev, node, 'follows');
          prev = node;
          continue;
        }

        // Para accumulation: flush on sentence-end or font change
        const next = orderedLines[i + 1];
        paraBuf.push(line);
        const ends  = /[.!?;:]$/.test(line.text.trim());
        const fsDiff = next && Math.abs((line.fontSize || 0) - (next.fontSize || 0)) > 2;
        const indDiff = next && (line.indentLevel || 0) !== (next.indentLevel || 0);
        if (ends || !next || fsDiff || indDiff) flushPara();
      }
      flushPara();
    }

    // Sort nodes by page, then by Y (descending = top-first)
    graph.nodes.sort((a, b) =>
      a.page !== b.page ? a.page - b.page : (b.y || 0) - (a.y || 0)
    );

    return graph;
  }

  /**
   * Convert a layout graph to the flat block array format expected by buildDocXml.
   * Headers and footers are skipped (they are page decorations, not body content).
   */
  function graphToBlocks(graph) {
    if (!graph || !graph.nodes) return [];
    const blocks  = [];
    let lastPage  = 1;
    let listBuf   = [];

    const flushList = () => {
      if (!listBuf.length) return;
      blocks.push({ type: 'list', listType: 'bullet', items: listBuf.map(n => ({ text: n.text, runs: n.runs })) });
      listBuf = [];
    };

    for (const node of graph.nodes) {
      if (node.type === NT.HEADER || node.type === NT.FOOTER) continue;

      if (node.page > lastPage) {
        flushList();
        blocks.push({ type: 'pageBreak' });
        lastPage = node.page;
      }

      switch (node.type) {
        case NT.H1: case NT.H2: case NT.H3:
          flushList();
          blocks.push({ type: node.type, text: node.text, runs: node.runs, fontSize: node.fontSize });
          break;

        case NT.TABLE:
          flushList();
          blocks.push({ type: 'table', cellRows: node.rows, colCount: node.colCount, colWidths: node.colWidths, isForm: node.isForm, pageWidth: graph.metadata.pageWidth });
          break;

        case NT.LIST:
          listBuf.push(node);
          break;

        case NT.SIG:
          flushList();
          blocks.push({ type: 'signature', text: node.text });
          break;

        case NT.P:
        default:
          flushList();
          blocks.push({
            type: 'p',
            text: node.text,
            runs: node.runs,
            fontSize: node.fontSize,
            xPositions: node.xPositions || [0],
            pageWidth: graph.metadata.pageWidth,
            alignment: node.alignment,
            indentLevel: node.indent || 0,
            singleLine: true,
          });
          break;
      }
    }
    flushList();
    return blocks;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  function _median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function _runs(items, FM) {
    return items.map(it => {
      const fp = FM ? FM.parseFont(it.fontName) : _fp(it.fontName);
      return { text: it.str, x: it.transform[4], y: it.transform[5], fontSize: it.height || 0, fontName: it.fontName || '', fontFamily: fp.family, bold: fp.bold, italic: fp.italic, mono: fp.mono, width: it.width || 0 };
    });
  }

  function _fp(fontName) {
    const n = (fontName || '').toLowerCase();
    return { family: n.includes('times') ? 'Times New Roman' : n.includes('courier') ? 'Courier New' : 'Calibri', bold: /bold|heavy|black/.test(n), italic: /italic|oblique/.test(n), mono: /mono|courier|consol/.test(n) };
  }

  function _groupLines(items, pageWidth, rowTol, FM) {
    const bkts = {};
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const k = Math.round(it.transform[5] / rowTol) * rowTol;
      if (!bkts[k]) bkts[k] = { runs: [], maxFs: 0, y: it.transform[5] };
      const fp = FM ? FM.parseFont(it.fontName) : _fp(it.fontName);
      bkts[k].runs.push({ text: it.str, x: it.transform[4], y: it.transform[5], fontSize: it.height || 0, fontName: it.fontName || '', fontFamily: fp.family, bold: fp.bold, italic: fp.italic, mono: fp.mono, width: it.width || 0 });
      if ((it.height || 0) > bkts[k].maxFs) bkts[k].maxFs = it.height || 0;
    }
    return Object.keys(bkts).map(Number).sort((a, b) => b - a).map(k => {
      const bk     = bkts[k];
      const sorted = bk.runs.sort((a, b) => a.x - b.x);
      const text   = sorted.map(r => r.text).join(' ').trim();
      const x0     = sorted.length ? sorted[0].x : 0;
      const pct    = x0 / (pageWidth || 612);
      const indentLevel = pct < 0.06 ? 0 : pct < 0.12 ? 1 : pct < 0.20 ? 2 : 3;
      const alignment   = Math.abs(x0 - pageWidth/2) < pageWidth*0.10 ? 'center' : x0 > pageWidth*0.83 ? 'right' : 'left';
      return { runs: sorted, text, fontSize: bk.maxFs, xPositions: sorted.map(r => r.x), parts: sorted.map(r => ({ text: r.text, x: r.x })), pageWidth, y: bk.y, indentLevel, alignment };
    }).filter(l => l.text.length > 0);
  }

  function _classifyLine(line, basePt) {
    const t   = (line.text || '').trim();
    if (!t) return NT.P;
    if (/^[_]{6,}$/.test(t) || /^[-]{8,}$/.test(t) || /^_{3,}\s*(Date|Sign|Name|Signature)/i.test(t)) return NT.SIG;
    if (/^[•·▪▸►‣◦○●]\s+/.test(t) || /^[-–—*]\s{1,3}\S/.test(t) || /^(\d{1,3}[.):]|[a-zA-Z][.)])\s+\S/.test(t)) return NT.LIST;
    const fs    = line.fontSize || basePt;
    const ratio = fs / (basePt || 11);
    const bold  = line.runs && line.runs.some(r => r.bold);
    const short = t.length < 80;
    if (ratio >= 1.50 && short)                   return NT.H1;
    if ((ratio >= 1.25 || (ratio>=1.1 && bold)) && short) return NT.H2;
    if ((ratio >= 1.05 || bold) && short && t.length < 60) return NT.H3;
    if (t === t.toUpperCase() && /[A-Z]/.test(t) && short && t.length < 60) return NT.H2;
    return NT.P;
  }

  function _detectTables(items, pageWidth, medH) {
    const pw = pageWidth;
    const gap = pw * 0.028;
    const rowTol = Math.max(2, medH * 0.55);
    const rowMap = {};
    for (const it of items) {
      const k = Math.round(it.transform[5] / rowTol) * rowTol;
      if (!rowMap[k]) rowMap[k] = { y: it.transform[5], items: [] };
      rowMap[k].items.push(it);
    }
    const rows = Object.values(rowMap).sort((a, b) => b.y - a.y)
      .map(r => ({ y: r.y, items: r.items.sort((a, b) => a.transform[4] - b.transform[4]), xs: r.items.map(it => it.transform[4]) }));

    const cntCols = xs => { if (!xs.length) return 0; let c=1; for(let k=1;k<xs.length;k++) if(xs[k]-xs[k-1]>=gap)c++; return c; };
    const overlapXs = (a,b,tol) => { for(const x of a) for(const y of b) if(Math.abs(x-y)<=tol) return true; return false; };
    const inBounds  = (x,xs) => x >= Math.min(...xs)-gap && x <= Math.max(...xs)+pw*0.5;
    const clusters  = xs => { const c=[]; for(const x of xs){const l=c[c.length-1]; if(!l||x-l.max>gap)c.push({min:x,max:x,center:x,count:1}); else{l.max=x;l.center=(l.min+l.max)/2;l.count++;}} return c; };
    const nearestC  = (x,c) => { let b=0,bd=Infinity; for(let k=0;k<c.length;k++){const d=Math.abs(x-c[k].center);if(d<bd){bd=d;b=k;}} return b; };

    const tableItems = new Set();
    const tables = [];
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (cntCols(row.xs) >= 2) {
        const region = [row];
        let j = i+1;
        while (j < rows.length) {
          const next = rows[j];
          if (region[region.length-1].y - next.y > medH*3.2) break;
          const nc = cntCols(next.xs);
          if (nc >= 2 && overlapXs(next.xs, row.xs, gap*1.8)) region.push(next);
          else if (nc === 1 && inBounds(next.xs[0], row.xs)) region.push(next);
          else break;
          j++;
        }
        const multiCol = region.filter(r => cntCols(r.xs) >= 2);
        if (region.length >= 2 && multiCol.length >= 2) {
          const allXs = region.flatMap(r => r.xs).sort((a,b)=>a-b);
          const colCls = clusters(allXs);
          const cellRows = region.map(r => { const cells=new Array(colCls.length).fill(''); for(const it of r.items){const ci=nearestC(it.transform[4],colCls);const t=it.str.trim();cells[ci]=cells[ci]?cells[ci]+' '+t:t;} return cells.map(c=>c.trim()); });
          const colWidths = colCls.map((col,ci)=>{ const nxt=colCls[ci+1]; return nxt?nxt.center-col.center:pw-col.center; });
          const isForm = colCls.length===2 && cellRows.filter(r=>/^[A-Za-z\u0600-\u06FF][^:]{0,35}[:\s]*$/.test(r[0]||'')).length/cellRows.length > 0.38;
          for(const r of region) for(const it of r.items) tableItems.add(it);
          tables.push({ rows:cellRows, colCount:colCls.length, colWidths, isForm, yStart:region[0].y, yEnd:region[region.length-1].y });
          i = j; continue;
        }
      }
      i++;
    }
    tables.sort((a,b)=>b.yStart-a.yStart);
    return { tableItems, tables };
  }

  window.PDFPipeline.LayoutGraph = { buildLayoutGraph, graphToBlocks, NT };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[LayoutGraph] v1.0 loaded');
  }
})();
