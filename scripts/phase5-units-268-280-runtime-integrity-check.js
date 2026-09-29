#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const root = process.cwd();
const files = [
  'public/js/runtime-resource-orchestrator.js',
  'public/js/runtime-recovery-orchestrator.js',
  'public/js/runtime-processor-workers.js',
];

function read(p) { return fs.readFileSync(new URL(p, 'file://' + root + '/'), 'utf8'); }
const failures = [];
function check(name, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
}
function makeWindow() {
  const listeners = {};
  const win = {
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach(fn => fn(evt)); return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    performance: {},
    console,
  };
  win.window = win;
  return win;
}

for (const p of files) {
  try { new vm.Script(read(p), { filename: p }); check(p + ' syntax', true); }
  catch (e) { check(p + ' syntax', false, e.message); }
}

{
  const window = makeWindow();
  vm.runInNewContext(read(files[0]), { window, console, isFinite, Number, Object, JSON, Date, Math, setInterval: () => 0 });
  const r = window.RuntimeResourceOrchestrator;
  const a = r.allocate('cpu', 10, 'owner-a');
  const special = r.allocate('cpu', 1, '__proto__');
  const wrong = r.release('cpu', 10, 'owner-b');
  const right = r.release('cpu', 10, 'owner-a');
  check('resource allocation', a.ok && a.available === 90);
  check('prototype-safe resource owner map', special.ok === true);
  check('owner-scoped release rejection', wrong.ok === false && wrong.released === 0);
  check('owner-scoped release success', right.ok === true && right.released === 10);
  check('resource releaseAll invalid-owner guard', r.releaseAll('')?.ok === false);
}

{
  const window = makeWindow();
  vm.runInNewContext(read(files[1]), { window, console, setTimeout, Object, Date, Math });
  const r = window.RuntimeRecoveryOrchestrator;
  check('recovery graph validity', r.GRAPH_VALID === true);
  const bad = r.runRecovery({ subsystems: ['not-a-real-subsystem'] });
  const protoBad = r.runRecovery({ subsystems: ['constructor'] });
  check('invalid recovery request fails closed', bad.ok === false && bad.reason === 'invalid-recovery-graph');
  check('prototype-safe recovery registry', protoBad.ok === false && protoBad.reason === 'invalid-recovery-graph');
}

{
  const window = makeWindow();
  vm.runInNewContext(read(files[2]), { window, console, setTimeout, setInterval: () => 0, Object, Array, Number, Math, Date, isFinite });
  const p = window.RuntimeProcessorWorkers;
  check('processor pool registration validation', p.registerPool('', {})?.ok === false);
  check('prototype-safe processor registry', p.registerPool('constructor', { maxWorkers: 2 })?.ok === true);
  check('processor pool registration', p.registerPool('ocr', { maxWorkers: 2 })?.ok === true);
  check('processor cap enforced', p.taskStart('ocr') === true && p.taskStart('ocr') === true && p.taskStart('ocr') === false);
  check('thermal limit validation', p.setThermalLimit('ocr', 0)?.ok === false);
  check('active task count survives reset', (p.resetPool('ocr'), p.getStats().ocr.activeCount === 2));
  window.dispatchEvent(new window.CustomEvent('tool-mesh:isolated', { detail: { family: 'ocr', toolId: 'pdf-merge' } }));
  check('explicit isolation family attribution', p.getStats().ocr.crashCount === 1);
}

if (failures.length) {
  console.error('\nPhase 5 Units 268-280 audit FAILED:');
  failures.forEach(x => console.error(' - ' + x));
  process.exit(1);
}
console.log('\nPhase 5 Units 268-280 audit PASSED.');
