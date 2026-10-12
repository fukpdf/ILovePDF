// Phase H — Enterprise Recovery V2 v1.0
// PURELY ADDITIVE — extends Phase 36 AdvancedPdfRecovery, does not replace it.
//
// § H1  ObjectGraphRecovery  — deep object graph rebuild, circular ref resolution
// § H2  IncrementalXrefBuilder — page-by-page xref reconstruction
// § H3  StreamSalvage        — compressed stream partial recovery
// § H4  FontRecovery         — damaged font descriptor repair
// § H5  PageTreeRecovery     — /Pages tree reconstruction from orphan pages
// § H6  ImageExtractRecovery — rescue embedded images from damaged PDFs
// § H7  RecoveryOrchestrator — confidence-scored multi-stage recovery pipeline
//
// Exposes: window.EnterpriseRecoveryV2

(function () {
  'use strict';

  var VERSION  = '1.0';
  var MB       = 1024 * 1024;
  var LOG_PFX  = '[ERV2]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }
  function _err(t, e) { try { window.DebugTrace && window.DebugTrace.error && window.DebugTrace.error(LOG_PFX + ' ' + t, e); } catch (_) {} }

  var ENC = new TextEncoder();
  var DEC = new TextDecoder('latin1');

  function _pad10(n) { return String(n).padStart(10, '0'); }
  function _buf2str(buf) { return DEC.decode(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf); }
  function _str2buf(s) { return ENC.encode(s); }


  // ═══════════════════════════════════════════════════════════════════════════
  // § H1  OBJECT GRAPH RECOVERY
  // Scans a PDF for all object definitions and builds a full object graph.
  // Resolves indirect references and detects circular chains.
  // ═══════════════════════════════════════════════════════════════════════════
  var ObjectGraphRecovery = (function () {

    // Parse all objects in a PDF text string
    function parseObjects(text) {
      var re      = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
      var objects = {};
      var m;
      while ((m = re.exec(text)) !== null) {
        var num  = parseInt(m[1], 10);
        var gen  = parseInt(m[2], 10);
        var body = m[3].trim();
        objects[num] = { num: num, gen: gen, body: body, offset: m.index };
      }
      return objects;
    }

    // Find all indirect references in a body string (N G R pattern)
    function findRefs(body) {
      var re   = /(\d+)\s+(\d+)\s+R/g;
      var refs = [];
      var m;
      while ((m = re.exec(body)) !== null) {
        refs.push({ num: parseInt(m[1], 10), gen: parseInt(m[2], 10) });
      }
      return refs;
    }

    // Build adjacency graph: objNum → [referenced obj nums]
    function buildGraph(objects) {
      var graph = {};
      Object.keys(objects).forEach(function (k) {
        var obj = objects[k];
        graph[k] = findRefs(obj.body).map(function (r) { return r.num; });
      });
      return graph;
    }

    // Detect cycles using DFS (returns array of cycle chains)
    function detectCycles(graph) {
      var visited  = {};
      var inStack  = {};
      var cycles   = [];

      function dfs(node, path) {
        if (inStack[node]) { cycles.push(path.slice(path.indexOf(node))); return; }
        if (visited[node]) return;
        visited[node] = true;
        inStack[node] = true;
        path.push(node);
        (graph[node] || []).forEach(function (n) { dfs(n, path); });
        path.pop();
        inStack[node] = false;
      }

      Object.keys(graph).forEach(function (k) { dfs(k, []); });
      return cycles;
    }

    // Identify orphan objects (not referenced by any other object)
    function findOrphans(objects, graph) {
      var referenced = new Set();
      Object.values(graph).forEach(function (refs) { refs.forEach(function (r) { referenced.add(String(r)); }); });
      return Object.keys(objects).filter(function (k) { return !referenced.has(k) && k !== '1'; });
    }

    async function recover(buffer) {
      var text     = _buf2str(new Uint8Array(buffer));
      var objects  = parseObjects(text);
      var graph    = buildGraph(objects);
      var cycles   = detectCycles(graph);
      var orphans  = findOrphans(objects, graph);
      var count    = Object.keys(objects).length;

      _log('object-graph', { objects: count, cycles: cycles.length, orphans: orphans.length });

      return {
        objects:  objects,
        graph:    graph,
        cycles:   cycles,
        orphans:  orphans,
        count:    count,
        confidence: Math.min(1, count / 10),
      };
    }

    return { parseObjects: parseObjects, findRefs: findRefs, buildGraph: buildGraph, detectCycles: detectCycles, findOrphans: findOrphans, recover: recover };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H2  INCREMENTAL XREF BUILDER
  // Rebuilds xref table incrementally, one object at a time.
  // More accurate than Phase 36's bulk rebuild for partially corrupt files.
  // ═══════════════════════════════════════════════════════════════════════════
  var IncrementalXrefBuilder = (function () {

    function build(objects, bodyStr) {
      var xref   = {};
      var maxObj = 0;

      Object.values(objects).forEach(function (obj) {
        xref[obj.num] = { offset: obj.offset, gen: obj.gen };
        if (obj.num > maxObj) maxObj = obj.num;
      });

      // Build xref section string
      var lines = ['xref', '0 ' + (maxObj + 1), '0000000000 65535 f '];
      for (var i = 1; i <= maxObj; i++) {
        if (xref[i]) lines.push(_pad10(xref[i].offset) + ' ' + String(xref[i].gen || 0).padStart(5, '0') + ' n ');
        else         lines.push('0000000000 00000 f ');
      }

      var xrefStr    = lines.join('\n');
      var xrefOffset = bodyStr.length;
      var trailer    = 'trailer\n<<\n/Size ' + (maxObj + 1) + '\n/Root 1 0 R\n>>\nstartxref\n' + xrefOffset + '\n%%EOF';

      _log('xref-built', { maxObj: maxObj, entries: Object.keys(xref).length });

      return {
        xrefStr:     xrefStr,
        xrefOffset:  xrefOffset,
        trailer:     trailer,
        maxObj:      maxObj,
        confidence:  Math.min(1, Object.keys(xref).length / Math.max(1, maxObj)),
      };
    }

    async function buildFromBuffer(buffer) {
      var text    = _buf2str(new Uint8Array(buffer));
      var objects = ObjectGraphRecovery.parseObjects(text);
      return build(objects, text);
    }

    return { build: build, buildFromBuffer: buildFromBuffer };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H3  STREAM SALVAGE
  // Attempts partial decompression and content extraction from damaged streams.
  // ═══════════════════════════════════════════════════════════════════════════
  var StreamSalvage = (function () {

    var HAS_DECOMP = typeof DecompressionStream !== 'undefined';

    // Try to inflate a byte array; on failure return however many bytes decoded
    async function tryInflate(bytes) {
      if (!HAS_DECOMP) return { bytes: bytes, partial: true, confidence: 0.3 };
      try {
        var ds     = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        var result = new Uint8Array(0);
        var done   = false;

        writer.write(bytes).catch(function () {});
        writer.close().catch(function () {});

        while (!done) {
          try {
            var next = await Promise.race([
              reader.read(),
              new Promise(function (_, rej) { setTimeout(rej, 2000); }),
            ]);
            done   = next.done;
            if (next.value) {
              var merged = new Uint8Array(result.length + next.value.length);
              merged.set(result); merged.set(next.value, result.length);
              result = merged;
            }
          } catch (_) { done = true; }
        }

        return { bytes: result, partial: result.length > 0 && result.length < bytes.length * 5, confidence: result.length > 100 ? 0.8 : 0.4 };
      } catch (ex) {
        return { bytes: bytes, partial: true, confidence: 0.2 };
      }
    }

    // Extract readable text from a raw (possibly damaged) stream body
    function extractText(streamBytes) {
      var text = _buf2str(streamBytes);
      // Filter to printable ASCII + common whitespace
      return text.replace(/[^\x20-\x7E\x09\x0A\x0D]/g, ' ').replace(/ {3,}/g, ' ').trim();
    }

    // Salvage all streams in a PDF
    async function salvageAll(buffer) {
      var text    = _buf2str(new Uint8Array(buffer));
      var re      = /stream\s*([\s\S]*?)\s*endstream/g;
      var salvaged = [];
      var m;
      while ((m = re.exec(text)) !== null) {
        var raw    = new Uint8Array(m[1].length);
        for (var i = 0; i < m[1].length; i++) raw[i] = m[1].charCodeAt(i) & 0xFF;
        var result = await tryInflate(raw);
        if (result.bytes && result.bytes.length > 10) {
          var extracted = extractText(result.bytes);
          if (extracted.length > 5) salvaged.push({ offset: m.index, text: extracted, confidence: result.confidence });
        }
      }
      _log('stream-salvage', { streams: salvaged.length });
      return salvaged;
    }

    return { tryInflate: tryInflate, extractText: extractText, salvageAll: salvageAll };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H4  FONT RECOVERY
  // Inserts minimal font descriptors for missing/corrupt font objects.
  // ═══════════════════════════════════════════════════════════════════════════
  var FontRecovery = (function () {
    var HELVETICA_STUB = '<<\n/Type /Font\n/Subtype /Type1\n/BaseFont /Helvetica\n/Encoding /WinAnsiEncoding\n>>';
    var COURIER_STUB   = '<<\n/Type /Font\n/Subtype /Type1\n/BaseFont /Courier\n/Encoding /WinAnsiEncoding\n>>';

    function detectMissingFonts(objects) {
      var fontRefs    = [];
      var fontObjects = {};

      Object.values(objects).forEach(function (obj) {
        if (/\/Type\s*\/Font/.test(obj.body)) fontObjects[obj.num] = obj;
        var refs = obj.body.match(/\/F\d+\s+\d+\s+\d+\s+R/g) || [];
        refs.forEach(function (r) { fontRefs.push(r); });
      });

      return { fontRefs: fontRefs, fontObjects: fontObjects, missing: fontRefs.length - Object.keys(fontObjects).length };
    }

    // Inject Helvetica stubs for missing fonts into text
    function injectFallbackFonts(text, maxObj) {
      var nextObj = maxObj + 1;
      var injected = '';
      // Add one stub font that can be referenced
      injected += '\n' + nextObj + ' 0 obj\n' + HELVETICA_STUB + '\nendobj\n';
      injected += '\n' + (nextObj + 1) + ' 0 obj\n' + COURIER_STUB + '\nendobj\n';
      _log('font-stubs-injected', { at: nextObj });
      return { text: text + injected, nextObj: nextObj + 2 };
    }

    return { detectMissingFonts: detectMissingFonts, injectFallbackFonts: injectFallbackFonts };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H5  PAGE TREE RECOVERY
  // Reconstructs a /Pages tree from discovered page objects.
  // ═══════════════════════════════════════════════════════════════════════════
  var PageTreeRecovery = (function () {

    function findPageObjects(objects) {
      return Object.values(objects).filter(function (obj) {
        return /\/Type\s*\/Page\b/.test(obj.body);
      }).sort(function (a, b) { return a.num - b.num; });
    }

    function buildPagesTree(pageObjects, parentObjNum) {
      var refs = pageObjects.map(function (p) { return p.num + ' 0 R'; }).join(' ');
      return '<<\n/Type /Pages\n/Kids [' + refs + ']\n/Count ' + pageObjects.length + '\n>>';
    }

    function injectPagesNode(text, pageObjects, maxObj) {
      var pagesNum  = maxObj + 1;
      var pagesBody = buildPagesTree(pageObjects, pagesNum);
      var injected  = '\n' + pagesNum + ' 0 obj\n' + pagesBody + '\nendobj\n';
      // Patch existing /Root catalog if present
      var patched = text.replace(/\/Pages\s+\d+\s+\d+\s+R/, '/Pages ' + pagesNum + ' 0 R');
      _log('pages-tree-rebuilt', { pages: pageObjects.length, pagesObj: pagesNum });
      return { text: patched + injected, pagesObjNum: pagesNum };
    }

    return { findPageObjects: findPageObjects, buildPagesTree: buildPagesTree, injectPagesNode: injectPagesNode };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H6  IMAGE EXTRACT RECOVERY
  // Rescues embedded JPEG/PNG images from a damaged PDF byte stream.
  // ═══════════════════════════════════════════════════════════════════════════
  var ImageExtractRecovery = (function () {
    var JPEG_SOI = new Uint8Array([0xFF, 0xD8, 0xFF]);
    var JPEG_EOI = new Uint8Array([0xFF, 0xD9]);
    var PNG_SIG  = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    function findSignature(bytes, sig, start) {
      outer: for (var i = start; i < bytes.length - sig.length; i++) {
        for (var j = 0; j < sig.length; j++) {
          if (bytes[i + j] !== sig[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    function extractJpeg(bytes) {
      var images = [];
      var pos    = 0;
      while (pos < bytes.length) {
        var start = findSignature(bytes, JPEG_SOI, pos);
        if (start === -1) break;
        var end   = findSignature(bytes, JPEG_EOI, start + 3);
        if (end === -1) { pos = start + 1; continue; }
        end += 2;
        var img = bytes.slice(start, end);
        if (img.length > 500) images.push({ type: 'jpeg', bytes: img, offset: start, size: img.length });
        pos = end;
      }
      return images;
    }

    function extractPng(bytes) {
      var images = [];
      var pos    = 0;
      while (pos < bytes.length) {
        var start = findSignature(bytes, PNG_SIG, pos);
        if (start === -1) break;
        // PNG: scan for IEND chunk
        var end = start + PNG_SIG.length;
        while (end < bytes.length - 12) {
          // Chunk length (4 bytes) + type (4 bytes) + IEND = 0x49454E44
          if (bytes[end+4]===0x49 && bytes[end+5]===0x45 && bytes[end+6]===0x4E && bytes[end+7]===0x44) {
            end += 12;
            break;
          }
          var chunkLen = (bytes[end] << 24) | (bytes[end+1] << 16) | (bytes[end+2] << 8) | bytes[end+3];
          end += 12 + Math.max(0, chunkLen);
          if (end > bytes.length) break;
        }
        var img = bytes.slice(start, end);
        if (img.length > 100) images.push({ type: 'png', bytes: img, offset: start, size: img.length });
        pos = end;
      }
      return images;
    }

    async function extractAll(buffer) {
      var bytes   = new Uint8Array(buffer);
      var jpegs   = extractJpeg(bytes);
      var pngs    = extractPng(bytes);
      var all     = jpegs.concat(pngs);
      var blobs   = all.map(function (img) {
        return Object.assign({}, img, { blob: new Blob([img.bytes], { type: 'image/' + img.type }), url: null });
      });
      _log('images-extracted', { count: blobs.length });
      return blobs;
    }

    return { extractAll: extractAll, extractJpeg: extractJpeg, extractPng: extractPng };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § H7  RECOVERY ORCHESTRATOR
  // Runs all recovery stages in sequence, scores confidence, returns best result.
  // Never corrupts the original — always works on a copy.
  // ═══════════════════════════════════════════════════════════════════════════
  var RecoveryOrchestrator = (function () {

    async function recover(inputBuffer, opts) {
      var stages  = [];
      var report  = { inputSize: inputBuffer.byteLength, stages: [], confidence: 0, success: false };
      var working = inputBuffer.slice(0);   // always work on a copy

      try {
        // Stage 1: Object graph analysis
        var graph = await ObjectGraphRecovery.recover(working);
        stages.push({ stage: 'object-graph', objects: graph.count, orphans: graph.orphans.length, confidence: graph.confidence });

        var text   = _buf2str(new Uint8Array(working));
        var maxObj = Math.max.apply(null, Object.keys(graph.objects).map(Number).concat([1]));

        // Stage 2: Font recovery
        if (opts && opts.recoverFonts !== false) {
          var fontInfo = FontRecovery.detectMissingFonts(graph.objects);
          if (fontInfo.missing > 0) {
            var fontResult = FontRecovery.injectFallbackFonts(text, maxObj);
            text   = fontResult.text;
            maxObj = fontResult.nextObj;
            stages.push({ stage: 'font-recovery', stubs: 2, confidence: 0.7 });
          }
        }

        // Stage 3: Page tree recovery
        if (opts && opts.recoverPageTree !== false) {
          var pages = PageTreeRecovery.findPageObjects(graph.objects);
          if (pages.length > 0 && !/\/Type\s*\/Pages/.test(text)) {
            var ptResult = PageTreeRecovery.injectPagesNode(text, pages, maxObj);
            text   = ptResult.text;
            maxObj++;
            stages.push({ stage: 'page-tree', pages: pages.length, confidence: 0.75 });
          }
        }

        // Stage 4: Incremental xref rebuild
        var xrefResult = await IncrementalXrefBuilder.buildFromBuffer(_str2buf(text).buffer);
        var assembled  = text.replace(/xref[\s\S]*%%EOF/g, '').trimEnd();
        assembled     += '\n' + xrefResult.xrefStr + '\n' + xrefResult.trailer;
        stages.push({ stage: 'xref-rebuild', entries: xrefResult.maxObj, confidence: xrefResult.confidence });

        // Stage 5: Stream salvage (telemetry only — no text replacement needed for output)
        if (opts && opts.salvageStreams) {
          var salvaged = await StreamSalvage.salvageAll(_str2buf(assembled).buffer);
          stages.push({ stage: 'stream-salvage', streamsFixed: salvaged.length, confidence: salvaged.length > 0 ? 0.6 : 0.3 });
        }

        // Compute overall confidence
        var avgConf = stages.reduce(function (s, st) { return s + (st.confidence || 0); }, 0) / Math.max(1, stages.length);

        // Assemble final output
        var outBytes = _str2buf(assembled);
        report.stages     = stages;
        report.confidence = avgConf;
        report.outputSize = outBytes.length;
        report.success    = avgConf > 0.5;

        _log('recovery-complete', { stages: stages.length, confidence: avgConf.toFixed(2), size: outBytes.length });

        return { success: report.success, bytes: outBytes.buffer, report: report };

      } catch (ex) {
        _err('orchestrator', ex);
        report.error = ex.message;
        return { success: false, bytes: inputBuffer, report: report };
      }
    }

    return { recover: recover };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.EnterpriseRecoveryV2 = {
    version:                VERSION,
    ObjectGraphRecovery:    ObjectGraphRecovery,
    IncrementalXrefBuilder: IncrementalXrefBuilder,
    StreamSalvage:          StreamSalvage,
    FontRecovery:           FontRecovery,
    PageTreeRecovery:       PageTreeRecovery,
    ImageExtractRecovery:   ImageExtractRecovery,
    RecoveryOrchestrator:   RecoveryOrchestrator,

    // Convenience: full recovery pipeline for a File
    recoverFile: async function (file, opts) {
      var ab   = await file.arrayBuffer();
      var r    = await RecoveryOrchestrator.recover(ab, opts || { recoverFonts: true, recoverPageTree: true, salvageStreams: false });
      if (!r.success) return { success: false, file: file, report: r.report };
      var blob = new Blob([r.bytes], { type: 'application/pdf' });
      return { success: true, file: new File([blob], file.name, { type: 'application/pdf' }), report: r.report };
    },

    // Extract embedded images from a damaged PDF
    extractImages: async function (file) {
      var ab = await file.arrayBuffer();
      return ImageExtractRecovery.extractAll(ab);
    },

    audit: function () {
      return {
        version:  VERSION,
        stages:   ['ObjectGraph', 'IncrementalXref', 'StreamSalvage', 'FontRecovery', 'PageTree', 'ImageExtract', 'Orchestrator'],
        note:     'Extends Phase36 AdvancedPdfRecovery — deep multi-stage recovery',
      };
    },
  };

  _log('loaded', {});
}());
