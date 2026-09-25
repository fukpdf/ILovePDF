#!/usr/bin/env node
import fs from 'node:fs';
const src=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
 ['multi-file does not skip empty files before dispatch', /files\[fileIndex\]\.size > 0 && offset >= files\[fileIndex\]\.size/],
 ['empty file is represented by terminal chunk', /var isLastFile = end >= file\.size[\s\S]*?type:'stream-chunk'/],
 ['empty file advances after send', /if \(file\.size === 0\) \{[\s\S]*?fileIndex\+\+[\s\S]*?offset = 0[\s\S]*?chunkIndex = 0/],
 ['worker uses terminal file boundary to dispatch final batch', /if \(\(data\.fileIndex \|\| 0\) \+ 1 >= state\.totalFiles\)[\s\S]*?_dispatchStream/],
 ['empty-only batch cannot silently return after init', /while \(fileIndex < files\.length && files\[fileIndex\]\.size > 0/],
 ['multi-file completion clears active registry', /stream-done[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['multi-file completion settles promise', /stream-done[\s\S]*?resolve\(d\)/],
 ['multi-file cancellation remains central', /token\.onCancel[\s\S]*?_cancelStream\(streamId\)/]
];
let pass=0;
for(const [name,re] of checks){const ok=re.test(src);console.log((ok?'PASS ':'FAIL ')+name);if(ok)pass++;}
console.log('RESULT '+pass+'/'+checks.length);
if(pass!==checks.length)process.exit(1);
