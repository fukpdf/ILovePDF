#!/usr/bin/env node
// Phase 3 security/lifecycle regression gate.
// Static verification for the shared upload and output-delivery boundaries.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const pass = (id, detail) => checks.push({ id, status: 'PASS', detail });
const fail = (id, detail) => checks.push({ id, status: 'FAIL', detail });
const read = p => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

const upload = read('utils/upload.js');
if (upload.includes('validateFileSignature') && upload.includes("createUpload")) pass('shared-upload-boundary', 'Shared upload boundary performs content-signature validation.');
else fail('shared-upload-boundary', 'Shared upload signature validation is missing.');

for (const [file, marker] of [
  ['routes/advanced.js', "createUpload('pdf')"],
  ['routes/image.js', "createUpload('image')"],
  ['routes/r2.js', "createUpload('any')"],
  ['routes/convert.js', 'createUpload('],
  ['routes/edit.js', 'createUpload('],
  ['routes/organize.js', 'createUpload('],
]) {
  const src = read(file);
  if (src.includes(marker)) pass('upload:'+file, 'Uses shared upload boundary.');
  else fail('upload:'+file, 'Does not use shared upload boundary.');
}

for (const file of ['utils/cleanup.js','routes/convert.js','routes/advanced.js','controllers/imageController.js']) {
  const src = read(file);
  if (src.includes('validateOutputBuffer')) pass('output:'+file, 'Generated output validation is wired.');
  else fail('output:'+file, 'Generated output validation is not wired.');
}

const advanced = read('routes/advanced.js');
const r2 = read('routes/r2.js');
if (!/multer\\s*\\(/.test(advanced) && !advanced.includes("from 'multer'")) pass('advanced-no-direct-multer', 'No direct multer configuration remains.');
else fail('advanced-no-direct-multer', 'Direct multer configuration remains.');
if (!/multer\\s*\\(/.test(r2) && !r2.includes("from 'multer'")) pass('r2-no-direct-multer', 'No direct multer configuration remains.');
else fail('r2-no-direct-multer', 'Direct multer configuration remains.');

const results = checks.map(x => '[' + x.status + '] ' + x.id + ': ' + x.detail).join('\n');
console.log(results);
const failures = checks.filter(x => x.status === 'FAIL').length;
console.log('\nPhase 3 regression gate: ' + (failures ? 'FAIL' : 'PASS') + ' (' + (checks.length - failures) + '/' + checks.length + ' checks passed)');
process.exitCode = failures ? 1 : 0;
