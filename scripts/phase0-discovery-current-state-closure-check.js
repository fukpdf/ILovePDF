#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const required = [
  'package.json',
  'package-lock.json',
  'server.js',
  'utils/upload.js',
  'public/js/tools-config.js',
  '.github/workflows/audit.yml',
  '.github/workflows/deploy.yml',
  'docs/01_PROJECT_MASTER.md',
  'docs/03_TRD.md',
  'docs/07_DEPLOYMENT_GUIDE.md',
  'docs/09_RUNTIME_ARCHITECTURE.md',
  'docs/11_SECURITY_ARCHITECTURE.md',
  'docs/19_DATA_FLOWS.md',
  'docs/20_TESTING_QUALITY.md',
  'docs/21_ENVIRONMENT_CONFIG.md',
  'docs/22_SCRIPTS_BUILD_TOOLS.md',
  'docs/architecture/PHASE-ROADMAP.md',
  'docs/architecture/CLIENT-FIRST-PROCESSING-POLICY.md',
  'docs/architecture/PHASE-0-1-COMPLETION.md'
];

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

for (const rel of required) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail('missing Phase 0 baseline artifact: ' + rel);
  else pass('baseline artifact present: ' + rel);
}
if (process.exitCode) process.exit(1);

const checks = [
  ['project baseline documents browser/server execution split', read('docs/01_PROJECT_MASTER.md').includes('BROWSER') && read('docs/01_PROJECT_MASTER.md').includes('EXPRESS')],
  ['project baseline documents deployment flow', read('docs/01_PROJECT_MASTER.md').includes('Firebase Hosting') && read('docs/01_PROJECT_MASTER.md').includes('Cloudflare Worker')],
  ['TRD documents runtime/dependency baseline', /Node\.js|Runtime|Dependencies/i.test(read('docs/03_TRD.md'))],
  ['deployment guide documents deployment targets', read('docs/07_DEPLOYMENT_GUIDE.md').includes('Firebase Hosting') && read('docs/07_DEPLOYMENT_GUIDE.md').includes('Cloudflare Worker')],
  ['data-flow document distinguishes client and server processing', read('docs/19_DATA_FLOWS.md').includes('Client-Side Processing') && read('docs/19_DATA_FLOWS.md').includes('Server-Side Processing')],
  ['security document records file/security boundaries', read('docs/11_SECURITY_ARCHITECTURE.md').includes('File Security') && read('docs/11_SECURITY_ARCHITECTURE.md').includes('JWT Secret')],
  ['environment document records secret boundary', /DO NOT commit to repository/i.test(read('docs/21_ENVIRONMENT_CONFIG.md'))],
  ['testing document records current validation model', read('docs/20_TESTING_QUALITY.md').includes('enterprise-ci-gate.js')],
  ['scripts document records build/CI tooling', read('docs/22_SCRIPTS_BUILD_TOOLS.md').includes('enterprise-ci-gate.js')],
  ['tool inventory exists in authoritative runtime config', read('public/js/tools-config.js').includes('const TOOLS = [')],
  ['server upload lifecycle exists', read('utils/upload.js').includes('sweepUploads') && read('utils/upload.js').includes('UPLOAD_DIR')],
  ['security workflow invokes core validation', read('.github/workflows/audit.yml').includes('npm test') && read('.github/workflows/audit.yml').includes('audit:security') && read('.github/workflows/audit.yml').includes('audit:runtime')],
  ['deployment workflow validates before deploy', read('.github/workflows/deploy.yml').includes('npm test') && read('.github/workflows/deploy.yml').includes('audit:security')],
  ['Phase 0 scope lists all baseline dimensions', (() => { const c=read('docs/architecture/PHASE-0-1-COMPLETION.md'); return ['repository structure','runtime and deployment','tool inventory','browser/server','security and secret','temporary/permanent storage','tests and ci','current ui/shared','migration constraints'].every(x=>c.toLowerCase().includes(x)); })()]
];
for (const [name, ok] of checks) ok ? pass(name) : fail(name);

const walk = dir => {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    if (e.isDirectory() && (e.name === 'node_modules' || e.name === '.git')) continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
};
const publicFiles=walk(path.join(ROOT,'public'));
const scripts=walk(path.join(ROOT,'scripts'));
const html=publicFiles.filter(p=>p.endsWith('.html')).length;
const js=walk(ROOT).filter(p=>p.endsWith('.js')).length;
const scriptCount=scripts.filter(p=>p.endsWith('.js')).length;
console.log('PHASE0 INVENTORY: public_html='+html+' total_js='+js+' scripts_js='+scriptCount);

if (process.exitCode) {
  console.error('Phase 0 Discovery/Current-State Closure: FAILED');
  process.exit(1);
}
console.log('Phase 0 Discovery/Current-State Closure: PASSED');
