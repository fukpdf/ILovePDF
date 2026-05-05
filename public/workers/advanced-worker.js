// Advanced Worker v3.0 — persistent off-thread document builder + pixel processor.
// Phase 1: Persistent (handles multiple tasks, no re-spawn).
// Phase 5: WebGPU detection + OffscreenCanvas acceleration for remove-bg.
// Operations: build-docx | build-xlsx | build-pptx | remove-bg | chunk-text-score

// ── LAZY LIBRARY LOADING ───────────────────────────────────────────────────────
var _jszip = false, _xlsx = false, _pptx = false;
function ensureJszip() { if (!_jszip) { importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); _jszip = true; } }
function ensureXlsx()  { if (!_xlsx)  { importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'); _xlsx = true; } }
function ensurePptx()  { if (!_pptx)  { importScripts('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'); _pptx = true; } }

// Phase 5: WebGPU availability (stealth — never exposed to user)
var _gpuDevice = null;
var _gpuChecked = false;

async function tryGetGPU() {
  if (_gpuChecked) return _gpuDevice;
  _gpuChecked = true;
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    _gpuDevice = await adapter.requestDevice();
    return _gpuDevice;
  } catch (_) { return null; }
}

// ── XML ESCAPE ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── BUILD DOCX ────────────────────────────────────────────────────────────────
async function buildDocx(pages) {
  ensureJszip();
  var paras = [];

  for (var pi = 0; pi < pages.length; pi++) {
    var p = pages[pi];
    var rawText    = (p.text || '').trim();
    var paragraphs = p.paragraphs;

    paras.push(
      '<w:p><w:pPr><w:spacing w:before="320" w:after="80"/></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="374151"/></w:rPr>' +
      '<w:t>Page ' + p.pageNum + '</w:t></w:r></w:p>'
    );

    if (paragraphs && paragraphs.length) {
      for (var qi = 0; qi < paragraphs.length; qi++) {
        var para = paragraphs[qi];
        if (!para.text) continue;
        if (para.isHeading) {
          paras.push(
            '<w:p><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>' +
            '<w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1E3A5F"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        } else {
          paras.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(para.text) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else if (rawText) {
      var lines = rawText.split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (line) {
          paras.push(
            '<w:p><w:pPr><w:spacing w:line="276" w:lineRule="auto" w:after="100"/></w:pPr>' +
            '<w:r><w:rPr><w:sz w:val="22"/><w:color w:val="374151"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(line) + '</w:t></w:r></w:p>'
          );
        }
      }
    } else {
      paras.push('<w:p/>');
    }

    paras.push('<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>');
  }

  var docXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + paras.join('') +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr>' +
    '</w:body></w:document>';

  var contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  var rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  var wordRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  var stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/>' +
    '<w:rPr><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr>' +
    '</w:style></w:styles>';

  var zip = new self.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', docXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', wordRels);

  var ab = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return ab;
}

// ── BUILD XLSX ─────────────────────────────────────────────────────────────────
function buildXlsx(sheets) {
  ensureXlsx();
  var wb = self.XLSX.utils.book_new();
  for (var i = 0; i < sheets.length; i++) {
    var s  = sheets[i];
    var ws = self.XLSX.utils.aoa_to_sheet(s.rows && s.rows.length ? s.rows : [['(empty)']]);
    var maxCol = 0;
    (s.rows || []).forEach(function (r) { maxCol = Math.max(maxCol, r.length); });
    ws['!cols'] = Array.from({ length: maxCol }, function () { return { wch: 18 }; });
    self.XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 31));
  }
  var arr = self.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(arr).buffer;
}

// ── BUILD PPTX ─────────────────────────────────────────────────────────────────
async function buildPptx(slides, docTitle) {
  ensurePptx();
  var pptx     = new self.PptxGenJS();
  pptx.layout  = 'LAYOUT_16x9';
  pptx.subject = docTitle || 'Converted Presentation';

  for (var i = 0; i < slides.length; i++) {
    var s     = slides[i];
    var slide = pptx.addSlide();

    slide.addText(String(s.title || 'Slide ' + s.pageNum).substring(0, 80), {
      x: 0.4, y: 0.15, w: 9.2, h: 0.65,
      fontSize: 20, bold: true, color: '1E293B', wrap: true,
    });

    var bodyText = (s.text || '').trim();
    if (bodyText) {
      slide.addText(bodyText.substring(0, 1200), {
        x: 0.4, y: 0.9, w: 9.2, h: 4.4,
        fontSize: 11, color: '475569', wrap: true, valign: 'top',
      });
    } else {
      slide.addText('(No text content)', {
        x: 0.4, y: 2.5, w: 9.2, h: 0.5,
        fontSize: 11, color: '94A3B8', italic: true,
      });
    }

    slide.addText(String(s.pageNum), {
      x: 9.2, y: 5.15, w: 0.4, h: 0.25,
      fontSize: 9, color: 'CBD5E1', align: 'right',
    });
  }

  return await pptx.write({ outputType: 'arraybuffer' });
}

// ── REMOVE BACKGROUND ─────────────────────────────────────────────────────────
// Phase 5: Try WebGPU compute shader first; fall back to CPU pixel loop.

async function removeBgGPU(device, pixelsBuf, width, height, threshold) {
  // WebGPU compute shader for parallel pixel processing
  const t = Math.max(100, Math.min(255, threshold || 240));
  const feather = 35;

  const wgsl = `
    @group(0) @binding(0) var<storage, read_write> pixels: array<u32>;

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let idx = id.x;
      let total = arrayLength(&pixels) / 4u;
      if (idx >= total) { return; }

      let base = idx * 4u;
      let r = pixels[base];
      let g = pixels[base + 1u];
      let b = pixels[base + 2u];
      let avg = (r + g + b) / 3u;
      let th  = u32(${t});
      let fe  = u32(${feather});

      if (r >= th && g >= th && b >= th) {
        pixels[base + 3u] = 0u;
      } else if (avg >= (th - fe)) {
        let alpha = u32(255u * (th - avg) / fe);
        let cur   = pixels[base + 3u];
        if (alpha < cur) { pixels[base + 3u] = alpha; }
      }
    }
  `;

  const src = new Uint32Array(pixelsBuf);
  const bufSize = src.byteLength;

  const gpuBuf = device.createBuffer({
    size: bufSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(gpuBuf, 0, src.buffer);

  const readBuf = device.createBuffer({
    size: bufSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const module   = device.createShaderModule({ code: wgsl });
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: gpuBuf } }],
  });

  const encoder = device.createCommandEncoder();
  const pass    = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(src.length / 4 / 64));
  pass.end();
  encoder.copyBufferToBuffer(gpuBuf, 0, readBuf, 0, bufSize);
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Uint8ClampedArray(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  gpuBuf.destroy(); readBuf.destroy();

  return result.buffer;
}

