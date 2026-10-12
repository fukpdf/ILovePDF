#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.HOMEPAGE_NODE_SMOKE_PORT || 4174);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); });
child.stderr.on('data', chunk => { output += chunk.toString(); });

try {
  let response = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Node server exited before serving homepage.\n' + output);
    try {
      response = await fetch(base + '/');
      if (response.ok) break;
    } catch {}
    await delay(250);
  }
  if (!response || response.status !== 200) {
    throw new Error('Node server did not return HTTP 200 for /.\n' + output);
  }
  const html = await response.text();
  if (!/<!doctype\s+html/i.test(html)) throw new Error('Node server did not return a complete HTML document');
  if (/DecompressionStream|Loading ILovePDF/i.test(html)) {
    throw new Error('Node server still serves the runtime chunk loader instead of assembled homepage HTML');
  }
  if (!/<h1\b/i.test(html)) throw new Error('Node-served homepage has no H1 in the initial HTML response');
  const css = await fetch(base + '/css/home.css');
  if (css.status !== 200) throw new Error('Node server failed to serve homepage CSS: HTTP ' + css.status);
  const stylesheetAuditHtml = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
  const duplicateCssPaths = [...stylesheetAuditHtml.matchAll(/<link\b[^>]*>/gi)]
    .map(match => match[0])
    .filter(tag => /\brel=["'][^"']*\bstylesheet\b[^"']*["']/i.test(tag))
    .map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
    .filter(href => href && href.startsWith('/css/'))
    .map(href => href.split(/[?#]/, 1)[0])
    .filter((href, index, all) => all.indexOf(href) !== index);
  if (duplicateCssPaths.length) {
    throw new Error('Node-served homepage repeats local CSS paths: ' + [...new Set(duplicateCssPaths)].join(', '));
  }
  console.log('PASS: real Node server serves assembled homepage HTML directly (HTTP 200), with no runtime loader and working homepage CSS');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000)
  ]);
}
