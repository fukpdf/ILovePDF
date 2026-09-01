import sharp from 'sharp';
import fs from 'fs';
import { cleanupFiles } from '../utils/cleanup.js';

const ALLOWED_IMAGE_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'avif', 'heif']);
const MAX_PIXELS = 50_000_000;

async function validateImageBuffer(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.format || !ALLOWED_IMAGE_FORMATS.has(meta.format)) {
    const err = new Error(`Unsupported image format: ${meta.format || 'unknown'}. Use JPG, PNG, WebP, GIF, or BMP.`);
    err.status = 400;
    throw err;
  }
  const pixels = (meta.width || 0) * (meta.height || 0);
  if (!Number.isFinite(pixels) || pixels <= 0) {
    const err = new Error('Image dimensions could not be determined.');
    err.status = 400;
    throw err;
  }
  if (pixels > MAX_PIXELS) {
    const err = new Error(`Image too large (${meta.width}×${meta.height} = ${(pixels / 1e6).toFixed(1)} MP). Maximum is ${MAX_PIXELS / 1e6} MP.`);
    err.status = 413;
    throw err;
  }
  return meta;
}

function sendImage(res, buffer, mimeType, filename) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

export async function backgroundRemove(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });
    const buffer = await fs.promises.readFile(req.file.path);
    const meta = await validateImageBuffer(buffer);
    const threshold = Math.min(255, Math.max(140, parseInt(req.body.threshold) || 240));
    const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const pixels = new Uint8Array(data);
    const total = width * height;
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      const base = i * 4;
      const r = pixels[base], g = pixels[base + 1], b = pixels[base + 2];
      if (r >= threshold && g >= threshold && b >= threshold) { pixels[base + 3] = 0; mask[i] = 0; }
      else mask[i] = 1;
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!mask[idx]) continue;
        let transNeighbours = 0, totalNeighbours = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          totalNeighbours++;
          if (!mask[ny * width + nx]) transNeighbours++;
        }
        if (transNeighbours > 0 && totalNeighbours > 0) pixels[idx * 4 + 3] = Math.max(0, Math.min(255, Math.round(255 * (1 - transNeighbours / totalNeighbours))));
      }
    }
    const result = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    cleanupFiles(req.file);
    sendImage(res, result, 'image/png', 'ilovepdf-bg-removed.png');
  } catch (err) {
    cleanupFiles(req.file);
    res.status(err.status || 500).json({ error: err.message });
  }
}

export async function cropImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });
    const buffer = await fs.promises.readFile(req.file.path);
    const meta = await validateImageBuffer(buffer);
    const xPct = Math.max(0, Math.min(100, parseFloat(req.body.x) || 0));
    const yPct = Math.max(0, Math.min(100, parseFloat(req.body.y) || 0));
    const wPct = Math.max(1, Math.min(100, parseFloat(req.body.width) || 100));
    const hPct = Math.max(1, Math.min(100, parseFloat(req.body.height) || 100));
    const left = Math.round((xPct / 100) * meta.width), top = Math.round((yPct / 100) * meta.height);
    const width = Math.round((wPct / 100) * meta.width), height = Math.round((hPct / 100) * meta.height);
    const safeW = Math.min(width, meta.width - left), safeH = Math.min(height, meta.height - top);
    if (safeW <= 0 || safeH <= 0) return res.status(400).json({ error: 'Crop region is outside image bounds.' });
    const result = await sharp(buffer).extract({ left, top, width: safeW, height: safeH }).toBuffer();
    const ext = meta.format === 'jpeg' || meta.format === 'jpg' ? 'jpg' : 'png';
    cleanupFiles(req.file); sendImage(res, result, ext === 'jpg' ? 'image/jpeg' : 'image/png', `ilovepdf-crop.${ext}`);
  } catch (err) { cleanupFiles(req.file); res.status(err.status || 500).json({ error: err.message }); }
}

export async function resizeImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });
    const buffer = await fs.promises.readFile(req.file.path);
    const meta = await validateImageBuffer(buffer);
    const preset = req.body.preset || 'custom';
    let targetW, targetH, fitMode;
    switch (preset) {
      case '1:1': targetW = 1080; targetH = 1080; fitMode = 'cover'; break;
      case '16:9': targetW = 1920; targetH = 1080; fitMode = 'cover'; break;
      case 'a4': targetW = 2480; targetH = 3508; fitMode = 'inside'; break;
      case 'hd': targetW = 1920; targetH = 1080; fitMode = 'inside'; break;
      default: targetW = parseInt(req.body.width) || meta.width; targetH = parseInt(req.body.height) || meta.height; fitMode = 'fill';
    }
    if (targetW <= 0 || targetH <= 0) return res.status(400).json({ error: 'Invalid dimensions.' });
    if (targetW * targetH > MAX_PIXELS) return res.status(413).json({ error: `Requested output exceeds ${MAX_PIXELS / 1e6} MP.` });
    const result = await sharp(buffer).resize(targetW, targetH, { fit: fitMode, withoutEnlargement: false }).toBuffer();
    const ext = meta.format === 'jpeg' || meta.format === 'jpg' ? 'jpg' : 'png';
    cleanupFiles(req.file); sendImage(res, result, ext === 'jpg' ? 'image/jpeg' : 'image/png', `ilovepdf-resize.${ext}`);
  } catch (err) { cleanupFiles(req.file); res.status(err.status || 500).json({ error: err.message }); }
}

export async function applyFilters(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload an image.' });
    const buffer = await fs.promises.readFile(req.file.path);
    const meta = await validateImageBuffer(buffer);
    const filter = req.body.filter || 'grayscale';
    let pipeline = sharp(buffer);
    switch (filter) {
      case 'grayscale': pipeline = pipeline.grayscale(); break;
      case 'sepia': pipeline = pipeline.recomb([[0.393,0.769,0.189],[0.349,0.686,0.168],[0.272,0.534,0.131]]); break;
      case 'blur': pipeline = pipeline.blur(4); break;
      case 'brighten': pipeline = pipeline.modulate({ brightness: 1.35 }); break;
      case 'contrast': pipeline = pipeline.linear(1.5, -(128 * 0.5)); break;
      case 'sharpen': pipeline = pipeline.sharpen({ sigma: 2 }); break;
      case 'invert': pipeline = pipeline.negate(); break;
      default: pipeline = pipeline.grayscale();
    }
    const result = await pipeline.toBuffer();
    const ext = meta.format === 'jpeg' || meta.format === 'jpg' ? 'jpg' : 'png';
    cleanupFiles(req.file); sendImage(res, result, ext === 'jpg' ? 'image/jpeg' : 'image/png', `ilovepdf-filter-${filter}.${ext}`);
  } catch (err) { cleanupFiles(req.file); res.status(err.status || 500).json({ error: err.message }); }
}
