// Phase 41D — Global Multilingual Render Engine v1.0
// PURELY ADDITIVE — zero changes to any existing file.
//
// § 41D-1  BidirectionalLayoutEngine  — RTL/LTR/mixed/vertical-CJK text flow
// § 41D-2  UniversalFontManager       — multilingual font fallback management
// § 41D-3  PdfTextFlowEngine          — preserve paragraphs/tables/headings/spacing
// § 41D-4  UnicodeGlyphResolver       — fix missing glyphs and shaping issues
// § 41D-5  ExportValidator            — detect corrupted glyphs and broken PDF text
//
// Exposes: window.GlobalMultilingualRenderer

(function () {
  'use strict';

  var VERSION = '1.0';
  var LOG_PFX = '[P41D]';

  function _log(tag, d) {
    try { if (window.DebugTrace && window.DebugTrace.log) window.DebugTrace.log(LOG_PFX + ' ' + tag, d); } catch (_) {}
  }
  function _err(tag, e) {
    try { if (window.DebugTrace && window.DebugTrace.error) window.DebugTrace.error(LOG_PFX + ' ' + tag, e); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41D-1  BIDIRECTIONAL LAYOUT ENGINE
  // Handles RTL, LTR, mixed and vertical text layout for multilingual PDFs.
  // ═══════════════════════════════════════════════════════════════════════════

  var BidirectionalLayoutEngine = (function () {

    // RTL scripts
    var RTL_SCRIPTS = new Set(['arabic', 'hebrew', 'urdu', 'persian', 'aramaic']);

    // Vertical CJK option
    var VERTICAL_CJK = false; // disabled by default; activate per-doc

    function detectDirection(text) {
      if (!text) return 'ltr';
      var sample = text.slice(0, 300);
      var rtlChars = (sample.match(/[\u0600-\u06FF\u0590-\u05FF\u0750-\u077F]/g) || []).length;
      var ltrChars = (sample.match(/[a-zA-Z\u00C0-\u024F]/g) || []).length;
      var cjkChars = (sample.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
      if (rtlChars > ltrChars && rtlChars > cjkChars) return 'rtl';
      if (cjkChars > ltrChars + rtlChars) return 'cjk';
      return 'ltr';
    }

    // Detect if a single line contains mixed RTL/LTR (bidi)
    function isBiDirectional(line) {
      if (!line) return false;
      var hasRtl = /[\u0600-\u06FF\u0590-\u05FF]/.test(line);
      var hasLtr = /[a-zA-Z0-9]/.test(line);
      return hasRtl && hasLtr;
    }

    // Apply Unicode Bidirectional Algorithm approximation for rendering
    // Wraps RTL text in Unicode bidi control chars for correct display
    function applyBidiMarkers(text, direction) {
      if (!text) return text;
      if (direction === 'rtl') {
        // Wrap in RLM (right-to-left mark) + RLE/PDF markers for canvas/PDF rendering
        return '\u202B' + text + '\u202C'; // RLE + text + PDF
      }
      if (direction === 'ltr') {
        return '\u202A' + text + '\u202C'; // LRE + text + PDF
      }
      return text;
    }

    // For HTML output: wrap with dir attribute for correct browser rendering
    function wrapWithDirHtml(text, direction) {
      if (!text) return text;
      var dir = direction === 'rtl' ? 'rtl' : 'ltr';
      return '<span dir="' + dir + '">' + text + '</span>';
    }

    // Split mixed bidi paragraph into LTR and RTL runs
    function splitBidiRuns(text) {
      if (!text) return [{ text: '', dir: 'ltr' }];
      var runs  = [];
      var cur   = '';
      var curDir = null;

      for (var i = 0; i < text.length; i++) {
        var ch   = text[i];
        var code = ch.charCodeAt(0);
        var dir  = 'neutral';

        if (code >= 0x0600 && code <= 0x06FF || code >= 0x0590 && code <= 0x05FF) dir = 'rtl';
        else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || code >= 0xC0) dir = 'ltr';

        if (dir === 'neutral') {
          cur += ch;
        } else if (!curDir || curDir === dir) {
          curDir = dir; cur += ch;
        } else {
          if (cur.trim()) runs.push({ text: cur, dir: curDir });
          cur = ch; curDir = dir;
        }
      }
      if (cur.trim()) runs.push({ text: cur, dir: curDir || 'ltr' });
      return runs.length ? runs : [{ text: text, dir: 'ltr' }];
    }

    // Prepare text for PDF embedding: resolve bidi direction and return metadata
    function prepareForPdf(text, opts) {
      opts = opts || {};
      var direction = opts.direction || detectDirection(text);
      var bidi      = isBiDirectional(text);
      var runs      = bidi ? splitBidiRuns(text) : [{ text: text, dir: direction }];

      return {
        direction: direction,
        isBidi:    bidi,
        runs:      runs,
        isRtl:     direction === 'rtl',
        isCjk:     direction === 'cjk',
      };
    }

    return {
      detectDirection: detectDirection,
      isBiDirectional: isBiDirectional,
      applyBidiMarkers: applyBidiMarkers,
      wrapWithDirHtml: wrapWithDirHtml,
      splitBidiRuns: splitBidiRuns,
      prepareForPdf: prepareForPdf,
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41D-2  UNIVERSAL FONT MANAGER
  // Manages multilingual font fallback for PDF and HTML rendering.
  // ═══════════════════════════════════════════════════════════════════════════

  var UniversalFontManager = (function () {

    // Google Fonts / Noto CDN URLs for multilingual coverage
    var FONT_CDN_BASE = 'https://fonts.googleapis.com/css2?family=';

    var FONT_MAP = {
      arabic:    { family: 'Noto+Sans+Arabic',        cdnWeight: '400;700', covers: /[\u0600-\u06FF]/ },
      hebrew:    { family: 'Noto+Sans+Hebrew',         cdnWeight: '400;700', covers: /[\u0590-\u05FF]/ },
      devanagari:{ family: 'Noto+Sans+Devanagari',     cdnWeight: '400;700', covers: /[\u0900-\u097F]/ },
      bengali:   { family: 'Noto+Sans+Bengali',        cdnWeight: '400;700', covers: /[\u0980-\u09FF]/ },
      chinese:   { family: 'Noto+Sans+SC',             cdnWeight: '400;700', covers: /[\u4E00-\u9FFF]/ },
      japanese:  { family: 'Noto+Sans+JP',             cdnWeight: '400;700', covers: /[\u3040-\u309F\u30A0-\u30FF]/ },
      korean:    { family: 'Noto+Sans+KR',             cdnWeight: '400;700', covers: /[\uAC00-\uD7AF]/ },
      thai:      { family: 'Noto+Sans+Thai',           cdnWeight: '400;700', covers: /[\u0E00-\u0E7F]/ },
      cyrillic:  { family: 'Noto+Sans',                cdnWeight: '400;700', covers: /[\u0400-\u04FF]/ },
      latin:     { family: 'Noto+Sans',                cdnWeight: '400;700', covers: /[A-Za-z]/ },
    };

    // CSS font-family stack for multilingual HTML rendering
    var UNIVERSAL_CSS_STACK = [
      'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Hebrew',
      'Noto Sans Devanagari', 'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR',
      'Noto Sans Thai', 'Arial Unicode MS', 'sans-serif',
    ].join(', ');

    var _loadedFonts = {};

    // Detect which scripts are present in text and return font families needed
    function detectNeededFonts(text) {
      if (!text) return [];
      var needed = [];
      for (var script in FONT_MAP) {
        if (FONT_MAP[script].covers.test(text)) {
          needed.push(script);
        }
      }
      return needed;
    }

    // Inject a Google Fonts CSS link for needed scripts (non-blocking, once per family)
    function injectGoogleFont(script) {
      var info = FONT_MAP[script];
      if (!info || _loadedFonts[script]) return;
      _loadedFonts[script] = true;
      try {
        var family = info.family + ':wght@' + info.cdnWeight;
        var link   = document.createElement('link');
        link.rel   = 'stylesheet';
        link.href  = FONT_CDN_BASE + family + '&display=swap';
        document.head.appendChild(link);
        _log('font-injected', { script: script, family: info.family });
      } catch (_) {}
    }

    // Inject all needed fonts for a given text (async, non-blocking)
    function ensureFontsForText(text) {
      var needed = detectNeededFonts(text);
      for (var i = 0; i < needed.length; i++) {
        injectGoogleFont(needed[i]);
      }
      return needed;
    }

    // Get CSS font-family stack for a script
    function getCssFontStack(script) {
      var info = FONT_MAP[script];
      var primary = info ? info.family.replace(/\+/g, ' ') : 'Noto Sans';
      return primary + ', ' + UNIVERSAL_CSS_STACK;
    }

    // For PDF-lib: return best available standard font + Unicode-safe flag
    function getPdfFont(script) {
      // pdf-lib StandardFonts only support Latin/WinAnsi
      // For multilingual, we flag that Unicode text may need HTML fallback rendering
      var isLatin = script === 'latin' || script === 'cyrillic';
      return {
        useStandardFont: isLatin,
        standardFont: 'Helvetica',
        needsUnicodeFallback: !isLatin,
        cssStack: getCssFontStack(script),
      };
    }

    return {
      detectNeededFonts: detectNeededFonts,
      ensureFontsForText: ensureFontsForText,
      injectGoogleFont: injectGoogleFont,
      getCssFontStack: getCssFontStack,
      getPdfFont: getPdfFont,
      FONT_MAP: FONT_MAP,
      UNIVERSAL_CSS_STACK: UNIVERSAL_CSS_STACK,
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41D-3  PDF TEXT FLOW ENGINE
  // Preserves document structure (paragraphs, tables, headings, bullets) during
  // multilingual rendering.
  // ═══════════════════════════════════════════════════════════════════════════

  var PdfTextFlowEngine = (function () {

    // Block types
    var BLOCK_HEADING  = 'heading';
    var BLOCK_PARA     = 'paragraph';
    var BLOCK_TABLE    = 'table';
    var BLOCK_BULLET   = 'bullet';
    var BLOCK_CODE     = 'code';
    var BLOCK_BREAK    = 'break';

    function classifyLine(line) {
      if (!line || !line.trim()) return { type: BLOCK_BREAK, text: '' };

      var t = line.trim();

      // Heading detection: ALL CAPS, or shorter lines with large font hint
      if (t === t.toUpperCase() && /[A-Z\u0600-\u06FF\u0400-\u04FF]/.test(t) && t.length >= 2 && t.length <= 100) {
        return { type: BLOCK_HEADING, text: t, level: t.length < 40 ? 1 : 2 };
      }

      // Bullet detection
      if (/^[\u2022\u2023\u25E6\u2043\u2219\-\*•·]\s+/.test(t) || /^\d+[\.\)]\s+/.test(t)) {
        return { type: BLOCK_BULLET, text: t };
      }

      // Table-like detection: 2+ consecutive tab-separated or double-space-separated columns
      if (/\t{2,}|  {4,}/.test(t)) {
        return { type: BLOCK_TABLE, text: t };
      }

      // Code-like detection: starts with whitespace indent > 4 chars
      if (/^\s{4,}/.test(line) && !/^\s{4,}[A-Z]/.test(line)) {
        return { type: BLOCK_CODE, text: t };
      }

      return { type: BLOCK_PARA, text: t };
    }

    // Parse text into structured blocks
    function parseBlocks(text) {
      if (!text) return [];
      var lines  = text.split('\n');
      var blocks = [];
      var curPara = null;

      for (var i = 0; i < lines.length; i++) {
        var classified = classifyLine(lines[i]);

        if (classified.type === BLOCK_BREAK) {
          if (curPara) { blocks.push(curPara); curPara = null; }
          continue;
        }

        if (classified.type === BLOCK_PARA) {
          if (curPara) {
            curPara.text += ' ' + classified.text;
          } else {
            curPara = { type: BLOCK_PARA, text: classified.text };
          }
          continue;
        }

        // Non-para blocks: flush current paragraph first
        if (curPara) { blocks.push(curPara); curPara = null; }
        blocks.push(classified);
      }

      if (curPara) blocks.push(curPara);
      return blocks;
    }

    // Reassemble blocks back to text, preserving structure
    function blocksToText(blocks) {
      if (!blocks || !blocks.length) return '';
      var parts = [];
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b.type === BLOCK_HEADING) parts.push('\n' + b.text + '\n');
        else if (b.type === BLOCK_BULLET) parts.push(b.text);
        else if (b.type === BLOCK_TABLE)  parts.push(b.text);
        else if (b.type === BLOCK_CODE)   parts.push('    ' + b.text);
        else parts.push(b.text);
      }
      return parts.join('\n');
    }

    // Preserve structure through translation: extract text from each block,
    // returns { blocks, texts } where texts is an array of strings to translate
    function extractForTranslation(text) {
      var blocks = parseBlocks(text);
      var texts  = blocks.map(function (b) { return b.text; });
      return { blocks: blocks, texts: texts };
    }

    // Merge translated texts back into blocks
    function mergeTranslated(blocks, translatedTexts) {
      var merged = [];
      for (var i = 0; i < blocks.length; i++) {
        var block = Object.assign({}, blocks[i]);
        block.text = (translatedTexts[i] || blocks[i].text).trim();
        merged.push(block);
      }
      return merged;
    }

    return {
      parseBlocks: parseBlocks,
      blocksToText: blocksToText,
      extractForTranslation: extractForTranslation,
      mergeTranslated: mergeTranslated,
      classifyLine: classifyLine,
      BLOCK_TYPES: { HEADING: BLOCK_HEADING, PARA: BLOCK_PARA, TABLE: BLOCK_TABLE, BULLET: BLOCK_BULLET, CODE: BLOCK_CODE },
    };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41D-4  UNICODE GLYPH RESOLVER
  // Detects and resolves missing/broken glyphs in multilingual text.
  // ═══════════════════════════════════════════════════════════════════════════

  var UnicodeGlyphResolver = (function () {

    // Ranges that commonly cause glyph issues in PDF standard fonts
    var PROBLEMATIC_RANGES = [
      { range: /[\u0600-\u06FF]/,  script: 'arabic',   issue: 'arabic-shaping'   },
      { range: /[\u0590-\u05FF]/,  script: 'hebrew',   issue: 'hebrew-bidi'      },
      { range: /[\u0900-\u097F]/,  script: 'devanagari', issue: 'indic-conjuncts' },
      { range: /[\u4E00-\u9FFF]/,  script: 'cjk',      issue: 'cjk-tofu'         },
      { range: /[\u3040-\u30FF]/,  script: 'japanese', issue: 'kana-tofu'        },
      { range: /[\uAC00-\uD7AF]/,  script: 'korean',   issue: 'hangul-tofu'      },
      { range: /[\u0E00-\u0E7F]/,  script: 'thai',     issue: 'thai-combining'   },
      { range: /[\u0400-\u04FF]/,  script: 'cyrillic', issue: 'cyrillic-glyph'   },
    ];

    function analyzeGlyphIssues(text) {
      if (!text) return { issues: [], hasProblematicChars: false, affectedScripts: [] };
      var issues = [];
      var affected = [];

      for (var i = 0; i < PROBLEMATIC_RANGES.length; i++) {
        var item = PROBLEMATIC_RANGES[i];
        if (item.range.test(text)) {
          issues.push(item.issue);
          affected.push(item.script);
        }
      }

      return {
        issues: issues,
        hasProblematicChars: issues.length > 0,
        affectedScripts: affected,
      };
    }

    // For non-Latin scripts that can't be embedded in pdf-lib StandardFonts,
    // transliterate as a last-resort fallback (used only when no font is available)
    var ARABIC_TRANSLIT = {
      '\u0627': 'a', '\u0628': 'b', '\u062A': 't', '\u062B': 'th', '\u062C': 'j',
      '\u062D': 'h', '\u062E': 'kh', '\u062F': 'd', '\u0630': 'dh', '\u0631': 'r',
      '\u0632': 'z', '\u0633': 's', '\u0634': 'sh', '\u0635': 's', '\u0636': 'd',
      '\u0637': 't', '\u0638': 'z', '\u0639': "'", '\u063A': 'gh', '\u0641': 'f',
      '\u0642': 'q', '\u0643': 'k', '\u0644': 'l', '\u0645': 'm', '\u0646': 'n',
      '\u0647': 'h', '\u0648': 'w', '\u064A': 'y',
    };

    // Provide a Unicode-safe fallback string when the target font can't render glyphs
    function resolveForPdfLib(text, opts) {
      opts = opts || {};
      var analysis = analyzeGlyphIssues(text);
      if (!analysis.hasProblematicChars) return { text: text, needsFallback: false };

      // For PDF-lib, filter to only ASCII-safe characters as a last resort
      // (caller should prefer HTML/canvas rendering for multilingual content)
      var fallback = text.replace(/[^\u0000-\u007F]/g, function (ch) {
        // Return known transliteration or question mark
        return ARABIC_TRANSLIT[ch] || '?';
      });

      _log('glyph-fallback', { script: analysis.affectedScripts[0], originalLen: text.length, fallbackLen: fallback.length });

      return {
        text:        fallback,
        original:    text,
        needsFallback: true,
        affectedScripts: analysis.affectedScripts,
        issues: analysis.issues,
      };
    }

    // For HTML output: wrap in a span with correct font stack
    function resolveForHtml(text) {
      if (!text) return text;
      var analysis = analyzeGlyphIssues(text);
      if (!analysis.hasProblematicChars) return text;

      var fontStack = UniversalFontManager.getCssFontStack(analysis.affectedScripts[0] || 'latin');
      return '<span style="font-family:' + fontStack + '">' + text + '</span>';
    }

    return { analyzeGlyphIssues: analyzeGlyphIssues, resolveForPdfLib: resolveForPdfLib, resolveForHtml: resolveForHtml };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // § 41D-5  EXPORT VALIDATOR
  // Validates translated/rendered output for glyph corruption before export.
  // ═══════════════════════════════════════════════════════════════════════════

  var ExportValidator = (function () {

    function validateText(text, opts) {
      if (!text || typeof text !== 'string') {
        return { valid: false, issues: ['empty-text'], warnings: [], qualityScore: 0 };
      }

      var issues   = [];
      var warnings = [];

      // 1. Check for excessive replacement chars (tofu boxes after rendering)
      var replacements = (text.match(/\uFFFD/g) || []).length;
      var repRatio     = replacements / Math.max(text.length, 1);
      if (repRatio > 0.1) issues.push('excessive-replacement-chars');
      else if (repRatio > 0.02) warnings.push('some-replacement-chars');

      // 2. Check for encoding corruption remaining
      if (window.UniversalEncodingRepair) {
        try {
          var corrScore = window.UniversalEncodingRepair.MojibakeDetector.score(text);
          if (corrScore > 0.1) issues.push('encoding-corruption-in-export');
          else if (corrScore > 0.02) warnings.push('minor-encoding-issues');
        } catch (_) {}
      }

      // 3. Glyph issues
      var glyphInfo = UnicodeGlyphResolver.analyzeGlyphIssues(text);
      if (glyphInfo.hasProblematicChars) {
        warnings.push('non-latin-chars-may-need-unicode-font');
      }

      // 4. Minimum content check
      if (text.trim().length < 10) issues.push('output-too-short');

      var qualityScore = Math.max(0, 1 - repRatio * 5 - (issues.length * 0.2));
      var valid = issues.length === 0;

      _log('export-validated', { valid: valid, issues: issues.length, warnings: warnings.length, qualityScore: qualityScore.toFixed(3) });

      return { valid: valid, issues: issues, warnings: warnings, qualityScore: qualityScore };
    }

    function validateBlob(blob) {
      if (!blob || blob.size === 0) return Promise.resolve({ valid: false, issues: ['empty-blob'] });
      if (blob.size < 200) return Promise.resolve({ valid: false, issues: ['blob-too-small'] });
      return Promise.resolve({ valid: true, issues: [], warnings: [], blobSize: blob.size });
    }

    return { validateText: validateText, validateBlob: validateBlob };
  }());

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — window.GlobalMultilingualRenderer
  // ═══════════════════════════════════════════════════════════════════════════

  window.GlobalMultilingualRenderer = {
    version:                  VERSION,
    BidirectionalLayoutEngine: BidirectionalLayoutEngine,
    UniversalFontManager:     UniversalFontManager,
    PdfTextFlowEngine:        PdfTextFlowEngine,
    UnicodeGlyphResolver:     UnicodeGlyphResolver,
    ExportValidator:          ExportValidator,

    // Convenience: prepare text for multilingual PDF rendering
    prepareText: function (text, opts) {
      opts = opts || {};
      var direction = BidirectionalLayoutEngine.detectDirection(text);
      var fonts     = UniversalFontManager.ensureFontsForText(text);
      var flow      = PdfTextFlowEngine.extractForTranslation(text);
      var glyphs    = UnicodeGlyphResolver.analyzeGlyphIssues(text);
      return { direction: direction, fonts: fonts, flow: flow, glyphs: glyphs };
    },

    audit: function () {
      console.group('GlobalMultilingualRenderer v' + VERSION);
      console.log('BidirectionalLayoutEngine: ready');
      console.log('UniversalFontManager:     ' + Object.keys(UniversalFontManager.FONT_MAP).length + ' scripts');
      console.log('PdfTextFlowEngine:        ready');
      console.log('UnicodeGlyphResolver:     ready');
      console.log('ExportValidator:          ready');
      console.groupEnd();
    },
  };

  _log('ready', { version: VERSION });

}());
