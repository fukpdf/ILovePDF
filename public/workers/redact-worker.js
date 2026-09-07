// redact-worker.js — Dedicated Redact PDF Worker (Phase 2B security fix)
//
// REPLACES the old shared pdf-lib-worker.js OPS.redact implementation, which
// only drew a black rectangle ON TOP OF the original page content. Proven via
// an executed proof-of-concept (see phase1.5-redaction-security.md in the
// audit archive) that the original text remained byte-for-byte intact and
// fully extractable underneath the rectangle in that implementation.
//
// THIS implementation performs genuine redaction by FLATTENING each targeted
// page to a raster image (rendered via pdf.js, exactly the pattern already
// proven working in public/js/image-pdf-app.js's pdf-to-jpg tool) and
// rebuilding the output PDF using ONLY that image for redacted pages — the
// original vector text/image objects for those pages are never carried into
// the output at all. This is a well-established "true redaction via
// flattening" technique.
//
// KNOWN, EXPECTED TRADE-OFF (not a bug — inherent to true redaction that
// doesn't require a custom PDF content-stream editor): a redacted page's text
// is no longer selectable/searchable/copyable in the output, since the page
// is now an image. Non-redacted pages are copied unchanged (still vector,
// still fully selectable/searchable) via pdf-lib's copyPages — the same
// mechanism already proven working in merge/organize.
//
// Runs as its own dedicated worker (NOT part of the shared pdf-lib-worker.js
// family) because it needs pdf.js in addition to pdf-lib — per the Phase 2A
// worker-contract decision matrix, a tool needing a library its siblings
// don't need gets its own worker, so merge/split/rotate/etc. never pay the
// cost of loading pdf.js.
//
// Message contract is UNCHANGED from the old shared worker, so no caller
// (redact-pdf-app.js) needs to change its message-building/parsing code:
//   IN:  { op: 'redact', buffers: [ArrayBuffer], opts, jobId }
//   OUT success: { buffer: ArrayBuffer, jobId }
//   OUT error:   { __error: string, jobId }

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js');
importScripts('/workers/p4-heartbeat-mixin.js');

const { PDFDocument } = self.PDFLib;

var PDFJS_URL    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
var PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
var _pdfjsPromise = null;

function loadPdfJs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = import(PDFJS_URL).then(function (lib) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return lib;
  });
  return _pdfjsPromise;
}

function parseRange(str, total) {
  var out = [];
  String(str).split(',').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      var a = Math.max(1, parseInt(m[1], 10)), b = Math.min(total, parseInt(m[2], 10));
      for (var i = a; i <= b; i++) out.push(i);
    } else {
      var n = parseInt(part, 10);
      if (n >= 1 && n <= total) out.push(n);
    }
  });
  return out;
}

// Renders one page to a flattened PNG image with the redaction rectangle
// burned in, using the SAME pdf.js render call shape already proven working
// in public/js/image-pdf-app.js (page.render({canvasContext, viewport})),
// substituting OffscreenCanvas (worker-safe) for the main-thread <canvas>
// used there, matching the pattern already proven in image-tools-worker.js.
async function renderRedactedPage(pdfjsDoc, pageNum, rectPct) {
  var pg = await pdfjsDoc.getPage(pageNum);
  var scale = 2.0; // fixed quality factor; matches the mid-tier scale used elsewhere in this codebase
  var vp = pg.getViewport({ scale: scale });
  var w = Math.min(Math.round(vp.width), 8192);
  var h = Math.min(Math.round(vp.height), 8192);

  var canvas = new OffscreenCanvas(w, h);
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  pg.cleanup();

  // Burn in the redaction rectangle(s) directly on the rendered pixels —
  // this happens AFTER rendering the original content, so the black box
  // genuinely occludes and replaces those pixels; there is no original
  // content layered underneath in the output because the output page is
  // ONLY this flattened image, not the original content stream.
  ctx.fillStyle = '#000000';
  ctx.fillRect(
    w * rectPct.x,
    h * rectPct.y,
    w * rectPct.width,
    h * rectPct.height
  );

  var blob = await canvas.convertToBlob({ type: 'image/png' });
  var imgBytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes: imgBytes, widthPt: vp.width / scale, heightPt: vp.height / scale };
}

self.onmessage = async function (ev) {
  var d = ev.data || {};
  var jobId = d.jobId;
  try {
    if (d.op !== 'redact') throw new Error('redact-worker: unsupported op "' + d.op + '"');
    var inputBuf = d.buffers[0];

    var opts = d.opts || {};
    var xPct = Math.max(0, parseFloat(opts.x || '10')) / 100;
    var yPct = Math.max(0, parseFloat(opts.y || '40')) / 100;
    var wPct = Math.max(0.01, parseFloat(opts.width || '30')) / 100;
    var hPct = Math.max(0.01, parseFloat(opts.height || '10')) / 100;
    // Canvas y-origin is top-down; PDF/pdf-lib y-origin is bottom-up. The
    // rectangle math below stays in canvas (top-down) space throughout
    // rendering, so no conversion is needed here — this differs from the
    // old pdf-lib-worker.js OPS.redact, which had to flip Y because it drew
    // directly in PDF coordinate space via pdf-lib's drawRectangle.
    var rectPct = { x: xPct, y: yPct, width: wPct, height: hPct };

    // Two independent copies: pdf.js and pdf-lib each parse the input
    // themselves and each may consume/retain their own buffer.
    var pdfjsLib = await loadPdfJs();
    var docForRender = await pdfjsLib.getDocument({ data: inputBuf.slice(0), isEvalSupported: false }).promise;
    var srcDoc = await PDFDocument.load(inputBuf, { ignoreEncryption: true });

    var totalPages = srcDoc.getPageCount();
    var targetSet = (!opts.pages || /^all$/i.test(String(opts.pages).trim()))
      ? null // null = every page
      : new Set(parseRange(String(opts.pages), totalPages));

    var outDoc = await PDFDocument.create();

    for (var i = 0; i < totalPages; i++) {
      var pageNum = i + 1;
      var isTarget = targetSet === null || targetSet.has(pageNum);

      if (isTarget) {
        var rendered = await renderRedactedPage(docForRender, pageNum, rectPct);
        var pngImage = await outDoc.embedPng(rendered.bytes);
        var newPage = outDoc.addPage([rendered.widthPt, rendered.heightPt]);
        newPage.drawImage(pngImage, {
          x: 0, y: 0, width: rendered.widthPt, height: rendered.heightPt,
        });
      } else {
        // Non-redacted pages are copied unchanged (still vector/searchable),
        // using the same copyPages mechanism already proven working in
        // merge-pdf-app.js and organize-app.js.
        var copied = await outDoc.copyPages(srcDoc, [i]);
        outDoc.addPage(copied[0]);
      }
    }

    try { await docForRender.destroy(); } catch (_) {}

    var resultBytes = await outDoc.save();
    var resultBuf = resultBytes.buffer.slice(resultBytes.byteOffset, resultBytes.byteOffset + resultBytes.byteLength);
    self.postMessage({ buffer: resultBuf, jobId: jobId }, [resultBuf]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || String(err), jobId: jobId });
  }
};
