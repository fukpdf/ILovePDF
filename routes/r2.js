// R2 storage routes — temporary upload + signed download + (auth'd) user files
import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import {
  isR2Configured, putTempObject, putUserObject,
  getSignedDownloadUrl, headObject, listUserObjects,
} from '../utils/r2.js';

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'ilovepdf_token';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

function readUser(req) {
  const tok = req.cookies?.[COOKIE];
  if (!tok) return null;
  try { return jwt.verify(tok, SECRET); } catch { return null; }
}

function requireR2(_req, res, next) {
  if (!isR2Configured()) return res.status(503).json({ error: 'Storage is not configured.' });
  next();
}

// POST /api/r2/upload  (field: 'file', optional 'permanent=1' for logged-in users)
router.post('/r2/upload', requireR2, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const user = readUser(req);
    const wantsPermanent = req.body?.permanent === '1' || req.body?.permanent === 'true';
    let key;
    if (wantsPermanent && user) {
      key = await putUserObject(String(user.id), req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      key = await putTempObject(req.file.buffer, req.file.originalname, req.file.mimetype);
    }
    const url = await getSignedDownloadUrl(key, 600);
    res.json({ key, url, size: req.file.size, name: req.file.originalname });
  } catch (e) {
    console.error('[r2] upload error:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// GET /api/r2/download?key=tmp/...  -> returns a fresh signed URL
router.get('/r2/download', requireR2, async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ error: 'key required' });
    // Permission check for user-prefixed keys
    if (key.startsWith('users/')) {
      const user = readUser(req);
      if (!user || !key.startsWith(`users/${user.id}/`)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (!key.startsWith('tmp/')) {
      return res.status(400).json({ error: 'Invalid key prefix' });
    }
    await headObject(key); // 404s if missing
    const url = await getSignedDownloadUrl(key, 600);
    res.json({ url });
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Object not found or expired.' });
    }
    console.error('[r2] download error:', e.message);
    res.status(500).json({ error: 'Could not sign URL.' });
  }
});

// GET /api/user/files — paid/logged-in users list their saved files
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
