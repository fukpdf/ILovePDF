#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const p='public/js/runtime-stream-bridge.js',x=fs.readFileSync(p,'utf8'),a=x.indexOf('// ── MULTI-FILE'),b=x.indexOf('// ── Cancel all');
const m=x.slice(a,b);
const checks=[
 ['multi-file init builds explicit message',/var initMsg = Object\.assign/.test(m)],
 ['multi-file init validates security',/validateWorkerMessage\(initMsg\)/.test(m)],
 ['multi-file chunk builds explicit message',/var chunkMsg = \{/.test(m)],
 ['multi-file chunk validates security',/validateWorkerMessage\(chunkMsg\)/.test(m)],
 ['security failure reaches finishError',/catch \(se\) \{ finishError\(se\); return; \}/.test(m)],
 ['multi-file terminal finalizer retained',/function finishError\(err\)/.test(m)],
 ['syntax valid',true]
];
try{execFileSync(process.execPath,['--check',p],{stdio:'ignore'});}catch{checks[6][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}
console.log('Unit 33 multi-file security audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);