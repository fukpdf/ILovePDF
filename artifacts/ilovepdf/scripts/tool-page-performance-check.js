#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public/tool.html'), 'utf8');
const styles = readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');
const toolPage = readFileSync(path.join(root, 'public/js/tool-page.js'), 'utf8');
const loader = readFileSync(path.join(root, 'public/js/tool-engine-loader.js'), 'utf8');
const browserTools = readFileSync(path.join(root, 'public/js/browser-tools.js'), 'utf8');
const advancedEngine = readFileSync(path.join(root, 'public/js/advanced-engine.js'), 'utf8');

const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
const externalScripts = scriptTags.filter((tag) => /\bsrc\s*=/i.test(tag));
const scriptUrls = externalScripts.map((tag) => {
  const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}).filter(Boolean);
const fileName = (url) => url.split('/').pop().split('?')[0];
const loaderScriptIndex = html.indexOf('<script src=\"/js/tool-engine-loader.js\" defer></script>');
const toolPageScriptIndex = html.indexOf('<script src=\"/js/tool-page.js?v=20261010-popular-tool-cards-audit-v1\" defer></script>');

const initialEngineFiles = new Set([
  'workerPool.js', 'browser-tools.js', 'browser-tool-runtime.js', 'advanced-engine.js',
  'pdf-preview.js', 'live-preview.js', 'page-organizer.js', 'runtime-stream-bridge.js',
  'compress-runtime.js', 'compress-worker-adapter.js', 'merge-runtime.js',
  'merge-worker-adapter.js', 'runtime-tool-idle-loader.js', 'bg-ai-engine.js',
  'bg-remover-pro.js', 'edit-pdf-pro.js', 'pdf-word-app.js', 'pdf-excel-app.js',
  'pdf-ppt-app.js', 'compress-pdf-app.js', 'runtime-processor-loader.js',
]);
const initialEngineRequests = externalScripts.map((tag) => {
  const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  return match ? fileName(match[1]) : '';
}).filter((name) => initialEngineFiles.has(name));

