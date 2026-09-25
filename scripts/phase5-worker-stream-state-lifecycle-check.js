#!/usr/bin/env node
import fs from 'node:fs';
const src=fs.readFileSync('public/workers/pdf-worker.js','utf8');
const checks=[
 ['stream state is registered on init', /if \(data\.type === 'stream-init'\)[\s\S]*?_streamState\.set\(data\.streamId/],
 ['cancel removes stream state', /if \(data\.type === 'stream-cancel'\)[\s\S]*?_streamState\.delete\(data\.streamId\)/],
 ['dispatch snapshots and removes state before async operation', /const state = _streamState\.get\(streamId\)[\s\S]*?_streamState\.delete\(streamId\)[\s\S]*?await op/],
 ['missing state becomes terminal worker error', /if \(!state\)[\s\S]*?stream-state-lost/],
 ['unknown operation is rejected', /const op = OPS\[tool\][\s\S]*?if \(!op\) throw new Error/],
 ['result buffer is required', /if \(!resultBuffer\) throw new Error\('No output produced'\)/],
 ['successful stream transfers result', /stream-done[\s\S]*?\[resultBuffer\]/],
 ['processing errors become stream errors', /catch \(err\)[\s\S]*?stream-error/],
 ['stream state is cleared before operation retains no chunk list', /state\.chunks = \[\][\s\S]*?state\.fileBuffers\.push\(buf\)/]
];
let pass=0;
for(const [name,re] of checks){const ok=re.test(src);console.log((ok?'PASS ':'FAIL ')+name);if(ok)pass++;}
console.log('RESULT '+pass+'/'+checks.length);
if(pass!==checks.length)process.exit(1);
