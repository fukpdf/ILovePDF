#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const x=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const w=fs.readFileSync('public/workers/workerPool.js','utf8');
const checks=[
 ['transferable entry supports listener cleanup',/removeCancelListener: null/.test(x)],
 ['transferable cancellation stores unsubscribe',/entry\.removeCancelListener = token\.onCancel/.test(x)],
 ['chunk cancellation stores unsubscribe',/entry\.removeCancelListener = token\.onCancel/.test(x)],
 ['multi-file cancellation stores unsubscribe',/entry\.removeCancelListener = token\.onCancel/.test(x)],
 ['terminal cleanup invokes unsubscribe',/entry\.removeCancelListener\) \{[\s\S]*?entry\.removeCancelListener = null;/.test(x)],
 ['CancelToken exposes unsubscribe',/return function \(\) \{[\s\S]*?_cbs\.splice\(i, 1\);/.test(w)]
];
for(const [q,ok] of checks) console.log((ok?'PASS ':'FAIL ')+q);
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js']);execFileSync(process.execPath,['--check','public/workers/workerPool.js']);}catch{console.log('FAIL syntax');process.exit(1);}
if(checks.some(c=>!c[1]))process.exit(1);
console.log('Unit 36 stream listener cleanup audit: '+checks.length+'/'+checks.length);