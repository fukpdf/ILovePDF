// Per-identity daily limits, mirroring utils/usage.js in the existing backend:
//   guest    — 10 files/day, 60 MB per file
//   free     — 30 files/day, 200 MB per file
//   premium  — unlimited
//
// Counters live in the same KV namespace as job records, keyed by date so
// they auto-rotate every 24 h via TTL.

const MB = 1024 * 1024;
export const LIMITS = {
  guest:   { files: 10,        perFile: 60  * MB },
  free:    { files: 30,        perFile: 200 * MB },
  premium: { files: Infinity,  perFile: 1024 * MB },
};

const today = () => new Date().toISOString().slice(0, 10);

function counterKey(identity) {
  if (identity.user_id) return `usage:${today()}:u:${identity.user_id}`;
  return `usage:${today()}:i:${identity.ip}`;
}

export async function checkAndConsume(env, identity, fileSize) {
  const tier = identity.plan || (identity.user_id ? 'free' : 'guest');
  const cap  = LIMITS[tier] || LIMITS.guest;
  if (fileSize > cap.perFile) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: `File exceeds the ${(cap.perFile / MB).toFixed(0)} MB per-file limit for the ${tier} tier.`,
      tier,
    };
  }
  if (cap.files === Infinity) return { ok: true, tier, used: 0, cap: cap.files };

  const key = counterKey(identity);
  const cur = Number((await env.PDF_STATUS.get(key)) || 0);
  if (cur >= cap.files) {
    return {
      ok: false,
      code: 'LIMIT_REACHED',
      message: `Daily limit of ${cap.files} files reached for the ${tier} tier. Try again tomorrow or upgrade.`,
      tier,
    };
  }
  // Increment with a fresh 25 h TTL — KV is eventually consistent so this
  // is best-effort; that's acceptable for daily quotas.
  await env.PDF_STATUS.put(key, String(cur + 1), { expirationTtl: 25 * 3600 });
  return { ok: true, tier, used: cur + 1, cap: cap.files };
}
