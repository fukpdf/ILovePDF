import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '.data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_signups (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    storage_quota INTEGER NOT NULL DEFAULT 2147483648, -- 2 GB
    storage_used  INTEGER NOT NULL DEFAULT 0,
    avatar_url    TEXT,
    plan          TEXT NOT NULL DEFAULT 'free',
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// Idempotent migration — adds the `plan` column to legacy databases that
// were created before the tier system existed. SQLite's ADD COLUMN can't
// be wrapped in IF NOT EXISTS, so we probe pragma_table_info first.
try {
  const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all().map(r => r.name);
  if (!cols.includes('plan')) {
    db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
    console.log("[db] migrated: added users.plan column");
  }
} catch (e) {
  console.error('[db] migration check failed:', e.message);
}

export default db;
