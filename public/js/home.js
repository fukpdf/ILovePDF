/* Homepage-only logic — Recent Use section, category sections, calculators.
   Header + auth modal live in chrome.js (loaded on every page). */

const homeToolUrl = t => t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);

/* ─── RECENT USE — localStorage helpers ────────────────────────────────── */
const RECENT_KEY = 'ilpdf_recent_v1';

function getRecentTools() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}

/* Build a flat map: id/url-slug → tool object from TOOL_GROUPS */
function buildToolMap() {
  const map = {};
  (window.TOOL_GROUPS || []).forEach(g => {
    (g.items || []).forEach(t => {
      if (t.tid) map[t.tid] = t;
      if (t.url) map[t.url.replace(/^\/+/, '')] = t;
    });
  });
  return map;
}

/* Safe i18n with humanised-key guard (prevents blank cards on cold cache) */
const t18 = (key, fallback) => {
  if (!window.t) return fallback;
  const v = window.t(key);
  if (!v || v === key) return fallback;
  const lastSeg = key.split('.').pop();
  const humanised = lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1).replace(/_/g, ' ');
  if (v === humanised) return fallback;
  return v;
};

/* PLACEHOLDER - full content too large for single call - will split */
