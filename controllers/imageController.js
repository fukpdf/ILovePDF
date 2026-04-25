import sharp from 'sharp';
import fs from 'fs';
import { cleanupFiles } from '../utils/cleanup.js';

function sendImage(res, buffer, mimeType, filename) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// ── BACKGROUND REMOVER (white bg removal) ─────────────────────────────────

export async function backgroundRemove(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });

    const buffer = fs.readFileSync(req.file.path);
    const threshold = Math.min(255, Math.max(180, parseInt(req.body.threshold) || 240));

    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (r >= threshold && g >= threshold && b >= threshold) {
        pixels[i + 3] = 0;
      }
    }

    const result = await sharp(Buffer.from(pixels), {
      raw: { width: info.width, height: info.height, channels: 4 }
    }).png().toBuffer();

    cleanupFiles(req.file);
    sendImage(res, result, 'image/png', 'ilovepdf-bg-removed.png');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
}

// ── CROP IMAGE ─────────────────────────────────────────────────────────────

export async function cropImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });

    const buffer = fs.readFileSync(req.file.path);
    const meta = await sharp(buffer).metadata();

    const xPct   = Math.max(0, Math.min(100, parseFloat(req.body.x)      || 0));
    const yPct   = Math.max(0, Math.min(100, parseFloat(req.body.y)      || 0));
    const wPct   = Math.max(1, Math.min(100, parseFloat(req.body.width)  || 100));
    const hPct   = Math.max(1, Math.min(100, parseFloat(req.body.height) || 100));

    const left   = Math.round((xPct / 100) * meta.width);
    const top    = Math.round((yPct / 100) * meta.height);
    const width  = Math.round((wPct / 100) * meta.width);
    const height = Math.round((hPct / 100) * meta.height);

    const safeW = Math.min(width,  meta.width  - left);
    const safeH = Math.min(height, meta.height - top);

    if (safeW <= 0 || safeH <= 0)
      return res.status(400).json({ error: 'Crop region is outside image bounds.' });

    const result = await sharp(buffer)
      .extract({ left, top, width: safeW, height: safeH })
      .toBuffer();

    const ext  = (meta.format === 'jpeg' || meta.format === 'jpg') ? 'jpg' : 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';

    cleanupFiles(req.file);
    sendImage(res, result, mime, `ilovepdf-crop.${ext}`);
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
}

// ── RESIZE IMAGE ───────────────────────────────────────────────────────────

export async function resizeImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });

    const buffer = fs.readFileSync(req.file.path);
    const meta   = await sharp(buffer).metadata();
    const preset = req.body.preset || 'custom';
    let targetW, targetH, fitMode;

    switch (preset) {
      case '1:1':  targetW = 1080; targetH = 1080; fitMode = 'cover';   break;
      case '16:9': targetW = 1920; targetH = 1080; fitMode = 'cover';   break;
      case 'a4':   targetW = 2480; targetH = 3508; fitMode = 'inside';  break;
      case 'hd':   targetW = 1920; targetH = 1080; fitMode = 'inside';  break;
      default:
        targetW  = parseInt(req.body.width)  || meta.width;
        targetH  = parseInt(req.body.height) || meta.height;
        fitMode  = 'fill';
    }

    if (targetW <= 0 || targetH <= 0)
      return res.status(400).json({ error: 'Invalid dimensions.' });

    const result = await sharp(buffer)
      .resize(targetW, targetH, { fit: fitMode, withoutEnlargement: false })
      .toBuffer();

    const ext  = (meta.format === 'jpeg' || meta.format === 'jpg') ? 'jpg' : 'png';
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';

    cleanupFiles(req.file);
    sendImage(res, result, mime, `ilovepdf-resize.${ext}`);
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
}

// ── IMAGE FILTERS ──────────────────────────────────────────────────────────

export async function applyFilters(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });

    const buffer = fs.readFileSync(req.file.path);
    const meta   = await sharp(buffer).metadata();
    const filter = req.body.filter || 'grayscale';

    let pipeline = sharp(buffer);

    switch (filter) {
      case 'grayscale':
        pipeline = pipeline.grayscale();
        break;
      case 'sepia':
        pipeline = pipeline.recomb([
          [0.393, 0.769, 0.189],
          [0.349, 0.686, 0.168],
          [0.272, 0.534, 0.131],
        ]);
        break;
      case 'blur':
        pipeline = pipeline.blur(4);
        break;
      case 'brighten':
        pipeline = pipeline.modulate({ brightness: 1.35 });
        break;
      case 'contrast':
        pipeline = pipeline.linear(1.5, -(128 * 0.5));
        break;
      case 'sharpen':
        pipeline = pipeline.sharpen({ sigma: 2 });
        break;
      case 'invert':
        pipeline = pipeline.negate();
        break;
      default:
        pipeline = pipeline.grayscale();
    }

    const result = await pipeline.toBuffer();
    const ext    = (meta.format === 'jpeg' || meta.format === 'jpg') ? 'jpg' : 'png';
    const mime   = ext === 'jpg' ? 'image/jpeg' : 'image/png';

    cleanupFiles(req.file);
    sendImage(res, result, mime, `ilovepdf-filter-${filter}.${ext}`);
  } catch (err) {
    cleanupFiles(req.file);
    res.status(500).json({ error: err.message });
  }
}
