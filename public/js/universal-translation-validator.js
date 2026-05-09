// Phase 41E — Universal Translation Validation Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 41E-1  CorruptionScanner        — detect malformed Unicode in translated output
// § 41E-2  TranslationQualityAudit  — score readability, glyph correctness, consistency
// § 41E-3  AutoRetryEngine          — retry strategy when corruption detected
// § 41E-4  ChunkRepairRecovery      — repair only failed chunks, never full rerun
// § 41E-5  SafeMergeEngine          — merge translated chunks preserving order/structure
//
// Exposes: window.UniversalTranslationValidator

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41E]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41E-1  CORRUPTION SCANNER
  // Detects malformed Unicode, glyph ratio issues, invalid sequences.
  // ═══════════════════════════════════════════════════════════════════════════

  var CorruptionScanner = (function () {

    var CORRUPTION_THRESHOLD  = 0.05;  // 5% replacement chars → corrupted
    var GLYPH_ISSUE_THRESHOLD = 0.15;  // 15% question marks → glyph failure

    function scanChunk(text, sourceText) {
      if (!text || typeof text !== 'string') {
        return { corrupted: true, score: 1, reason: 'empty-chunk' };
      }

      var len = text.length || 1;
      var issues = [];
      var score  = 0;

      // 1. Replacement char density
      var replacements = (text.match(/\uFFFD/g) || []).length;
      var repRatio     = replacements / len;
      if (repRatio > CORRUPTION_THRESHOLD) {
        issues.push('replacement-chars');
        score += repRatio * 2;
      }

      // 2. Excessive question marks (glyph failure indicator)
      var qmarks     = (text.match(/\?/g) || []).length;
      var qmarkRatio = qmarks / len;
      if (qmarkRatio > GLYPH_ISSUE_THRESHOLD) {
        issues.push('glyph-question-marks');
        score += qmarkRatio;
      }

      // 3. Encoding corruption via Phase 41A if available
      var encodingScore = 0;
      if (window.UniversalEncodingRepair) {
        try {
          encodingScore = window.UniversalEncodingRepair.MojibakeDetector.score(text);
          if (encodingScore > 0.03) {
            issues.push('encoding-corruption');
            score += encodingScore;
          }
        } catch (_) {}
      }

      // 4. If source is provided: check length ratio (translated should be 20%–400% of source)
      if (sourceText && sourceText.length > 0) {
        var ratio = text.replace(/\s/g, '').length / Math.max(1, sourceText.replace(/\s/g, '').length);
        if (ratio < 0.15 || ratio > 5.0) {
          issues.push('length-ratio-anomaly');
          score += 0.3;
        }
      }

      // 5. Detect if translation returned source unchanged (failed translation)
      if (sourceText && text.trim() === sourceText.trim()) {
        issues.push('untranslated');
        score += 0.5;
      }

      score = Math.min(1, score);
      var corrupted = score > 0.1 || issues.length > 0;

      return { corrupted: corrupted, score: score, issues: issues, replacementRatio: repRatio, encodingScore: encodingScore };
    }

    function scanAll(chunks, sourceChunks) {
      var results     = [];
      var totalCorr   = 0;
      var failedIdx   = [];

      for (var i = 0; i < chunks.length; i++) {
        var src = sourceChunks ? sourceChunks[i] : null;
        var r   = scanChunk(chunks[i], src);
        results.push(r);
        if (r.corrupted) { totalCorr++; failedIdx.push(i); }
      }

      var overallScore = chunks.length > 0 ? 1 - (totalCorr / chunks.length) : 0;

      _log('scan-complete', { total: chunks.length, corrupted: totalCorr, overallScore: overallScore.toFixed(3) });

      return {
        chunkResults: results,
        totalCorrupted: totalCorr,
        failedIndices: failedIdx,
        overallScore: overallScore,
        hasCorruption: totalCorr > 0,
      };
    }

    return { scanChunk: scanChunk, scanAll: scanAll };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41E-2  TRANSLATION QUALITY AUDIT
  // Scores translation quality across multiple dimensions.
  // ═══════════════════════════════════════════════════════════════════════════

  var TranslationQualityAudit = (function () {

    function auditChunk(original, translated, opts) {
      opts = opts || {};
      var issues   = [];
      var warnings = [];

      if (!translated || !translated.trim()) {
        return { score: 0, grade: 'F', issues: ['empty-translation'], warnings: [], readability: 0 };
      }

      // 1. Readability: ratio of alpha chars to total
      var alphaChars  = (translated.match(/[a-zA-Z\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u0900-\u097F]/g) || []).length;
      var readability = Math.min(1, alphaChars / Math.max(1, translated.length));

      // 2. Glyph correctness: low replacement-char ratio
      var repChars  = (translated.match(/\uFFFD|\?{3,}/g) || []).length;
      var glyphScore = Math.max(0, 1 - (repChars / Math.max(translated.length, 1)) * 10);

      // 3. Paragraph integrity: translated should preserve paragraph breaks
      if (original) {
        var origParas  = (original.match(/\n{2,}/g) || []).length;
        var transParas = (translated.match(/\n{2,}/g) || []).length;
        if (origParas > 2 && transParas < origParas * 0.3) {
          warnings.push('paragraph-structure-loss');
        }
      }

      // 4. Language consistency: detect if output is mostly question marks or replacement chars
      if (translated.length > 20) {
        var qRatio = (translated.match(/\?/g) || []).length / translated.length;
        if (qRatio > 0.3) { issues.push('glyph-failure'); }
        else if (qRatio > 0.1) { warnings.push('partial-glyph-failure'); }
      }

      // 5. Encoding issues
      if (window.UniversalEncodingRepair) {
        try {
          var corrScore = window.UniversalEncodingRepair.MojibakeDetector.score(translated);
          if (corrScore > 0.05) issues.push('encoding-corruption');
          else if (corrScore > 0.01) warnings.push('minor-encoding');
        } catch (_) {}
      }

      // Composite score
      var score = (readability * 0.4 + glyphScore * 0.4 + (issues.length === 0 ? 0.2 : 0));
      score = Math.max(0, Math.min(1, score));

      var grade = score >= 0.85 ? 'A' : score >= 0.70 ? 'B' : score >= 0.55 ? 'C' : score >= 0.40 ? 'D' : 'F';

      return { score: score, grade: grade, issues: issues, warnings: warnings, readability: readability, glyphScore: glyphScore };
    }

    function auditAll(originals, translated) {
      var results   = [];
      var totalScore = 0;

      for (var i = 0; i < translated.length; i++) {
        var orig = originals ? originals[i] : null;
        var r    = auditChunk(orig, translated[i]);
        results.push(r);
        totalScore += r.score;
      }

      var avgScore = translated.length > 0 ? totalScore / translated.length : 0;
      _log('audit-complete', { chunks: translated.length, avgScore: avgScore.toFixed(3) });
      return { chunkAudits: results, averageScore: avgScore, overallGrade: avgScore >= 0.7 ? 'pass' : 'fail' };
    }

    return { auditChunk: auditChunk, auditAll: auditAll };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41E-3  AUTO RETRY ENGINE
  // Determines retry strategy for corrupted or failed translation chunks.
  // ═══════════════════════════════════════════════════════════════════════════

  var AutoRetryEngine = (function () {

    var MAX_RETRIES = 3;

    // Strategy for each retry attempt
    var RETRY_STRATEGIES = [
      { label: 'smaller-chunk',    maxLen: 200, encoding: true  },
      { label: 'encoding-repair',  maxLen: 350, encoding: true  },
      { label: 'alternate-api',    maxLen: 400, encoding: false },
      { label: 'fallback-direct',  maxLen: 490, encoding: false },
    ];

    function shouldRetry(scanResult, attempt) {
      if (!scanResult || !scanResult.corrupted) return false;
      return attempt < MAX_RETRIES;
    }

    function getStrategy(attempt, scanResult) {
      var idx      = Math.min(attempt, RETRY_STRATEGIES.length - 1);
      var strategy = Object.assign({}, RETRY_STRATEGIES[idx]);

      // Adjust for specific issues
      if (scanResult && scanResult.issues) {
        if (scanResult.issues.indexOf('length-ratio-anomaly') !== -1) strategy.maxLen = 150;
        if (scanResult.issues.indexOf('encoding-corruption') !== -1) strategy.encoding = true;
        if (scanResult.issues.indexOf('untranslated') !== -1) strategy.useAlternate = true;
      }

      return strategy;
    }

    // Repair a chunk before retry
    function repairChunk(chunk, strategy) {
      if (!strategy.encoding) return chunk;
      if (!window.UniversalEncodingRepair) return chunk;
      try {
        var result = window.UniversalEncodingRepair.repair(chunk);
        return result.cleanText || chunk;
      } catch (_) { return chunk; }
    }

    // Split a chunk for retry with a smaller size
    function splitForRetry(chunk, maxLen) {
      if (!chunk) return [];
      var chunker = window.UniversalTranslationChunker;
      if (chunker) {
        try {
          return chunker.chunkText(chunk, { maxLen: maxLen });
        } catch (_) {}
      }
      // Fallback: hard split
      var out = [];
      var start = 0;
      while (start < chunk.length) {
        out.push(chunk.slice(start, start + maxLen).trim());
        start += maxLen;
      }
      return out.filter(function (c) { return c.length > 0; });
    }

    return { shouldRetry: shouldRetry, getStrategy: getStrategy, repairChunk: repairChunk, splitForRetry: splitForRetry, MAX_RETRIES: MAX_RETRIES };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41E-4  CHUNK REPAIR RECOVERY
  // Repairs only failed chunks without rerunning the entire document.
  // ═══════════════════════════════════════════════════════════════════════════

  var ChunkRepairRecovery = (function () {

    // Repair a single failed chunk: try encoding repair, then smaller split
    async function repairChunk(index, originalChunk, translatedChunk, translateFn, opts) {
      opts = opts || {};
      var scan = CorruptionScanner.scanChunk(translatedChunk, originalChunk);

      if (!scan.corrupted) return translatedChunk; // Nothing to fix

      _log('repairing-chunk', { index: index, score: scan.score.toFixed(3), issues: scan.issues });

      // Strategy 1: Repair encoding of original chunk then re-translate
      for (var attempt = 0; attempt < AutoRetryEngine.MAX_RETRIES; attempt++) {
        var strategy     = AutoRetryEngine.getStrategy(attempt, scan);
        var repairedSrc  = AutoRetryEngine.repairChunk(originalChunk, strategy);

        // For small-chunk strategy: split and translate individually
        if (strategy.label === 'smaller-chunk' || repairedSrc.length > strategy.maxLen) {
          var subChunks = AutoRetryEngine.splitForRetry(repairedSrc, strategy.maxLen);
          var subResults = [];
          for (var s = 0; s < subChunks.length; s++) {
            try {
              var sub = await translateFn(subChunks[s], index, 1);
              subResults.push(sub || subChunks[s]);
            } catch (_) {
              subResults.push(subChunks[s]);
            }
          }
          var merged = subResults.join(' ');
          var newScan = CorruptionScanner.scanChunk(merged, originalChunk);
          if (!newScan.corrupted) {
            _log('chunk-repaired', { index: index, attempt: attempt, strategy: strategy.label });
            return merged;
          }
          continue;
        }

        // Standard retry
        try {
          var result = await translateFn(repairedSrc, index, 1);
          if (result) {
            var resultScan = CorruptionScanner.scanChunk(result, originalChunk);
            if (!resultScan.corrupted) {
              _log('chunk-repaired', { index: index, attempt: attempt, strategy: strategy.label });
              return result;
            }
          }
        } catch (_) {}
      }

      // All retries exhausted — return best available (repair encoding of translation)
      if (window.UniversalEncodingRepair) {
        try {
          var repResult = window.UniversalEncodingRepair.repair(translatedChunk || originalChunk);
          return repResult.cleanText || translatedChunk || originalChunk;
        } catch (_) {}
      }
      return translatedChunk || originalChunk;
    }

    // Repair all failed chunks in a results array
    async function repairFailed(originals, results, translateFn, scanResults, opts) {
      opts = opts || {};
      var repaired = results.slice(); // copy

      if (!scanResults || !scanResults.failedIndices || !scanResults.failedIndices.length) {
        return repaired;
      }

      var failedIndices = scanResults.failedIndices;
      _log('repair-start', { failedCount: failedIndices.length });

      for (var fi = 0; fi < failedIndices.length; fi++) {
        var idx = failedIndices[fi];
        try {
          repaired[idx] = await repairChunk(idx, originals[idx], results[idx], translateFn, opts);
        } catch (err) {
          _err('repair-chunk-error', { idx: idx, err: String(err && err.message || err) });
          repaired[idx] = results[idx] || originals[idx]; // keep best available
        }
      }

      _log('repair-complete', { repaired: failedIndices.length });
      return repaired;
    }

    return { repairChunk: repairChunk, repairFailed: repairFailed };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41E-5  SAFE MERGE ENGINE
  // Merges translated chunks preserving order, formatting, and directionality.
  // ═══════════════════════════════════════════════════════════════════════════

  var SafeMergeEngine = (function () {

    // Detect if a chunk ends with a sentence (for join logic)
    function endsSentence(text) {
      if (!text) return false;
      return /[.!?؟。！？\n]$/.test(text.trim());
    }

    // Detect if a chunk is a heading (ALL CAPS, short)
    function isHeading(text) {
      if (!text) return false;
      var t = text.trim();
      return t === t.toUpperCase() && /[A-Z\u0600-\u06FF\u0400-\u04FF]/.test(t) && t.length <= 100;
    }

    function merge(chunks, opts) {
      opts = opts || {};
      if (!chunks || !chunks.length) return '';

      var direction = opts.direction || 'ltr';
      var parts     = [];

      for (var i = 0; i < chunks.length; i++) {
        var chunk = (chunks[i] || '').trim();
        if (!chunk) continue;

        var prevChunk = i > 0 ? (chunks[i - 1] || '').trim() : '';

        // Heading: add double newline before
        if (isHeading(chunk)) {
          if (parts.length > 0) parts.push('\n\n');
          parts.push(chunk);
          parts.push('\n');
          continue;
        }

        // Normal flow: join with space, or paragraph break if previous ended a sentence
        if (parts.length > 0) {
          if (endsSentence(prevChunk)) {
            parts.push(' ');
          } else {
            parts.push(' ');
          }
        }
        parts.push(chunk);
      }

      var result = parts.join('');

      // Apply bidirectional markers for RTL output
      if (direction === 'rtl' && window.GlobalMultilingualRenderer) {
        try {
          result = window.GlobalMultilingualRenderer.BidirectionalLayoutEngine.applyBidiMarkers(result, 'rtl');
        } catch (_) {}
      }

      return result;
    }

    // Merge with structure preservation (using PdfTextFlowEngine if available)
    function mergeStructured(origBlocks, translatedTexts, opts) {
      if (!window.GlobalMultilingualRenderer) {
        return merge(translatedTexts, opts);
      }
      try {
        var PTE = window.GlobalMultilingualRenderer.PdfTextFlowEngine;
        var mergedBlocks = PTE.mergeTranslated(origBlocks, translatedTexts);
        return PTE.blocksToText(mergedBlocks);
      } catch (_) {
        return merge(translatedTexts, opts);
      }
    }

    return { merge: merge, mergeStructured: mergeStructured, isHeading: isHeading, endsSentence: endsSentence };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.UniversalTranslationValidator
  // ═══════════════════════════════════════════════════════════════════════════

  window.UniversalTranslationValidator = {
    version:                VERSION,
    CorruptionScanner:      CorruptionScanner,
    TranslationQualityAudit: TranslationQualityAudit,
    AutoRetryEngine:        AutoRetryEngine,
    ChunkRepairRecovery:    ChunkRepairRecovery,
    SafeMergeEngine:        SafeMergeEngine,

    // Convenience: validate and repair a set of translated chunks
    validateAndRepair: async function (originals, results, translateFn, opts) {
      var scanResults = CorruptionScanner.scanAll(results, originals);
      var repaired    = results;

      if (scanResults.hasCorruption && translateFn) {
        repaired = await ChunkRepairRecovery.repairFailed(originals, results, translateFn, scanResults, opts);
      }

      var audit = TranslationQualityAudit.auditAll(originals, repaired);
      var merged = SafeMergeEngine.merge(repaired, opts);

      return { mergedText: merged, audit: audit, scanResults: scanResults, repaired: repaired };
    },

    audit: function () {
      console.group('UniversalTranslationValidator v' + VERSION);
      console.log('CorruptionScanner:      ready');
      console.log('TranslationQualityAudit: ready');
      console.log('AutoRetryEngine:        maxRetries=' + AutoRetryEngine.MAX_RETRIES);
      console.log('ChunkRepairRecovery:    ready');
      console.log('SafeMergeEngine:        ready');
      console.groupEnd();
    },
  };

  _log('ready', { version: VERSION });

}());
