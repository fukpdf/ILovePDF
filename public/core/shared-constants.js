/**
 * ILovePDF Shared Constants — Phase 12B
 *
 * Single source of truth for platform-wide constants.
 * Exposes window.ILovePDFConstants — consumed by any page/module.
 *
 * ADDITIVE ONLY. No existing code is modified or broken.
 * Existing window.* globals (TOOL_GROUPS in chrome.js, SLUG_MAP in
 * tools-config.js, etc.) remain the authoritative runtime copies.
 * This file documents and cross-references them.
 */
(function (G) {
  'use strict';

  if (G.ILovePDFConstants) return;

  /* ─────────────────────────────────────────────────────────────────────────
   * FILE SIZE LIMITS
   * These mirror the server-side limits in utils/usage.js and the client-side
   * check in shared.js. Centralised here so future changes have one source.
   * ───────────────────────────────────────────────────────────────────────── */
  var FILE_LIMITS = {
    GUEST_MAX_BYTES:    100 * 1024 * 1024,   // 100 MB — guest / free tier
    PREMIUM_MAX_BYTES:  200 * 1024 * 1024,   // 200 MB — premium (env: MAX_UPLOAD_MB)
    OPFS_THRESHOLD:     200 * 1024 * 1024,   // 200 MB → OPFS staging
    OPFS_STREAM:        400 * 1024 * 1024,   // 400 MB → streaming strict mode
    BROWSER_MAX:        500 * 1024 * 1024,   // 500 MB → absolute browser cap
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * QUOTA / TIER DEFINITIONS
   * Mirrors utils/usage.js. Free tier has daily limits; guests have lower.
   * ───────────────────────────────────────────────────────────────────────── */
  var TIERS = {
    guest:   { label: 'Guest',   dailyOps: 10,   storageMB: 0    },
    free:    { label: 'Free',    dailyOps: 20,   storageMB: 2048 },
    premium: { label: 'Premium', dailyOps: 200,  storageMB: 2048 },
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * PERFORMANCE THRESHOLDS
   * Shared by AdvancedEngine, RuntimeMemory, AdaptiveRuntime, and auto-tuner.
   * ───────────────────────────────────────────────────────────────────────── */
  var PERF = {
    TOOL_TIMEOUT_MS:       180000,   // 3 min per tool execution
    WORKER_POOL_MAX:       4,        // hard cap on concurrent workers
    CHUNK_MB_LOW:          2,        // chunk size on low-perf devices
    CHUNK_MB_MED:          4,
    CHUNK_MB_HIGH:         8,
    CANVAS_POOL_MAX:       8,        // max pre-allocated canvases
    HEALTH_CRITICAL_SCORE: 20,       // CentralRuntime blocks tasks below this
    IDB_COALESCE_DELAY_MS: 400,      // IDB write coalescing window
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * CRAWLER SIGNATURES
   * Used by homepage-lazy-loader.js and runtime-browser-os-certification.js
   * to skip unnecessary boot on non-human traffic.
   * ───────────────────────────────────────────────────────────────────────── */
  var CRAWLER_UA_PATTERN = /googlebot|bingbot|slurp|duckduckbot|baidu|yandexbot|sogou|exabot|ia_archiver|facebot|facebookexternalhit|twitterbot|linkedinbot|semrush|ahrefs|bot|crawler|spider|scraper/i;

  /* ─────────────────────────────────────────────────────────────────────────
   * CDN URLS (mirrors browser-tools.js)
   * ───────────────────────────────────────────────────────────────────────── */
  var CDN = {
    PDF_LIB:      'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    PDFJS:        'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
    PDFJS_WORKER: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
    JSZIP:        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    MAMMOTH:      'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js',
    HTML2PDF:     'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.3/dist/html2pdf.bundle.min.js',
    XLSX:         'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    TESSERACT:    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    PPTXGEN:      'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
    LUCIDE:       'https://unpkg.com/lucide@latest',
    ONNX_WEB:     'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
    TRANSFORMERS: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js',
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * SUPPORTED LANGUAGES (mirrors i18n.js AVAILABLE array)
   * ───────────────────────────────────────────────────────────────────────── */
  var LANGUAGES = [
    { code:'en', name:'English',    native:'English',    flag:'🇬🇧', rtl:false },
    { code:'ar', name:'Arabic',     native:'العربية',    flag:'🇸🇦', rtl:true  },
    { code:'ur', name:'Urdu',       native:'اردو',       flag:'🇵🇰', rtl:true  },
    { code:'fa', name:'Persian',    native:'فارسی',      flag:'🇮🇷', rtl:true  },
    { code:'hi', name:'Hindi',      native:'हिन्दी',     flag:'🇮🇳', rtl:false },
    { code:'bn', name:'Bengali',    native:'বাংলা',      flag:'🇧🇩', rtl:false },
    { code:'zh', name:'Chinese',    native:'中文',        flag:'🇨🇳', rtl:false },
    { code:'ja', name:'Japanese',   native:'日本語',      flag:'🇯🇵', rtl:false },
    { code:'ko', name:'Korean',     native:'한국어',      flag:'🇰🇷', rtl:false },
    { code:'tr', name:'Turkish',    native:'Türkçe',     flag:'🇹🇷', rtl:false },
    { code:'id', name:'Indonesian', native:'Indonesia',  flag:'🇮🇩', rtl:false },
    { code:'ru', name:'Russian',    native:'Русский',    flag:'🇷🇺', rtl:false },
    { code:'fr', name:'French',     native:'Français',   flag:'🇫🇷', rtl:false },
    { code:'de', name:'German',     native:'Deutsch',    flag:'🇩🇪', rtl:false },
    { code:'es', name:'Spanish',    native:'Español',    flag:'🇪🇸', rtl:false },
    { code:'pt', name:'Portuguese', native:'Português',  flag:'🇧🇷', rtl:false },
    { code:'it', name:'Italian',    native:'Italiano',   flag:'🇮🇹', rtl:false },
    { code:'nl', name:'Dutch',      native:'Nederlands', flag:'🇳🇱', rtl:false },
    { code:'pl', name:'Polish',     native:'Polski',     flag:'🇵🇱', rtl:false },
  ];

  /* ─────────────────────────────────────────────────────────────────────────
   * TOOL PROCESSING MODES
   * Classification mirrors chrome.js TOOL_GROUPS prio field.
   * ───────────────────────────────────────────────────────────────────────── */
  var TOOL_MODES = {
    instant:  { label: '⚡ Instant',     desc: 'Runs in browser — no upload'       },
    compress: { label: '⚙ Compression',  desc: 'Browser + server compression'      },
    advanced: { label: '☁️ Advanced',    desc: 'Server-side heavy processing'       },
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * STORAGE KEYS (localStorage / sessionStorage)
   * ───────────────────────────────────────────────────────────────────────── */
  var STORAGE_KEYS = {
    LANG:            'ilovepdf_lang',
    API_BASE:        'ilovepdf:api_base',
    QUEUE_API_BASE:  'ilovepdf:queue_api_base',
    COOKIE_ACCEPTED: 'ilovepdf_cookies',
    AUTH_TOKEN:      'ilovepdf_token',          // cookie name
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * EXPORT
   * ───────────────────────────────────────────────────────────────────────── */
  G.ILovePDFConstants = {
    FILE_LIMITS:          FILE_LIMITS,
    TIERS:                TIERS,
    PERF:                 PERF,
    CRAWLER_UA_PATTERN:   CRAWLER_UA_PATTERN,
    CDN:                  CDN,
    LANGUAGES:            LANGUAGES,
    TOOL_MODES:           TOOL_MODES,
    STORAGE_KEYS:         STORAGE_KEYS,
  };

  console.debug('[ILovePDFConstants] shared constants loaded');

}(window));
