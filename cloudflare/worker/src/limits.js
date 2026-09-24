// Queue compatibility limits module.
// No artificial file-size or daily-use caps are enforced here.
export const LIMITS = Object.freeze({
  guest: { files: Infinity, perFile: Infinity },
  free: { files: Infinity, perFile: Infinity },
  premium: { files: Infinity, perFile: Infinity },
});
export async function checkAndConsume(_env, identity) {
  const tier = identity?.plan || (identity?.user_id ? 'free' : 'guest');
  return { ok: true, tier, used: 0, cap: Infinity };
}
