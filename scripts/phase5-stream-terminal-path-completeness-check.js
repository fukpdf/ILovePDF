#!/usr/bin/env node
import fs from 'node:fs';

const file = 'public/js/runtime-stream-bridge.js';
const src = fs.readFileSync(file, 'utf8');

const checks = [
  ['transferable path has cancel settlement slot', /_streamViaTransferableStream[\\s\\S]*?cancelReject: reject/],
  ['chunk path has cancel settlement slot', /_streamViaChunkAck[\\s\\S]*?cancelReject: reject/],
  ['multi-file path has cancel settlement slot', /streamFilesToWorkerReadable[\\s\\S]*?cancelReject: reject/],
  ['central cancel rejects promise', /entry\.cancelReject\(new Error\('cancelled'\)\)/],
  ['central cancel removes registry', /_activeStreams\.delete\(streamId\)/],
  ['transferable terminal guard', /w\.onmessage = function \(e\) \{[\\s\\S]*?entry\.terminal\) return;/],
  ['chunk terminal guard', /_streamViaChunkAck[\\s\\S]*?w\.onmessage = function \(e\) \{[\\s\\S]*?entry\.terminal\) return;/],
  ['multi-file terminal guard', /streamFilesToWorkerReadable[\\s\\S]*?w\.onmessage = function\(e\) \{[\\s\\S]*?entry\.terminal\) return;/],
  ['transferable onerror finalizes', /w\.onerror = function \(e\) \{[\\s\\S]*?finishTransferRuntimeError/],
  ['chunk onerror finalizes', /_streamViaChunkAck[\\s\\S]*?w\.onerror = function \(e\) \{[\\s\\S]*?finishRuntimeError/],
  ['multi-file onerror finalizes', /streamFilesToWorkerReadable[\\s\\S]*?w\.onerror = function\(e\) \{ finishError/],
  ['transferable messageerror finalizes', /w\.onmessageerror = function \(\) \{[\\s\\S]*?finishTransferRuntimeError/],
  ['chunk messageerror finalizes', /_streamViaChunkAck[\\s\\S]*?w\.onmessageerror = function \(\) \{[\\s\\S]*?finishRuntimeError/],
  ['multi-file messageerror finalizes', /streamFilesToWorkerReadable[\\s\\S]*?w\.onmessageerror = function \(\) \{ finishError/],
  ['pagehide uses central cancellation', /pagehide[\\s\\S]*?_cancelStream\(id\)/],
  ['pagehide does not directly settle/terminate streams', /pagehide[\\s\\S]*?_activeStreams\.clear\(\);/]
];

let passed = 0;
for (const [name, re] of checks) {
  const ok = re.test(src);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
  if (ok) passed++;
}
console.log('RESULT ' + passed + '/' + checks.length);
if (passed !== checks.length) process.exit(1);
