/**
 * Phase 3 — shared file lifecycle primitives.
 *
 * User artifacts are temporary by default. This module centralizes registration,
 * release and safe cleanup without touching permanent/static application assets.
 */

const active = new Map();
let sequence = 0;

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
}

export function registerTempArtifact(path, meta = {}) {
  const filePath = normalizePath(path);
  if (!filePath) return null;
  const id = meta.id || `tmp_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
  active.set(id, {
    id,
    path: filePath,
    createdAt: Date.now(),
    kind: meta.kind || 'user-artifact',
    owner: meta.owner || null,
  });
  return id;
}

export function getTempArtifact(id) {
  return active.get(id) || null;
}

export function releaseTempArtifact(id) {
  if (!id) return false;
  return active.delete(id);
}

export function listTempArtifacts() {
  return Array.from(active.values()).map(item => ({ ...item }));
}

export function releaseAllTempArtifacts() {
  const items = listTempArtifacts();
  active.clear();
  return items;
}

export function lifecycleStats() {
  return { activeArtifacts: active.size };
}
