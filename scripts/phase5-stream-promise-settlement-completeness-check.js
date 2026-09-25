#!/usr/bin/env node
import fs from 'node:fs';

const src=fs.readFileSync('public/js/runtime-stream-bridge.js','utf8');
const checks=[
 ['transferable registers before cancellation listener', /var entry = \{[\s\S]*?cancelReject: reject \};[\s\S]*?_activeStreams\.set\(streamId, entry\)[\s\S]*?entry\.removeCancelListener/],
 ['chunk registers before cancellation listener', /_streamViaChunkAck[\s\S]*?var entry = \{[\s\S]*?cancelReject: reject \};[\s\S]*?_activeStreams\.set\(streamId, entry\)[\s\S]*?entry\.removeCancelListener/],
 ['multi-file registers before cancellation listener', /streamFilesToWorkerReadable[\s\S]*?var entry = \{[\s\S]*?cancelReject: reject \};[\s\S]*?_activeStreams\.set\(streamId, entry\)[\s\S]*?entry\.removeCancelListener/],
 ['transferable success clears cancelReject', /stream-done[\s\S]*?entry\.cancelReject = null;[\s\S]*?resolve\(d\)/],
 ['chunk success clears cancelReject', /_streamViaChunkAck[\s\S]*?stream-done[\s\S]*?entry\.cancelReject = null;[\s\S]*?resolve\(d\)/],
 ['multi-file success clears cancelReject', /streamFilesToWorkerReadable[\s\S]*?stream-done[\s\S]*?entry\.cancelReject = null;[\s\S]*?resolve\(d\)/],
 ['transferable runtime error clears cancelReject', /finishTransferRuntimeError[\s\S]*?reject\(err[\s\S]*?entry\.cancelReject = null/],
 ['transferable fallback clears cancelReject', /finishTransferFallback[\s\S]*?reject\(_fallbackStreamError\(err\)\)[\s\S]*?entry\.cancelReject = null/],
 ['chunk runtime error clears cancelReject', /finishRuntimeError[\s\S]*?reject\(err[\s\S]*?entry\.cancelReject = null/],
 ['multi-file error clears cancelReject', /finishError[\s\S]*?reject\(err[\s\S]*?entry\.cancelReject = null/],
 ['central cancel settles and nulls cancelReject', /entry\.cancelReject\(new Error\('cancelled'\)\)[\s\S]*?entry\.cancelReject = null/],
 ['terminal handlers reject only through finalizers', /w\.onerror = function[\s\S]*?finishTransferRuntimeError[\s\S]*?w\.onmessageerror = function[\s\S]*?finishTransferRuntimeError/],
 ['pagehide delegates cancellation', /pagehide[\s\S]*?_cancelStream\(id\)/]
];
let pass=0;
for(const [name,re] of checks){const ok=re.test(src);console.log((ok?'PASS ':'FAIL ')+name);if(ok)pass++;}
console.log('RESULT '+pass+'/'+checks.length);
if(pass!==checks.length)process.exit(1);
