// Stream Helpers v1.0 — Phase 23A
// Browser-side streaming, chunking, pipeline, and EXIF orientation utilities.
// Zero external dependencies. Exposes: window.StreamHelpers
(function () {
  'use strict';

  var DEFAULT_CHUNK = 4 * 1024 * 1024; // 4 MB

  // ── Async chunk iterator over a File/Blob ─────────────────────────────────
  function chunkIterator(fileOrBlob, chunkSize) {
    chunkSize = chunkSize || DEFAULT_CHUNK;
    var size  = fileOrBlob.size;
    var pos   = 0;
    return {
      [Symbol.asyncIterator]: function () {
        return {
          next: async function () {
            if (pos >= size) return { done: true, value: null };
            var end = Math.min(pos + chunkSize, size);
            var buf = await fileOrBlob.slice(pos, end).arrayBuffer();
            var off = pos;
            pos = end;
            return { done: false, value: { buffer: buf, offset: off, end: pos, total: size } };
          },
        };
      },
    };
  }

  // ── Read a File progressively, calling onChunk(buf, bytesRead, total) ─────
  async function readProgressively(file, onChunk, chunkSize, yieldMs) {
    chunkSize = chunkSize || DEFAULT_CHUNK;
    yieldMs   = yieldMs   || 0;
    var read  = 0;
    for await (var chunk of chunkIterator(file, chunkSize)) {
      read += chunk.buffer.byteLength;
      if (onChunk) await onChunk(chunk.buffer, read, file.size);
      if (yieldMs > 0) await new Promise(function (r) { setTimeout(r, yieldMs); });
    }
    return read;
  }

  // ── Accumulate ArrayBuffer parts without intermediate copies ──────────────
  function BufferAssembler() {
    var parts = [], total = 0;
    return {
      push: function (buf) {
        var ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
        parts.push(ab);
        total += ab.byteLength;
      },
      build: function () {
        if (parts.length === 0) return new ArrayBuffer(0);
        if (parts.length === 1) return parts[0];
        var out = new Uint8Array(total), off = 0;
        for (var i = 0; i < parts.length; i++) {
          out.set(new Uint8Array(parts[i]), off);
          off += parts[i].byteLength;
        }
        return out.buffer;
      },
      size:  function () { return total; },
      clear: function () { parts = []; total = 0; },
    };
  }

  // ── Sequential pipeline with main-thread yield between items ─────────────
  async function pipeline(items, transformFn, onProgress, yieldMs) {
    yieldMs = yieldMs || 0;
    var results = [];
    for (var i = 0; i < items.length; i++) {
      results.push(await transformFn(items[i], i, items.length));
      if (onProgress) onProgress(i + 1, items.length);
      if (yieldMs > 0 || i % 5 === 0) {
        await new Promise(function (r) { setTimeout(r, yieldMs || 0); });
      }
    }
    return results;
  }

  // ── Batch processor: items in groups of batchSize, yield between batches ──
  async function batchProcess(items, batchSize, processFn, onBatchDone) {
    batchSize = batchSize || 10;
    var results = [];
    for (var start = 0; start < items.length; start += batchSize) {
      var batch = items.slice(start, start + batchSize);
      var batchResults = await Promise.all(
        batch.map(function (item, i) { return processFn(item, start + i, items.length); })
      );
      results = results.concat(batchResults);
      if (onBatchDone) onBatchDone(Math.min(start + batchSize, items.length), items.length);
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    return results;
  }

  // ── Process PDF pages one at a time with automatic page.cleanup() ─────────
  async function processPages(pdfDoc, fn, onProgress, yieldMs) {
    yieldMs = yieldMs || 5;
    var total = pdfDoc.numPages;
    var results = [];
    for (var i = 1; i <= total; i++) {
      var page = await pdfDoc.getPage(i);
      var result;
      try {
        result = await fn(page, i, total);
      } finally {
        try { page.cleanup(); } catch (_) {}
      }
      results.push(result);
      if (onProgress) onProgress(i, total);
      if (yieldMs > 0) await new Promise(function (r) { setTimeout(r, yieldMs); });
    }
    return results;
  }

  // ── Human-readable byte formatter ─────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1048576)    return Math.round(bytes / 1024) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  // ── EXIF orientation reader (JPEG only) ───────────────────────────────────
  // Returns 1–8 (EXIF orientation tag value), or 1 if not JPEG or tag absent.
  function readExifOrientation(arrayBuffer) {
    try {
      var view = new DataView(arrayBuffer);
      if (view.getUint16(0, false) !== 0xFFD8) return 1; // not JPEG

      var len = view.byteLength, offset = 2;
      while (offset < len) {
        var marker = view.getUint16(offset, false);
        offset += 2;

        if (marker === 0xFFE1) { // APP1 — contains EXIF
          var exifStart = offset + 2; // skip APP1 length field
          // Check for 'Exif\0\0' header
          if (view.getUint32(exifStart, false) !== 0x45786966) break;
          var tiffStart  = exifStart + 6;
          var le         = view.getUint16(tiffStart, false) === 0x4949; // little-endian?
          var ifdOffset  = view.getUint32(tiffStart + 4, le);
          var ifdStart   = tiffStart + ifdOffset;
          var numEntries = view.getUint16(ifdStart, le);
          for (var n = 0; n < numEntries; n++) {
            var ep = ifdStart + 2 + n * 12;
            if (view.getUint16(ep, le) === 0x0112) { // Orientation tag
              return view.getUint16(ep + 8, le);
            }
          }
          break;
        } else if ((marker & 0xFF00) !== 0xFF00) {
          break;
        } else {
          offset += view.getUint16(offset, false);
        }
      }
    } catch (_) {}
    return 1;
  }

  // ── Apply EXIF orientation to an HTMLImageElement → new canvas ────────────
  // Returns a canvas with the image drawn in the correct visual orientation.
  function applyExifOrientation(img, orientation) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var canvas = document.createElement('canvas');
    var ctx    = canvas.getContext('2d');

    // Orientations 5–8 swap width and height
    if (orientation >= 5 && orientation <= 8) {
      canvas.width = h; canvas.height = w;
    } else {
      canvas.width = w; canvas.height = h;
    }

    switch (orientation) {
      case 2: ctx.transform(-1,  0,  0,  1,  w,  0); break; // flip H
      case 3: ctx.transform(-1,  0,  0, -1,  w,  h); break; // rotate 180
      case 4: ctx.transform( 1,  0,  0, -1,  0,  h); break; // flip V
      case 5: ctx.transform( 0,  1,  1,  0,  0,  0); break; // transpose
      case 6: ctx.transform( 0,  1, -1,  0,  h,  0); break; // rotate 90 CW
      case 7: ctx.transform( 0, -1, -1,  0,  h,  w); break; // transverse
      case 8: ctx.transform( 0, -1,  1,  0,  0,  w); break; // rotate 90 CCW
      default: break; // orientation 1 = identity
    }

    ctx.drawImage(img, 0, 0);
    return canvas;
  }

  // ── Canvas cleanup helper ─────────────────────────────────────────────────
  function releaseCanvas(canvas) {
    if (!canvas) return;
    try { canvas.width = 0; canvas.height = 0; } catch (_) {}
  }

  // ── Yield to main thread (RAF or setTimeout) ──────────────────────────────
  function yieldToMain() {
    return new Promise(function (r) {
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(r);
      else setTimeout(r, 0);
    });
  }

  // ── Adaptive render scale helper ──────────────────────────────────────────
  // Returns a PDF render scale appropriate for the current memory tier.
  // Falls back gracefully if window.MemPressure is not yet loaded.
  function adaptivePdfScale(preferredScale, pageCount) {
    var scale = preferredScale;

    // Use MemPressure if available
    if (window.MemPressure) {
      var memScale = window.MemPressure.renderScale('pdf');
      scale = Math.max(0.6, scale * memScale);
    }

    // Cap based on page count to prevent OOM on large PDFs
    if (pageCount > 50) scale = Math.min(scale, 1.0);
    else if (pageCount > 20) scale = Math.min(scale, 1.5);

    return Math.max(0.6, scale);
  }

  window.StreamHelpers = {
    DEFAULT_CHUNK:        DEFAULT_CHUNK,
    chunkIterator:        chunkIterator,
    readProgressively:    readProgressively,
    BufferAssembler:      BufferAssembler,
    pipeline:             pipeline,
    batchProcess:         batchProcess,
    processPages:         processPages,
    formatBytes:          formatBytes,
    readExifOrientation:  readExifOrientation,
    applyExifOrientation: applyExifOrientation,
    releaseCanvas:        releaseCanvas,
    yieldToMain:          yieldToMain,
    adaptivePdfScale:     adaptivePdfScale,
  };

}());
