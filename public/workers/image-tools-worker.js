// image-tools-worker.js v1.0 — Dedicated per-job image processing worker
// Uses OffscreenCanvas + createImageBitmap — no main thread needed.
// Spawned fresh per task, terminated immediately after result.
//
// Protocol in:  { op, buffer: ArrayBuffer, mime: string, opts: {}, jobId: string }
// Protocol out: { buffer: ArrayBuffer, mime: string, ext: string } | { __error: string }
//
// Supported ops: crop-image, resize-image, image-filters

function extFromMime(mime) {
  if (!mime) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif'))  return 'gif';
  return 'png';
}

function outMime(mime) {
  // Preserve source format; fallback to png
  if (!mime) return 'image/png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'image/jpeg';
  if (mime.includes('png'))  return 'image/png';
  if (mime.includes('webp')) return 'image/webp';
  return 'image/png';
}

const OPS = {};

// ── crop-image ────────────────────────────────────────────────────────────────
// opts: { x, y, width, height } — all 0-100 percentages of source dimensions
OPS['crop-image'] = async function (buffer, mime, opts) {
  const blob   = new Blob([buffer], { type: mime });
  const bmp    = await createImageBitmap(blob);
  const srcW   = bmp.width, srcH = bmp.height;

  const xPct = Math.max(0, Math.min(99, parseFloat(opts.x      || '0')))  / 100;
  const yPct = Math.max(0, Math.min(99, parseFloat(opts.y      || '0')))  / 100;
  const wPct = Math.max(0.01, Math.min(1, parseFloat(opts.width  || '100') / 100));
  const hPct = Math.max(0.01, Math.min(1, parseFloat(opts.height || '100') / 100));

  const sx = Math.round(srcW * xPct);
  const sy = Math.round(srcH * yPct);
  const sw = Math.round(srcW * wPct);
  const sh = Math.round(srcH * hPct);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  bmp.close();

  const om   = outMime(mime);
  const blob2 = await canvas.convertToBlob({ type: om, quality: 0.92 });
  const buf   = await blob2.arrayBuffer();
  return { buffer: buf, mime: om, ext: extFromMime(om) };
};

// ── resize-image ──────────────────────────────────────────────────────────────
// opts: { preset, width, height } — preset overrides width/height
// presets: '1:1', '16:9', 'a4', 'hd', 'thumb'
OPS['resize-image'] = async function (buffer, mime, opts) {
  const blob = new Blob([buffer], { type: mime });
  const bmp  = await createImageBitmap(blob);
  const srcW = bmp.width, srcH = bmp.height;

  let tw, th;
  const preset = opts.preset || '';
  if (preset === '1:1')       { const s = Math.max(srcW, srcH); tw = s; th = s; }
  else if (preset === '16:9') { tw = 1920; th = 1080; }
  else if (preset === 'a4')   { tw = 2480; th = 3508; }
  else if (preset === 'hd')   { tw = 1920; th = 1080; }
  else if (preset === 'thumb'){ tw = 200;  th = 200;  }
  else {
    tw = Math.max(1, Math.min(8000, parseInt(opts.width  || srcW, 10)));
    th = Math.max(1, Math.min(8000, parseInt(opts.height || srcH, 10)));
  }

  const canvas = new OffscreenCanvas(tw, th);
  const ctx    = canvas.getContext('2d');
  ctx.imageSmoothingEnabled  = true;
  ctx.imageSmoothingQuality  = 'high';
  ctx.drawImage(bmp, 0, 0, tw, th);
  bmp.close();

  const om    = outMime(mime);
  const blob2 = await canvas.convertToBlob({ type: om, quality: 0.92 });
  const buf   = await blob2.arrayBuffer();
  return { buffer: buf, mime: om, ext: extFromMime(om) };
};

// ── image-filters ─────────────────────────────────────────────────────────────
// opts: { filter } — 'grayscale' | 'sepia' | 'blur' | 'brighten' | 'contrast'
//                    'invert' | 'sharpen'
OPS['image-filters'] = async function (buffer, mime, opts) {
  const blob = new Blob([buffer], { type: mime });
  const bmp  = await createImageBitmap(blob);
  const w    = bmp.width, h = bmp.height;

  const canvas = new OffscreenCanvas(w, h);
  const ctx    = canvas.getContext('2d');
  const filter = opts.filter || 'grayscale';

  if (filter === 'sharpen') {
    // Manual 3×3 sharpen convolution (no ctx.filter needed)
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const id = ctx.getImageData(0, 0, w, h);
    const src = new Uint8ClampedArray(id.data);
    const dst = id.data;
    const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const off = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const ki  = (ky + 1) * 3 + (kx + 1);
              const pi  = ((y + ky) * w + (x + kx)) * 4 + c;
              sum += src[pi] * kernel[ki];
            }
          }
          dst[off + c] = Math.max(0, Math.min(255, sum));
        }
        dst[off + 3] = src[off + 3]; // preserve alpha
      }
    }
    ctx.putImageData(id, 0, 0);
  } else {
    // CSS filter fast path — supported in OffscreenCanvas in modern browsers
    const filterMap = {
      grayscale: 'grayscale(100%)',
      sepia:     'sepia(80%)',
      blur:      'blur(3px)',
      brighten:  'brightness(140%)',
      contrast:  'contrast(150%)',
      invert:    'invert(100%)',
    };
    ctx.filter = filterMap[filter] || 'none';
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  }

  const om    = outMime(mime);
  const blob2 = await canvas.convertToBlob({ type: om, quality: 0.92 });
  const buf   = await blob2.arrayBuffer();
  return { buffer: buf, mime: om, ext: extFromMime(om) };
};

// ── message handler ───────────────────────────────────────────────────────────

self.onmessage = async function (ev) {
  const { op, buffer, mime, opts, jobId } = ev.data || {};
  try {
    if (!op || !OPS[op]) throw new Error('Unknown op: ' + op);
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected ArrayBuffer input');
    const result = await OPS[op](buffer, mime || 'image/png', opts || {});
    self.postMessage({ buffer: result.buffer, mime: result.mime, ext: result.ext, jobId }, [result.buffer]);
  } catch (err) {
    self.postMessage({ __error: (err && err.message) || String(err), jobId });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
