import db from './db.js';

export const FEATURE_FLAG_ALLOWLIST = ['new_ui', 'maintenance_mode', 'beta_tools', 'ads_enabled', 'analytics_enabled'];

export function getConfig(key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM adm_settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

export function setConfig(key, value) {
  try {
    const serialized = JSON.stringify(value);
    db.prepare(`
      INSERT INTO adm_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, serialized);
    return true;
  } catch (_) {
    return false;
  }
}

export function getFlag(key, defaultValue = false) {
  const flags = getConfig('feature_flags', {});
  return flags[key] !== undefined ? flags[key] : defaultValue;
}

export function setFlag(key, value) {
  const flags = getConfig('feature_flags', {});
  flags[key] = Boolean(value);
  return setConfig('feature_flags', flags);
}

export function auditLog(userId, action, details = '', ip = '') {
  try {
    db.prepare('INSERT INTO adm_logs (user_id, action, details, ip) VALUES (?, ?, ?, ?)').run(
      userId || 0,
      action || 'unknown',
      typeof details === 'object' ? JSON.stringify(details) : String(details),
      ip || '127.0.0.1'
    );
  } catch (_) {}
}