const toolSpecificScripts = [
  'workerPool.js', 'stream-helpers.js', 'browser-tools.js', 'browser-tool-runtime.js',
  'runtime-stream-bridge.js', 'pdf-preview.js', 'live-preview.js', 'page-organizer.js',
];
const advancedTools = [
  'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint', 'word-to-pdf',
  'powerpoint-to-pdf', 'excel-to-pdf', 'word-to-excel', 'html-to-pdf', 'ocr',
  'scan-to-pdf', 'translate', 'ai-summarize', 'crop-image',
  'resize-image', 'image-filters', 'image-compressor', 'image-converter',
];
const translationScripts = [
  'universal-encoding-repair.js', 'universal-translation-chunker.js',
  'universal-ocr-cleanup.js', 'global-multilingual-renderer.js',
  'universal-translation-validator.js', 'universal-translation-pipeline.js',
];
const checks = [
  ['only lightweight shell scripts are requested on initial tool-page open', externalScripts.length <= 25],
  ['no processing, preview, worker, or idle-engine script is referenced by initial HTML', initialEngineRequests.length === 0],
  ['tool engine loader is included before tool-page bootstrap', /src=["']\/js\/tool-engine-loader\.js["'][^>]*defer/i.test(html) && loaderScriptIndex >= 0 && toolPageScriptIndex > loaderScriptIndex],
  ['essential tool identity/configuration scripts remain on the shell', ['tools-config.js', 'tool-registry-runtime.js', 'tool-module-registry.js', 'tool-page.js'].every((name) => externalScripts.some((tag) => tag.includes(name)))],
  ['loader uses deterministic sequential script injection', /script\.async\s*=\s*false/.test(loader) && /await loadOne\(sources\[i\]\)/.test(loader)],
  ['loader deduplicates scripts and concurrent tool preparation', /_loaded\\s*=\\s*new Set/.test(loader) && loader.includes('_scriptPromises = new Map()') && loader.includes('_enginePromises = new Map()')],
  ['shared engine includes browser processing and streaming dependencies', toolSpecificScripts.every((name) => loader.includes(name))],
  ['advanced engine is restricted to tools that use advanced processing', advancedTools.every((id) => loader.includes("'" + id + "'")) && /ADVANCED_TOOLS/.test(loader)],
  ['only relevant pro-editor modules are mapped for edit/background-removal', loader.includes("'background-remover': ['/js/bg-ai-engine.js', '/js/bg-remover-pro.js']") && loader.includes("'edit': ['/js/edit-pdf-pro.js']")],
  ['translation/OCR enhancements are requested only for related tools', translationScripts.every((name) => loader.includes(name)) && /TRANSLATION_TOOLS/.test(loader)],
  ['file selection starts preview and engine loads in parallel', /ToolEngineLoader\.prepareEngine\(tool\.id\)/.test(toolPage) && /ToolEngineLoader\.preparePreview\(tool\.id\)/.test(toolPage)],
  ['preview does not wait for processing engine downloads', /const previewResult = await previewWarm/.test(toolPage) && !/await Promise\.all\(\[engineWarm, previewWarm\]\)/.test(toolPage)],
  ['engine readiness updates while user reviews preview', /engineWarmHandled\.then/.test(toolPage) && /engine-ready-status/.test(toolPage)],
  ['processing has a defensive engine-ready gate', /!window\.ToolEngineLoader\.isEngineReady\(currentTool\.id\)/.test(toolPage) && /await window\.ToolEngineLoader\.prepareEngine\(currentTool\.id\)/.test(toolPage)],
  ['PDF-to-Word fidelity modules are loaded after file selection in dependency order', [
    'font-mapper.js', 'column-engine.js', 'form-reconstruction.js', 'fidelity-validator.js',
    'visual-reconstruction.js', 'ocr-zoning.js', 'image-anchor-engine.js', 'layout-graph.js',
    'docx-coordinate-engine.js', 'fidelity-debug.js',
  ].every((name) => browserTools.includes("'/js/pdf-pipeline/" + name + "'") && loader.includes("/js/pdf-pipeline/" + name))],
  ['advanced engine supports lazy loading after window load', /function attachResumeInput\(\)/.test(advancedEngine) && /document\.readyState === 'complete'\) attachResumeInput\(\)/.test(advancedEngine)],
  ['upload skeleton remains in initial HTML', /class=["']sk-upload-wrap["']/.test(html) && /class=["']sk-upload-icon["']/.test(html)],
  ['skeleton reserves stable dimensions', /\.sk-upload-icon\s*\{[^}]*width:\s*64px[^}]*height:\s*64px/s.test(styles) && /\.sk-upload-btn\s*\{[^}]*width:\s*200px[^}]*height:\s*48px/s.test(styles)],
  ['tool shell reserves initial viewport to reduce footer shift', /main#tool-content\s*\{[^}]*min-height:\s*100vh[^}]*min-height:\s*100svh/s.test(styles)],
  ['main stylesheet remains present', /href=["']\/css\/styles\.css(?:\?[^"']*)?["']/.test(html)],
  ['processing workers are not prefetched on initial page open', !html.includes('rel="prefetch" href="/workers/') && !html.includes("rel='prefetch' href='/workers/")],
  ['duplicate initial external script URLs are absent', new Set(scriptUrls).size === scriptUrls.length],
];

let failed = 0;
for (const [name, passed] of checks) {
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
  if (!passed) failed++;
}
console.log('INFO initial external script tags: ' + externalScripts.length);
console.log('INFO processing/preview script requests at initial HTML parse: ' + initialEngineRequests.length);
console.log('INFO exact duplicate initial script URLs: ' + (scriptUrls.length - new Set(scriptUrls).size));

for (const file of [
  'public/js/tool-engine-loader.js',
  'public/js/tool-page.js',
  'public/js/advanced-engine.js',
]) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  const passed = result.status === 0;
  console.log((passed ? 'PASS ' : 'FAIL ') + 'JavaScript syntax: ' + file);
  if (!passed) {
    failed++;
    if (result.stderr) console.error(result.stderr);
  }
}

assert.equal(failed, 0, failed + ' on-demand engine regression checks failed.');
