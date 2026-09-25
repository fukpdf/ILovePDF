#!/usr/bin/env node
const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync('public/workers/workerPool.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['no undefined priority map',!/pool_proto_queues\[priority\]/.test(src)],
 ['priority validates against TIER_ORDER',/TIER_ORDER\.indexOf\(priority\) === -1/.test(src)],
 ['four priority tiers declared',/\['high', 'normal', 'low', 'background'\]/.test(src)],
 ['unknown priority falls back to normal',/if \(TIER_ORDER\.indexOf\(priority\) === -1\) priority = 'normal';/.test(src)],
 ['normal priority remains accepted',/priority = opts\.priority \|\| 'normal'/.test(src)],
 ['unbounded queue policy retained',/MAX_QUEUE\s*=\s*0/.test(src)],
 ['no artificial task cutoff retained',/MAX_TASKS_PER_SLOT\s*=\s*0/.test(src)],
 ['worker timeout disabled',/TIMEOUT_MS\s*=\s*0/.test(src)],
 ['cancel token retained',/function CancelToken\(\)/.test(src)],
 ['starvation handling retained',/STARVATION_MS/.test(src)],
 ['audit command registered',pkg.scripts['audit:phase5:worker-pool']==='node scripts/phase5-worker-pool-check.js']
];
let fail=0;for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)fail++;}
try{new Function(src);console.log('PASS — JavaScript syntax');}catch(e){console.log('FAIL — JavaScript syntax: '+e.message);fail++;}
console.log(`Unit 24 WorkerPool checks: ${checks.length+1-fail}/${checks.length+1}`);
if(fail)process.exit(1);
