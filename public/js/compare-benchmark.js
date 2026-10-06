// Phase 40K — Compare Accuracy Benchmark v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § K1  DocumentPairLibrary   — synthetic test pairs (modified, reordered, whitespace, etc.)
// § K2  SimilarityScorer      — measures false positives, false negatives, similarity accuracy
// § K3  CompareBenchmarkRunner— runs all test pairs through similarity engine
//
// Exposes: window.CompareBenchmark

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[CB]';

  function _log(t, d) { try { window.DebugTrace && window.DebugTrace.log && window.DebugTrace.log(LOG_PFX + ' ' + t, d); } catch (_) {} }

  // ═══════════════════════════════════════════════════════════════════════════
  // § K1  DOCUMENT PAIR LIBRARY
  // Each pair has: docA text, docB text, expected similarity (0–1), change type
  // ═══════════════════════════════════════════════════════════════════════════
  var DocumentPairLibrary = (function () {
    var PAIRS = [
      {
        id: 'identical',
        type: 'identical',
        docA: 'The quick brown fox jumps over the lazy dog.',
        docB: 'The quick brown fox jumps over the lazy dog.',
        expectedSim: 1.0,
        expectedDiff: 0.0,
      },
      {
        id: 'minor-edit',
        type: 'minor-edit',
        docA: 'The quick brown fox jumps over the lazy dog.',
        docB: 'The quick brown fox jumped over the lazy dog.',
        expectedSim: 0.90,
        expectedDiff: 0.10,
      },
      {
        id: 'whitespace-only',
        type: 'whitespace',
        docA: 'Hello World\nFoo Bar',
        docB: 'Hello  World\n\nFoo  Bar',
        expectedSim: 0.95,
        expectedDiff: 0.05,
      },
      {
        id: 'reordered-sentences',
        type: 'reorder',
        docA: 'First sentence. Second sentence. Third sentence.',
        docB: 'Third sentence. First sentence. Second sentence.',
        expectedSim: 0.70,
        expectedDiff: 0.30,
      },
      {
        id: 'font-change',
        type: 'font-change',
        docA: 'Invoice Amount: $500.00',
        docB: 'Invoice Amount: $500.00',   // same content, different rendering (simulated identical)
        expectedSim: 1.0,
        expectedDiff: 0.0,
      },
      {
        id: 'major-change',
        type: 'major-change',
        docA: 'Original document with important financial data Q4 revenue $1.2M.',
        docB: 'Completely different content about weather patterns in Europe during winter.',
        expectedSim: 0.05,
        expectedDiff: 0.95,
      },
      {
        id: 'translation',
        type: 'translation',
        docA: 'The annual report shows strong growth in all regions.',
        docB: 'Le rapport annuel montre une forte croissance dans toutes les régions.',
        expectedSim: 0.10,
        expectedDiff: 0.90,
      },
      {
        id: 'partial-redact',
        type: 'redaction',
        docA: 'Employee: John Smith, SSN: 123-45-6789, Salary: $75,000',
        docB: 'Employee: [REDACTED], SSN: [REDACTED], Salary: [REDACTED]',
        expectedSim: 0.40,
        expectedDiff: 0.60,
      },
    ];

    function getAll() { return PAIRS.slice(); }
    function getById(id) { return PAIRS.find(function (p) { return p.id === id; }) || null; }

    return { getAll: getAll, getById: getById };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § K2  SIMILARITY SCORER
  // ═══════════════════════════════════════════════════════════════════════════
  var SimilarityScorer = (function () {

    function _tokenize(text) {
      return (text || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    }

    // Jaccard similarity on word tokens
    function jaccardSim(textA, textB) {
      var setA = new Set(_tokenize(textA));
      var setB = new Set(_tokenize(textB));
      var inter = 0;
      setA.forEach(function (t) { if (setB.has(t)) inter++; });
      var union = setA.size + setB.size - inter;
      return union === 0 ? 1.0 : inter / union;
    }

    // Character n-gram similarity (bigrams)
    function bigramSim(textA, textB) {
      function bigrams(s) {
        var set = new Set();
        for (var i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
        return set;
      }
      var bA  = bigrams((textA || '').toLowerCase());
      var bB  = bigrams((textB || '').toLowerCase());
      var inter = 0;
      bA.forEach(function (b) { if (bB.has(b)) inter++; });
      var union = bA.size + bB.size - inter;
      return union === 0 ? 1.0 : inter / union;
    }

    // Combined similarity: weighted Jaccard + bigram
    function similarity(textA, textB) {
      var jac = jaccardSim(textA, textB);
      var bg  = bigramSim(textA, textB);
      return Math.round((jac * 0.6 + bg * 0.4) * 1000) / 1000;
    }

    function score(textA, textB, pair) {
      var sim  = similarity(textA, textB);
      var diff = Math.round((1 - sim) * 1000) / 1000;

      var error    = Math.abs(sim - (pair.expectedSim || 0));
      var accurate = error < 0.20;   // within 20 percentage points

      // False positive: reported similar but shouldn't be
      var falsePositive = sim > 0.7 && (pair.expectedSim || 0) < 0.3;
      // False negative: reported different but shouldn't be
      var falseNegative = sim < 0.5 && (pair.expectedSim || 0) > 0.8;

      return {
        similarity:   sim,
        diff:         diff,
        expected:     pair.expectedSim,
        error:        Math.round(error * 100) + '%',
        accurate:     accurate,
        falsePositive: falsePositive,
        falseNegative: falseNegative,
        grade:        accurate ? 'A' : error < 0.35 ? 'B' : 'C',
      };
    }

    return { similarity: similarity, jaccardSim: jaccardSim, bigramSim: bigramSim, score: score };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // § K3  COMPARE BENCHMARK RUNNER
  // ═══════════════════════════════════════════════════════════════════════════
  var CompareBenchmarkRunner = (function () {

    async function run() {
      var pairs   = DocumentPairLibrary.getAll();
      var results = [];

      for (var pair of pairs) {
        var start  = performance.now();
        var scored = SimilarityScorer.score(pair.docA, pair.docB, pair);
        var ms     = Math.round(performance.now() - start);
        results.push({
          id:            pair.id,
          type:          pair.type,
          score:         scored,
          ms:            ms,
        });
        await new Promise(function (r) { setTimeout(r, 0); });
      }

      var fp    = results.filter(function (r) { return r.score.falsePositive; }).length;
      var fn    = results.filter(function (r) { return r.score.falseNegative; }).length;
      var accur = results.filter(function (r) { return r.score.accurate; }).length;
      var avgSim = results.reduce(function (s, r) { return s + r.score.similarity; }, 0) / results.length;

      _log('compare-benchmark', { total: results.length, accurate: accur, fp: fp, fn: fn });

      return {
        results:          results,
        totalPairs:       results.length,
        accurateCount:    accur,
        accuratePct:      Math.round((accur / results.length) * 100) + '%',
        falsePositives:   fp,
        falseNegatives:   fn,
        avgSimilarity:    Math.round(avgSim * 1000) / 1000,
        grade:            accur / results.length >= 0.8 ? 'A' : accur / results.length >= 0.6 ? 'B' : 'C',
      };
    }

    return { run: run };
  }());


  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  window.CompareBenchmark = {
    version:                VERSION,
    DocumentPairLibrary:    DocumentPairLibrary,
    SimilarityScorer:       SimilarityScorer,
    CompareBenchmarkRunner: CompareBenchmarkRunner,

    similarity: function (a, b) { return SimilarityScorer.similarity(a, b); },

    run: async function () {
      console.group('[CB] Compare Accuracy Benchmark');
      var r = await CompareBenchmarkRunner.run();
      console.table(r.results.map(function (x) {
        return {
          Pair: x.id,
          Type: x.type,
          Sim: (x.score.similarity * 100).toFixed(0) + '%',
          Expected: (x.score.expected * 100).toFixed(0) + '%',
          Error: x.score.error,
          FP: x.score.falsePositive ? '⚠' : '',
          FN: x.score.falseNegative ? '⚠' : '',
          Grade: x.score.grade,
        };
      }));
      console.log('Accuracy:', r.accuratePct, '  Grade:', r.grade, '  FP:', r.falsePositives, '  FN:', r.falseNegatives);
      console.groupEnd();
      return r;
    },

    audit: function () {
      return { version: VERSION, testPairs: DocumentPairLibrary.getAll().length };
    },
  };

  _log('loaded', {});
}());
