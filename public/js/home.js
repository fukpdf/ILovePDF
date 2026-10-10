/* Homepage-only logic — Recent Use section, category sections, calculators.
   Header + auth modal live in chrome.js (loaded on every page). */

const homeToolUrl = t => t.url || (t.slug ? `/${t.slug}` : `/tool.html?id=${t.tid}`);

/* RESTORE IN PROGRESS - full file via user manual restore required if this fails */
console.error('[ILovePDF] home.js was truncated during an automated edit. Please restore from commit e8e860a0ffeeb997597c6cd1caa6f3b4eab03ed6');
