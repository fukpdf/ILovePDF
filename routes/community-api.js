// Community Economy API — Phase Community
// Mounted at /api/community/*
// All endpoints are rate-limited by the global apiLimiter in server.js.
// No admin-only data is exposed — all responses are aggregate and anonymous.
import express from 'express';
import db from '../utils/db.js';
import {
  recordUserActivity,
  getUserStats,
  checkAndUnlockAchievements,
  getUserAchievements,
  getCommunityStats,
} from '../utils/community-db.js';

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeUid(req) {
  // Accept uid from body/query but cap length and strip anything dangerous
  const raw = (req.body?.uid || req.query?.uid || '').toString().slice(0, 64);
  return /^[a-zA-Z0-9_\-\.@]+$/.test(raw) ? raw : null;
}

function formatPKR(n) {
  if (n >= 1000000) return '₨' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return '₨' + (n / 1000).toFixed(1) + 'K';
  return '₨' + Math.round(n);
}

const AI_TOOLS = new Set(['ocr','ai-summarize','translate','background-remover']);

// ── GET /api/community/savings ─────────────────────────────────────────────────
// Used by RuntimeSavings.getCommunity() on every tool page.
router.get('/savings', (req, res) => {
  try {
    const stats = getCommunityStats();
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      total:     stats.allTime.savings,
      today:     stats.today.savings,
      currency:  'PKR',
      formatted: formatPKR(stats.allTime.savings),
      todayFormatted: formatPKR(stats.today.savings),
    });
  } catch (e) {
    res.status(500).json({ error: 'stats unavailable' });
  }
});

// ── POST /api/community/savings/add ───────────────────────────────────────────
// Called by RuntimeSavings.reportToCommunity() after each tool completion.
// The actual DB recording to adm_analytics happens in runtime-analytics.js on
// the frontend (via /api/admin/analytics/event). This endpoint handles:
//   1. Streak / stats update in community_streaks
//   2. Achievement check
//   3. Returns updated user state for the client
router.post('/savings/add', (req, res) => {
  try {
    const { uid, amount, slug } = req.body || {};
    const pkr   = Math.min(10000, Math.max(0, Number(amount) || 0));
    const isAI  = AI_TOOLS.has(slug || '');
    const safeId = safeUid({ body: { uid } });

    let streakInfo = null;
    let achievements = [];
    if (safeId && pkr > 0) {
      streakInfo   = recordUserActivity(safeId, { savingsPkr: pkr, isAI });
      achievements = checkAndUnlockAchievements(safeId);
    }

    res.json({
      ok:           true,
      streak:       streakInfo,
      achievements, // newly unlocked this request
    });
  } catch (e) {
    // Never fail silently in ways that would break the frontend
    res.status(500).json({ error: 'record failed', detail: e.message });
  }
});

// ── GET /api/community/stats ───────────────────────────────────────────────────
// Real-time aggregate stats. Polled every 10s by community-economy.js.
router.get('/stats', (req, res) => {
  try {
    const stats = getCommunityStats();
    res.set('Cache-Control', 'public, max-age=20');
    res.json({
      today: {
        files:   stats.today.files,
        savings: stats.today.savings,
        savingsFormatted: formatPKR(stats.today.savings),
        users:   stats.today.users,
        live:    stats.today.live,
      },
      allTime: {
        files:   stats.allTime.files,
        savings: stats.allTime.savings,
        savingsFormatted: formatPKR(stats.allTime.savings),
        users:   stats.allTime.users,
        aiOps:   stats.allTime.aiOps,
      },
      topTools: stats.topTools,
      ts:       stats.ts,
    });
  } catch (e) {
    res.status(500).json({ error: 'stats unavailable' });
  }
});

// ── GET /api/community/activity ────────────────────────────────────────────────
// Recent activity feed for the live ticker.
router.get('/activity', (req, res) => {
  try {
    const stats = getCommunityStats();
    const items = (stats.activity || []).map(r => ({
      tool:    r.tool_id,
      savings: r.savings_pkr,
      ts:      r.created_at,
    }));
    res.set('Cache-Control', 'public, max-age=20');
    res.json({ items });
  } catch (e) {
    res.json({ items: [] });
  }
});

// ── GET /api/community/user/:uid ──────────────────────────────────────────────
// User-specific stats + achievements. Called when dashboard modal opens.
router.get('/user/:uid', (req, res) => {
  const uid = safeUid({ body: {}, query: { uid: req.params.uid } });
  if (!uid) return res.status(400).json({ error: 'invalid uid' });

  try {
    const stats    = getUserStats(uid);
    const achievements = getUserAchievements(uid);
    res.set('Cache-Control', 'private, max-age=30');
    res.json({ stats, achievements });
  } catch (e) {
    res.status(500).json({ error: 'user data unavailable' });
  }
});

// ── GET /api/community/leaderboard ────────────────────────────────────────────
// Top tools by savings — for admin analytics.
router.get('/leaderboard', (req, res) => {
  try {
    const stats = getCommunityStats();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ topTools: stats.topTools || [] });
  } catch (e) {
    res.json({ topTools: [] });
  }
});

export default router;
