import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const factory = fs.readFileSync(path.join(root, 'public/js/runtime-worker-factory.js'), 'utf8');
const session = fs.readFileSync(path.join(root, 'public/js/runtime-secure-session.js'), 'utf8');
const sandbox = fs.readFileSync(path.join(root, 'public/js/runtime-execution-sandbox.js'), 'utf8');

const required = [
  [factory, "VERSION = '2.1'", 'worker factory version'],
  [factory, 'function _authorize(urlStr)', 'factory authorization helper'],
  [factory, 'RuntimeSecureSession', 'secure session integration'],
  [factory, 'secure-session-unavailable', 'fail-closed unavailable marker'],
  [factory, 'secure-session-authorization-denied', 'fail-closed denied marker'],
  [factory, 'if (_lite) return { ok: true', 'LOW tier passthrough'],
  [factory, '_recordSecurityBlock(urlStr, auth.reason)', 'security block audit'],
  [session, 'function authorizeWorker(workerUrl)', 'secure session worker authorization'],
  [session, 'WORKER_TOKEN_TTL', 'worker token TTL'],
  [sandbox, "_tier !== 'LOW'", 'sandbox non-low tier guard'],
  [sandbox, 'ss.authorizeWorker(url)', 'sandbox worker authorization'],
];
const failures = required.filter(([src, needle]) => !src.includes(needle));
if (failures.length) {
  console.error('Worker factory security contract FAILED');
  for (const [, needle, label] of failures) console.error('- missing:', label, needle);
  process.exit(1);
}
console.log('Worker factory security contract PASSED');
console.log('Units 138-150 contract: secure-session authorization enforced for MEDIUM/HIGH worker construction; LOW passthrough preserved.');
