import compression from 'compression';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

import organizeRouter from './routes/organize.js';
import editRouter from './routes/edit.js';
import convertRouter from './routes/convert.js';
import securityRouter from './routes/security.js';
import advancedRouter from './routes/advanced.js';
import imageRouter from './routes/image.js';
import authRouter from './routes/auth.js';
import r2Router from './routes/r2.js';
import { SLUG_MAP, buildHtml, getRedirect, getDirectFile, buildHomeHtml } from './utils/seo.js';
import './utils/seo-categories.js'; // registers categoryForSlug callback
import seoRouter from './routes/seo-routes.js';
import { UPLOAD_DIR, sweepUploads } from './utils/upload.js';
import { checkUsage, enforcePerFile } from './utils/usage.js';
import { isR2Configured, startR2Sweeper } from './utils/r2.js';
import { isFirebaseConfigured, firebaseWebApiKey } from './utils/firebase-admin.js';
import { isHfConfigured } from './utils/ai.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const app = express();
app.set('trust proxy', 1); // we are behind Replit / Railway proxies
app.use(compression());

// Homepage SEO injection — must run BEFORE static so we can rewrite index.html.
// Cached at boot so per-request cost is just a string send.
const __HOME_HTML = (() => {
  try {
    const base = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    return buildHomeHtml(base);
  } catch (e) {
    console.warn('[seo] could not pre-build home HTML:', e.message);
    return null;
  }
})();
app.get('/', (_req, res, next) => {
  if (!__HOME_HTML) return next();
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(__HOME_HTML);
});

// Phase-3 SEO: /sitemap.xml, /robots.txt, /pdf-tools etc., /submit-urls,
// /ping-index. Mounted before static so it can override sitemap/robots files.
app.use(seoRouter);

app.use(express.static('public'));

console.log(`[ilovepdf] uploads dir: ${UPLOAD_DIR}`);
console.log(`[ilovepdf] firebase: ${isFirebaseConfigured() ? 'enabled' : 'disabled'}`);
console.log(`[ilovepdf] r2:       ${isR2Configured()       ? 'enabled' : 'disabled'}`);
console.log(`[ilovepdf] hf:       ${isHfConfigured()       ? 'enabled' : 'disabled'}`);

setInterval(sweepUploads, 15 * 60 * 1000);
sweepUploads();
startR2Sweeper(); // 10-min TTL for tmp/* objects

// CORS — comma-separated ALLOWED_ORIGINS env (e.g. https://app.example.com,https://www.example.com)
// Plus a built-in allowlist of the production frontend domains so the deployed
// site works out of the box. Use ALLOWED_ORIGINS=* to allow any origin.
const DEFAULT_ALLOWED = [
  'https://ilovepdf.cyou',
  'https://www.ilovepdf.cyou',
  'https://ilovepdf-web.web.app',
  'https://ilovepdf-web.firebaseapp.com',
];
const ENV_ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED = Array.from(new Set([...DEFAULT_ALLOWED, ...ENV_ALLOWED]));
const ALLOW_ANY = ALLOWED.includes('*');
console.log(`[ilovepdf] cors:     allowing ${ALLOW_ANY ? 'ANY origin' : ALLOWED.length + ' origin(s)'}`);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Same-origin requests have no Origin header; nothing to do for CORS.
  if (origin && (ALLOW_ANY || ALLOWED.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else if (origin && req.method === 'OPTIONS') {
    // Reject unknown-origin pre-flights cleanly so the browser shows a useful error.
    return res.status(403).json({ error: 'origin not allowed', origin });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Powered-By', 'ILovePDF');
  // SharedArrayBuffer requires both COOP and COEP.
  // credentialless mode allows CDN resources (jsdelivr, etc.) without CORP headers
  // while still enabling cross-origin isolation for large-file worker transfers.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP. Please wait 15 minutes and try again.' },
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Public Firebase config (safe to expose — these are not secrets)
app.get('/api/config/firebase', (_req, res) => {
  if (!isFirebaseConfigured()) return res.status(503).json({ error: 'firebase not configured' });
  res.json({
    apiKey:        firebaseWebApiKey(),
    authDomain:    process.env.FIREBASE_AUTH_DOMAIN,
    projectId:     process.env.FIREBASE_PROJECT_ID,
    appId:         process.env.FIREBASE_APP_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  });
});

// Health probe (used by Railway / uptime monitors)
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    services: {
      firebase: isFirebaseConfigured(),
      r2:       isR2Configured(),
      hf:       isHfConfigured(),
    },
  });
});

app.use('/api', apiLimiter);
app.use('/api', authRouter); // auth routes are NOT subject to usage limits
app.use('/api', r2Router);   // R2 upload/download/list (own auth checks inside)

// Pre-flight quota check on every other POST (before multer parses the body)
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/r2/'))   return next();
  return checkUsage(req, res, next);
});

app.use('/api', organizeRouter);
app.use('/api', editRouter);
app.use('/api', convertRouter);
app.use('/api', securityRouter);
app.use('/api', advancedRouter);
app.use('/api', imageRouter);

app.use('/api', enforcePerFile);

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum allowed size is 100 MB. Sign up required for larger files.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// Email-confirmation landing page
app.get('/verify-signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify-signup.html'));
});

// Static About page (clean URL — no .html extension)
app.get('/about', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// Contact redirects to the contact section on the about page
app.get('/contact', (_req, res) => {
  res.redirect(301, '/about.html#contact');
});

// SEO routes
const TOOL_HTML = fs.readFileSync(path.join(__dirname, 'public', 'tool.html'), 'utf8');
app.get('/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!Object.prototype.hasOwnProperty.call(SLUG_MAP, slug)) return next();
  // Tools that have a hand-built standalone HTML page (e.g. utilities with a
  // custom UI) — stream the file at the clean URL so we keep one canonical URL.
  const direct = getDirectFile(slug);
  if (direct) {
    res.set('Cache-Control', 'public, max-age=300');
    return res.sendFile(path.join(__dirname, 'public', direct.replace(/^\/+/, '')));
  }
  const redir = getRedirect(slug);
  if (redir) return res.redirect(302, redir);
  const html = buildHtml(slug, TOOL_HTML, 'upload');
  if (!html) return next();
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
});

// 3-step flow sub-routes: /:slug/preview and /:slug/download.
// Both serve the same tool.html shell — tool-page.js reads window.__STEP and
// renders the appropriate step (Preview / Download). Direct deep-links with
// no in-memory state are gracefully redirected back to the upload step.
// Tools that have their own standalone HTML page (n2w, currency-converter)
// or are pure redirects don't have a multi-step flow.
app.get('/:slug/:step', (req, res, next) => {
  const { slug, step } = req.params;
  if (!Object.prototype.hasOwnProperty.call(SLUG_MAP, slug)) return next();
  if (step !== 'preview' && step !== 'download') return next();
  if (getDirectFile(slug) || getRedirect(slug)) return next();
  const html = buildHtml(slug, TOOL_HTML, step);
  if (!html) return next();
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ILovePDF running on port ${PORT}`);
});
