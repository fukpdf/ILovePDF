import { JWT_SECRET as SECRET } from '../utils/secret.js';
// R2 storage routes — temporary upload + signed download + (auth'd) user files
import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import rateLimit from 'express-rate-limit';
import {
  isR2Configured, putTempObject, putUserObject,
  getSignedDownloadUrl, headObject, listUserObjects,
} from '../utils/r2.js';

const router = express.Router();

const COOKIE = 'ilovepdf_token';
const R2_MAX_USER_STORAGE_MB = Math.max(100, Number.parseInt(process.env.R2_MAX_USER_STORAGE_MB || '1024', 10) || 1024);
const r2UploadLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many storage upload requests. Please wait.' } });
const r2DownloadLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many storage download requests. Please wait.' } });

// Use diskStorage so large uploads are streamed to disk instead of buffered
// entirely in Node.js heap — prevents OOM under concurrent load.
const R2_TMP_DIR = path.join(os.tmpdir(), 'ilovepdf-r2-uploads');
try { fs.mkdirSync(R2_TMP_DIR, { recursive: true }); } catch (_) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, R2_TMP_DIR),
    filename:    (_req, file,  cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

async function _readAndClean(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    fs.promises.unlink(filePath).catch(() => {});
    return buf;
  } catch (e) {
    fs.promises.unlink(filePath).catch(() => {});
    throw e;
  }
}

function readUser(req) {
  const tok = req.cookies?.[COOKIE];
  if (!tok) return null;
  try { return jwt.verify(tok, SECRET); } catch { return null; }
}

function requireR2(_req, res, next) {
  if (!isR2Configured()) return res.status(503).json({ error: 'Storage is not configured.' });
  next();
}

router.post('/r2/upload', requireR2, r2UploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const user = readUser(req);
    const wantsPermanent = req.body?.permanent === '1' || req.body?.permanent === 'true';
    const buffer = await _readAndClean(req.file.path);
    let key;
    if (wantsPermanent && user) {
      const existing = await listUserObjects(String(user.id));
      const existingBytes = existing.reduce((sum, item) => sum + Number(item.size || 0), 0);
      if (existingBytes + req.file.size > R2_MAX_USER_STORAGE_MB * 1024 * 1024) {
        return res.status(413).json({ error: `Storage quota exceeded. Maximum ${R2_MAX_USER_STORAGE_MB} MB per account.` });
      }
      key = await putUserObject(String(user.id), buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = await putTempObject(buffer, req.file.originalname, req.file.mimetype);
    }
    const url = await getSignedDownloadUrl(key, 600);
    res.json({ key, url, size: req.file.size, name: req.file.originalname });
  } catch (e) {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    console.error('[r2] upload error:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

router.get('/r2/download', requireR2, r2DownloadLimiter, async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'key required' });
    if (key.startsWith('users/')) {
      const user = readUser(req);
      if (!user || !key.startsWith(`users/${user.id}/`)) return res.status(403).json({ error: 'Forbidden' });
    } else if (!key.startsWith('tmp/')) {
      return res.status(400).json({ error: 'Invalid key prefix' });
    }
    await headObject(key);
    const url = await getSignedDownloadUrl(key, 600);
    res.json({ url });
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: 'Object not found or expired.' });
    console.error('[r2] download error:', e.message);
    res.status(500).json({ error: 'Could not sign URL.' });
  }
});

router.get('/user/files', requireR2, async (req, res) => {
  const user = readUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const files = await listUserObjects(String(user.id));
    res.json({ files });
  } catch (e) {
    console.error('[r2] list error:', e.message);
    res.status(500).json({ error: 'Could not list files.' });
  }
});

export default router;
