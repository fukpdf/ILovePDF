import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = fs.readFileSync(path.join(root, 'public/js/runtime-worker-prewarm.js'), 'utf8');

const checks = [
  ['prewarm function guards target', /if \(!target \|\| !target\.url \|\| _warmed\.has\(target\.url\)\) return;/],
  ['prewarm success gates warmed state', /if \(result === true\) \{\s*_warmed\.add\(target\.url\);/],
  ['failed prewarm is not marked warmed', /Do not mark failed prewarm attempts as warmed/],
  ['fallback uses options object', /WorkerPool\.run\(target\.url, \{ __ping: true \}, \{ priority: 'background' \}\)/],
  ['fallback marks warmed after success', /p\.then\(function \(\) \{\s*_warmed\.add\(target\.url\);/],
  ['fallback failure does not mark warmed', /\.catch\(function \(\) \{\}\)/],
];

const failed = checks.filter(([, re]) => !re.test(c));
if (failed.length) {
  console.error('Worker prewarm reliability audit FAILED');
  failed.forEach(([n]) => console.error(' -', n));
  process.exit(1);
}
console.log('Worker prewarm reliability audit PASSED');
