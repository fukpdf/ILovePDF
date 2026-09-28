#!/usr/bin/env node
// Phase 5 bulk i18n runtime-integrity gate.
// Covers Units 62-73 as one auditable batch.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));
const fail = [];
const ok = [];
const requireMatch = (source, re, msg) => re.test(source) ? ok.push(msg) : fail.push(msg);

const i18n = read('public/js/i18n.js');
const ext = read('public/js/i18n-ext.js');
const special = read('public/js/special-page-i18n.js');
const bridge = read('public/js/tool-i18n-bridge.js');
const chunker = read('public/js/universal-translation-chunker.js');
const validator = read('public/js/universal-translation-validator.js');
const pipeline = read('public/js/universal-translation-pipeline.js');

const expected = ['en','ar','ur','fa','hi','bn','zh','ja','ko','tr','id','ru','fr','de','es','pt','it','nl','pl'];

const codes = [...i18n.matchAll(/code:'([^']+)'/g)].map(m => m[1]);
if (codes.length !== expected.length || expected.some(x => !codes.includes(x)) || new Set(codes).size !== codes.length) fail.push('62 locale registry is not exactly the expected 19 unique locales.');
else ok.push('62 locale registry is exact and unique.');

for (const code of expected) {
  const p = 'public/locales/' + code + '.json';
  if (!exists(p)) { fail.push('63 missing locale asset: ' + p); continue; }
  try {
    const data = JSON.parse(read(p));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) fail.push('63 empty/invalid locale JSON: ' + code);
  } catch (_) { fail.push('63 invalid locale JSON: ' + code); }
}
if (!fail.some(x => x.startsWith('63 '))) ok.push('63 all registered locale JSON assets exist and parse.');

requireMatch(ext, /var EXT = \{\};/, '64 extension registry exists.');
requireMatch(ext, /RuntimeI18n\.extend\(/, '64 extension pack uses RuntimeI18n.extend.');
requireMatch(ext, /setLanguage/, '64 extension pack re-hooks language changes.');
for (const code of expected) requireMatch(ext, new RegExp("EXT\\['" + code + "'\\]"), '64 extension entry exists: ' + code);

requireMatch(i18n, /_loading\[lang\]/, '65 concurrent locale loads are deduplicated.');
if (i18n.includes("fetch(LOCALES_BASE + lang + '.json'")) ok.push('65 locale loading is lazy and path-based.');
else fail.push('65 locale loading is lazy and path-based.');
requireMatch(i18n, /_fetched\[lang\] = true/, '65 successful locale loads are cached.');
requireMatch(i18n, /loadLocale: function \(lang\)/, '65 public loadLocale API exists.');

requireMatch(i18n, /_fallback\[key\]/, '66 English fallback is used by translation lookup.');
requireMatch(i18n, /localStorage\.setItem\(STORAGE_KEY, target\)/, '66 selected language is persisted.');
requireMatch(i18n, /localStorage\.setItem\(EXPLICIT_STORAGE_KEY, '1'\)/, '66 explicit-user marker is persisted.');
requireMatch(i18n, /options\.persist !== false/, '66 non-persistent automatic detection is supported.');
requireMatch(i18n, /explicit && stored/, '66 explicit stored choice wins during init.');

requireMatch(i18n, /navigator\.languages/, '67 browser language priority list is inspected.');
requireMatch(i18n, /split\('-'\)\[0\]/, '67 regional browser language codes normalize to base codes.');
requireMatch(i18n, /setLanguage\(browserLang, \{ persist: false \}\)/, '67 automatic browser detection does not mark a manual choice.');

requireMatch(i18n, /RTL_LANGS/, '68 RTL language registry exists.');
requireMatch(i18n, /setAttribute\('dir',\s*rtl \?\s*'rtl' : 'ltr'\)/, '68 document direction follows selected language.');
requireMatch(i18n, /setAttribute\('lang', lang\)/, '68 document lang follows selected language.');
requireMatch(i18n, /classList\.toggle\('rtl', rtl\)/, '68 RTL body class is synchronized.');

for (const attr of ['data-i18n','data-i18n-placeholder','data-i18n-html','data-i18n-title','data-i18n-aria-label']) {
  if (i18n.includes(attr)) ok.push('69 DOM hook supported: ' + attr);
  else fail.push('69 DOM hook missing: ' + attr);
}
requireMatch(i18n, /rerender: function \(\)/, '69 explicit DOM rerender API exists.');
requireMatch(i18n, /refreshDynamic: function \(\)/, '69 dynamic refresh API exists.');

requireMatch(i18n, /new MutationObserver/, '70 MutationObserver exists for dynamic nodes.');
requireMatch(i18n, /clearTimeout\(_obsTimer\)/, '70 observer work is debounced.');
requireMatch(i18n, /observe: function \(\)/, '70 observer can be started idempotently.');
requireMatch(i18n, /if \(_observer \|\| typeof MutationObserver === 'undefined'\) return/, '70 observer has duplicate/unsupported-runtime guard.');

requireMatch(bridge, /i18n:change/, '71 tool card bridge listens for language changes.');
requireMatch(bridge, /data-tid/, '71 tool cards prefer canonical data-tid.');
requireMatch(bridge, /humanisedFallback/, '71 tool bridge rejects humanised missing-key fallbacks.');
requireMatch(bridge, /DOMContentLoaded/, '71 tool bridge has initial hydration hook.');

requireMatch(special, /SpecialPageI18n=Object\.freeze/, '72 special-page bridge exposes isolated API.');
requireMatch(special, /i18n:change/, '72 special-page bridge reacts to global language changes.');
requireMatch(special, /hook\(\)/, '72 special-page bridge initializes its DOM hooks.');
requireMatch(special, /data-i18n/, '72 special-page bridge uses semantic i18n hooks.');

requireMatch(chunker, /UniversalTranslationChunker/, '73 chunker runtime is exposed.');
requireMatch(chunker, /LanguageAwareChunker/, '73 language-aware chunking exists.');
requireMatch(chunker, /ResumeSafeChunkState/, '73 resumable chunk state exists.');
requireMatch(validator, /UniversalTranslationValidator/, '73 validator runtime is exposed.');
requireMatch(validator, /CorruptionScanner/, '73 corruption scanning exists.');
requireMatch(validator, /SafeMergeEngine/, '73 safe translated-chunk merge exists.');
requireMatch(pipeline, /UniversalTranslationPipeline/, '73 translation pipeline runtime is exposed.');
requireMatch(pipeline, /validator|Validator/i, '73 pipeline references translation validation.');

if (fail.length) {
  console.error('[FAIL] Phase 5 bulk i18n runtime-integrity gate (' + fail.length + ' issue(s))');
  fail.forEach(x => console.error(' - ' + x));
  process.exitCode = 1;
} else {
  ok.forEach(x => console.log('[PASS] ' + x));
  console.log('Phase 5 bulk i18n runtime-integrity gate: PASS');
}
