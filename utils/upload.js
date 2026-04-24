// Shared multer config — uploads to /tmp/uploads (Railway-friendly)
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'ilovepdf-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  pdf:   ['application/pdf'],
  image: ['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/tiff'],
  any:   null, // allow anything (used by some advanced tools that accept multiple types)
};

function fileFilter(kind) {
  const types = ALLOWED[kind];
  return (_req, file, cb) => {
    if (!types) return cb(null, true);
    if (types.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${types.join(', ')}`));
  };
}

// kind: 'pdf' | 'image' | 'any'
export function createUpload(kind = 'pdf', maxBytes = 100 * 1024 * 1024) {
  return multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: maxBytes },
    fileFilter: fileFilter(kind),
  });
}

// Sweeps any orphaned files older than 1 hour (safety net for cleanup)
export function sweepUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const cutoff = Date.now() - 60 * 60 * 1000;
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return;
    for (const name of files) {
      const p = path.join(UPLOAD_DIR, name);
      fs.stat(p, (e, s) => {
        if (!e && s.mtimeMs < cutoff) fs.unlink(p, () => {});
      });
    }
  });
}
