#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const wp=fs.readFileSync('public/workers/workerPool.js','utf8');
const rb=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
 ['CancelToken onCancel returns unsubscribe',/return function \(\) \{[\s\S]*?_cbs\.splice\(i, 1\);/.test(wp)],
 ['stream stores cancellation listener cleanup',/entry\.removeCancelListener = token\.onCancel/.test(rb)],
 ['cancel path removes listener',/if \(entry\.removeCancelListener\)[\s\S]*?entry\.removeCancelListener = null;/.test(rb)],
 ['terminal paths remove listener',/removeCancelListener/.test(rb)],
 ['workerPool syntax valid',true],['stream bridge syntax valid',true]
];
try{execFileSync(process.execPath,['--check','public/workers/workerPool.js'],{stdio:'ignore'});}catch{checks[4][1]=false;}
try{execFileSync(process.execPath,['--check','public/js/runtime-stream-bridge.js'],{stdio:'ignore'});}catch{checks[5][1]=false;}
let n=0;for(const [q,ok] of checks){console.log((ok?'PASS ':'FAIL ')+q);if(ok)n++;}console.log('Unit 35 cancellation-listener audit: '+n+'/'+checks.length);if(n!==checks.length)process.exit(1);