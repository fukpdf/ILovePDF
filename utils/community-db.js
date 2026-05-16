// Community Economy DB — Phase Community
// New tables: community_streaks, community_achievements
// Community stats are read from the existing adm_analytics table
// (event='savings_added', savings_pkr column) — no duplication.
import db from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS community_streaks (
    uid            TEXT PRIMARY KEY,
    current_streak INTEGER NOT NULL DEFAULT 1,
    last_active_ts INTEGER NOT NULL DEFAULT 0,
    max_streak     INTEGER NOT NULL DEFAULT 1,
    total_ops      INTEGER NOT NULL DEFAULT 0,
    total_savings  INTEGER NOT NULL DEFAULT 0,
    ai_ops         INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS community_achievements (
    uid            TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (uid, achievement_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ca_uid ON community_achievements(uid);
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStartSec() {
  const d = new Date(); d.setHours(0,0,0,0);
  return Math.floor(d.getTime() / 1000);
}

// ── Streak & stats ────────────────────────────────────────────────────────────

export function recordUserActivity(uid, { savingsPkr = 0, isAI = false } = {}) {
  if (!uid) return null;
  const now     = Math.floor(Date.now() / 1000);
  const today   = todayStartSec();
  const yest    = today - 86400;

  const row = db.prepare('SELECT * FROM community_streaks WHERE uid=?').get(uid);
  let streak = 1;
  if (row) {
    const lastDay = Math.floor(row.last_active_ts / 86400) * 86400;
    if (lastDay >= today)  { streak = row.current_streak; }           // same day
    else if (lastDay >= yest) { streak = row.current_streak + 1; }    // consecutive
    else                   { streak = 1; }                            // broken
  }

  const maxStreak = row ? Math.max(row.max_streak, streak) : streak;

  db.prepare(`
    INSERT INTO community_streaks
      (uid, current_streak, last_active_ts, max_streak, total_ops, total_savings, ai_ops, updated_at)
    VALUES (?,?,?,?,1,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET
      current_streak = ?,
      last_active_ts = ?,
      max_streak     = ?,
      total_ops      = total_ops + 1,
      total_savings  = total_savings + ?,
      ai_ops         = ai_ops + ?,
      updated_at     = ?
  `).run(
    uid, streak, now, maxStreak, savingsPkr, isAI ? 1 : 0, now,
    streak, now, maxStreak, savingsPkr, isAI ? 1 : 0, now
  );

  return { current_streak: streak, max_streak: maxStreak };
}

export function getUserStats(uid) {
  if (!uid) return null;
  return db.prepare('SELECT * FROM community_streaks WHERE uid=?').get(uid) || null;
}

// ── Achievements ──────────────────────────────────────────────────────────────

const ACHIEVEMENTS = [
  { id: 'first_tool',  name: 'First Tool Used',   icon: '🎯', color: '#10b981', savReq: 0,    opsReq: 1,  strReq: 0, aiReq: 0 },
  { id: 'saved_100',   name: 'Saved PKR 100',      icon: '💰', color: '#f59e0b', savReq: 100,  opsReq: 0,  strReq: 0, aiReq: 0 },
  { id: 'saved_500',   name: 'Saved PKR 500',      icon: '💎', color: '#3b82f6', savReq: 500,  opsReq: 0,  strReq: 0, aiReq: 0 },
  { id: 'saved_1000',  name: 'Saved PKR 1,000',    icon: '🏅', color: '#8b5cf6', savReq: 1000, opsReq: 0,  strReq: 0, aiReq: 0 },
  { id: 'ops_10',      name: '10 Tools Used',      icon: '⚡',  color: '#f59e0b', savReq: 0,    opsReq: 10, strReq: 0, aiReq: 0 },
  { id: 'ops_50',      name: '50 Tools Used',      icon: '🚀', color: '#4f46e5', savReq: 0,    opsReq: 50, strReq: 0, aiReq: 0 },
  { id: 'streak_3',    name: '3-Day Streak',        icon: '🔥', color: '#ef4444', savReq: 0,    opsReq: 0,  strReq: 3, aiReq: 0 },
  { id: 'streak_7',    name: '7-Day Streak',        icon: '💫', color: '#ec4899', savReq: 0,    opsReq: 0,  strReq: 7, aiReq: 0 },
  { id: 'ai_user',     name: 'AI Power User',       icon: '🤖', color: '#06b6d4', savReq: 0,    opsReq: 0,  strReq: 0, aiReq: 5 },
];

export function checkAndUnlockAchievements(uid) {
  const stats = getUserStats(uid);
  if (!stats) return [];

  const existing = new Set(
    db.prepare('SELECT achievement_id FROM community_achievements WHERE uid=?')
      .all(uid).map(r => r.achievement_id)
  );

  const now = Math.floor(Date.now() / 1000);
  const unlocked = [];

  for (const a of ACHIEVEMENTS) {
    if (existing.has(a.id)) continue;
    const ok = (
      (a.savReq === 0 || stats.total_savings >= a.savReq) &&
      (a.opsReq === 0 || stats.total_ops     >= a.opsReq) &&
      (a.strReq === 0 || stats.current_streak >= a.strReq) &&
      (a.aiReq  === 0 || stats.ai_ops        >= a.aiReq)
    );
    if (ok) {
      db.prepare('INSERT OR IGNORE INTO community_achievements (uid, achievement_id, unlocked_at) VALUES (?,?,?)')
        .run(uid, a.id, now);
      unlocked.push({ ...a });
    }
  }
  return unlocked;
}

export function getUserAchievements(uid) {
  const unlockedRows = db.prepare('SELECT achievement_id, unlocked_at FROM community_achievements WHERE uid=?').all(uid);
  const map = new Map(unlockedRows.map(r => [r.achievement_id, r.unlocked_at]));
  return ACHIEVEMENTS.map(a => ({ ...a, unlocked: map.has(a.id), unlocked_at: map.get(a.id) || null }));
}

// ── Community stats (from real adm_analytics data) ────────────────────────────

let _cache = null, _cacheTs = 0;

export function getCommunityStats(bust = false) {
  const now = Date.now();
  if (!bust && _cache && now - _cacheTs < 30000) return _cache;

  const todaySec  = todayStartSec();
  const fiveMinAgo = Math.floor(now / 1000) - 300;

  const q = (sql, ...args) => { try { return db.prepare(sql).get(...args) || {}; } catch { return {}; } };
  const all = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };

  const todaySav  = q(`SELECT COALESCE(SUM(savings_pkr),0) AS v FROM adm_analytics WHERE event='savings_added' AND created_at>=?`, todaySec).v || 0;
  const todayFiles= q(`SELECT COUNT(*) AS v FROM adm_analytics WHERE event='savings_added' AND created_at>=?`, todaySec).v || 0;
  const todayUsers= q(`SELECT COUNT(DISTINCT COALESCE(uid,fp_hash,'anon')) AS v FROM adm_analytics WHERE created_at>=?`, todaySec).v || 0;
  const liveUsers = q(`SELECT COUNT(DISTINCT COALESCE(uid,fp_hash,'anon')) AS v FROM adm_analytics WHERE created_at>=?`, fiveMinAgo).v || 0;

  const allSav    = q(`SELECT COALESCE(SUM(savings_pkr),0) AS v FROM adm_analytics WHERE event='savings_added'`).v || 0;
  const allFiles  = q(`SELECT COUNT(*) AS v FROM adm_analytics WHERE event='savings_added'`).v || 0;
  const allUsers  = q(`SELECT COUNT(DISTINCT COALESCE(uid,fp_hash)) AS v FROM adm_analytics WHERE uid IS NOT NULL OR fp_hash IS NOT NULL`).v || 0;
  const aiOps     = q(`SELECT COUNT(*) AS v FROM adm_analytics WHERE tool_id IN ('ocr','ai-summarize','translate','background-remover')`).v || 0;

  const activity  = all(`
    SELECT event, tool_id, savings_pkr, created_at
    FROM adm_analytics
    WHERE event='savings_added' AND savings_pkr > 0
    ORDER BY created_at DESC LIMIT 20
  `);

  const topTools  = all(`
    SELECT tool_id, COUNT(*) AS uses, COALESCE(SUM(savings_pkr),0) AS total_savings
    FROM adm_analytics WHERE tool_id IS NOT NULL AND savings_pkr > 0
    GROUP BY tool_id ORDER BY total_savings DESC LIMIT 10
  `);

  _cache = {
    today:   { files: todayFiles, savings: todaySav,  users: todayUsers, live: Math.max(1, liveUsers) },
    allTime: { files: allFiles,   savings: allSav,    users: allUsers,   aiOps },
    activity,
    topTools,
    ts: now,
  };
  _cacheTs = now;
  return _cache;
}
