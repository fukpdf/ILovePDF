// Phase 41C — Universal OCR Cleanup Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 41C-1  SourceClassifier     — detect selectable/scanned/hybrid/multilingual PDFs
// § 41C-2  OcrNoiseCleaner      — remove OCR garbage, artifacts, invalid punctuation
// § 41C-3  ScriptDetector       — identify scripts in OCR output
// § 41C-4  TextQualityScorer    — score OCR output quality, confidence, garbage ratio
// § 41C-5  SmartReOcrEngine     — adaptive retry with adjusted mode/scale/language
//
// Exposes: window.UniversalOcrCleanup

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41C]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41C-1  SOURCE CLASSIFIER
  // Classifies PDF source type to determine optimal extraction strategy.
  // ═══════════════════════════════════════════════════════════════════════════

  var SourceClassifier = (function () {

    // Selectable text threshold: avg chars per page
    var SELECTABLE_MIN_CHARS = 40;
    var HYBRID_MIN_CHARS     = 10;

    function classify(pageTextData) {
      // pageTextData: [{ pageNum, charCount, hasImages, hasText }]
      if (!pageTextData || !pageTextData.length) return { type: 'unknown', selectableRatio: 0, confidence: 0 };

      var totalPages    = pageTextData.length;
      var selectablePages = 0;
      var totalChars    = 0;
      var imageOnlyPages = 0;

      for (var i = 0; i < totalPages; i++) {
        var page = pageTextData[i];
        totalChars += page.charCount || 0;
        if ((page.charCount || 0) >= SELECTABLE_MIN_CHARS) selectablePages++;
        if ((page.charCount || 0) < HYBRID_MIN_CHARS)      imageOnlyPages++;
      }

      var avgChars      = totalChars / totalPages;
      var selectableRatio = selectablePages / totalPages;
      var imageRatio    = imageOnlyPages / totalPages;

      var type;
      var confidence;

      if (selectableRatio >= 0.85) {
        type = 'selectable';
        confidence = 0.9;
      } else if (imageRatio >= 0.85) {
        type = 'scanned';
        confidence = 0.9;
      } else if (selectableRatio > 0.1 && imageRatio > 0.1) {
        type = 'hybrid';
        confidence = 0.8;
      } else {
        type = 'selectable';
        confidence = 0.5;
      }

      // Image-heavy classification
      var isImageHeavy = avgChars < 20;

      _log('source-classified', { type: type, confidence: confidence, selectableRatio: selectableRatio, avgChars: avgChars.toFixed(1) });

      return {
        type:           type,
        selectableRatio: selectableRatio,
        imageRatio:     imageRatio,
        isImageHeavy:   isImageHeavy,
        avgCharsPerPage: avgChars,
        confidence:     confidence,
        needsOcr:       type !== 'selectable' || isImageHeavy,
      };
    }

    // Quick classify from a text string (already extracted)
    function classifyText(text, pageCount) {
      if (!text || !pageCount) return { type: 'unknown', needsOcr: false };
      var avgChars = (text.replace(/\s/g, '').length) / Math.max(1, pageCount);
      var type     = avgChars < SELECTABLE_MIN_CHARS ? 'scanned' : 'selectable';
      return { type: type, avgCharsPerPage: avgChars, needsOcr: avgChars < SELECTABLE_MIN_CHARS };
    }

    return { classify: classify, classifyText: classifyText, SELECTABLE_MIN_CHARS: SELECTABLE_MIN_CHARS };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41C-2  OCR NOISE CLEANER
  // Removes OCR artifacts, garbage chars, invalid punctuation bursts.
  // ═══════════════════════════════════════════════════════════════════════════

  var OcrNoiseCleaner = (function () {

    // Artifact patterns commonly produced by OCR errors
    var ARTIFACT_PATTERNS = [
      // Binary/control chars that slip through
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
      // Repeated punctuation bursts (more than 3 in a row of non-sentence chars)
      /([!@#$%^&*(){}\[\]|\\<>\/~`]{3,})/g,
      // Sequences of random symbols typical of OCR failure
      /[|†‡§¶©®™°±×÷≠≈≤≥←↑→↓]{4,}/g,
      // Long sequences of dots/dashes that aren't horizontal rules
      /\.{5,}/g,
      // Excessive underscores
      /_{4,}/g,
    ];

    // Duplicate line detection: if a line appears 3+ times consecutively, keep once
    function deduplicateLines(text) {
      if (!text) return text;
      var lines  = text.split('\n');
      var out    = [];
      var prev   = '';
      var runLen = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === prev) {
          runLen++;
          if (runLen < 2) out.push(line); // keep first duplicate, drop rest
        } else {
          out.push(line);
          prev   = line;
          runLen = 0;
        }
      }
      return out.join('\n');
    }

    // Remove OCR fragment lines (very short, isolated, non-alphabetic)
    function removeFragments(text, opts) {
      opts = opts || {};
      var minLineLen = opts.minLineLen || 2;
      if (!text) return text;
      var lines = text.split('\n');
      var out = lines.filter(function (line) {
        var trimmed = line.trim();
        // Keep empty lines (paragraph breaks)
        if (!trimmed) return true;
        // Keep lines with enough content
        if (trimmed.length >= minLineLen) return true;
        // Drop single-char "artifacts" that are clearly OCR noise
        return false;
      });
      return out.join('\n');
    }

    function cleanArtifacts(text) {
      if (!text) return text;
      var result = text;
      for (var i = 0; i < ARTIFACT_PATTERNS.length; i++) {
        result = result.replace(ARTIFACT_PATTERNS[i], ' ');
      }
      return result;
    }

    // Remove binary contamination: sequences of high-byte chars with no valid Unicode script
    function removeBinaryContamination(text) {
      if (!text) return text;
      // Replace sequences of replacement chars interspersed with random chars
      return text
        .replace(/(\uFFFD\s*){2,}/g, '\n')
        .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '');
    }

    function clean(text, opts) {
      if (!text || typeof text !== 'string') return text || '';
      opts = opts || {};
      var result = text;
      result = removeBinaryContamination(result);
      result = cleanArtifacts(result);
      result = deduplicateLines(result);
      result = removeFragments(result, opts);
      // Normalize multiple blank lines
      result = result.replace(/\n{3,}/g, '\n\n').trim();
      _log('ocr-cleaned', { before: text.length, after: result.length });
      return result;
    }

    return { clean: clean, cleanArtifacts: cleanArtifacts, deduplicateLines: deduplicateLines, removeFragments: removeFragments };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41C-3  SCRIPT DETECTOR
  // Identifies scripts in OCR output for language model selection.
  // ═══════════════════════════════════════════════════════════════════════════

  var ScriptDetector = (function () {

    var SCRIPT_RANGES = {
      arabic:    { re: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g,  tessLang: 'ara'  },
      urdu:      { re: /[\u0600-\u06FF\u0750-\u077F]/g,               tessLang: 'urd'  },
      hebrew:    { re: /[\u0590-\u05FF\uFB1D-\uFB4F]/g,               tessLang: 'heb'  },
      devanagari:{ re: /[\u0900-\u097F]/g,                             tessLang: 'hin'  },
      bengali:   { re: /[\u0980-\u09FF]/g,                             tessLang: 'ben'  },
      chinese:   { re: /[\u4E00-\u9FFF\u3400-\u4DBF\u20000-\u2A6DF]/g,tessLang: 'chi_sim' },
      japanese:  { re: /[\u3040-\u309F\u30A0-\u30FF]/g,               tessLang: 'jpn'  },
      korean:    { re: /[\uAC00-\uD7AF\u1100-\u11FF]/g,               tessLang: 'kor'  },
      cyrillic:  { re: /[\u0400-\u04FF]/g,                             tessLang: 'rus'  },
      thai:      { re: /[\u0E00-\u0E7F]/g,                             tessLang: 'tha'  },
      latin:     { re: /[a-zA-Z\u00C0-\u024F]/g,                      tessLang: 'eng'  },
    };

    function detect(text) {
      if (!text) return { scripts: [], primary: 'latin', tessLang: 'eng', isRtl: false, isMixed: false };

      var sample = text.slice(0, 1000);
      var counts = {};
      var total  = 0;

      for (var script in SCRIPT_RANGES) {
        var matches = (sample.match(SCRIPT_RANGES[script].re) || []).length;
        if (matches > 0) { counts[script] = matches; total += matches; }
      }

      if (total === 0) return { scripts: ['latin'], primary: 'latin', tessLang: 'eng', isRtl: false, isMixed: false };

      // Sort by count descending
      var sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
      var primary = sorted[0] || 'latin';
      var isRtl   = primary === 'arabic' || primary === 'urdu' || primary === 'hebrew';
      var isMixed = sorted.length > 1 && counts[sorted[1]] / total > 0.1;

      return {
        scripts:  sorted,
        primary:  primary,
        tessLang: (SCRIPT_RANGES[primary] || SCRIPT_RANGES.latin).tessLang,
        isRtl:    isRtl,
        isMixed:  isMixed,
        counts:   counts,
      };
    }

    // Map common language codes to Tesseract language codes
    var LANG_TO_TESS = {
      'en': 'eng', 'ar': 'ara', 'fa': 'fas', 'ur': 'urd',
      'hi': 'hin', 'bn': 'ben', 'zh': 'chi_sim', 'zh-cn': 'chi_sim',
      'zh-tw': 'chi_tra', 'ja': 'jpn', 'ko': 'kor', 'ru': 'rus',
      'tr': 'tur', 'he': 'heb', 'th': 'tha', 'vi': 'vie',
      'fr': 'fra', 'de': 'deu', 'es': 'spa', 'pt': 'por',
    };

    function langToTess(langCode) {
      if (!langCode) return 'eng';
      var lower = langCode.toLowerCase().split('-')[0];
      return LANG_TO_TESS[langCode.toLowerCase()] || LANG_TO_TESS[lower] || 'eng';
    }

    return { detect: detect, langToTess: langToTess, SCRIPT_RANGES: SCRIPT_RANGES };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41C-4  TEXT QUALITY SCORER
  // Scores OCR output quality and identifies poor-quality extractions.
  // ═══════════════════════════════════════════════════════════════════════════

  var TextQualityScorer = (function () {

    var MIN_GOOD_SCORE = 0.55;  // Below this → consider re-OCR
    var MIN_PASS_SCORE = 0.30;  // Below this → likely garbage

    function score(text, opts) {
      opts = opts || {};
      if (!text || typeof text !== 'string') {
        return { qualityScore: 0, confidence: 0, garbageRatio: 1, detectedScripts: [], needsRepair: true, needsReOcr: true };
      }

      var len = text.length || 1;

      // 1. Non-printable / replacement char ratio
      var replacements = (text.match(/\uFFFD/g) || []).length;
      var controlChars = (text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      var garbageChars = replacements + controlChars;
      var garbageRatio = garbageChars / len;

      // 2. Printable ratio
      var printable = (text.match(/[\u0020-\uD7FF\uE000-\uFFFD]/g) || []).length;
      var printableRatio = printable / len;

      // 3. Word density (words per 100 chars — low means OCR scattered chars everywhere)
      var words    = (text.match(/\S+/g) || []).length;
      var avgWordLen = printable / Math.max(words, 1);

      // 4. Script detection
      var scriptInfo = ScriptDetector.detect(text);

      // 5. Encoding corruption score (from Phase 41A if available)
      var encodingCorruption = 0;
      try {
        if (window.UniversalEncodingRepair) {
          encodingCorruption = window.UniversalEncodingRepair.MojibakeDetector.score(text);
        }
      } catch (_) {}

      // 6. Compute quality score (0–1, higher is better)
      var qualityScore = printableRatio
        * (1 - garbageRatio * 3)
        * (1 - encodingCorruption)
        * Math.min(1, avgWordLen / 4);  // avg word len 4+ is healthy

      qualityScore = Math.max(0, Math.min(1, qualityScore));

      // 7. Confidence from Tesseract (if provided)
      var confidence = typeof opts.tessConfidence === 'number' ? opts.tessConfidence / 100 : qualityScore;

      var needsRepair = encodingCorruption > 0.02 || garbageRatio > 0.02;
      var needsReOcr  = qualityScore < MIN_PASS_SCORE;

      _log('quality-scored', {
        score: qualityScore.toFixed(3),
        garbageRatio: garbageRatio.toFixed(3),
        encodingCorruption: encodingCorruption.toFixed(3),
        primary: scriptInfo.primary,
        needsReOcr: needsReOcr,
      });

      return {
        qualityScore:    qualityScore,
        confidence:      confidence,
        garbageRatio:    garbageRatio,
        detectedScripts: scriptInfo.scripts,
        primaryScript:   scriptInfo.primary,
        tessLang:        scriptInfo.tessLang,
        isRtl:           scriptInfo.isRtl,
        needsRepair:     needsRepair,
        needsReOcr:      needsReOcr,
        avgWordLen:      avgWordLen,
        wordCount:       words,
      };
    }

    return { score: score, MIN_GOOD_SCORE: MIN_GOOD_SCORE, MIN_PASS_SCORE: MIN_PASS_SCORE };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41C-5  SMART RE-OCR ENGINE
  // Adaptive retry with adjusted mode/scale/language when quality is poor.
  // ═══════════════════════════════════════════════════════════════════════════

  var SmartReOcrEngine = (function () {

    // Retry strategy table: each attempt changes parameters
    var RETRY_STRATEGIES = [
      { scale: 2.5, psm: '3',  preproc: 'auto',     label: 'balanced-retry'   },
      { scale: 3.0, psm: '6',  preproc: 'contrast',  label: 'high-contrast'    },
      { scale: 2.0, psm: '4',  preproc: 'bw',        label: 'bw-layout'        },
      { scale: 2.5, psm: '11', preproc: 'auto',      label: 'sparse-text'      },
      { scale: 3.0, psm: '3',  preproc: 'strong',    label: 'max-quality'      },
    ];

    // Check if WebGPU preprocessing is available
    function hasGpuPreproc() {
      try { return !!(window.WebGPUAIPipelines && window.WebGPUAIPipelines.ocrPreprocess); }
      catch (_) { return false; }
    }

    // Apply GPU preprocessing to a canvas if available
    async function applyGpuPreproc(canvas) {
      if (!hasGpuPreproc()) return canvas;
      try {
        var result = await window.WebGPUAIPipelines.ocrPreprocess(canvas);
        return result || canvas;
      } catch (_) { return canvas; }
    }

    // Determine best language for re-OCR based on quality score
    function selectBestLang(qualityResult, requestedLang) {
      if (!qualityResult) return requestedLang || 'eng';
      // If a specific script was detected with high confidence, use it
      if (qualityResult.detectedScripts && qualityResult.detectedScripts.length > 0) {
        var detectedLang = ScriptDetector.detect(qualityResult._sampleText || '').tessLang;
        if (detectedLang && detectedLang !== 'eng') return detectedLang;
      }
      return requestedLang || 'eng';
    }

    // Run re-OCR on a canvas with a given strategy
    async function reOcrCanvas(canvas, lang, strategy) {
      try {
        var Tesseract = window.Tesseract;
        if (!Tesseract) return null;

        // Apply GPU preprocessing if available
        var processedCanvas = await applyGpuPreproc(canvas);

        var dataUrl = processedCanvas.toDataURL('image/png');
        var result  = await Tesseract.recognize(dataUrl, lang, {
          logger: function () {},
          tessedit_pageseg_mode: strategy.psm || '3',
        });

        return result && result.data ? result.data : null;
      } catch (err) {
        _err('re-ocr-fail', err);
        return null;
      }
    }

    // Decide whether re-OCR is needed and return the best strategy
    function shouldReOcr(qualityResult) {
      if (!qualityResult) return false;
      return qualityResult.needsReOcr || qualityResult.qualityScore < TextQualityScorer.MIN_GOOD_SCORE;
    }

    // Get recommended retry strategy based on quality and script
    function getRetryStrategy(qualityResult, attempt) {
      attempt = Math.max(0, Math.min(attempt || 0, RETRY_STRATEGIES.length - 1));
      var strategy = Object.assign({}, RETRY_STRATEGIES[attempt]);

      // If RTL script detected, prefer PSM 3 (full auto)
      if (qualityResult && qualityResult.isRtl) strategy.psm = '3';
      // If table-like content detected, prefer PSM 6 (single column)
      if (qualityResult && qualityResult.avgWordLen < 3) strategy.psm = '6';

      return strategy;
    }

    function buildRetryOpts(qualityResult, attempt, requestedLang) {
      var strategy = getRetryStrategy(qualityResult, attempt);
      var lang     = selectBestLang(qualityResult, requestedLang);
      return {
        scale:     strategy.scale,
        psm:       strategy.psm,
        preproc:   strategy.preproc,
        lang:      lang,
        label:     strategy.label,
        useGpu:    hasGpuPreproc(),
      };
    }

    _log('ready', { strategies: RETRY_STRATEGIES.length, gpuAvail: hasGpuPreproc() });

    return {
      shouldReOcr:    shouldReOcr,
      buildRetryOpts: buildRetryOpts,
      reOcrCanvas:    reOcrCanvas,
      getRetryStrategy: getRetryStrategy,
      RETRY_STRATEGIES: RETRY_STRATEGIES,
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.UniversalOcrCleanup
  // ═══════════════════════════════════════════════════════════════════════════

  window.UniversalOcrCleanup = {
    version:           VERSION,
    SourceClassifier:  SourceClassifier,
    OcrNoiseCleaner:   OcrNoiseCleaner,
    ScriptDetector:    ScriptDetector,
    TextQualityScorer: TextQualityScorer,
    SmartReOcrEngine:  SmartReOcrEngine,

    // Convenience: clean + score OCR text in one call
    processOcrText: function (text, opts) {
      opts = opts || {};
      var cleaned = OcrNoiseCleaner.clean(text, opts);
      var quality = TextQualityScorer.score(cleaned, opts);
      var repaired = cleaned;

      // Apply encoding repair if Phase 41A is available
      if (window.UniversalEncodingRepair && quality.needsRepair) {
        try {
          var repairResult = window.UniversalEncodingRepair.repair(cleaned);
          repaired = repairResult.cleanText || cleaned;
        } catch (_) {}
      }

      return { text: repaired, quality: quality };
    },

    audit: function () {
      console.group('UniversalOcrCleanup v' + VERSION);
      console.log('SourceClassifier:  selectable_min=' + SourceClassifier.SELECTABLE_MIN_CHARS + ' chars');
      console.log('OcrNoiseCleaner:   ready');
      console.log('ScriptDetector:    ' + Object.keys(ScriptDetector.SCRIPT_RANGES).length + ' scripts');
      console.log('TextQualityScorer: min_good=' + TextQualityScorer.MIN_GOOD_SCORE + ' min_pass=' + TextQualityScorer.MIN_PASS_SCORE);
      console.log('SmartReOcrEngine:  strategies=' + SmartReOcrEngine.RETRY_STRATEGIES.length);
      console.groupEnd();
    },
  };

  _log('ready', { version: VERSION });

}());
