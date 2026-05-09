// Phase 41F — Universal Advanced Translation Pipeline v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// Ties all Phase 41A–41E subsystems into a single pipeline that hooks
// ADDITIVELY into window.BrowserTools.process for translation-related tools.
//
// Pipeline:
//   Input → SourceClassifier → OCR cleanup → Encoding repair →
//   Script detection → Chunking → Translation queue →
//   Validation → Retry/recovery → Multilingual render →
//   Export validation → Output
//
// Hook guard: window.BrowserTools.__phase41v1 prevents double-patching.
//
// Tools intercepted (translation/OCR adjacent only):
//   translate, ocr, scan-to-pdf, ai-summarize, pdf-to-word,
//   pdf-to-excel, pdf-to-powerpoint, compare
//
// Load order (tool.html): loaded before browser-tools.js; installs via
//   polling setInterval pattern (same as Phase 26+).
//
// Exposes: window.UniversalTranslationPipeline

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41F]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL SETS — which tools receive which pipeline stages
  // ═══════════════════════════════════════════════════════════════════════════

  // Tools that get the full translation pipeline (encoding repair + smart chunking + validation)
  var TRANSLATION_TOOLS = new Set([
    'translate', 'ai-summarize',
  ]);

  // Tools that get OCR cleanup pre-processing
  var OCR_TOOLS = new Set([
    'ocr', 'scan-to-pdf', 'pdf-to-word', 'pdf-to-excel', 'pdf-to-powerpoint',
  ]);

  // Tools that get encoding repair on output
  var ENCODING_TOOLS = new Set([
    'translate', 'ocr', 'scan-to-pdf', 'pdf-to-word', 'pdf-to-excel',
    'pdf-to-powerpoint', 'ai-summarize', 'compare',
  ]);

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSYSTEM ACCESSORS — lazy, graceful fallbacks
  // ═══════════════════════════════════════════════════════════════════════════

  function getEncodingRepair()  { try { return window.UniversalEncodingRepair; }  catch (_) { return null; } }
  function getChunker()         { try { return window.UniversalTranslationChunker; } catch (_) { return null; } }
  function getOcrCleanup()      { try { return window.UniversalOcrCleanup; }      catch (_) { return null; } }
  function getRenderer()        { try { return window.GlobalMultilingualRenderer; } catch (_) { return null; } }
  function getValidator()       { try { return window.UniversalTranslationValidator; } catch (_) { return null; } }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-PROCESSING: Applied to files/options BEFORE the upstream tool runs
  // ═══════════════════════════════════════════════════════════════════════════

  // Inject Phase 41 hints into opts for upstream processors to use optionally
  function buildEnrichedOpts(toolId, files, opts) {
    var patch   = {};
    var cleanup = getOcrCleanup();
    var repair  = getEncodingRepair();

    // Script detection hint for OCR-heavy tools
    if (OCR_TOOLS.has(toolId) && cleanup) {
      try {
        var detector = cleanup.ScriptDetector;
        patch._p41ScriptDetector  = detector;
        patch._p41OcrCleanup      = cleanup;
        patch._p41QualityScorer   = cleanup.TextQualityScorer;
      } catch (_) {}
    }

    // Encoding repair ref for translation tools
    if ((TRANSLATION_TOOLS.has(toolId) || ENCODING_TOOLS.has(toolId)) && repair) {
      try {
        patch._p41EncodingRepair  = repair;
        patch._p41Sanitizer       = repair.TranslationTextSanitizer;
      } catch (_) {}
    }

    // Chunker ref for translation tools
    if (TRANSLATION_TOOLS.has(toolId)) {
      var chunker = getChunker();
      if (chunker) {
        try {
          patch._p41Chunker         = chunker;
          patch._p41ChunkText       = chunker.chunkText.bind(chunker);
          patch._p41TranslateChunks = chunker.translateChunks.bind(chunker);
        } catch (_) {}
      }
    }

    // Renderer ref
    var renderer = getRenderer();
    if (renderer) {
      try {
        patch._p41Renderer  = renderer;
        patch._p41BidiEngine = renderer.BidirectionalLayoutEngine;
      } catch (_) {}
    }

    // Validator ref
    var validator = getValidator();
    if (validator) {
      try {
        patch._p41Validator = validator;
      } catch (_) {}
    }

    patch._p41Enabled = true;
    patch._p41Version = VERSION;

    return Object.assign({}, opts || {}, patch);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POST-PROCESSING: Applied to the RESULT BLOB/text AFTER the upstream tool
  // ═══════════════════════════════════════════════════════════════════════════

  // Post-process a text blob: encoding repair + export validation
  async function postProcessTextBlob(blob, toolId, opts) {
    if (!blob || blob.size === 0) return blob;

    var repair    = getEncodingRepair();
    var validator = getValidator();
    var renderer  = getRenderer();

    try {
      // Only post-process text blobs
      var mime = blob.type || '';
      if (!mime.includes('text') && !mime.includes('xml') && !mime.includes('json')) {
        return blob;
      }

      var text = await blob.text();
      if (!text || text.length === 0) return blob;

      // 1. Encoding repair
      var cleanText = text;
      if (repair && ENCODING_TOOLS.has(toolId)) {
        try {
          var repairResult = repair.repair(text);
          if (repairResult && repairResult.cleanText) {
            cleanText = repairResult.cleanText;
            if (repairResult.repaired) {
              _log('post-encoding-repaired', { toolId: toolId, score: repairResult.corruptionScore });
            }
          }
        } catch (_) {}
      }

      // 2. Export validation
      if (validator && validator.ExportValidator) {
        try {
          var validation = validator.ExportValidator.validateText(cleanText);
          if (!validation.valid) {
            _log('export-validation-issues', { toolId: toolId, issues: validation.issues });
          }
        } catch (_) {}
      }

      // 3. Font injection for HTML output (non-blocking)
      if (renderer && renderer.UniversalFontManager && mime.includes('text/html')) {
        try { renderer.UniversalFontManager.ensureFontsForText(cleanText); } catch (_) {}
      }

      // Only rewrite blob if text was changed
      if (cleanText !== text) {
        return new Blob([cleanText], { type: blob.type });
      }
    } catch (postErr) {
      _err('post-process-error', postErr);
      // Fall through — return original blob unchanged
    }

    return blob;
  }

  // Post-process a result { blob, filename } or plain Blob
  async function postProcessResult(result, toolId, opts) {
    if (!result) return result;

    try {
      if (result && result.blob) {
        var processed = await postProcessTextBlob(result.blob, toolId, opts);
        if (processed !== result.blob) {
          return Object.assign({}, result, { blob: processed });
        }
        return result;
      }

      // Plain Blob result
      if (result instanceof Blob) {
        return postProcessTextBlob(result, toolId, opts);
      }
    } catch (_) {}

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSLATION-SPECIFIC PIPELINE
  // Enhanced translation flow using Phase 41A–41E systems.
  // Operates as a thin advisory layer that enhances opts before the upstream
  // translatePdf function runs. Does NOT reimplement translation itself.
  // ═══════════════════════════════════════════════════════════════════════════

  function buildTranslationHints(toolId, opts) {
    var hints = {};
    var repair  = getEncodingRepair();
    var chunker = getChunker();

    // Source language detection hint
    if (repair) {
      try {
        var sanitizer = repair.TranslationTextSanitizer;
        hints._p41SanitizerFn = function (text) {
          return sanitizer.process(text);
        };
      } catch (_) {}
    }

    // Smart chunking hints
    if (chunker) {
      var sourceLang = opts.sourceLang || 'en';
      try {
        var script = chunker.LanguageAwareChunker.detectScript(opts._sampleText || '');
        var chunkSize = chunker.AdaptiveChunkSizer.computeChunkSize(script, true);
        hints._p41ChunkSize = chunkSize;
        hints._p41Script    = script;
        _log('translation-hints', { toolId: toolId, script: script, chunkSize: chunkSize, lang: sourceLang });
      } catch (_) {}
    }

    return hints;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OCR-SPECIFIC PIPELINE HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  function buildOcrHints(toolId, opts) {
    var hints   = {};
    var cleanup = getOcrCleanup();
    if (!cleanup) return hints;

    try {
      // Detect script from any provided language option
      var lang = opts.language || opts.lang || 'eng';
      var tessLang = cleanup.ScriptDetector.langToTess(lang);
      hints._p41TessLang = tessLang;

      // Smart re-OCR strategy if quality is poor
      hints._p41ReOcrEngine   = cleanup.SmartReOcrEngine;
      hints._p41QualityScorer = cleanup.TextQualityScorer;
      hints._p41OcrCleaner    = cleanup.OcrNoiseCleaner;

      _log('ocr-hints', { toolId: toolId, lang: lang, tessLang: tessLang });
    } catch (_) {}

    return hints;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN WRAPPER INSTALLER
  // Wraps window.BrowserTools.process additively using the standard pattern.
  // ═══════════════════════════════════════════════════════════════════════════

  function installPhase41() {
    if (!window.BrowserTools) return false;
    if (window.BrowserTools.__phase41v1) return true;

    var upstream = window.BrowserTools.process.bind(window.BrowserTools);

    window.BrowserTools.process = async function (toolId, files, opts) {
      // Only intercept tools in our scope; pass everything else through unchanged
      var isTranslation = TRANSLATION_TOOLS.has(toolId);
      var isOcr         = OCR_TOOLS.has(toolId);
      var isEncoding    = ENCODING_TOOLS.has(toolId);

      if (!isTranslation && !isOcr && !isEncoding) {
        return upstream(toolId, files, opts);
      }

      // ── Step 1: Build enriched opts with Phase 41 subsystem refs ──────────
      var enrichedOpts = buildEnrichedOpts(toolId, files, opts);

      // ── Step 2: Tool-specific pre-processing hints ─────────────────────────
      if (isTranslation) {
        var txHints = buildTranslationHints(toolId, enrichedOpts);
        Object.assign(enrichedOpts, txHints);
      }
      if (isOcr) {
        var ocrHints = buildOcrHints(toolId, enrichedOpts);
        Object.assign(enrichedOpts, ocrHints);
      }

      // ── Step 3: Yield to main thread before heavy processing ───────────────
      await new Promise(function (r) { setTimeout(r, 0); });

      // ── Step 4: Run upstream processor with enriched opts ──────────────────
      var result;
      try {
        result = await upstream(toolId, files, enrichedOpts);
      } catch (upstreamErr) {
        _err('upstream-error', { toolId: toolId, err: String(upstreamErr && upstreamErr.message || upstreamErr) });
        throw upstreamErr; // re-throw unchanged — do not swallow errors
      }

      // ── Step 5: Post-process result (encoding repair, export validation) ──
      if (isEncoding || isTranslation) {
        try {
          result = await postProcessResult(result, toolId, enrichedOpts);
        } catch (postErr) {
          _err('post-process-fail', { toolId: toolId, err: String(postErr && postErr.message || postErr) });
          // Fall through — return original result
        }
      }

      // ── Step 6: Inject fonts for HTML rendering if renderer available ──────
      if (isTranslation || isOcr) {
        try {
          var renderer = getRenderer();
          if (renderer && renderer.UniversalFontManager) {
            var targetLang = enrichedOpts.targetLang || enrichedOpts.language || '';
            if (targetLang) renderer.UniversalFontManager.ensureFontsForText(targetLang);
          }
        } catch (_) {}
      }

      _log('pipeline-complete', { toolId: toolId, isTranslation: isTranslation, isOcr: isOcr });
      return result;
    };

    window.BrowserTools.__phase41v1 = true;
    _log('installed', { version: VERSION, translationTools: Array.from(TRANSLATION_TOOLS), ocrTools: Array.from(OCR_TOOLS) });
    return true;
  }

  // ── Deferred install (same pattern as Phase 26, 31) ──────────────────────
  // browser-tools.js loads after this script, so BrowserTools may not exist yet.
  if (!installPhase41()) {
    var _tries = 0;
    var _iv = setInterval(function () {
      if (installPhase41() || _tries++ > 150) clearInterval(_iv);
    }, 80);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GLOBAL PIPELINE RUNNER
  // Standalone: run the full multilingual pipeline on raw text without going
  // through BrowserTools. Useful for testing and direct integration.
  // ═══════════════════════════════════════════════════════════════════════════

  var Pipeline = {

    // Run full encoding repair + chunking + translation + validation pipeline
    // translateFn(chunk, index, total) → Promise<string>
    async translateText(text, translateFn, opts) {
      opts = opts || {};
      if (!text || typeof text !== 'string') throw new Error('No text provided');

      var repair    = getEncodingRepair();
      var chunker   = getChunker();
      var validator = getValidator();
      var renderer  = getRenderer();

      // ── Stage 1: Encoding repair ──────────────────────────────────────────
      var cleanResult = repair ? repair.repair(text, opts) : { cleanText: text };
      var cleanText   = cleanResult.cleanText || text;
      if (cleanResult.repaired) {
        _log('pipeline-encoding-repaired', { corruptionScore: cleanResult.corruptionScore });
      }

      // ── Stage 2: Script detection ─────────────────────────────────────────
      var direction = 'ltr';
      var script    = 'latin';
      if (chunker) {
        script = chunker.LanguageAwareChunker.detectScript(cleanText);
      }
      if (renderer) {
        direction = renderer.BidirectionalLayoutEngine.detectDirection(cleanText);
      }

      // ── Stage 3: Chunking ─────────────────────────────────────────────────
      var chunks = chunker
        ? chunker.chunkText(cleanText, { script: script, apiTarget: true })
        : [cleanText];

      // ── Stage 4: Translation queue ────────────────────────────────────────
      var queueResult = chunker
        ? await chunker.translateChunks(chunks, translateFn, { onProgress: opts.onProgress, jobId: opts.jobId })
        : { results: await Promise.all(chunks.map(function (c, i) { return translateFn(c, i, chunks.length); })), failCount: 0 };

      var rawResults = queueResult.results;

      // ── Stage 5: Validation + repair ─────────────────────────────────────
      var finalText;
      if (validator) {
        var validated = await validator.validateAndRepair(chunks, rawResults, translateFn, { direction: direction });
        finalText = validated.mergedText;
        _log('pipeline-validated', { grade: validated.audit.overallGrade, avgScore: validated.audit.averageScore.toFixed(3) });
      } else {
        finalText = rawResults.join(' ');
      }

      // ── Stage 6: Font injection (non-blocking) ────────────────────────────
      if (renderer) {
        try { renderer.UniversalFontManager.ensureFontsForText(finalText); } catch (_) {}
      }

      // ── Stage 7: Export validation ────────────────────────────────────────
      var exportValid = null;
      if (validator && validator.ExportValidator) {
        try { exportValid = validator.ExportValidator.validateText(finalText); } catch (_) {}
      }

      _log('pipeline-done', {
        inputLen:  text.length,
        outputLen: finalText.length,
        chunks:    chunks.length,
        failCount: queueResult.failCount,
        script:    script,
        direction: direction,
      });

      return {
        text:          finalText,
        chunks:        chunks.length,
        failCount:     queueResult.failCount,
        script:        script,
        direction:     direction,
        encodingFixed: !!(cleanResult.repaired),
        exportValid:   exportValid,
      };
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.UniversalTranslationPipeline
  // ═══════════════════════════════════════════════════════════════════════════

  window.UniversalTranslationPipeline = {
    version:          VERSION,
    Pipeline:         Pipeline,
    TRANSLATION_TOOLS: Array.from(TRANSLATION_TOOLS),
    OCR_TOOLS:        Array.from(OCR_TOOLS),
    ENCODING_TOOLS:   Array.from(ENCODING_TOOLS),

    // Re-expose pipeline runner for convenience
    translateText: Pipeline.translateText.bind(Pipeline),

    // Check if the hook is installed
    isInstalled: function () {
      return !!(window.BrowserTools && window.BrowserTools.__phase41v1);
    },

    // Subsystem status
    status: function () {
      return {
        installed:      !!(window.BrowserTools && window.BrowserTools.__phase41v1),
        encodingRepair: !!getEncodingRepair(),
        chunker:        !!getChunker(),
        ocrCleanup:     !!getOcrCleanup(),
        renderer:       !!getRenderer(),
        validator:      !!getValidator(),
      };
    },

    audit: function () {
      var st = window.UniversalTranslationPipeline.status();
      console.group('UniversalTranslationPipeline v' + VERSION + ' — Phase 41');
      console.log('Hook installed:         ', st.installed);
      console.log('EncodingRepair (41A):   ', st.encodingRepair);
      console.log('TranslationChunker (41B):', st.chunker);
      console.log('OcrCleanup (41C):       ', st.ocrCleanup);
      console.log('MultilingualRenderer (41D):', st.renderer);
      console.log('TranslationValidator (41E):', st.validator);
      console.log('Translation tools:       ', Array.from(TRANSLATION_TOOLS).join(', '));
      console.log('OCR tools:               ', Array.from(OCR_TOOLS).join(', '));
      console.log('Encoding tools:          ', Array.from(ENCODING_TOOLS).join(', '));

      if (window.UniversalEncodingRepair)          window.UniversalEncodingRepair.audit();
      if (window.UniversalTranslationChunker)      window.UniversalTranslationChunker.audit();
      if (window.UniversalOcrCleanup)              window.UniversalOcrCleanup.audit();
      if (window.GlobalMultilingualRenderer)       window.GlobalMultilingualRenderer.audit();
      if (window.UniversalTranslationValidator)    window.UniversalTranslationValidator.audit();

      console.groupEnd();
      return st;
    },
  };

  _log('ready', { version: VERSION });

}());
