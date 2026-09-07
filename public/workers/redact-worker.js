// redact-worker.js — Dedicated Redact PDF Worker (Phase 2B security fix)
//
// Replaces the old shared pdf-lib-worker.js OPS.redact implementation, which
// only drew a black rectangle over the original page content. That leaves the
// underlying text recoverable. This worker instead rasterizes targeted pages,
// burns the redaction rectangle into the pixels, and rebuilds those pages using
// only the flattened image.
//
// Non-redacted pages are copied unchanged with pdf-lib copyPages.
//
// Message contract:
//   IN:  { op: 'redact', buffers: [ArrayBuffer], opts, jobId }
//   OUT: { buffer: ArrayBuffer, jobId }
//   ERR: { __error: string, jobId }

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

async function renderRedactedPage(pdfjsDoc, pageNum, rectPct) {
  var pg = await pdfjsDoc.getPage(pageNum);
  var scale = 2.0;
  var vp = pg.getViewport({ scale: scale });
  var w = Math.min(Math.round(vp.width), 8192);
  var h = Math.min(Math.round(vp.height), 8192);

  var canvas = new OffscreenCanvas(w, h);
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await pg.render({ canvasContext: ctx, viewport: vp }).promise;
  pg.cleanup();

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
    var rectPct = { x: xPct, y: yPct, width: wPct, height: hPct };

    var pdfjsLib = await loadPdfJs();
    var docForRender = await pdfjsLib.getDocument({ data: inputBuf.slice(0), isEvalSupported: false }).promise;
    var srcDoc = await PDFDocument.load(inputBuf, { ignoreEncryption: true });

    var totalPages = srcDoc.getPageCount();
    var targetSet = (!opts.pages || /^all$/i.test(String(opts.pages).trim()))
      ? null
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