function removeBgCPU(pixelsBuf, width, height, threshold) {
  var t = Math.max(100, Math.min(255, threshold || 240));
  var d = new Uint8ClampedArray(pixelsBuf);
  var featherRange = 35;

  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    var avg = (r + g + b) / 3;

    if (r >= t && g >= t && b >= t) {
      d[i + 3] = 0;
    } else if (avg >= t - featherRange) {
      var alpha = Math.round(255 * (1 - (avg - (t - featherRange)) / featherRange));
      alpha = Math.max(0, Math.min(255, alpha));
      if (alpha < d[i + 3]) d[i + 3] = alpha;
    }
  }

  // Edge smoothing pass
  var d2 = new Uint8ClampedArray(d);
  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var idx   = (y * width + x) * 4;
      var a     = d[idx + 3];
      if (a === 255) {
        var above = d[((y-1)*width + x)*4 + 3];
        var below = d[((y+1)*width + x)*4 + 3];
        var left  = d[(y*width + x - 1)*4 + 3];
        var right = d[(y*width + x + 1)*4 + 3];
        var minN  = Math.min(above, below, left, right);
        if (minN < 230) d2[idx + 3] = Math.round(a * 0.85 + minN * 0.15);
      }
    }
  }
  return { pixels: d2.buffer, width: width, height: height };
}

async function removeBg(pixelsBuf, width, height, threshold) {
  // Phase 5: Try WebGPU for hardware-accelerated pixel processing
  try {
    var device = await tryGetGPU();
    if (device) {
      var gpuResult = await removeBgGPU(device, pixelsBuf, width, height, threshold);
      return { pixels: gpuResult, width: width, height: height };
    }
  } catch (_) { /* GPU failed — fall through to CPU */ }

  return removeBgCPU(pixelsBuf, width, height, threshold);
}

// ── CHUNK TEXT SCORING (extractive summarisation, TF-IDF) ─────────────────────
function chunkTextScore(text, maxSentences) {
  var max = Math.min(25, Math.max(3, parseInt(maxSentences || 7, 10)));

  var sentences = (text.match(/[^.!?\n]{10,}[.!?]/g) || [])
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length >= 15; });

  if (!sentences.length) {
    sentences = text.split(/\n{2,}/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  var allWords = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  var freq = {};
  for (var wi = 0; wi < allWords.length; wi++) {
    var w = allWords[wi]; freq[w] = (freq[w] || 0) + 1;
  }

  var scored = sentences.map(function (s) {
    var sWords = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    var score  = 0;
    for (var si = 0; si < sWords.length; si++) score += (freq[sWords[si]] || 0);
    return { s: s, score: sWords.length ? score / sWords.length : 0 };
  });

  var top = scored.slice()
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, max)
    .map(function (x) { return x.s; });

  return {
    summary:       top.join(' '),
    wordCount:     allWords.length,
    sentenceCount: sentences.length,
    topCount:      top.length,
  };
}

// ── DISPATCHER (persistent — handles multiple messages) ───────────────────────

self.onmessage = async function (e) {
  var data = e.data || {};
  try {
    switch (data.op) {
      case 'build-docx': {
        if (!data.pages || !data.pages.length) throw new Error('No pages provided');
        var buf = await buildDocx(data.pages);
        self.postMessage({ buffer: buf }, [buf]);
        break;
      }
      case 'build-xlsx': {
        if (!data.sheets || !data.sheets.length) throw new Error('No sheets provided');
        var buf2 = buildXlsx(data.sheets);
        self.postMessage({ buffer: buf2 }, [buf2]);
        break;
      }
      case 'build-pptx': {
        if (!data.slides || !data.slides.length) throw new Error('No slides provided');
        var buf3 = await buildPptx(data.slides, data.docTitle);
        self.postMessage({ buffer: buf3 }, [buf3]);
        break;
      }
      case 'remove-bg': {
        if (!(data.pixels instanceof ArrayBuffer)) throw new Error('pixels must be ArrayBuffer');
        var result = await removeBg(data.pixels, data.width, data.height, data.threshold);
        self.postMessage(
          { pixels: result.pixels, width: result.width, height: result.height },
          [result.pixels]
        );
        break;
      }
      case 'chunk-text-score': {
        if (!data.text) throw new Error('No text provided');
        var scored = chunkTextScore(data.text, data.maxSentences);
        self.postMessage(scored);
        break;
      }
      default:
        throw new Error('Unknown operation: ' + data.op);
    }
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || 'Processing error' });
  }
};

self.onmessageerror = function () {
  self.postMessage({ __error: 'Message deserialization error' });
};
