import sharp from 'sharp';
import fs from 'fs';
import { cleanupFiles } from '../utils/cleanup.js';

function sendImage(res, buffer, mimeType, filename) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// ── BACKGROUND REMOVER ─────────────────────────────────────────────────────
// v2: threshold-based removal + 1-pass edge feathering for smooth borders.
//
// Algorithm:
//  1. Convert to RGBA raw pixels.
//  2. Hard-threshold pass: mark near-white pixels as fully transparent.
//  3. Feathering pass: for each opaque pixel that has at least one transparent
//     neighbour, reduce its alpha proportionally to the fraction of transparent
//     neighbours (8-connectivity). This gives a 1-pixel anti-aliased edge
//     instead of harsh jagged boundaries.

export async function backgroundRemove(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });

    const buffer    = fs.readFileSync(req.file.path);
    const threshold = Math.min(255, Math.max(140, parseInt(req.body.threshold) || 240));

    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const pixels = new Uint8Array(data);
    const total  = width * height;

    // ── Pass 1: hard threshold ──────────────────────────────────────────────
    // Mark each near-white pixel fully transparent; keep truly opaque pixels.
    const mask = new Uint8Array(total); // 0 = transparent, 1 = opaque

    for (let i = 0; i < total; i++) {
      const base = i * 4;
      const r = pixels[base];
      const g = pixels[base + 1];
      const b = pixels[base + 2];
      if (r >= threshold && g >= threshold && b >= threshold) {
        pixels[base + 3] = 0;
        mask[i] = 0;
      } else {
        mask[i] = 1;
      }
    }

    // ── Pass 2: edge feathering ────────────────────────────────────────────
    // For opaque pixels adjacent to transparent ones, partially reduce alpha
    // based on the proportion of transparent neighbours (8-connectivity).
    // This softens the hard cutout edge by 1 pixel.

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!mask[idx]) continue;           // already transparent — skip

        // Count transparent neighbours in 8-connected neighbourhood
        let transNeighbours = 0;
        let totalNeighbours = 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
            totalNeighbours++;
            if (!mask[ny * width + nx]) transNeighbours++;
          }
        }

        if (transNeighbours > 0 && totalNeighbours > 0) {
          // Alpha = 255 × (1 − fraction_transparent)
          // Clamp to ensure truly interior pixels stay opaque.
          const fraction = transNeighbours / totalNeighbours;
          const alpha    = Math.round(255 * (1 - fraction));
          pixels[idx * 4 + 3] = Math.max(0, Math.min(255, alpha));
        }
      }
    }

    // ── Encode result as PNG (alpha channel required) ─────────────────────
    const result = await sharp(Buffer.from(pixels), {
      raw: { width, height, channels: 4 },
    }).png({ compressionLevel: 6 }).toBuffer();

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
