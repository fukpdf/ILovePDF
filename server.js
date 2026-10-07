import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Utility imports
import { generateNonce, injectNonce } from './utils/csp-nonce.js';
import { originGuard } from './utils/origin-guard.js';
import { requestTimingMiddleware, getHealthSnapshot } from './utils/server-health-monitor.js';
import { packetValidatorSoft } from './utils/runtime-packet-validator.js';
import { checkUsage, enforcePerFile } from './utils/usage.js';
import { buildHtml, SLUG_MAP } from './utils/seo.js';
import './utils/db.js'; // Ensure SQLite database and tables are initialized

// Route imports
import authRouter from './routes/auth.js';
import organizeRouter from './routes/organize.js';
import editRouter from './routes/edit.js';
import convertRouter from './routes/convert.js';
import securityRouter from './routes/security.js';
import advancedRouter from './routes/advanced.js';
import imageRouter from './routes/image.js';
import r2Router from './routes/r2.js';
import searchRouter from './routes/search.js';
import adminRouter from './routes/admin.js';
import adminApiRouter from './routes/admin-api.js';
import communityApiRouter from './routes/community-api.js';
import seoRouter from './routes/seo-routes.js';
import liveIntelligenceRouter from './routes/live-intelligence.js';
import debugRouter from './routes/debug.js';
import securityTelemetryRouter from './routes/security-telemetry.js';
import executionTicketsRouter from './routes/execution-tickets.js';
import securityDashboardRouter from './routes/security-dashboard.js';
import securityIncidentsRouter from './routes/security-incidents.js';
import threatFeedRouter from './routes/threat-feed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const app = express();
app.set('trust proxy', 1);

// Pre-load tool HTML shell
let TOOL_HTML = '';
try {
  TOOL_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'tool.html'), 'utf8');
} catch (e) {
  console.warn('[server] Could not pre-load public/tool.html:', e.message);
}

// 1. Compression
app.use(compression());

// 2. Request timing
app.use(requestTimingMiddleware());

// 3. CSP + Security Headers
app.use((req, res, next) => {
  const nonce = generateNonce();
  res.locals.nonce = nonce;

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'unsafe-inline' https: blob: data:`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' data: blob: https:`,
    `connect-src 'self' https: blob: data: wss: ws:`,
    `worker-src 'self' blob:`,
    `frame-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');

  next();
});

// 4. API Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// 5. Body Parsers & Cookie Parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// 6. Admin and Community routers before API rate limiting
app.use('/admin', adminRouter);
app.use('/admin/security-dashboard', securityDashboardRouter);
app.use('/api/admin', adminApiRouter);
app.use('/api/community', communityApiRouter);

// 7. Health & Config endpoints
app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/server-health', (_req, res) => res.json(getHealthSnapshot()));
app.get('/api/geo', (_req, res) => res.json({ country: 'US', currency: 'USD' }));
app.get('/api/config/public', (_req, res) => {
  res.json({
    r2Configured: Boolean(process.env.R2_BUCKET),
    firebaseConfigured: Boolean(process.env.FIREBASE_PROJECT_ID),
    maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '100', 10),
  });
});
app.get('/api/config/firebase', (_req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  });
});

// 8. Origin Guard & Rate Limiter for other /api/* endpoints
app.use('/api', originGuard);
app.use('/api', apiLimiter);
app.use('/api', packetValidatorSoft);

// 9. Mount specialized API routers
app.use('/api/security-telemetry', securityTelemetryRouter);
app.use('/api/security-incidents', securityIncidentsRouter);
app.use('/api/threat-feed', threatFeedRouter);
app.use('/api', executionTicketsRouter);
app.use('/api', authRouter);
app.use('/api', r2Router);
app.use('/api', searchRouter);
app.use('/api/live-intel', liveIntelligenceRouter);
app.use('/live-intel', liveIntelligenceRouter);
app.use('/api/debug', debugRouter);
app.use('/debug', debugRouter);

// 10. Quota check & Core Processing routers
app.use('/api', checkUsage);
app.use('/api', organizeRouter);
app.use('/api', editRouter);
app.use('/api', convertRouter);
app.use('/api', securityRouter);
app.use('/api', advancedRouter);
app.use('/api', imageRouter);
app.use('/api', enforcePerFile);

// 11. SEO & Sitemap router
app.use('/', seoRouter);

// 12. Legacy HTML redirects & Clean URLs
app.get('/contact', (_req, res) => res.redirect(301, '/about#contact'));
app.get('/contact.html', (_req, res) => res.redirect(301, '/about#contact'));

app.get('/:page.html', (req, res, next) => {
  const p = req.params.page;
  const filePath = path.join(PUBLIC_DIR, `${p}.html`);
  if (fs.existsSync(filePath)) {
    return res.redirect(301, `/${p}`);
  }
  next();
});

// Clean URLs for static content
const STATIC_PAGES = ['about', 'privacy', 'terms', 'disclaimer', 'blog', 'dashboard', 'tools', 'offline', 'n2w', 'numbers-to-words', 'currency-converter'];
STATIC_PAGES.forEach(slug => {
  app.get(`/${slug}`, (_req, res, next) => {
    const filePath = path.join(PUBLIC_DIR, `${slug}.html`);
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      content = injectNonce(content, res.locals.nonce);
      res.type('html').send(content);
    } else {
      next();
    }
  });
});

// Tool clean-URL routes (upload, preview, download)
app.get('/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (SLUG_MAP[slug]) {
    const html = buildHtml(slug, TOOL_HTML, 'upload');
    return res.type('html').send(injectNonce(html, res.locals.nonce));
  }
  next();
});

app.get('/:slug/:step', (req, res, next) => {
  const { slug, step } = req.params;
  if (SLUG_MAP[slug] && (step === 'preview' || step === 'download')) {
    const html = buildHtml(slug, TOOL_HTML, step);
    return res.type('html').send(injectNonce(html, res.locals.nonce));
  }
  next();
});

// 13. Static file serving from public
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders: (res, pathHeader) => {
    if (pathHeader.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// 14. Root & Catch-all
app.get('/', (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    let content = fs.readFileSync(indexPath, 'utf8');
    content = injectNonce(content, res.locals.nonce);
    return res.type('html').send(content);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'tool.html'));
});

// 15. Global Error Handler
app.use((err, req, res, _next) => {
  console.error('[server error]', req.method, req.path, err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 100 MB.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large.' });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT && process.env.PORT !== '8080' ? parseInt(process.env.PORT, 10) : 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`ILovePDF application listening on http://${HOST}:${PORT}`);
});

export default app;
