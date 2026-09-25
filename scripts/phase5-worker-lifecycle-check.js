#!/usr/bin/env node
const fs=require('fs');
const src=fs.readFileSync('public/workers/workerPool.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['handlers capture worker identity',/var worker = slot\.worker;/.test(src)],
 ['late onmessage ignored',/if \(slot\.worker !== worker\) return;\s*settle\(pool, slot, null, e\.data\)/s.test(src)],
 ['stale onerror ignored',/worker\.onerror = function \(e\) \{\s*\/\/ A retired worker/s.test(src)],
 ['failed worker terminated before settle',/try \{ worker\.terminate\(\); \} catch \(_\) \{\}\s*var replacement = null;/s.test(src)],
 ['replacement installed before settle',/slot\.worker = replacement;\s*attachHandlers\(pool, slot\);\s*slot\.taskCount = 0;/s.test(src)],
 ['replacement failure retires slot',/if \(!replacement\) slot\.crashes = MAX_CRASHES;/.test(src)],
 ['cancel replacement failure retires slot',/var replacement = spawnWorker\(pool\.url\);[\s\S]*?else \{\s*\/\/ Never leave a terminated worker in a reusable idle slot\.[\s\S]*?slot\.crashes = MAX_CRASHES;/s.test(src)],
 ['cancel active-task identity guard',/if \(!slot\.busy \|\| slot\.currentTask !== task\) return;/.test(src)],
 ['cancel replacement handlers attached',/slot\.worker = replacement;\s*slot\.crashes = 0;\s*slot\.taskCount = 0;\s*attachHandlers\(pool, slot\);/s.test(src)],
 ['priority validation retained',/TIER_ORDER\.indexOf\(priority\) === -1/.test(src)],
 ['no artificial timeout',/TIMEOUT_MS\s*=\s*0/.test(src)],
 ['unbounded queue retained',/MAX_QUEUE\s*=\s*0/.test(src)],
 ['audit command registered',pkg.scripts['audit:phase5:worker-lifecycle']==='node scripts/phase5-worker-lifecycle-check.js']
];
let fail=0;
for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)fail++;}
try{new Function(src);console.log('PASS — JavaScript syntax');}catch(e){console.log('FAIL — JavaScript syntax: '+e.message);fail++;}
console.log('Unit 26 lifecycle checks: '+(checks.length+1-fail)+'/'+(checks.length+1));
if(fail)process.exit(1);
