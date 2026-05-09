// Phase 41A — Universal Encoding Recovery Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 41A-1  MojibakeDetector        — detect UTF8/Latin1/CP1252/mojibake corruption
// § 41A-2  UniversalUtfRepairEngine — repair malformed byte sequences
// § 41A-3  UnicodeSanitizer        — NFC/NFKC normalise, strip invalid chars
// § 41A-4  ScriptAwareNormalizer   — language-aware per-script cleanup
// § 41A-5  TranslationTextSanitizer — full repair → normalise → validate pipeline
//
// Exposes: window.UniversalEncodingRepair

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41A]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41A-1  MOJIBAKE DETECTOR
  // Identifies encoding corruption patterns in text before translation.
  // ═══════════════════════════════════════════════════════════════════════════

  var MojibakeDetector = (function () {

    // Common mojibake indicator patterns (Latin-1/CP1252 decoded as UTF-8)
    // Use \u00xx ranges to avoid invalid regex character class ordering
    var MOJIBAKE_SEQUENCES = [
      /\u00C3[\u0080-\u00BF]/g,  // Ã + continuation byte — UTF-8 2-byte seq decoded as Latin-1
      /\u00C2[\u0080-\u00BF]/g,  // Â + continuation byte — common UTF-8/Latin-1 mix
      /\u00C3[\u00C0-\u00FF]/g,  // Ã + high Latin-1 byte
      /\u00C2[\u00C0-\u00FF]/g,  // Â + high Latin-1 byte
      /\uFFFD/g,                  // Unicode replacement character
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,  // non-printable control chars
    ];

    // High-confidence mojibake pairs (Latin-1 corruption of common UTF-8 chars)
    var MOJIBAKE_MAP = {
      'Ã©': 'é', 'Ã¨': 'è', 'Ã ': 'à', 'Ã¢': 'â', 'Ã«': 'ë',
      'Ã®': 'î', 'Ã¯': 'ï', 'Ã´': 'ô', 'Ã¹': 'ù', 'Ã»': 'û',
      'Ã¼': 'ü', 'Ã§': 'ç', 'Ã¦': 'æ', 'Ã¸': 'ø', 'Ã±': 'ñ',
      'Ã': 'Á', 'â€™': '\u2019', 'â€œ': '\u201C', 'â€': '\u201D',
      'â€"': '\u2013', 'â€"': '\u2014', 'â€¦': '\u2026',
      'Ä±': 'ı', 'Ä°': 'İ', 'ÅŸ': 'ş', 'Åž': 'Ş', 'Ä\x9f': 'ğ',
      'â\x80\x98': '\u2018', 'â\x80\x99': '\u2019',
    };

    // Unicode ranges for valid scripts
    var SCRIPT_RANGES = {
      arabic:  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
      hebrew:  /[\u0590-\u05FF\uFB1D-\uFB4F]/,
      indic:   /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/,
      cjk:     /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u3400-\u4DBF\u20000-\u2A6DF]/,
      cyril:   /[\u0400-\u04FF\u0500-\u052F]/,
      thai:    /[\u0E00-\u0E7F]/,
      latin:   /[A-Za-z\u00C0-\u024F]/,
    };

    function detect(text) {
      if (!text || typeof text !== 'string') return { corrupted: false, patterns: [], score: 0 };
      var patterns = [];
      var totalChars = text.length || 1;

      for (var i = 0; i < MOJIBAKE_SEQUENCES.length; i++) {
        var re = MOJIBAKE_SEQUENCES[i];
        re.lastIndex = 0;
        var matches = text.match(re) || [];
        if (matches.length > 0) {
          patterns.push({ pattern: re.source, count: matches.length });
        }
      }

      // Check for suspicious high-ASCII density (Latin-1 bleed)
      var highAscii = (text.match(/[\x80-\xBF]/g) || []).length;
      var highAsciiRatio = highAscii / totalChars;
      if (highAsciiRatio > 0.05) {
        patterns.push({ pattern: 'high-ascii-density', count: highAscii, ratio: highAsciiRatio });
      }

      // Check for replacement char density
      var replacements = (text.match(/\uFFFD/g) || []).length;
      if (replacements > 0) {
        patterns.push({ pattern: 'replacement-chars', count: replacements });
      }

      var s = score(text);
      return {
        corrupted: s > 0.02 || patterns.length > 0,
        patterns:  patterns,
        score:     s,
      };
    }

    function score(text) {
      if (!text || !text.length) return 0;
      var len = text.length;
      var bad = 0;

      // Count replacement chars
      bad += (text.match(/\uFFFD/g) || []).length * 3;

      // Count non-printable control chars (not tab/newline/CR)
      bad += (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length * 2;

      // Count suspicious high-ascii in non-RTL/CJK text
      var hasRtl = SCRIPT_RANGES.arabic.test(text) || SCRIPT_RANGES.hebrew.test(text);
      if (!hasRtl) {
        bad += (text.match(/[\x80-\xBF]/g) || []).length;
      }

      // Count known mojibake sequences
      for (var seq in MOJIBAKE_MAP) {
        if (text.indexOf(seq) !== -1) bad += 5;
      }

      return Math.min(1, bad / len);
    }

    function corruptionMap(text) {
      if (!text) return [];
      var map = [];
      var idx;
      for (var seq in MOJIBAKE_MAP) {
        idx = text.indexOf(seq);
        while (idx !== -1) {
          map.push({ offset: idx, length: seq.length, type: 'mojibake', replacement: MOJIBAKE_MAP[seq] });
          idx = text.indexOf(seq, idx + 1);
        }
      }
      return map;
    }

    function hasCorruption(text) {
      return score(text) > 0.01;
    }

    return {
      detect: detect,
      score: score,
      corruptionMap: corruptionMap,
      hasCorruption: hasCorruption,
      MOJIBAKE_MAP: MOJIBAKE_MAP,
      SCRIPT_RANGES: SCRIPT_RANGES,
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41A-2  UNIVERSAL UTF REPAIR ENGINE
  // Repairs common encoding corruption patterns safely.
  // ═══════════════════════════════════════════════════════════════════════════

  var UniversalUtfRepairEngine = (function () {

    // CP1252 → Unicode character map for bytes 0x80–0x9F
    var CP1252_MAP = {
      0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E',
      0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6',
      0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152',
      0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C',
      0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
      0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A',
      0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178',
    };

    function repairMojibake(text) {
      if (!text) return text;
      var result = text;

      // Apply known mojibake sequence substitutions (longest first to avoid partial matches)
      var seqs = Object.keys(MojibakeDetector.MOJIBAKE_MAP).sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < seqs.length; i++) {
        var seq = seqs[i];
        if (result.indexOf(seq) !== -1) {
          result = result.split(seq).join(MojibakeDetector.MOJIBAKE_MAP[seq]);
        }
      }
      return result;
    }

    function repairLatin1ToUtf8(text) {
      if (!text) return text;
      // If string contains low-to-high pairs that look like UTF-8 encoded as Latin-1, decode them
      try {
        // Try to detect and repair the Ã-pattern (Latin-1 interpretation of UTF-8 2-byte sequences)
        return text.replace(/Ã([\x80-\xBF])/g, function (_, b) {
          var code = 0xC0 | ('Ã'.charCodeAt(0) & 0x1F);
          var code2 = b.charCodeAt(0) & 0x3F;
          return String.fromCharCode((code << 6) | code2);
        });
      } catch (_) {
        return text;
      }
    }

    function repairCp1252(text) {
      if (!text) return text;
      return text.replace(/[\x80-\x9F]/g, function (ch) {
        var code = ch.charCodeAt(0);
        return CP1252_MAP[code] || ch;
      });
    }

    function repairSurrogatePairs(text) {
      if (!text) return text;
      // Remove lone surrogates (not part of a valid pair)
      try {
        return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
      } catch (_) {
        // Lookbehind not supported in older browsers — do simple scan
        var out = '';
        for (var i = 0; i < text.length; i++) {
          var c = text.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF) {
            // High surrogate — check next char
            var next = text.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
              out += text[i] + text[i + 1];
              i++;
            } else {
              out += '\uFFFD';
            }
          } else if (c >= 0xDC00 && c <= 0xDFFF) {
            out += '\uFFFD';
          } else {
            out += text[i];
          }
        }
        return out;
      }
    }

    function repair(text) {
      if (!text || typeof text !== 'string') return text || '';
      var result = text;
      var repaired = false;

      var before = MojibakeDetector.score(result);
      if (before > 0.01) {
        result = repairMojibake(result);
        result = repairLatin1ToUtf8(result);
        result = repairCp1252(result);
        result = repairSurrogatePairs(result);
        repaired = MojibakeDetector.score(result) < before;
      }

      return { text: result, repaired: repaired, scoreImprovement: before - MojibakeDetector.score(result) };
    }

    return { repair: repair, repairMojibake: repairMojibake, repairLatin1ToUtf8: repairLatin1ToUtf8, repairCp1252: repairCp1252, repairSurrogatePairs: repairSurrogatePairs };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41A-3  UNICODE SANITIZER
  // NFC/NFKC normalisation, invalid char stripping, whitespace normalisation.
  // ═══════════════════════════════════════════════════════════════════════════

  var UnicodeSanitizer = (function () {

    var HAS_NORMALIZE = typeof String.prototype.normalize === 'function';

    // Ranges of invalid/unassigned Unicode blocks that should never appear in text
    var INVALID_RANGES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFF9-\uFFFB\uFEFF]/g;

    // Tags and specials that are safe to strip
    var ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

    function normalizeForm(text, form) {
      if (!text || !HAS_NORMALIZE) return text;
      try { return text.normalize(form || 'NFC'); } catch (_) { return text; }
    }

    function stripInvalidChars(text) {
      if (!text) return text;
      var result = text.replace(INVALID_RANGES, '');
      result = result.replace(/\uFFFD+/g, ' '); // Replace replacement chars with space
      return result;
    }

    function normalizeWhitespace(text) {
      if (!text) return text;
      return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function stripZeroWidth(text) {
      if (!text) return text;
      return text.replace(ZERO_WIDTH, '');
    }

    function sanitize(text, opts) {
      if (!text || typeof text !== 'string') return text || '';
      opts = opts || {};
      var result = text;
      var removed = 0;

      var before = result.length;
      result = stripZeroWidth(result);
      result = stripInvalidChars(result);
      result = normalizeForm(result, opts.form || 'NFC');
      result = normalizeWhitespace(result);
      removed = before - result.length;

      return { text: result, removedChars: removed };
    }

    return { sanitize: sanitize, normalizeForm: normalizeForm, stripInvalidChars: stripInvalidChars, normalizeWhitespace: normalizeWhitespace };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41A-4  SCRIPT-AWARE NORMALIZER
  // Language/script-specific cleanup beyond generic Unicode normalization.
  // ═══════════════════════════════════════════════════════════════════════════

  var ScriptAwareNormalizer = (function () {

    // Arabic: normalize alef variants → plain alef, tah marbuta forms
    function normalizeArabic(text) {
      if (!text) return text;
      return text
        .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')  // Alef variants → Alef
        .replace(/\u0629/g, '\u0647')   // Tah Marbuta → Heh (when needed)
        .replace(/[\u064B-\u065F]/g, '') // Strip harakat (diacritics) for translation
        .replace(/\u0640/g, '');          // Strip tatweel
    }

    // Indic: normalize Devanagari, Bengali etc. via NFC
    function normalizeIndic(text) {
      if (!text) return text;
      try {
        return typeof text.normalize === 'function' ? text.normalize('NFC') : text;
      } catch (_) { return text; }
    }

    // CJK: normalize fullwidth → halfwidth for punctuation; keep CJK chars as-is
    function normalizeCjk(text) {
      if (!text) return text;
      // Fullwidth punctuation → ASCII equivalents for chunking safety
      return text.replace(/[\uFF01-\uFF60]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      });
    }

    // Hebrew: strip cantillation marks for cleaner translation
    function normalizeHebrew(text) {
      if (!text) return text;
      return text.replace(/[\u0591-\u05C7]/g, ''); // Strip dagesh/vowel points
    }

    // Thai: no normalization needed beyond NFC; clean extra spaces
    function normalizeThai(text) {
      if (!text) return text;
      return text.replace(/\s+/g, ' ').trim();
    }

    // Cyrillic: NFC normalise (handles precomposed chars)
    function normalizeCyrillic(text) {
      if (!text) return text;
      try { return typeof text.normalize === 'function' ? text.normalize('NFC') : text; }
      catch (_) { return text; }
    }

    function detectPrimaryScript(text) {
      if (!text) return 'unknown';
      var sample = text.slice(0, 500);
      var ranges = MojibakeDetector.SCRIPT_RANGES;
      var counts = {
        arabic: (sample.match(ranges.arabic) || []).length,
        hebrew: (sample.match(ranges.hebrew) || []).length,
        indic:  (sample.match(ranges.indic)  || []).length,
        cjk:    (sample.match(ranges.cjk)    || []).length,
        cyril:  (sample.match(ranges.cyril)  || []).length,
        thai:   (sample.match(ranges.thai)   || []).length,
        latin:  (sample.match(ranges.latin)  || []).length,
      };
      var max = 0; var primary = 'latin';
      for (var sc in counts) {
        if (counts[sc] > max) { max = counts[sc]; primary = sc; }
      }
      return primary;
    }

    function normalize(text, scriptHint) {
      if (!text) return text;
      var script = scriptHint || detectPrimaryScript(text);
      switch (script) {
        case 'arabic': return normalizeArabic(text);
        case 'hebrew': return normalizeHebrew(text);
        case 'indic':  return normalizeIndic(text);
        case 'cjk':    return normalizeCjk(text);
        case 'thai':   return normalizeThai(text);
        case 'cyril':  return normalizeCyrillic(text);
        default:       return text;
      }
    }

    return {
      normalize: normalize,
      detectPrimaryScript: detectPrimaryScript,
      normalizeArabic: normalizeArabic,
      normalizeHebrew: normalizeHebrew,
      normalizeIndic: normalizeIndic,
      normalizeCjk: normalizeCjk,
      normalizeThai: normalizeThai,
      normalizeCyrillic: normalizeCyrillic,
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41A-5  TRANSLATION TEXT SANITIZER
  // Full pipeline: repair → normalize → validate → clean
  // ═══════════════════════════════════════════════════════════════════════════

  var TranslationTextSanitizer = (function () {

    function detectLanguageHints(text) {
      if (!text) return [];
      var sample = text.slice(0, 1000);
      var ranges = MojibakeDetector.SCRIPT_RANGES;
      var hints = [];
      if (ranges.arabic.test(sample)) hints.push('arabic');
      if (ranges.hebrew.test(sample)) hints.push('hebrew');
      if (ranges.indic.test(sample))  hints.push('indic');
      if (ranges.cjk.test(sample))    hints.push('cjk');
      if (ranges.cyril.test(sample))  hints.push('cyrillic');
      if (ranges.thai.test(sample))   hints.push('thai');
      if (ranges.latin.test(sample))  hints.push('latin');
      return hints;
    }

    function process(text, opts) {
      opts = opts || {};
      if (!text || typeof text !== 'string') {
        return { cleanText: text || '', repaired: false, corruptionScore: 0, warnings: [], removedChars: 0, languageHints: [] };
      }

      var warnings = [];
      var repaired = false;
      var removedChars = 0;

      // Step 1: Detect corruption
      var detection = MojibakeDetector.detect(text);
      var corruptionScore = detection.score;

      if (detection.corrupted) {
        warnings.push('Encoding corruption detected (score: ' + corruptionScore.toFixed(3) + ')');
        _log('corruption-detected', { score: corruptionScore, patterns: detection.patterns.length });
      }

      // Step 2: Repair
      var repairResult = UniversalUtfRepairEngine.repair(text);
      var repairedText = repairResult.text;
      if (repairResult.repaired) {
        repaired = true;
        warnings.push('Encoding repaired (improvement: ' + repairResult.scoreImprovement.toFixed(3) + ')');
      }

      // Step 3: Script-aware normalization
      var langHints = detectLanguageHints(repairedText);
      var primaryScript = ScriptAwareNormalizer.detectPrimaryScript(repairedText);
      var scriptNormalized = ScriptAwareNormalizer.normalize(repairedText, primaryScript);

      // Step 4: Unicode sanitize
      var sanitizeResult = UnicodeSanitizer.sanitize(scriptNormalized, { form: opts.normalForm || 'NFC' });
      var cleanText = sanitizeResult.text;
      removedChars = sanitizeResult.removedChars;

      if (removedChars > 0) {
        warnings.push('Removed ' + removedChars + ' invalid chars');
      }

      // Step 5: Final validation
      var finalScore = MojibakeDetector.score(cleanText);
      if (finalScore > 0.05) {
        warnings.push('Residual corruption after repair (score: ' + finalScore.toFixed(3) + ')');
      }

      _log('sanitize-complete', { repaired: repaired, corruptionScore: corruptionScore, finalScore: finalScore, languageHints: langHints, removedChars: removedChars });

      return {
        cleanText:       cleanText,
        repaired:        repaired,
        corruptionScore: corruptionScore,
        finalScore:      finalScore,
        warnings:        warnings,
        removedChars:    removedChars,
        languageHints:   langHints,
        primaryScript:   primaryScript,
      };
    }

    return { process: process, detectLanguageHints: detectLanguageHints };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.UniversalEncodingRepair
  // ═══════════════════════════════════════════════════════════════════════════

  window.UniversalEncodingRepair = {
    version:                  VERSION,
    MojibakeDetector:         MojibakeDetector,
    UniversalUtfRepairEngine: UniversalUtfRepairEngine,
    UnicodeSanitizer:         UnicodeSanitizer,
    ScriptAwareNormalizer:    ScriptAwareNormalizer,
    TranslationTextSanitizer: TranslationTextSanitizer,

    // Convenience shortcut: repair + sanitize a string in one call
    repair: function (text, opts) {
      return TranslationTextSanitizer.process(text, opts);
    },

    audit: function () {
      console.group('UniversalEncodingRepair v' + VERSION);
      console.log('MojibakeDetector: ready');
      console.log('UtfRepairEngine:  ready');
      console.log('UnicodeSanitizer: ready | normalize():', typeof String.prototype.normalize === 'function');
      console.log('ScriptAwareNorm:  ready');
      console.groupEnd();
    },
  };

  _log('ready', { version: VERSION });

}());
