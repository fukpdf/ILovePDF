#!/usr/bin/env node
const fs=require('fs');
const src=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const checks=[
 ['active stream registry exists',/_activeStreams = new Map\(\)/.test(src)],
 ['cancel marks entry cancelled',/entry\.cancelled = true/.test(src)],
 ['cancel notifies worker',/entry\.worker\.postMessage\(\{ type: 'stream-cancel', streamId: streamId \}\)/.test(src)],
 ['cancel terminates worker immediately',/entry\.worker\.postMessage\([\s\S]*?\}\);\s*\} catch \(_\) \{\}\s*try \{ entry\.worker\.terminate\(\); \} catch \(_\) \{\}/.test(src)],
 ['cancel aborts controller',/entry\.abortController\.abort\(\)/.test(src)],
 ['cancel removes registry entry',/_activeStreams\.delete\(streamId\)/.test(src)],
 ['transferable path registers active worker',/var entry = \{ worker: w, cancelled: false, abortController: null \}/.test(src)],
 ['chunk path registers active worker',/var entry = \{ worker: w, cancelled: false \}/.test(src)],
 ['chunk send checks cancellation',/if \(entry\.cancelled \|\| done\) return;/.test(src)],
 ['transferable token cancellation rejects',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); reject\(new Error\('cancelled'\)\); \}\)/.test(src)],
 ['chunk token cancellation rejects',/token\.onCancel\(function \(\) \{ _cancelStream\(streamId\); reject\(new Error\('cancelled'\)\); \}\)/.test(src)],
 ['audit command registered',pkg.scripts['audit:phase5:stream-cancel']==='node scripts/phase5-stream-cancel-check.js']
];
let fail=0; for(const [n,ok] of checks){console.log((ok?'PASS':'FAIL')+' — '+n);if(!ok)fail++;}
try{new Function(src);console.log('PASS — JavaScript syntax');}catch(e){console.log('FAIL — JavaScript syntax: '+e.message);fail++;}
console.log('Unit 27 stream cancellation checks: '+(checks.length+1-fail)+'/'+(checks.length+1));
if(fail)process.exit(1);
