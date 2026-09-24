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

const SIGNATURES = {
  'application/pdf': buffer => buffer.subarray(0, 5).toString('ascii') === '%PDF-',
  'image/jpeg': buffer => buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF,
  'image/png': buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])),
  'image/gif': buffer => buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a',
  'image/webp': buffer => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  'image/bmp': buffer => buffer.subarray(0, 2).toString('ascii') === 'BM',
  'image/tiff': buffer => buffer.subarray(0, 4).equals(Buffer.from([0x49,0x49,0x2A,0x00])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x4D,0x4D,0x00,0x2A])),
  'application/zip': buffer => buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0x50,0x4B,0x03,0x04])) ||
     buffer.subarray(0, 4).equals(Buffer.from([0x50,0x4B,0x05,0x06])) ||
     buffer.subarray(0, 4).equals(Buffer.from([0x50,0x4B,0x07,0x08]))),
};

function validateFileSignature(file) {
  if (!file?.path || !file?.mimetype) return { ok: false, reason: 'Uploaded file metadata is incomplete.' };
  const checker = SIGNATURES[file.mimetype];
  if (!checker) return { ok: true, skipped: true };
  const fd = fs.openSync(file.path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (!checker(buffer.subarray(0, bytesRead))) {
      return { ok: false, reason: `File content does not match declared type: ${file.mimetype}.` };
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true };
}

function validateUploadedFiles(req, kind) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
  ];
  for (const file of files) {
    const result = validateFileSignature(file);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function fileFilter(kind) {
  const types = ALLOWED[kind];
  return (_req, file, cb) => {
    if (!types) return cb(null, true);
    if (types.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${types.join(', ')}`));
  };
}

// kind: 'pdf' | 'image' | 'any'
export function createUpload(kind = 'pdf') {
  const upload = multer({
    dest: UPLOAD_DIR,
    fileFilter: fileFilter(kind),
  });

  // Phase 3: run content-signature validation immediately after multer writes
  // the temporary file, before route handlers receive it.
  const wrap = handler => (req, res, next) => {
    handler(req, res, err => {
      if (err) return next(err);
      const result = validateUploadedFiles(req, kind);
      if (!result.ok) {
        const files = [
          ...(req.file ? [req.file] : []),
          ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat()),
        ];
        files.forEach(file => fs.unlink(file.path, () => {}));
        return res.status(400).json({ error: result.reason });
      }
      next();
    });
  };

  return {
    single: field => wrap(upload.single(field)),
    array: (field, maxCount) => wrap(upload.array(field, maxCount)),
    fields: fields => wrap(upload.fields(fields)),
    none: () => wrap(upload.none()),
  };
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
