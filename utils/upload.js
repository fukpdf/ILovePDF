import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const UPLOAD_DIR = path.join(os.tmpdir(), 'ilovepdf-uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function sweepUploads() {
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    const now = Date.now();
    for (const f of files) {
      const full = path.join(UPLOAD_DIR, f);
      try {
        const stats = fs.statSync(full);
        if (now - stats.mtimeMs > 15 * 60 * 1000) {
          fs.unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// Periodically sweep temporary uploads
setInterval(sweepUploads, 5 * 60 * 1000).unref();

export function validateFileSignature(filePath, allowedType = 'any') {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);

    if (allowedType === 'pdf') {
      const isPdf = buf.slice(0, 5).toString('ascii') === '%PDF-';
      if (!isPdf) {
        fs.unlink(filePath, () => {});
        return false;
      }
    } else if (allowedType === 'image') {
      const isJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
      const isGif = buf.slice(0, 3).toString('ascii') === 'GIF';
      const isBmp = buf.slice(0, 2).toString('ascii') === 'BM';
      if (!isJpg && !isPng && !isWebp && !isGif && !isBmp) {
        fs.unlink(filePath, () => {});
        return false;
      }
    }
    return true;
  } catch (e) {
    try { fs.unlink(filePath, () => {}); } catch (_) {}
    return false;
  }
}

export function createUpload(type = 'any', maxSize = 100 * 1024 * 1024) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `${unique}${ext}`);
    },
  });

  const fileFilter = (_req, file, cb) => {
    if (type === 'pdf') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.pdf' && !file.mimetype.includes('pdf')) {
        return cb(new Error('Only PDF files are allowed'));
      }
    } else if (type === 'image') {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Only image files are allowed'));
      }
    }
    cb(null, true);
  };

  return multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter,
  });
}
