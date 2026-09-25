#!/usr/bin/env node
import fs from 'node:fs';

const src=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
 ['registry is a Map', /var _activeStreams = new Map\(\)/],
 ['transferable registers active entry', /_streamViaTransferableStream[\s\S]*?_activeStreams\.set\(streamId, entry\)/],
 ['chunk registers active entry', /_streamViaChunkAck[\s\S]*?_activeStreams\.set\(streamId, entry\)/],
 ['multi-file registers active entry', /streamFilesToWorkerReadable[\s\S]*?_activeStreams\.set\(streamId, entry\)/],
 ['transferable runtime error deletes registry', /finishTransferRuntimeError[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['transferable fallback deletes registry', /finishTransferFallback[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['transferable success deletes registry', /d\.type === 'stream-done'[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['chunk runtime error deletes registry', /function finishRuntimeError[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['chunk success deletes registry', /d\.type === 'stream-done'[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['multi-file error deletes registry', /function finishError[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['multi-file success deletes registry', /d\.type === 'stream-done'[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['central cancellation deletes registry', /_cancelStream[\s\S]*?_activeStreams\.delete\(streamId\)/],
 ['pagehide iterates and cancels active streams', /pagehide[\s\S]*?_activeStreams\.forEach\(function \(_, id\) \{ _cancelStream\(id\); \}\)/],
 ['pagehide clears registry after cancellation', /pagehide[\s\S]*?_activeStreams\.clear\(\)/],
 ['terminal handlers ignore late messages', /!d \|\| d\.streamId !== streamId \|\| entry\.terminal/],
 ['worker error handlers respect terminal state', /w\.onerror = function[\s\S]*?if \(entry\.terminal\) return/]
];
let pass=0;
for(const [name,re] of checks){const ok=re.test(src);console.log((ok?'PASS ':'FAIL ')+name);if(ok)pass++;}
console.log('RESULT '+pass+'/'+checks.length);
if(pass!==checks.length)process.exit(1);
