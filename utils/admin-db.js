// Admin database schema — extends the main SQLite DB with admin-specific tables.
// All tables are prefixed with `adm_` to avoid collisions with the main schema.
import db from './db.js';

db.exec(`
  -- Admin users (site owner accounts)
  CREATE TABLE IF NOT EXISTS adm_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_login    INTEGER
  );

  -- Admin sessions (token-based, httpOnly cookie)
  CREATE TABLE IF NOT EXISTS adm_sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    last_active INTEGER NOT NULL,
    ip          TEXT,
    user_agent  TEXT
  );

  -- Login attempt tracking (brute-force protection)
  CREATE TABLE IF NOT EXISTS adm_login_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ip           TEXT NOT NULL,
    username     TEXT,
    attempted_at INTEGER NOT NULL,
    success      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_adm_attempts_ip ON adm_login_attempts(ip, attempted_at);

  -- Audit log
  CREATE TABLE IF NOT EXISTS adm_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    action     TEXT NOT NULL,
    details    TEXT,
    ip         TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_adm_logs_created ON adm_logs(created_at DESC);

  -- Blog categories
  CREATE TABLE IF NOT EXISTS adm_blog_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Blog posts
  CREATE TABLE IF NOT EXISTS adm_blog_posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    slug             TEXT UNIQUE NOT NULL,
    content          TEXT,
    excerpt          TEXT,
    status           TEXT NOT NULL DEFAULT 'draft',
    featured         INTEGER NOT NULL DEFAULT 0,
    category_id      INTEGER,
    tags             TEXT DEFAULT '[]',
    meta_title       TEXT,
    meta_description TEXT,
    og_image         TEXT,
    thumbnail        TEXT,
    author           TEXT DEFAULT 'Admin',
    read_time        INTEGER DEFAULT 0,
    views            INTEGER DEFAULT 0,
    published_at     INTEGER,
    scheduled_at     INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_adm_posts_status  ON adm_blog_posts(status);
  CREATE INDEX IF NOT EXISTS idx_adm_posts_slug    ON adm_blog_posts(slug);

  -- Media files
  CREATE TABLE IF NOT EXISTS adm_media (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    original_name TEXT,
    filepath      TEXT NOT NULL,
    url           TEXT NOT NULL,
    mime_type     TEXT,
    size          INTEGER,
    width         INTEGER,
    height        INTEGER,
    alt_text      TEXT DEFAULT '',
    uploaded_by   INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Key-value config store (all site settings)
  CREATE TABLE IF NOT EXISTS adm_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Feature flags
  CREATE TABLE IF NOT EXISTS adm_feature_flags (
    key         TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Site announcements
  CREATE TABLE IF NOT EXISTS adm_announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'info',
    active     INTEGER NOT NULL DEFAULT 0,
    starts_at  INTEGER,
    ends_at    INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Tool overrides (visibility, featured, sort order, etc.)
  CREATE TABLE IF NOT EXISTS adm_tool_overrides (
    tool_id            TEXT PRIMARY KEY,
    visible            INTEGER NOT NULL DEFAULT 1,
    featured           INTEGER NOT NULL DEFAULT 0,
    beta               INTEGER NOT NULL DEFAULT 0,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    custom_description TEXT,
    custom_badge       TEXT,
    updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Analytics events (lightweight, privacy-first)
  CREATE TABLE IF NOT EXISTS adm_analytics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event      TEXT NOT NULL,
    tool_id    TEXT,
    path       TEXT,
    referrer   TEXT,
    ua_type    TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_adm_analytics_event   ON adm_analytics(event, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_adm_analytics_tool    ON adm_analytics(tool_id, created_at DESC);
`);

// ─── Config helpers ───────────────────────────────────────────────────────────

