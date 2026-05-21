// compare-worker.js v1.0 — PDF comparison report builder
// Phase 2C: Off-thread report generation for compare-pdf-app.js.
// Terminates after each job.
//
// Protocol:
//   IN:  { op: 'compare', textA: string, textB: string, filenameA, filenameB,
//          pagesA: number, pagesB: number, jobId: string }
//   OUT: { buffer: ArrayBuffer, similarity: number, jobId }   (buffer = UTF-8 text)
//   ERR: { __error: string }

'use strict';

self.onmessage = function (e) {
  var data      = e.data || {};
  var op        = data.op;
  var textA     = data.textA     || '';
  var textB     = data.textB     || '';
  var filenameA = data.filenameA || 'Document A';
  var filenameB = data.filenameB || 'Document B';
  var pagesA    = data.pagesA    || 0;
  var pagesB    = data.pagesB    || 0;
  var jobId     = data.jobId     || '';

  if (op !== 'compare') {
    self.postMessage({ __error: 'compare-worker: unknown op: ' + op });
    return;
  }

  try {
    var wordsA = (textA.toLowerCase().match(/\b[a-z]{2,}\b/g) || []);
    var wordsB = (textB.toLowerCase().match(/\b[a-z]{2,}\b/g) || []);

    var setA = new Set(wordsA);
    var setB = new Set(wordsB);
    var inter = 0;
    setA.forEach(function (w) { if (setB.has(w)) inter++; });
    var union   = setA.size + setB.size - inter;
    var sim     = union > 0 ? Math.round(inter / union * 100) : 0;
    var uniqueA = setA.size - inter;
    var uniqueB = setB.size - inter;

    // Per-page word counts (pages joined by '\n=== page N ===\n' convention)
    var pageTextsA = textA.split(/\n=== page \d+ ===\n/i).filter(Boolean);
    var pageTextsB = textB.split(/\n=== page \d+ ===\n/i).filter(Boolean);
    var maxP = Math.max(pageTextsA.length, pageTextsB.length, pagesA, pagesB);

    var pageDiffs = [];
    for (var pi = 0; pi < maxP; pi++) {
      var pa   = (pageTextsA[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
      var pb   = (pageTextsB[pi] || '').toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
      var psa  = new Set(pa);
      var psb  = new Set(pb);
      var padd = 0, prem = 0;
      psb.forEach(function (w) { if (!psa.has(w)) padd++; });
      psa.forEach(function (w) { if (!psb.has(w)) prem++; });
      if (padd || prem) {
        pageDiffs.push({ page: pi + 1, added: padd, removed: prem });
      }
    }

    var verdict = sim >= 90 ? 'Documents appear to be very similar or nearly identical.'
                : sim >= 60 ? 'Documents share significant content with notable differences.'
                : sim >= 30 ? 'Documents have some common content but are substantially different.'
                :             'Documents appear to be largely different in content.';

    var lines = [
      'ILovePDF \u2014 Document Comparison Report',
      '='.repeat(50),
      'Generated : ' + new Date().toISOString(),
      'Document A: ' + filenameA + (pagesA ? ' (' + pagesA + ' pages)' : ''),
      'Document B: ' + filenameB + (pagesB ? ' (' + pagesB + ' pages)' : ''),
      'Similarity: ' + sim + '% word overlap',
      '',
      'WORD ANALYSIS',
      '-'.repeat(50),
      'Words unique to A : ' + uniqueA,
      'Words unique to B : ' + uniqueB,
      'Words in common   : ' + inter,
      '',
    ];

    if (pageDiffs.length > 0) {
      lines.push('PAGE-BY-PAGE DIFFERENCES');
      lines.push('-'.repeat(50));
      pageDiffs.forEach(function (d) {
        lines.push('Page ' + d.page + ': +' + d.added + ' words added / -' + d.removed + ' words removed');
      });
      lines.push('');
    }

    lines.push('VERDICT');
    lines.push('-'.repeat(50));
    lines.push(verdict);

    var report = lines.join('\n');
    var enc    = new TextEncoder();
    var buf    = enc.encode(report).buffer;

    self.postMessage({ buffer: buf, similarity: sim, jobId: jobId }, [buf]);
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: jobId });
  }
};

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
