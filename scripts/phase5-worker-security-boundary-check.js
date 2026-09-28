import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sandbox = fs.readFileSync(path.join(root, 'public/js/runtime-execution-sandbox.js'), 'utf8');
const session = fs.readFileSync(path.join(root, 'public/js/runtime-secure-session.js'), 'utf8');

const failures = [];
const requireText = (text, needle, label) => {
  if (!text.includes(needle)) failures.push(label);
};

requireText(sandbox, "if (_tier !== 'LOW')", 'sandbox must gate worker authorization above LOW tier');
requireText(sandbox, "RuntimeSecureSession", 'sandbox must integrate RuntimeSecureSession');
requireText(sandbox, "Worker blocked: RuntimeSecureSession is unavailable", 'sandbox must fail closed when secure session is unavailable');
requireText(sandbox, "worker-authorization-denied", 'sandbox must reject missing/invalid worker authorization');
requireText(sandbox, "authToken.token", 'sandbox must require a worker token');
requireText(sandbox, "authToken.sessionId", 'sandbox must require a session binding');
requireText(sandbox, "authToken.exp", 'sandbox must require token expiry');
requireText(sandbox, "worker.postMessage({ _sandboxInit: true", 'authorized worker must receive sandbox initialization');
requireText(session, "function authorizeWorker(workerUrl)", 'secure session must expose worker authorization');
requireText(session, "WORKER_TOKEN_TTL", 'worker authorization must be time-bounded');
requireText(session, "validateWorkerToken(token, url)", 'secure session must expose worker token validation');

if (failures.length) {
  console.error('Phase 5 worker security boundary audit failed:');
  failures.forEach(f => console.error(' - ' + f));
  process.exit(1);
}

console.log('Phase 5 worker security boundary audit passed.');
