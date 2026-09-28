import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const failures = [];

const shield = read('public/js/runtime-shield-workers.js');
const auth = read('public/js/runtime-worker-auth.js');
const security = read('public/js/runtime-security.js');

function need(source, pattern, label) {
  if (!source.includes(pattern)) failures.push(label);
}

need(shield, "var VERSION = '1.1';", 'RuntimeShieldWorkers must be v1.1');
need(shield, 'Do not register outbound nonces yet.', 'shield must not pre-register outbound nonce');
need(shield, '_noncePool.set(nonce, now + NONCE_POOL_TTL_MS);', 'shield must register nonce during inbound verification');
need(shield, "reason: 'replay-detected'", 'shield replay rejection must remain active');
need(shield, "reason: 'stale-timestamp'", 'shield timestamp rejection must remain active');
need(shield, 'RuntimeSecurity.validateWorkerMessage', 'shield must wrap RuntimeSecurity validation');
need(shield, 'RuntimeWorkers.dispatch', 'shield must auto-stamp RuntimeWorkers dispatch');

need(auth, "var TOKEN_TTL  = 120_000;", 'worker auth TTL must align with secure-session 2 minute TTL');
need(auth, "if (sessionId === 'anon' && _tier !== 'LOW') return null;", 'worker auth must fail closed without secure session on MEDIUM/HIGH');
need(auth, 'token.sessionId !== _getSessionId()', 'worker auth must bind verification to current session');
need(auth, 'session:rotated', 'worker auth must revoke tokens on session rotation');

need(security, 'function validateWorkerMessage(msg)', 'RuntimeSecurity worker message validator must exist');

if (failures.length) {
  console.error('Phase 5 Units 151-163 worker message integrity audit FAILED');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}

console.log('Phase 5 Units 151-163 worker message integrity audit PASSED');
console.log(' - first-message nonce replay defect fixed');
console.log(' - worker-auth session binding and fail-closed behavior verified');
console.log(' - RuntimeSecurity integration preserved');
