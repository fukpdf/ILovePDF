// translation-worker.js v1.0 — Translation output report formatter
// Phase 2C: Off-thread report builder for translate-pdf-app.js.
// Terminates after each job.
//
// NOTE: The actual translation is done via external API calls on the main thread
// (mymemory.translated.net).  This worker handles the final report assembly and
// encoding only — keeping main-thread CPU free.
//
// Protocol:
//   IN:  { op: 'build-report', translated: [{num, text}], sourceName, pages,
//          targetLang, srcLang, jobId }
//   OUT: { buffer: ArrayBuffer, jobId }   (buffer = UTF-8 encoded text report)
//   ERR: { __error: string }

'use strict';

self.onmessage = function (e) {
  var data       = e.data || {};
  var op         = data.op;
  var translated = data.translated || [];
  var sourceName = data.sourceName || 'document';
  var pages      = data.pages      || translated.length;
  var targetLang = data.targetLang || 'es';
  var srcLang    = data.srcLang    || 'en';
  var jobId      = data.jobId      || '';

  if (op !== 'build-report') {
    self.postMessage({ __error: 'translation-worker: unknown op: ' + op });
    return;
  }

  try {
    var lineOut = [
      'ILovePDF \u2014 Translated (' + targetLang.toUpperCase() + ')',
      '='.repeat(50),
      'Source    : ' + sourceName,
      'Pages     : ' + pages,
      'Direction : ' + srcLang.toUpperCase() + ' \u2192 ' + targetLang.toUpperCase(),
      'Generated : ' + new Date().toISOString(),
      '',
    ];

    translated.forEach(function (pg) {
      lineOut.push('--- Page ' + pg.num + ' ---');
      lineOut.push((pg.text && pg.text.trim()) ? pg.text : '(empty page)');
      lineOut.push('');
    });

    var report = lineOut.join('\n');
    var enc    = new TextEncoder();
    var buf    = enc.encode(report).buffer;

    self.postMessage({ buffer: buf, jobId: jobId }, [buf]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: jobId });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
