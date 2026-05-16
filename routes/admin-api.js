// Admin REST API — all CRUD endpoints for every dashboard section.
// Mounted at /api/admin/* and protected by adminGuard middleware.
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';
import {
  getConfig, setConfig, getFlag, setFlag, auditLog,
} from '../utils/admin-db.js';
import { adminGuard } from '../middleware/admin-guard.js';
import { validatePassword } from './admin.js';
import bcrypt from 'bcryptjs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR  = path.join(__dirname, '..', 'public', 'admin', 'uploads');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const router = express.Router();

// ── PUBLIC endpoints (no auth required) ──────────────────────────────────────
// These must be registered BEFORE router.use(adminGuard).

// Analytics ingest — called from public tool pages
router.post('/analytics/event', express.json(), (req, res) => {
  const {
    event, tool_id, path: p, referrer,
    uid, fp_hash, trust_score, savings_pkr, gpu_tier, pwa_installed, extra,
  } = req.body || {};
  if (!event) return res.status(400).json({ error: 'event required' });
  const ua     = req.headers['user-agent'] || '';
  const uaType = /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  try {
    db.prepare(
      `INSERT INTO adm_analytics
         (event,tool_id,path,referrer,ua_type,uid,fp_hash,trust_score,savings_pkr,gpu_tier,pwa_installed,extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      event, tool_id || null, p || '', referrer || '', uaType,
      uid     || null,
      fp_hash || null,
      trust_score != null ? trust_score : null,
      savings_pkr || null,
      gpu_tier    || null,
      pwa_installed ? 1 : 0,
      extra || null,
    );
  } catch {}
  res.json({ ok: true });
});

// Current active announcement — called from public pages for the banner widget
router.get('/public/announcement', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const ann = db.prepare(
    'SELECT * FROM adm_announcements WHERE active=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>=?) ORDER BY created_at DESC LIMIT 1'
  ).get(now, now);
  res.json({ announcement: ann || null });
});

// ── Protected endpoints — require valid admin session ─────────────────────────
router.use(adminGuard);

// ── Multer for media uploads ──────────────────────────────────────────────────
const ALLOWED_MIME = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase();
      const name = crypto.randomBytes(12).toString('hex') + ext;
      cb(null, name);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME.includes(file.mimetype));
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/overview', (req, res) => {
  const totalTools  = 33;
  const totalPosts  = db.prepare('SELECT COUNT(*) as c FROM adm_blog_posts').get()?.c || 0;
  const pubPosts    = db.prepare("SELECT COUNT(*) as c FROM adm_blog_posts WHERE status='published'").get()?.c || 0;
  const draftPosts  = db.prepare("SELECT COUNT(*) as c FROM adm_blog_posts WHERE status='draft'").get()?.c || 0;
  const totalUsers  = db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0;
  const todayUsers  = db.prepare(
    "SELECT COUNT(*) as c FROM users WHERE created_at >= strftime('%s','now','-1 day')"
  ).get()?.c || 0;
  const activeFlags = db.prepare('SELECT COUNT(*) as c FROM adm_feature_flags WHERE enabled=1').get()?.c || 0;
  const recentLogs  = db.prepare(
    'SELECT * FROM adm_logs ORDER BY created_at DESC LIMIT 20'
  ).all();
  const topTools = db.prepare(
    "SELECT tool_id, COUNT(*) as c FROM adm_analytics WHERE event='tool_use' GROUP BY tool_id ORDER BY c DESC LIMIT 5"
  ).all();
  const memUsage = process.memoryUsage();
  const uptime   = process.uptime();

  res.json({
    stats: { totalTools, totalPosts, pubPosts, draftPosts, totalUsers, todayUsers, activeFlags },
    system: {
      uptime: Math.round(uptime),
      memUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      memTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMemMB: Math.round(memUsage.rss / 1024 / 1024),
      platform: process.platform,
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
      freeMemGB:  (os.freemem() / 1024 / 1024 / 1024).toFixed(1),
    },
    recentLogs,
    topTools,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — BLOG MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// List posts
router.get('/blog/posts', (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  let sql  = 'SELECT p.*, c.name as category_name FROM adm_blog_posts p LEFT JOIN adm_blog_categories c ON p.category_id=c.id';
  const where = []; const params = [];
  if (status)  { where.push("p.status=?");       params.push(status); }
  if (search)  { where.push("p.title LIKE ?");   params.push(`%${search}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.updated_at DESC';
  const off  = (parseInt(page) - 1) * parseInt(limit);
  sql += ` LIMIT ${parseInt(limit)} OFFSET ${off}`;
  const posts = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM adm_blog_posts').get()?.c || 0;
  res.json({ posts, total, page: parseInt(page) });
});

// Get single post
router.get('/blog/posts/:id', (req, res) => {
  const post = db.prepare(
    'SELECT p.*, c.name as category_name FROM adm_blog_posts p LEFT JOIN adm_blog_categories c ON p.category_id=c.id WHERE p.id=?'
  ).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  post.tags = safeParse(post.tags, []);
  res.json({ post });
});

// Create post
router.post('/blog/posts', express.json({ limit: '10mb' }), (req, res) => {
  const d = req.body;
  if (!d.title) return res.status(400).json({ error: 'Title required' });
  const slug = d.slug || slugify(d.title);
  if (db.prepare('SELECT 1 FROM adm_blog_posts WHERE slug=?').get(slug))
    return res.status(409).json({ error: 'Slug already exists. Use a different title or slug.' });

  const now   = Math.floor(Date.now() / 1000);
  const info  = db.prepare(`
    INSERT INTO adm_blog_posts
      (title,slug,content,excerpt,status,featured,category_id,tags,
       meta_title,meta_description,og_image,thumbnail,author,read_time,
       published_at,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    sanitizeText(d.title), slug,
    d.content || '',
    d.excerpt || '',
    d.status  || 'draft',
    d.featured ? 1 : 0,
    d.category_id || null,
    JSON.stringify(Array.isArray(d.tags) ? d.tags : []),
    d.meta_title        || d.title,
    d.meta_description  || '',
    d.og_image          || '',
    d.thumbnail         || '',
    d.author            || 'Admin',
    estimateReadTime(d.content || ''),
    d.status === 'published' ? now : (d.published_at || null),
    d.scheduled_at || null,
    now, now
  );
  auditLog(req.adminUser.id, 'BLOG_CREATE', `Post: ${d.title}`, req.ip);
  res.json({ id: info.lastInsertRowid, slug });
});

// Update post
router.put('/blog/posts/:id', express.json({ limit: '10mb' }), (req, res) => {
  const d   = req.body;
  const old = db.prepare('SELECT * FROM adm_blog_posts WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Post not found' });

  const slug = d.slug || old.slug;
  const dupe = db.prepare('SELECT 1 FROM adm_blog_posts WHERE slug=? AND id!=?').get(slug, req.params.id);
  if (dupe) return res.status(409).json({ error: 'Slug already exists.' });

  const now = Math.floor(Date.now() / 1000);
  const publishedAt = d.status === 'published' && !old.published_at ? now : (d.published_at || old.published_at);

  db.prepare(`
    UPDATE adm_blog_posts SET
      title=?,slug=?,content=?,excerpt=?,status=?,featured=?,category_id=?,tags=?,
      meta_title=?,meta_description=?,og_image=?,thumbnail=?,author=?,read_time=?,
      published_at=?,scheduled_at=?,updated_at=?
    WHERE id=?
  `).run(
    sanitizeText(d.title || old.title),
    slug,
    d.content          ?? old.content,
    d.excerpt          ?? old.excerpt,
    d.status           || old.status,
    d.featured != null  ? (d.featured ? 1 : 0) : old.featured,
    d.category_id      ?? old.category_id,
    JSON.stringify(Array.isArray(d.tags) ? d.tags : safeParse(old.tags, [])),
    d.meta_title       ?? old.meta_title,
    d.meta_description ?? old.meta_description,
    d.og_image         ?? old.og_image,
    d.thumbnail        ?? old.thumbnail,
    d.author           ?? old.author,
    estimateReadTime(d.content || old.content || ''),
    publishedAt,
    d.scheduled_at     ?? old.scheduled_at,
    now,
    req.params.id
  );
  auditLog(req.adminUser.id, 'BLOG_UPDATE', `Post ID ${req.params.id}`, req.ip);
  res.json({ ok: true, slug });
});

// Delete post
router.delete('/blog/posts/:id', (req, res) => {
  const post = db.prepare('SELECT title FROM adm_blog_posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  db.prepare('DELETE FROM adm_blog_posts WHERE id=?').run(req.params.id);
  auditLog(req.adminUser.id, 'BLOG_DELETE', `Post: ${post.title}`, req.ip);
  res.json({ ok: true });
});

// Categories
router.get('/blog/categories', (_req, res) => {
  res.json({ categories: db.prepare('SELECT * FROM adm_blog_categories ORDER BY name').all() });
});
router.post('/blog/categories', express.json(), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const slug = slugify(name);
  try {
    const info = db.prepare(
      'INSERT INTO adm_blog_categories (name,slug,description) VALUES (?,?,?)'
    ).run(sanitizeText(name), slug, description || '');
    res.json({ id: info.lastInsertRowid, slug });
  } catch { res.status(409).json({ error: 'Category already exists' }); }
});
router.delete('/blog/categories/:id', (req, res) => {
  db.prepare('DELETE FROM adm_blog_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONFIG (Homepage, SEO, Branding, Ads, Donations, Settings)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/config', (req, res) => {
  const prefix = req.query.prefix || '';
  let rows;
  if (prefix) {
    rows = db.prepare("SELECT key,value FROM adm_config WHERE key LIKE ?").all(prefix + '%');
  } else {
    rows = db.prepare('SELECT key,value FROM adm_config').all();
  }
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); }
    catch { result[row.key] = row.value; }
  }
  res.json({ config: result });
});

router.put('/config', express.json({ limit: '2mb' }), (req, res) => {
  const updates = req.body || {};
  for (const [key, value] of Object.entries(updates)) {
    if (typeof key !== 'string' || key.length > 100) continue;
    setConfig(key, value);
  }
  auditLog(req.adminUser.id, 'CONFIG_UPDATE', Object.keys(updates).join(', '), req.ip);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — FEATURE FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/feature-flags', (_req, res) => {
  const flags = db.prepare('SELECT * FROM adm_feature_flags ORDER BY key').all();
  res.json({ flags });
});

router.put('/feature-flags', express.json(), (req, res) => {
  const updates = req.body || {};
  for (const [key, enabled] of Object.entries(updates)) {
    setFlag(key, enabled);
  }
  auditLog(req.adminUser.id, 'FLAG_UPDATE', Object.keys(updates).join(', '), req.ip);
  res.json({ ok: true });
});

router.post('/feature-flags', express.json(), (req, res) => {
  const { key, enabled, description } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Key required' });
  setFlag(key, enabled, description);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/announcements', (_req, res) => {
  res.json({ announcements: db.prepare('SELECT * FROM adm_announcements ORDER BY created_at DESC').all() });
});
router.post('/announcements', express.json(), (req, res) => {
  const { message, type, starts_at, ends_at } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required' });
  const info = db.prepare(
    'INSERT INTO adm_announcements (message,type,active,starts_at,ends_at) VALUES (?,?,0,?,?)'
  ).run(sanitizeText(message), type || 'info', starts_at || null, ends_at || null);
  res.json({ id: info.lastInsertRowid });
});
router.put('/announcements/:id', express.json(), (req, res) => {
  const d = req.body;
  db.prepare(
    'UPDATE adm_announcements SET message=?,type=?,active=?,starts_at=?,ends_at=? WHERE id=?'
  ).run(d.message, d.type || 'info', d.active ? 1 : 0, d.starts_at || null, d.ends_at || null, req.params.id);
  res.json({ ok: true });
});
router.delete('/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM adm_announcements WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — TOOL OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/tools', (_req, res) => {
  const overrides = db.prepare('SELECT * FROM adm_tool_overrides').all();
  const map = {};
  for (const o of overrides) map[o.tool_id] = o;
  res.json({ overrides: map });
});

router.put('/tools/:toolId', express.json(), (req, res) => {
  const { toolId } = req.params;
  const d = req.body;
  db.prepare(`
    INSERT INTO adm_tool_overrides
      (tool_id,visible,featured,beta,sort_order,custom_description,custom_badge,updated_at)
    VALUES (?,?,?,?,?,?,?,strftime('%s','now'))
    ON CONFLICT(tool_id) DO UPDATE SET
      visible=excluded.visible, featured=excluded.featured, beta=excluded.beta,
      sort_order=excluded.sort_order, custom_description=excluded.custom_description,
      custom_badge=excluded.custom_badge, updated_at=excluded.updated_at
  `).run(
    toolId,
    d.visible  != null ? (d.visible  ? 1 : 0) : 1,
    d.featured != null ? (d.featured ? 1 : 0) : 0,
    d.beta     != null ? (d.beta     ? 1 : 0) : 0,
    d.sort_order || 0,
    d.custom_description || '',
    d.custom_badge       || '',
  );
  auditLog(req.adminUser.id, 'TOOL_UPDATE', toolId, req.ip);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — MEDIA
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/media', (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const off   = (parseInt(page) - 1) * parseInt(limit);
  const files = db.prepare('SELECT * FROM adm_media ORDER BY created_at DESC LIMIT ? OFFSET ?').all(parseInt(limit), off);
  const total = db.prepare('SELECT COUNT(*) as c FROM adm_media').get()?.c || 0;
  res.json({ files, total });
});

router.post('/media/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid image file provided.' });
  const url = `/admin/uploads/${req.file.filename}`;
  const info = db.prepare(`
    INSERT INTO adm_media (filename,original_name,filepath,url,mime_type,size,alt_text,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(req.file.filename, req.file.originalname, req.file.path, url,
         req.file.mimetype, req.file.size, req.body?.alt_text || '', req.adminUser.id);
  res.json({ id: info.lastInsertRowid, url, filename: req.file.filename });
});

router.put('/media/:id', express.json(), (req, res) => {
  db.prepare('UPDATE adm_media SET alt_text=? WHERE id=?').run(req.body?.alt_text || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/media/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM adm_media WHERE id=?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  try { fs.unlinkSync(file.filepath); } catch {}
  db.prepare('DELETE FROM adm_media WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/analytics', (req, res) => {
  const days       = parseInt(req.query.days || '30');
  const range      = req.query.range   || '';
  const fromParam  = req.query.from    || '';
  const toParam    = req.query.to      || '';
  const toolFilter = req.query.tool    || '';
  const uaFilter   = req.query.ua      || '';

  const nowSec = Math.floor(Date.now() / 1000);
  let since, until;

  if (range === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    since = Math.floor(d.getTime() / 1000);
    until = nowSec;
  } else if (range === 'yesterday') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    until = Math.floor(d.getTime() / 1000) - 1;
    since = until - 86399;
  } else if (fromParam && toParam) {
    since = Math.floor(new Date(fromParam).getTime() / 1000);
    until = Math.floor(new Date(toParam + 'T23:59:59').getTime() / 1000);
    if (isNaN(since) || isNaN(until)) {
      since = Math.floor((Date.now() - days * 86400000) / 1000);
      until = nowSec;
    }
  } else {
    since = Math.floor((Date.now() - days * 86400000) / 1000);
    until = nowSec;
  }

  // Build parameterized WHERE clause with optional filters
  const clauses = ['created_at>?', 'created_at<=?'];
  const params  = [since, until];
  if (toolFilter) { clauses.push('tool_id=?');  params.push(toolFilter); }
  if (uaFilter)   { clauses.push('ua_type=?');  params.push(uaFilter);  }
  const baseWhere = clauses.join(' AND ');

  const toolUsage = db.prepare(
    `SELECT tool_id, COUNT(*) as c FROM adm_analytics WHERE event='tool_use' AND ${baseWhere} GROUP BY tool_id ORDER BY c DESC LIMIT 15`
  ).all(...params);

  const dailyEvents = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') as day, COUNT(*) as c FROM adm_analytics WHERE ${baseWhere} GROUP BY day ORDER BY day`
  ).all(...params);

  const uaBreakdown = db.prepare(
    `SELECT ua_type, COUNT(*) as c FROM adm_analytics WHERE ${baseWhere} GROUP BY ua_type`
  ).all(...params);

  const totalEvents = db.prepare(
    `SELECT COUNT(*) as c FROM adm_analytics WHERE ${baseWhere}`
  ).get(...params)?.c || 0;

  // Distinct tool IDs for the filter dropdown (all time, top 50)
  const toolIds = db.prepare(
    "SELECT DISTINCT tool_id FROM adm_analytics WHERE tool_id IS NOT NULL ORDER BY tool_id LIMIT 50"
  ).all().map(r => r.tool_id);

  // Event type breakdown for summary
  const eventBreakdown = db.prepare(
    `SELECT event, COUNT(*) as c FROM adm_analytics WHERE ${baseWhere} GROUP BY event ORDER BY c DESC LIMIT 10`
  ).all(...params);

  res.json({ toolUsage, dailyEvents, uaBreakdown, totalEvents, eventBreakdown, toolIds, days, since, until });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8B — ECONOMY ANALYTICS (Phase 27)
// Credits · Savings · Donations · Ads · GPU · PWA · Abuse Detection
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/analytics/economy', (req, res) => {
  const days  = Math.min(365, Math.max(1, parseInt(req.query.days || '30')));
  const since = Math.floor((Date.now() - days * 86400000) / 1000);

  const q = (sql, ...p) => { try { return db.prepare(sql).get(...p) || {}; } catch { return {}; } };
  const a = (sql, ...p) => { try { return db.prepare(sql).all(...p) || []; } catch { return []; } };

  // ── Economy KPIs ──
  const rewardsTotal     = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='credits_rewarded' AND created_at>?", since).c || 0;
  const savingsTotal     = q("SELECT COALESCE(SUM(savings_pkr),0) as s FROM adm_analytics WHERE event='savings_added' AND created_at>?", since).s || 0;
  const donationsClicked = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='donation_clicked' AND created_at>?", since).c || 0;
  const quotaExceeded    = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='quota_exceeded' AND created_at>?", since).c || 0;
  const adShown          = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='ad_shown' AND created_at>?", since).c || 0;
  const adCompleted      = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='ad_completed' AND created_at>?", since).c || 0;
  const pwaInstalls      = q("SELECT COUNT(*) as c FROM adm_analytics WHERE event='pwa_installed' AND created_at>?", since).c || 0;

  // ── Unique users / fingerprints ──
  const uniqueFingerprints = q("SELECT COUNT(DISTINCT fp_hash) as c FROM adm_analytics WHERE fp_hash IS NOT NULL AND created_at>?", since).c || 0;
  const activeUsers        = q("SELECT COUNT(DISTINCT uid) as c FROM adm_analytics WHERE uid IS NOT NULL AND uid!='' AND created_at>?", since).c || 0;
  const lowTrustCount      = q("SELECT COUNT(DISTINCT fp_hash) as c FROM adm_analytics WHERE trust_score<50 AND trust_score>=0 AND fp_hash IS NOT NULL AND created_at>?", since).c || 0;

  // ── GPU tier breakdown ──
  const gpuBreakdown = a("SELECT gpu_tier, COUNT(*) as c FROM adm_analytics WHERE gpu_tier IS NOT NULL AND created_at>? GROUP BY gpu_tier ORDER BY c DESC", since);

  // ── Trust distribution ──
  const trustDist = a(`
    SELECT
      CASE WHEN trust_score>=90 THEN 'high'
           WHEN trust_score>=60 THEN 'medium'
           WHEN trust_score>=0  THEN 'low'
           ELSE 'unknown' END as tier,
      COUNT(DISTINCT fp_hash) as c
    FROM adm_analytics WHERE created_at>? GROUP BY tier`, since);

  // ── Abuse detection — reward farming (>3 rewards from same fingerprint) ──
  const abuseSuspects = a(`
    SELECT fp_hash, COUNT(*) as reward_count
    FROM adm_analytics
    WHERE event='credits_rewarded' AND fp_hash IS NOT NULL AND fp_hash!='' AND created_at>?
    GROUP BY fp_hash HAVING COUNT(*)>3
    ORDER BY reward_count DESC LIMIT 10`, since)
    .map(r => ({ fp: (r.fp_hash || '').slice(-10), rewards: r.reward_count }));

  // ── Top donation providers ──
  const donationProviders = a(`
    SELECT json_extract(extra,'$.provider') as provider, COUNT(*) as c
    FROM adm_analytics WHERE event='donation_clicked' AND extra IS NOT NULL AND created_at>?
    GROUP BY provider ORDER BY c DESC LIMIT 8`, since);

  // ── Daily reward trend (last 14 days) ──
  const rewardTrend = a(`
    SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') as day, COUNT(*) as c
    FROM adm_analytics WHERE event='credits_rewarded' AND created_at>?
    GROUP BY day ORDER BY day`, Math.floor((Date.now() - 14 * 86400000) / 1000));

  res.json({
    days, rewardsTotal, savingsTotal, donationsClicked, quotaExceeded,
    adShown, adCompleted, pwaInstalls,
    uniqueFingerprints, activeUsers, lowTrustCount,
    gpuBreakdown, trustDist, abuseSuspects, donationProviders, rewardTrend,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — SYSTEM HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/health', (_req, res) => {
  const mem      = process.memoryUsage();
  const uptime   = process.uptime();
  const dbPath   = path.join(__dirname, '..', '.data', 'app.db');
  const dbSize   = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const uploadsDir = path.join(__dirname, '..', 'tmp', 'ilovepdf-uploads');
  let uploadsCount = 0, uploadsSize = 0;
  try {
    const files = fs.readdirSync(uploadsDir);
    uploadsCount = files.length;
    for (const f of files) {
      try { uploadsSize += fs.statSync(path.join(uploadsDir, f)).size; } catch {}
    }
  } catch {}

  const recentErrors = db.prepare(
    "SELECT * FROM adm_logs WHERE action LIKE 'ERROR%' ORDER BY created_at DESC LIMIT 10"
  ).all();

  res.json({
    uptime: Math.round(uptime),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
    },
    os: {
      platform: process.platform,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
      freeMemGB:  (os.freemem()  / 1024 / 1024 / 1024).toFixed(2),
      loadAvg: os.loadavg().map(n => n.toFixed(2)),
    },
    db: {
      sizeMB: (dbSize / 1024 / 1024).toFixed(2),
      users:  db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0,
      posts:  db.prepare('SELECT COUNT(*) as c FROM adm_blog_posts').get()?.c || 0,
    },
    uploads: {
      count: uploadsCount,
      sizeMB: (uploadsSize / 1024 / 1024).toFixed(2),
    },
    recentErrors,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/logs', (req, res) => {
  const { page = 1, limit = 50, action } = req.query;
  const off = (parseInt(page) - 1) * parseInt(limit);
  let sql = 'SELECT l.*, u.username FROM adm_logs l LEFT JOIN adm_users u ON l.user_id=u.id';
  const params = [];
  if (action) { sql += ' WHERE l.action LIKE ?'; params.push(`%${action}%`); }
  sql += ' ORDER BY l.created_at DESC';
  sql += ` LIMIT ${parseInt(limit)} OFFSET ${off}`;
  const logs  = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM adm_logs').get()?.c || 0;
  res.json({ logs, total });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — BACKUP & EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/backup/export', (req, res) => {
  const posts    = db.prepare('SELECT * FROM adm_blog_posts').all();
  const cats     = db.prepare('SELECT * FROM adm_blog_categories').all();
  const config   = db.prepare('SELECT * FROM adm_config').all();
  const flags    = db.prepare('SELECT * FROM adm_feature_flags').all();
  const tools    = db.prepare('SELECT * FROM adm_tool_overrides').all();
  const anns     = db.prepare('SELECT * FROM adm_announcements').all();

  const payload = JSON.stringify({ posts, cats, config, flags, tools, anns, exportedAt: new Date().toISOString() }, null, 2);
  const filename = `ilovepdf-backup-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  auditLog(req.adminUser.id, 'BACKUP_EXPORT', '', req.ip);
  res.send(payload);
});

router.post('/backup/import', express.json({ limit: '20mb' }), (req, res) => {
  const data = req.body;
  if (!data || !data.exportedAt) return res.status(400).json({ error: 'Invalid backup file' });

  const importTx = db.transaction(() => {
    if (data.config) {
      for (const row of data.config) setConfig(row.key, row.value);
    }
    if (data.flags) {
      for (const row of data.flags) setFlag(row.key, row.enabled, row.description);
    }
    if (data.cats) {
      for (const c of data.cats) {
        try {
          db.prepare('INSERT OR IGNORE INTO adm_blog_categories (name,slug,description) VALUES (?,?,?)').run(c.name, c.slug, c.description);
        } catch {}
      }
    }
    if (data.posts) {
      for (const p of data.posts) {
        try {
          db.prepare('INSERT OR IGNORE INTO adm_blog_posts (title,slug,content,excerpt,status,featured,category_id,tags,meta_title,meta_description,og_image,thumbnail,author,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
            p.title, p.slug, p.content, p.excerpt, p.status, p.featured, p.category_id,
            p.tags, p.meta_title, p.meta_description, p.og_image, p.thumbnail, p.author,
            p.published_at, p.created_at, p.updated_at
          );
        } catch {}
      }
    }
  });
  importTx();
  auditLog(req.adminUser.id, 'BACKUP_IMPORT', `Imported from ${data.exportedAt}`, req.ip);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — PASSWORD CHANGE
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/auth/change-password', express.json(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM adm_users WHERE id=?').get(req.adminUser.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect.' });
  const err = validatePassword(newPassword);
  if (err) return res.status(400).json({ error: err });
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE adm_users SET password_hash=? WHERE id=?').run(hash, user.id);
  // Invalidate all other sessions
  db.prepare('DELETE FROM adm_sessions WHERE user_id=? AND token!=?').run(user.id, req.adminSession);
  auditLog(user.id, 'PASSWORD_CHANGE', '', req.ip);
  res.json({ ok: true });
});

// ── Utilities ─────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — RUNTIME DIAGNOSTICS SNAPSHOT
// Returns server-side process/memory/env data for the admin diagnostics panel.
// Protected by adminGuard (already applied via router.use above).
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/diagnostics/snapshot', (req, res) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      ts:          Date.now(),
      uptimeSec:   Math.round(process.uptime()),
      nodeVersion: process.version,
      platform:    process.platform,
      arch:        process.arch,
      env:         process.env.NODE_ENV || 'development',
      memoryMB: {
        rss:       Math.round(mem.rss        / 1048576),
        heapUsed:  Math.round(mem.heapUsed   / 1048576),
        heapTotal: Math.round(mem.heapTotal  / 1048576),
        external:  Math.round(mem.external   / 1048576),
      },
      loadAvg:    os.loadavg().map(v => Math.round(v * 100) / 100),
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB:  Math.round(os.freemem()  / 1048576),
      cpus:       os.cpus().length,
    });
  } catch (e) {
    res.status(500).json({ error: 'diagnostics unavailable', detail: e.message });
  }
});

function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function sanitizeText(t) {
  return String(t || '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').trim();
}

function safeParse(json, def) {
  try { return JSON.parse(json); } catch { return def; }
}

function estimateReadTime(html) {
  const text  = html.replace(/<[^>]+>/g, ' ');
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

export default router;
