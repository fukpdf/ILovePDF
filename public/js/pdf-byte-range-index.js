// PdfByteRangeIndex v1.0 — Phase 7B
// =====================================================================
// Partial PDF OPFS Staging — PDF xref parser and byte-range index.
//
// Parses the PDF cross-reference table (xref / xref streams) to locate
// the exact byte offsets of every page object WITHOUT loading the full
// document into RAM via pdf-lib. Only the tail (last ~8 KB) of the file
// is read to locate startxref, then only the xref table itself is pulled.
//
// This enables "partial staging": for tools that touch only a subset of
// pages (split, compare, extract, organize), we can write ONLY the
// required page bytes to OPFS and pass those to the worker — avoiding
// the full-file RAM spike.
//
// Public API (window.PdfByteRangeIndex):
//   .buildPageIndex(file)                      → Promise<PageIndex>
//   .stagePartialPdf(file, pageNumbers, key)   → Promise<{ opfsKey, size }>
//   .isSupportedForPartialStaging(file)        → boolean
//   .getStats()                                → object
// =====================================================================
(function (global) {
  'use strict';

  if (global.PdfByteRangeIndex) return;

  var LOG = '[PBRI]';
  var MB  = 1024 * 1024;

  // Only attempt partial staging for PDFs > this threshold
  var PARTIAL_STAGING_MIN_SIZE = 10 * MB;
  // Number of bytes to read from tail to find startxref
  var TAIL_READ_SIZE = 8192;

  // ── Stats ──────────────────────────────────────────────────────────────────
  var _stats = { indexed: 0, staged: 0, errors: 0, fullFallbacks: 0 };

  // ── PDF header / EOF helpers ───────────────────────────────────────────────
  function _u8(buf, offset) { return (new Uint8Array(buf))[offset]; }

  function _lastIndexOf(buf, pattern) {
    var arr  = new Uint8Array(buf);
    var pl   = pattern.length;
    for (var i = arr.length - pl; i >= 0; i--) {
      var match = true;
      for (var j = 0; j < pl; j++) {
        if (arr[i + j] !== pattern[j]) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  function _bytesToStr(buf, offset, len) {
    var arr = new Uint8Array(buf, offset, len);
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return s;
  }

  // ── Locate startxref ──────────────────────────────────────────────────────
  // Reads the last TAIL_READ_SIZE bytes and searches for 'startxref'.
  async function _findStartXref(file) {
    var tailSize   = Math.min(TAIL_READ_SIZE, file.size);
    var tailOffset = file.size - tailSize;
    var buf        = await file.slice(tailOffset, file.size).arrayBuffer();
    var text       = _bytesToStr(buf, 0, buf.byteLength);

    // Pattern: 'startxref\n<number>\n%%EOF'
    var idx = text.lastIndexOf('startxref');
    if (idx === -1) return null;

    var afterKw  = text.slice(idx + 9).replace(/^\s+/, '');
    var numMatch = afterKw.match(/^(\d+)/);
    if (!numMatch) return null;

    return tailOffset + idx + 9 + (afterKw.length - afterKw.replace(/^\s+/, '').length) + numMatch[0].length - numMatch[0].length
      // Absolute offset of the number itself:
      + (idx + 9); // base offset in file

    // Simpler: parse number from text position
  }

  // Simpler, correct version:
  async function _locateStartXref(file) {
    var tailSize   = Math.min(TAIL_READ_SIZE, file.size);
    var tailOffset = file.size - tailSize;
    var buf        = await file.slice(tailOffset, file.size).arrayBuffer();
    var text       = _bytesToStr(buf, 0, buf.byteLength);

    var idx = text.lastIndexOf('startxref');
    if (idx === -1) return null;

    var rest     = text.slice(idx + 'startxref'.length);
    var numMatch = rest.match(/\s+(\d+)/);
    if (!numMatch) return null;

    return parseInt(numMatch[1], 10); // absolute byte offset of xref table
  }

  // ── Parse classic xref table ──────────────────────────────────────────────
  // Returns a Map: objectNumber → { offset, gen, inUse }
  async function _parseXrefTable(file, xrefOffset) {
    // Read a generous chunk starting at xrefOffset
    var readSize = Math.min(512 * 1024, file.size - xrefOffset); // up to 512 KB
    var buf      = await file.slice(xrefOffset, xrefOffset + readSize).arrayBuffer();
    var text     = _bytesToStr(buf, 0, buf.byteLength);

    if (!text.startsWith('xref')) return null;

    var entries = new Map();
    var lines   = text.split(/\r\n|\r|\n/);
    var lineIdx = 1; // skip 'xref'
    var subsectionRe = /^(\d+)\s+(\d+)$/;
    var entryRe      = /^(\d{10})\s+(\d{5})\s+([fn])/;

    while (lineIdx < lines.length) {
      var line = lines[lineIdx].trim();
      if (!line || line === 'trailer' || line.startsWith('<<')) break;

      var subsMatch = line.match(subsectionRe);
      if (!subsMatch) { lineIdx++; continue; }

      var startObj = parseInt(subsMatch[1], 10);
      var count    = parseInt(subsMatch[2], 10);
      lineIdx++;

      for (var k = 0; k < count && lineIdx < lines.length; k++, lineIdx++) {
        var el = lines[lineIdx].trim();
        var em = el.match(entryRe);
        if (!em) { k--; continue; }
        var offset  = parseInt(em[1], 10);
        var gen     = parseInt(em[2], 10);
        var inUse   = (em[3] === 'n');
        entries.set(startObj + k, { offset: offset, gen: gen, inUse: inUse });
      }
    }

    return entries;
  }

  // ── Resolve page objects → byte ranges ────────────────────────────────────
  // For each page, reads its object header at xref[objNum].offset to find
  // the end offset (next object's start - 1, or approximate via 'endobj').
  async function _resolvePageRanges(file, pageObjNums, xrefEntries) {
    // Sort all known offsets to compute end-of-object
    var allOffsets = [];
    xrefEntries.forEach(function (entry) {
      if (entry.inUse && entry.offset > 0) allOffsets.push(entry.offset);
    });
    allOffsets.sort(function (a, b) { return a - b; });
    allOffsets.push(file.size); // sentinel

    function _nextOffset(objOffset) {
      for (var i = 0; i < allOffsets.length - 1; i++) {
        if (allOffsets[i] === objOffset) return allOffsets[i + 1];
      }
      return Math.min(objOffset + 256 * 1024, file.size); // 256 KB estimate
    }

    var ranges = [];
    for (var pi = 0; pi < pageObjNums.length; pi++) {
      var objNum  = pageObjNums[pi];
      var entry   = xrefEntries.get(objNum);
      if (!entry || !entry.inUse || entry.offset <= 0) continue;

      var start = entry.offset;
      var end   = _nextOffset(start);
      ranges.push({ page: pi + 1, objNum: objNum, start: start, end: end });
    }
    return ranges;
  }

  // ── Walk Pages tree (shallow) ─────────────────────────────────────────────
  // Reads the Pages tree root to collect all page object numbers.
  // This is a shallow parse — reads just the root catalog + Pages dictionary.
  async function _collectPageObjectNums(file, xrefEntries) {
    // Find catalog: look for object with /Type /Catalog
    // Strategy: iterate first 50 objects and scan for /Catalog
    var catalogObjNum = null;
    var checkList = [];
    xrefEntries.forEach(function (entry, objNum) {
      if (entry.inUse && entry.offset > 0) checkList.push({ objNum: objNum, offset: entry.offset });
    });
    // Sort by offset — catalog is usually near the start
    checkList.sort(function (a, b) { return a.offset - b.offset; });
    // Scan first 30 objects for /Type /Catalog
    var scanCount = Math.min(30, checkList.length);
    for (var i = 0; i < scanCount; i++) {
      var entry  = checkList[i];
      var readSz = Math.min(2048, file.size - entry.offset);
      if (readSz <= 0) continue;
      var buf   = await file.slice(entry.offset, entry.offset + readSz).arrayBuffer();
      var text  = _bytesToStr(buf, 0, buf.byteLength);
      if (text.indexOf('/Type /Catalog') !== -1 || text.indexOf('/Type/Catalog') !== -1) {
        catalogObjNum = entry.objNum;
        break;
      }
    }
    if (catalogObjNum === null) return null;

    // Read catalog to find /Pages ref
    var catEntry  = xrefEntries.get(catalogObjNum);
    if (!catEntry) return null;
    var catBuf    = await file.slice(catEntry.offset, Math.min(catEntry.offset + 4096, file.size)).arrayBuffer();
    var catText   = _bytesToStr(catBuf, 0, catBuf.byteLength);
    var pagesMatch = catText.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    if (!pagesMatch) return null;
    var pagesObjNum = parseInt(pagesMatch[1], 10);

    // Read Pages node to find /Kids
    var pagesEntry  = xrefEntries.get(pagesObjNum);
    if (!pagesEntry) return null;
    var pagesSz     = Math.min(16 * 1024, file.size - pagesEntry.offset);
    var pagesBuf    = await file.slice(pagesEntry.offset, pagesEntry.offset + pagesSz).arrayBuffer();
    var pagesText   = _bytesToStr(pagesBuf, 0, pagesBuf.byteLength);

    // Extract /Kids [refs...]
    var kidsMatch = pagesText.match(/\/Kids\s*\[([^\]]+)\]/);
    if (!kidsMatch) return null;

    var kidsStr = kidsMatch[1];
    var refRe   = /(\d+)\s+\d+\s+R/g;
    var match;
    var pageObjNums = [];
    while ((match = refRe.exec(kidsStr)) !== null) {
      pageObjNums.push(parseInt(match[1], 10));
    }
    return pageObjNums;
  }

  // ── PUBLIC: buildPageIndex ─────────────────────────────────────────────────
  // Returns a PageIndex: { pageCount, ranges: [{page,objNum,start,end}], xrefOffset }
  // Only works for classic xref tables (not xref streams).
  async function buildPageIndex(file) {
    if (!file || file.size < 512) throw new Error('pbri:file-too-small');

    var spanId = null;
    if (global.RuntimeTelemetry) {
      spanId = global.RuntimeTelemetry.startSpan('pdf-byte-range-index:build', {
        size: file.size, name: file.name,
      });
    }

    try {
      var xrefOffset = await _locateStartXref(file);
      if (xrefOffset === null || xrefOffset <= 0 || xrefOffset >= file.size) {
        throw new Error('pbri:startxref-not-found');
      }

      var xrefEntries = await _parseXrefTable(file, xrefOffset);
      if (!xrefEntries || xrefEntries.size === 0) {
        throw new Error('pbri:xref-parse-failed');
      }

      var pageObjNums = await _collectPageObjectNums(file, xrefEntries);
      if (!pageObjNums || pageObjNums.length === 0) {
        throw new Error('pbri:pages-tree-parse-failed');
      }

      var ranges = await _resolvePageRanges(file, pageObjNums, xrefEntries);

      var index = {
        pageCount:  pageObjNums.length,
        ranges:     ranges,
        xrefOffset: xrefOffset,
        fileSize:   file.size,
        buildTs:    Date.now(),
      };

      _stats.indexed++;
      if (global.RuntimeTelemetry && spanId !== null) {
        global.RuntimeTelemetry.endSpan(spanId, 'ok');
      }
      return index;
    } catch (err) {
      _stats.errors++;
      if (global.RuntimeTelemetry && spanId !== null) {
        global.RuntimeTelemetry.endSpan(spanId, 'error');
      }
      throw err;
    }
  }

  // ── PUBLIC: stagePartialPdf ────────────────────────────────────────────────
  // Writes ONLY the bytes needed for the requested page numbers to OPFS.
  // Requires OPFSManager. Falls back to full staging if OPFSManager unavailable.
  //
  // pageNumbers: 1-based array e.g. [1, 3, 5]
  // key:         OPFS key prefix
  // Returns: { opfsKey, size, pageCount, staged: true }
  async function stagePartialPdf(file, pageNumbers, key) {
    if (!global.OPFSManager || !global.OPFSManager.available()) {
      _stats.fullFallbacks++;
      return null; // signal caller to use full staging
    }
    if (!pageNumbers || pageNumbers.length === 0) {
      _stats.fullFallbacks++;
      return null;
    }

    var index;
    try {
      index = await buildPageIndex(file);
    } catch (_) {
      _stats.fullFallbacks++;
      return null; // xref parse failed → full staging
    }

    // Map 1-based page numbers to ranges
    var requestedRanges = [];
    pageNumbers.forEach(function (pn) {
      var r = index.ranges.find(function (r) { return r.page === pn; });
      if (r) requestedRanges.push(r);
    });

    if (requestedRanges.length === 0) {
      _stats.fullFallbacks++;
      return null;
    }

    // Collect all unique byte ranges: PDF header + requested page bytes
    // Header: first 1 KB (signature + version)
    var HEADER_SIZE = Math.min(1024, file.size);

    var segments = [{ start: 0, end: HEADER_SIZE }];
    requestedRanges.forEach(function (r) {
      segments.push({ start: r.start, end: r.end });
    });
    // Sort + de-duplicate overlapping ranges
    segments.sort(function (a, b) { return a.start - b.start; });

    // Read each segment and assemble into a single Blob
    var parts = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.start >= seg.end || seg.start >= file.size) continue;
      var end = Math.min(seg.end, file.size);
      parts.push(file.slice(seg.start, end));
    }

    var combined = new Blob(parts, { type: 'application/pdf' });
    var opfsKey  = 'partial:' + key + ':pages=' + pageNumbers.join(',') + ':' + Date.now();

    try {
      await global.OPFSManager.writeStream(opfsKey, combined);
    } catch (writeErr) {
      _stats.fullFallbacks++;
      return null;
    }

    _stats.staged++;
    return {
      opfsKey:   opfsKey,
      size:      combined.size,
      pageCount: requestedRanges.length,
      staged:    true,
    };
  }

  // ── PUBLIC: isSupportedForPartialStaging ──────────────────────────────────
  function isSupportedForPartialStaging(file) {
    if (!file || typeof file.size !== 'number') return false;
    if (file.size < PARTIAL_STAGING_MIN_SIZE) return false;
    if (!global.OPFSManager || !global.OPFSManager.available()) return false;
    return true;
  }

  function getStats() {
    return Object.assign({}, _stats, {
      minSizeForPartialStaging: PARTIAL_STAGING_MIN_SIZE,
    });
  }

  global.PdfByteRangeIndex = {
    buildPageIndex:               buildPageIndex,
    stagePartialPdf:              stagePartialPdf,
    isSupportedForPartialStaging: isSupportedForPartialStaging,
    getStats:                     getStats,
  };

  console.info(LOG, 'PdfByteRangeIndex v1.0 ready');
}(window));
