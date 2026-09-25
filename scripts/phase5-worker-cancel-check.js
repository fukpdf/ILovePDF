const fs=require('fs');const src=fs.readFileSync('public/workers/workerPool.js','utf8');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
['cancel handler checks active task',/if \(!slot\.busy \|\| slot\.currentTask !== task\) return;/.test(src)],
['cancel terminates active worker',/slot\.worker\.terminate\(\)/.test(src)],
['cancel spawns replacement',/var replacement = spawnWorker\(pool\.url\)/.test(src)],
['replacement handlers attached',/attachHandlers\(pool, slot\)/.test(src)],
['replacement resets crash count',/slot\.crashes = 0/.test(src)],
['replacement resets task count',/slot\.taskCount = 0/.test(src)],
['settle occurs after replacement setup',/attachHandlers\(pool, slot\);\s*}\s*settle\(pool, slot, new Error\('task_cancelled'\)/s.test(src)],
['cancel token retained',/function CancelToken\(\)/.test(src)],
['priority validation retained',/TIER_ORDER\.indexOf\(priority\) === -1/.test(src)],
['no stale priority sentinel',!/pool_proto_queues/.test(src)],
['no artificial timeout',/TIMEOUT_MS\s*=\s*0/.test(src)],
['unbounded queue retained',/MAX_QUEUE\s*=\s*0/.test(src)],
['audit command registered',pkg.scripts['audit:phase5:worker-cancel']==='node scripts/phase5-worker-cancel-check.js']
];let fail=0;for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)fail++}try{new Function(src);console.log('PASS — JavaScript syntax')}catch(e){console.log('FAIL — JavaScript syntax: '+e.message);fail++}console.log(`Unit 25 cancellation checks: ${checks.length+1-fail}/${checks.length+1}`);if(fail)process.exit(1);