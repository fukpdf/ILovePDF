import crypto from 'crypto';
import fs from 'fs';

const registry = new Map();

export function registerTempArtifact(filePath, metadata = {}) {
  const id = 'art_' + crypto.randomBytes(8).toString('hex');
  const record = {
    id,
    filePath,
    createdAt: Date.now(),
    owner: metadata.owner || 'system',
    kind: metadata.kind || 'temporary-artifact',
    meta: metadata,
  };
  registry.set(id, record);
  return id;
}

export function releaseTempArtifact(idOrPath) {
  if (!idOrPath) return false;
  let targetId = null;
  let targetRecord = null;

  if (registry.has(idOrPath)) {
    targetId = idOrPath;
    targetRecord = registry.get(idOrPath);
  } else {
    for (const [id, rec] of registry.entries()) {
      if (rec.filePath === idOrPath) {
        targetId = id;
        targetRecord = rec;
        break;
      }
    }
  }

  if (targetRecord) {
    registry.delete(targetId);
    try {
      if (fs.existsSync(targetRecord.filePath)) {
        fs.unlinkSync(targetRecord.filePath);
      }
    } catch (_) {}
    return true;
  }
  return false;
}

export function listTempArtifacts(filter = {}) {
  const list = Array.from(registry.values());
  if (filter.owner) return list.filter(r => r.owner === filter.owner);
  if (filter.kind) return list.filter(r => r.kind === filter.kind);
  return list;
}

export function getTempArtifact(id) {
  return registry.get(id) || null;
}
