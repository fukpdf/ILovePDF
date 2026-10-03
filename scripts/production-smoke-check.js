#!/usr/bin/env node
const BASE = (process.env.PRODUCTION_BASE_URL || 'https://ilovepdf.cyou').replace(/\/$/, '');

const checks = [
  ['homepage', '/'],
  ['crop route', '/crop-pdf'],
  ['rotate route', '/rotate-pdf'],
  ['tools config', '/js/tools-config.js'],
  ['tool page runtime', '/js/tool-page.js'],
];

let failed = 0;
for (const [name, path] of checks) {
  const res = await fetch(BASE + path, { redirect: 'follow' });
  const body = await res.text();
  const ok = res.ok && body.length > 0;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' [' + res.status + '] ' + path);
  if (!ok) failed++;
}

const config = await (await fetch(BASE + '/js/tools-config.js', { redirect: 'follow' })).text();
for (const id of ['crop', 'rotate', 'merge']) {
  const re = new RegExp('id:\\s*[\'"]' + id + '[\'"][\\s\\S]{0,700}?working:\\s*true');
  const ok = re.test(config);
  console.log((ok ? 'PASS ' : 'FAIL ') + 'production config working=true: ' + id);
  if (!ok) failed++;
}

for (const route of ['/crop-pdf', '/rotate-pdf']) {
  const body = await (await fetch(BASE + route, { redirect: 'follow' })).text();
  const shellOk = body.includes('/js/tool-page.js') && body.includes('/js/tools-config.js');
  console.log((shellOk ? 'PASS ' : 'FAIL ') + 'tool shell assets: ' + route);
  if (!shellOk) failed++;
}

console.log('Production smoke validation: ' + ((checks.length + 3 + 2) - failed) + '/' + (checks.length + 3 + 2));
if (failed) process.exit(1);