export function getConfig(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM adm_config WHERE key=?').get(key);
  if (!row) return defaultVal;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setConfig(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO adm_config (key, value, updated_at) VALUES (?,?,strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, v);
}

export function getFlag(key, defaultVal = false) {
  const row = db.prepare('SELECT enabled FROM adm_feature_flags WHERE key=?').get(key);
  return row ? !!row.enabled : defaultVal;
}

export function setFlag(key, enabled, description = '') {
  db.prepare(`
    INSERT INTO adm_feature_flags (key, enabled, description, updated_at)
    VALUES (?,?,?,strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at
  `).run(key, enabled ? 1 : 0, description);
}

// ─── Audit logger ─────────────────────────────────────────────────────────────

export function auditLog(userId, action, details = '', ip = '') {
  try {
    db.prepare(
      'INSERT INTO adm_logs (user_id,action,details,ip) VALUES (?,?,?,?)'
    ).run(userId || null, action, details || '', ip || '');
  } catch (e) {
    console.error('[admin-log] failed:', e.message);
  }
}

// ─── Seed default config ─────────────────────────────────────────────────────

const DEFAULTS = {
  'site.maintenance_mode':   false,
  'site.maintenance_message': 'We are currently performing maintenance. Please check back shortly.',
  'site.name':               'ILovePDF',
  'site.tagline':            'Every PDF & Image Tool You\'ll Ever Need',
  'site.hero_text':          'Merge, split, compress, convert, edit, sign and protect — plus AI summarizer, OCR and a full image suite.',
  'site.footer_text':        '© 2024 ILovePDF. All rights reserved.',
  'site.support_email':      '',
  'brand.primary_color':     '#4f46e5',
  'brand.logo_url':          '/favicon.svg',
  'brand.founder_name':      '',
  'brand.founder_image':     '',
  'brand.twitter_url':       '',
  'brand.github_url':        '',
  'brand.buymeacoffee_url':  'https://buymeacoffee.com/ilovepdf',
  'ads.enabled':             false,
  'ads.adsense_client':      '',
  'ads.homepage_slot':       '',
  'ads.sidebar_slot':        '',
  'ads.in_content_slot':     '',
  'ads.footer_slot':         '',
  'donate.enabled':          false,
  'donate.url':              'https://buymeacoffee.com/ilovepdf',
  'donate.message':          'Support the project!',
  'seo.global_title':        'ILovePDF — Free Online PDF & Image Tools',
  'seo.global_description':  'Free online PDF tools: Merge, Split, Compress, Convert, Edit, Watermark, Sign, Protect, OCR, AI Summarize and more.',
  'seo.og_image':            '',
  'seo.google_analytics_id': '',
  'seo.google_search_console': '',
};

for (const [key, val] of Object.entries(DEFAULTS)) {
  const exists = db.prepare('SELECT 1 FROM adm_config WHERE key=?').get(key);
  if (!exists) setConfig(key, val);
}

// ─── Seed default feature flags ───────────────────────────────────────────────

const DEFAULT_FLAGS = [
  { key: 'blog_enabled',       desc: 'Enable the blog section',                    val: 1 },
  { key: 'ads_enabled',        desc: 'Enable ad slots across the site',             val: 0 },
  { key: 'donate_button',      desc: 'Show the donate / Buy Me a Coffee button',    val: 0 },
  { key: 'maintenance_mode',   desc: 'Put the site into maintenance mode',          val: 0 },
  { key: 'user_registration',  desc: 'Allow new users to register',                 val: 1 },
  { key: 'google_signin',      desc: 'Enable Google Sign-In via Firebase',          val: 1 },
  { key: 'announcements',      desc: 'Show site-wide announcement banners',         val: 0 },
  { key: 'analytics_tracking', desc: 'Enable lightweight privacy-first analytics',  val: 1 },
  { key: 'ocr_tool',           desc: 'Enable OCR PDF tool',                         val: 1 },
  { key: 'ai_summarizer',      desc: 'Enable AI Summarizer tool',                   val: 1 },
];

for (const f of DEFAULT_FLAGS) {
  const exists = db.prepare('SELECT 1 FROM adm_feature_flags WHERE key=?').get(f.key);
  if (!exists) setFlag(f.key, f.val, f.desc);
}

export default db;
