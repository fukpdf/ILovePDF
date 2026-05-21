// pdf-ppt-pptx-worker.js — Dedicated PPTX builder for PdfToPowerPointApp (Phase 2B)
// Terminate-after-job: PdfToPowerPointApp spawns this worker FRESH per conversion job
// and terminates it the moment a response is received (or on error/timeout).
// This worker does NOT share the global WorkerPool slot — completely isolated.
//
// Protocol:
//   IN  { op: 'build-pptx', slides: Array<SlideObj>, docTitle: string, jobId: string }
//   OUT { buffer: ArrayBuffer, jobId: string }  (transferable)
//   ERR { __error: string, jobId: string }
//
// SlideObj: { pageNum: number, title: string, text: string }

var _pptxLoaded = false;

function _ensurePptx() {
  if (!_pptxLoaded) {
    importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
    _pptxLoaded = true;
  }
}

async function buildPptx(slides, docTitle) {
  _ensurePptx();
  var pptx     = new self.PptxGenJS();
  pptx.layout  = 'LAYOUT_16x9';
  pptx.subject = docTitle || 'Converted Presentation';
  pptx.author  = 'ILovePDF';
  pptx.title   = docTitle || 'Converted Presentation';

  var TC = { bg: '1E3A5F', title: 'FFFFFF', text: 'BFDBFE', accent: '60A5FA', muted: '7BA5C9' };

  pptx.defineSlideMaster({
    title: 'MASTER',
    background: { color: TC.bg },
    objects: [
      { rect: { x: 0,   y: 0,    w: 0.08,  h: '100%', fill: { color: TC.accent } } },
      { rect: { x: 0,   y: 6.82, w: '100%', h: 0.12,  fill: { color: TC.accent, transparency: 55 } } },
    ],
  });

  for (var i = 0; i < slides.length; i++) {
    var s     = slides[i];
    var slide = pptx.addSlide({ masterName: 'MASTER' });

    slide.addText(String(s.title || 'Slide ' + s.pageNum).substring(0, 120), {
      x: 0.28, y: 0.14, w: 9.3, h: 0.72,
      fontSize: 22, bold: true, color: TC.title, fontFace: 'Calibri',
      wrap: true, charSpacing: 0.5,
    });

    var bodyText = (s.text || '').trim();
    if (bodyText) {
      var bodyLines = bodyText.split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0; });

      var maxLines     = 22;
      var usedLines    = bodyLines.slice(0, maxLines);
      var wasTruncated = bodyLines.length > maxLines;

      var bodyObjs = usedLines.map(function (line) {
        return {
          text:    line.substring(0, 220),
          options: { bullet: { type: 'bullet' }, fontSize: 11, color: TC.text, fontFace: 'Calibri' },
        };
      });

      if (wasTruncated) {
        bodyObjs.push({
          text:    '\u2026 (' + (bodyLines.length - maxLines) + ' more lines)',
          options: { fontSize: 9, color: TC.muted, italic: true, fontFace: 'Calibri' },
        });
      }

      slide.addText(bodyObjs, { x: 0.28, y: 1.05, w: 9.3, h: 5.5, valign: 'top', wrap: true, autoFit: true });
    } else {
      slide.addText('(No text content)', {
        x: 0.28, y: 3.0, w: 9.3, h: 0.5,
        fontSize: 11, color: TC.muted, italic: true, fontFace: 'Calibri', align: 'center',
      });
    }

    slide.addText(String(s.pageNum), {
      x: 9.1, y: 6.6, w: 0.55, h: 0.25,
      fontSize: 8, color: TC.muted, align: 'right', fontFace: 'Calibri',
    });
  }

  return await pptx.write({ outputType: 'arraybuffer' });
}

self.onmessage = async function (ev) {
  var jobId = (ev.data && ev.data.jobId) || '';
  try {
    var data = ev.data || {};
    if (data.op !== 'build-pptx') throw new Error('Unknown op: ' + data.op);
    if (!data.slides || !data.slides.length) throw new Error('No slides provided');
    var buf = await buildPptx(data.slides, data.docTitle || '');
    self.postMessage({ buffer: buf, jobId: jobId }, [buf]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'PPTX build error', jobId: jobId });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error', jobId: '' });
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
