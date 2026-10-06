import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

function context(extra = {}) {
  const listeners = Object.create(null);
  const ctx = {
    console,
    Map,
    Set,
    Object,
    Number,
    Date,
    Math,
    Promise,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach(fn => fn(evt)); },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    ...extra,
  };
  ctx.window = ctx;
  return ctx;
}

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

{
  const meshCtx = context({
    RuntimeDeviceLite: { score: () => 80 },
    RuntimeEventBus: { on() {}, emit() {} },
    RuntimeSecureSession: { authorizeWorker: url => ({ token: 't:' + url }) },
    SecurityTelemetry: { record() {} },
  });
  vm.runInNewContext(read('public/js/runtime-worker-mesh.js'), meshCtx, { filename: 'runtime-worker-mesh.js' });
  const mesh = meshCtx.RuntimeWorkerMesh;
  const w1 = { terminated: 0, terminate() { this.terminated++; } };
  const w2 = { terminated: 0, terminate() { this.terminated++; } };
  check(mesh.VERSION === '1.1', 'mesh version');
  check(mesh.register('  worker-a  ', w1, ' /workers/a.js ')?.workerId === 'worker-a', 'mesh normalizes registration');
  check(mesh.register('worker-a', w2, '/workers/b.js')?.workerId === 'worker-a', 'mesh re-registration');
  check(w1.terminated === 1, 'mesh terminates replaced worker');
  check(mesh.getTrustScore('worker-a') === 20, 'mesh resets trust on re-registration');
  check(mesh.register('__proto__', w1, '/workers/x.js')?.workerId === '__proto__', 'mesh accepts string ids safely');
  check(mesh.setTrust('worker-a', NaN, 'bad') === 20, 'mesh rejects non-finite trust delta');
  check(mesh.quarantine('worker-a', 'test') === true, 'mesh quarantine contract');
  check(mesh.setTrust('worker-a', 100, 'resurrect') === 20, 'quarantine cannot be resurrected by trust');
  check(mesh.unregister('worker-a') === true && mesh.unregister('worker-a') === false, 'mesh unregister idempotence');
}

{
  const domainCtx = context();
  vm.runInNewContext(read('public/js/runtime-worker-domain-registry.js'), domainCtx, { filename: 'runtime-worker-domain-registry.js' });
  const reg = domainCtx.RuntimeWorkerDomainRegistry;
  check(reg.VERSION === '1.1', 'domain registry version');
  check(reg.ensureDomain('__proto__') === null, 'domain rejects prototype key');
  check(reg.ensureDomain(' ORGANIZE ')?.family === 'organize', 'domain normalizes family');
  check(reg.setPressure('__proto__', true) === false, 'domain rejects invalid pressure family');
  reg.setActiveTool('  ROTATE ');
  check(reg.getActiveTool() === 'rotate', 'domain normalizes tool id');
  check(reg.getFamily('rotate') === 'organize', 'domain tool-family lookup');
  check(reg.getFamily('__proto__') === null, 'domain rejects prototype tool id');
  check(Object.getPrototypeOf(reg.getAllStats()) === null, 'domain stats are prototype-safe');
}

{
  let calls = 0;
  const throttleCtx = context({
    WorkerPool: {
      run: async () => { calls++; return 'ok'; },
    },
    RuntimeWorkerDomainRegistry: {
      isPressured: () => false,
    },
  });
  vm.runInNewContext(read('public/js/runtime-worker-domain-throttle.js'), throttleCtx, { filename: 'runtime-worker-domain-throttle.js' });
  const throttle = throttleCtx.RuntimeWorkerDomainThrottle;
  check(throttle.VERSION === '1.2', 'throttle version');
  check(throttle.setFamilyCap('__proto__', 8) === false, 'throttle rejects prototype family');
  check(throttle.setFamilyCap('ai', 2.9) === true, 'throttle normalizes family cap');
  check(throttle.getStats().ai.cap === 2, 'throttle floors family cap');
  const result = await throttle.run('/workers/pdf-lib-worker.js', { task: 'x' }, { toolId: 'merge' });
  check(result === 'ok' && calls === 1, 'throttle dispatches mapped worker');
  let rejected = false;
  try { await throttle.run('/workers/unknown-worker.js', {}, {}); } catch (e) { rejected = e.message === 'worker-family-unmapped'; }
  check(rejected, 'throttle fails closed for unmapped worker');
}

if (failures.length) {
  console.error('Phase 5 Units 294-306 worker domain integrity audit FAILED');
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('Phase 5 Units 294-306 worker domain integrity audit PASSED');
console.log(' - worker mesh registration, trust, quarantine and unregister lifecycle verified');
console.log(' - domain registry family/tool normalization and prototype safety verified');
console.log(' - domain throttle cap validation and fail-closed routing verified');
