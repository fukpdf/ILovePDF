#!/usr/bin/env node
// Phase 5 ToolApp lifecycle/isolation contract.
// Units 99-111: shared ToolAppManager must not lose destroy hooks or leak
// processing interceptors across tool boundaries.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const source = read('public/js/tool-app-manager.js');
const failures = [];
const fail = msg => failures.push(msg);

if (!/ToolAppManager v1\.1/.test(source)) fail('ToolAppManager v1.1 lifecycle implementation is missing.');
if (!/var _registry = \{\};/.test(source)) fail('ToolApp registry boundary is missing.');
if (!/var _interceptors = \{\};/.test(source)) fail('Mounted interceptor registry is missing.');
if (!/var _baseProcess = null;/.test(source)) fail('Base BrowserTools processor is not retained.');
if (!/var _dispatcherInstalled = false;/.test(source)) fail('Dispatcher installation state is missing.');

if (!/function _dispatch\(id, files, opts\)/.test(source)) fail('Central processing dispatcher is missing.');
if (!/var instance = _interceptors\[id\];/.test(source)) fail('Dispatcher does not select the mounted instance by toolId.');
if (!/return instance\.process\(files, opts\);/.test(source)) fail('Dispatcher does not route matching tool calls to the ToolApp.');
if (!/return _baseProcess\(id, files, opts\);/.test(source)) fail('Dispatcher does not preserve the original processor for other tools.');

if (!/function _installDispatcher\(\)/.test(source)) fail('Shared dispatcher installation function is missing.');
if (!/_baseProcess = G\.BrowserTools\.process;/.test(source)) fail('Dispatcher does not capture the pre-existing BrowserTools processor.');
if (!/G\.BrowserTools\.process = _dispatch;/.test(source)) fail('BrowserTools is not routed through the shared dispatcher.');

if (!/if \(Object\.keys\(_interceptors\)\.length !== 0\) return;/.test(source)) fail('Dispatcher cleanup does not wait until all mounted tools are removed.');
if (!/G\.BrowserTools\.process = _baseProcess;/.test(source)) fail('Dispatcher cleanup does not restore the original processor.');

if (!/var instance = e\.instance;/.test(source)) fail('Destroy does not capture the mounted instance before unmount clears it.');
if (!/if \(instance && typeof instance\.destroy === 'function'\) instance\.destroy\(\);/.test(source)) fail('Destroy hook is missing or unreachable.');
if (/function destroyTool\(toolId\)[\s\S]*?\n\s*unmountTool\(toolId\);/.test(source)) fail('Destroy still delegates to unmountTool before retaining the instance.');
if (!/delete _interceptors\[toolId\];/.test(source)) fail('Destroy/unmount does not remove only the requested tool interceptor.');

if (!/if \(!e\.instance \|\| typeof e\.instance\.process !== 'function'\)/.test(source)) fail('Mount does not fail closed when a ToolApp has no process boundary.');
if (!/e\.state = STATE\.ERROR;/.test(source)) fail('Mount failure does not enter the ERROR state.');
if (!/e\.instance = null;/.test(source)) fail('Failed mount does not clear the partial instance.');

if (!/function unmountTool\(toolId\)/.test(source) || !/if \(!e \|\| e\.state !== STATE\.MOUNTED\) return;/.test(source)) {
  fail('Unmount state boundary is missing.');
}
if (!/delete _interceptors\[toolId\];[\s\S]*?e\.instance = null;/.test(source)) fail('Unmount does not detach the tool interceptor before releasing the instance.');

if (!/function recoverTool\(toolId, level\)/.test(source)) fail('Recover lifecycle boundary is missing.');
if (!/if \(e\.state === STATE\.ERROR\)[\s\S]*?e\.state = STATE\.REGISTERED;/.test(source)) fail('Recover does not reset an errored entry before remount.');

if (/Map<toolId, prevProcessFn>/.test(source)) fail('Legacy per-tool previous-processor chain remains.');
if (/_interceptors\[toolId\] = prevProcess/.test(source)) fail('Legacy interceptor stacking can restore a stale wrapper.');
if (/function _removeInterceptor\(toolId\)/.test(source)) fail('Legacy per-tool interceptor removal function remains.');

console.log('[PASS] ToolAppManager lifecycle/isolation contract');
console.log('[PASS] Destroy preserves instance until destroy hook executes');
console.log('[PASS] Mounted tools use a centralized toolId dispatcher');
console.log('[PASS] Unmount removes only the requested tool interceptor');
console.log('[PASS] Original BrowserTools processor is restored only when dispatcher is idle');
console.log('[PASS] Mount/recover fail closed on invalid or errored ToolApps');

if (failures.length) {
  console.error('[FAIL] Phase 5 ToolApp lifecycle/isolation contract (' + failures.length + ' issue(s))');
  failures.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  console.log('Phase 5 ToolApp lifecycle/isolation gate: PASS');
}
