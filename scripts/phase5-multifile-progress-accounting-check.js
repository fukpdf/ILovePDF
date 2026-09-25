#!/usr/bin/env node
import fs from 'node:fs';
const src=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const body=src.slice(src.indexOf('streamFilesToWorkerReadable'),src.indexOf('// ── Cancel all on pagehide'));
const checks=[
 ['total bytes is derived from every source file', /var totalBytes = files\.reduce\(function\(s, f\) \{ return s \+ \(f\.size \|\| 0\);/],
 ['progress is suppressed when total bytes are zero', /if \(onProgress && totalBytes\)/],
 ['processed bytes include completed source files', /files\.slice\(0,fileIndex\)\.reduce\(function\(s,f\)\{return s\+\(f\.size\|\|0\);/],
 ['current-file offset contributes to progress', /\+offset;/],
 ['progress is bounded at streaming ceiling', /Math\.min\(90, 10 \+ \(processed \/ totalBytes\) \* 75\)/],
 ['empty files do not inflate byte progress', /if \(file\.size === 0\)[\s\S]*?fileIndex\+\+[\s\S]*?offset = 0/],
 ['completed non-empty files reset offset before next file', /while \(fileIndex < files\.length && files\[fileIndex\]\.size > 0 && offset >= files\[fileIndex\]\.size\)[\s\S]*?offset = 0/],
 ['progress callback occurs only after successful postMessage', /w\.postMessage\(chunkMsg, \[buf\]\);[\s\S]*?if \(onProgress && totalBytes\)/]
];
let pass=0; for(const [n,r] of checks){const ok=r.test(body); console.log((ok?'PASS ':'FAIL ')+n); if(ok)pass++;}
console.log('RESULT '+pass+'/'+checks.length); if(pass!==checks.length)process.exit(1);