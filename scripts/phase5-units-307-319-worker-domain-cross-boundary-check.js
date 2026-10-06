#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
};

const read = p => fs.readFileSync(p, 'utf8');

for (const p of [
  'public/js/runtime-worker-mesh.js',
  'public/js/runtime-worker-domain-registry.js',
  'public/js/runtime-worker-domain-throttle.js',
]) {
  try { new vm.Script(read(p), { filename: p }); check(p + ' syntax', true); }
  catch (e) { check(p + ' syntax', false, e.message); }
}

function ctx(extra = {}) {
  const listeners = Object.create(null);
  const c = {
    console,
    Map, Set, Object, Number, String, Array, Promise, Date, Math,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach(fn => fn(evt)); return true; },
    document: { readyState: 'complete', addEventListener() {} },
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    ...extra,
  };
  c.window = c;
  return c;
}

{
  const bus = { handlers: Object.create(null), on(name, fn) { this.handlers[name] = fn; }, emit(name, data) { this.handlers[name]?.(data); } };
  const c = ctx({
    RuntimeDeviceLite: { score: () => 80 },
    RuntimeEventBus: bus,
    RuntimeSecureSession: { authorizeWorker: url => ({ token: 't:' + url }) },
    SecurityTelemetry: { record() {} },
  });
  vm.runInNewContext(read('public/js/runtime-worker-mesh.js'), c);
  const mesh = c.RuntimeWorkerMesh;
  const worker = { terminate() {} };
  check('mesh version', mesh.VERSION === '1.1');
  check('mesh registers normalized id', mesh.register(' worker-a ', worker, '/workers/a.js')?.workerId === 'worker-a');
  bus.emit('worker:terminated', { workerId: '  worker-a  ' });
  check('mesh normalizes termination lifecycle id', mesh.getTrustScore('worker-a') === -1);
  check('mesh accepts prototype-like id safely', mesh.register('__proto__', worker, '/workers/a.js')?.workerId === '__proto__');
}

{
  const c = ctx();
  vm.runInNewContext(read('public/js/runtime-worker-domain-registry.js'), c);
  const reg = c.RuntimeWorkerDomainRegistry;
  check('domain registry version', reg.VERSION === '1.1');
  check('domain rejects prototype family', reg.ensureDomain('__proto__') === null);
  check('domain crash guard is prototype-safe', reg.recordCrash('__proto__') === undefined);
  check('domain normalizes tool id', (reg.setActiveTool(' ROTATE '), reg.getActiveTool() === 'rotate'));
  check('domain family lookup is normalized', reg.getFamily(' ROTATE ') === 'organize');
  check('domain stats prototype-safe', Object.getPrototypeOf(reg.getAllStats()) === null);
}

{
  let calls = 0;
  let resolvers = [];
  const c = ctx({
    WorkerPool: {
      run: () => new Promise(resolve => { calls++; resolvers.push(resolve); }),
    },
    RuntimeWorkerDomainRegistry: { isPressured: () => false },
  });
  vm.runInNewContext(read('public/js/runtime-worker-domain-throttle.js'), c);
  const throttle = c.RuntimeWorkerDomainThrottle;
  check('throttle version', throttle.VERSION === '1.2');
  check('throttle rejects prototype family cap', throttle.setFamilyCap('__proto__', 4) === false);
  check('throttle normalizes family cap', throttle.setFamilyCap(' ai ', 1.9) === true);
  check('throttle exposes prototype-safe stats', Object.getPrototypeOf(throttle.getStats()) === null);
  const first = throttle.run('/workers/advanced-worker.js', { task: 1 }, { toolId: 'ocr' });
  const second = throttle.run('/workers/advanced-worker.js', { task: 2 }, { toolId: 'ocr' });
  check('throttle enforces family cap', calls === 1);
  resolvers[0]('ok');
  await first;
  resolvers[1]?.('ok');
  await second;
  check('held task drains after slot release', calls === 2);
  let rejected = false;
  try { await throttle.run('/workers/pdf-lib-worker.js', { task: 3 }, {}); }
  catch (e) { rejected = e.message === 'worker-family-unmapped'; }
  check('ambiguous worker URL fails closed without tool id', rejected);
  const routed = throttle.run('/workers/pdf-lib-worker.js', { task: 4 }, { toolId: 'merge' });
  check('ambiguous worker URL resolves with explicit tool family', calls === 3);
  resolvers[2]?.('ok');
  await routed;
}

if (failures.length) {
  console.error('\nPhase 5 Units 307-319 domain cross-boundary integrity audit FAILED');
  failures.forEach(x => console.error(' - ' + x));
  process.exit(1);
}
console.log('\nPhase 5 Units 307-319 domain cross-boundary integrity audit PASSED');
