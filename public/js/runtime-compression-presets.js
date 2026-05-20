// RuntimeCompressionPresets v1.0 — Performance Layer
// =====================================================================
// Adaptive compression preset selector.
//
// Inputs  : file size (bytes) + image dimensions (px²) + device tier
// Output  : preset object — { name, quality, scaleFactor, strategy,
//                             jpegQuality, pngCompression, webpQuality }
//
// Presets (ordered aggressive → lossless):
//   ultra-compressed  — heavy lossy, max savings (weak device / giant file)
//   mobile-safe       — lighter lossy, good quality (mid mobile)
//   balanced          — DEFAULT — best quality/size tradeoff for most cases
//   high-quality      — near-lossless (high device, small file)
//   desktop-optimal   — lossless-leaning (high device, small file, premium)
//
// Priority chain: device-tier > file-size > image-pixel-count
//
// Exposed as: window.RuntimeCompressionPresets
//   .select(opts)  → Preset   — opts: { fileBytes, imagePixels, forceName }
//   .all()         → Preset[] — full preset table
//   .names()       → string[]
// =====================================================================
(function (G) {
  'use strict';

  if (G.RuntimeCompressionPresets) return;

  var LOG = '[RCP]';

  // ── Preset table ─────────────────────────────────────────────────────────
  var PRESETS = {
    'ultra-compressed': {
      name:            'ultra-compressed',
      quality:         38,
      scaleFactor:     0.72,
      strategy:        'aggressive',
      jpegQuality:     38,
      pngCompression:  9,
      webpQuality:     35,
      pdfImageDpi:     72,
      label:           'Ultra Compressed',
      description:     'Maximum file size reduction. Visible quality loss acceptable.',
    },
    'mobile-safe': {
      name:            'mobile-safe',
      quality:         58,
      scaleFactor:     0.85,
      strategy:        'balanced-small',
      jpegQuality:     58,
      pngCompression:  8,
      webpQuality:     55,
      pdfImageDpi:     96,
      label:           'Mobile Safe',
      description:     'Optimised for mobile sharing and upload limits.',
    },
    'balanced': {
      name:            'balanced',
      quality:         72,
      scaleFactor:     1.0,
      strategy:        'balanced',
      jpegQuality:     72,
      pngCompression:  6,
      webpQuality:     70,
      pdfImageDpi:     120,
      label:           'Balanced',
      description:     'Best quality-to-size ratio for most use cases.',
    },
    'high-quality': {
      name:            'high-quality',
      quality:         85,
      scaleFactor:     1.0,
      strategy:        'quality',
      jpegQuality:     85,
      pngCompression:  4,
      webpQuality:     82,
      pdfImageDpi:     150,
      label:           'High Quality',
      description:     'Near-lossless. Larger file, excellent visual fidelity.',
    },
    'desktop-optimal': {
      name:            'desktop-optimal',
      quality:         92,
      scaleFactor:     1.0,
      strategy:        'lossless-lean',
      jpegQuality:     92,
      pngCompression:  1,
      webpQuality:     90,
      pdfImageDpi:     200,
      label:           'Desktop Optimal',
      description:     'Premium quality for desktop / print workflows.',
    },
  };

  var PRESET_ORDER = ['ultra-compressed', 'mobile-safe', 'balanced', 'high-quality', 'desktop-optimal'];

  // ── Device tier resolution ────────────────────────────────────────────────
  function _deviceTier() {
    try {
      if (G.RuntimeAdaptivePipeline) {
        var prof = G.RuntimeAdaptivePipeline.getProfile();
        return prof.deviceTier || 'mid'; // 'low' | 'mid' | 'high'
      }
      // Fallback heuristic
      var mem   = navigator.deviceMemory  || 4;
      var cores = navigator.hardwareConcurrency || 4;
      if (mem <= 2 || cores <= 2) return 'low';
      if (mem >= 8 && cores >= 8) return 'high';
      return 'mid';
    } catch (_) { return 'mid'; }
  }

  function _isMobile() {
    try {
      return /Mobile|Tablet|Android|iPhone|iPad/i.test(navigator.userAgent || '');
    } catch (_) { return false; }
  }

  // ── Preset selection logic ────────────────────────────────────────────────
  //
  // fileBytes    — raw input file size (0 if unknown)
  // imagePixels  — width × height for images (0 if not an image / unknown)
  // forceName    — override with exact preset name
  //
  function select(opts) {
    opts = opts || {};
    var name = opts.forceName;
    if (name && PRESETS[name]) return Object.assign({}, PRESETS[name]);

    var fileBytes   = opts.fileBytes   || 0;
    var imagePixels = opts.imagePixels || 0;
    var tier        = _deviceTier();
    var mobile      = _isMobile();

    var fileMB   = fileBytes / (1024 * 1024);
    var megaPx   = imagePixels / 1e6;

    // ── Rules (first match wins) ────────────────────────────────────────────
    // 1. Low-end device → always mobile-safe or below
    if (tier === 'low' || (mobile && tier !== 'high')) {
      if (fileMB > 10 || megaPx > 8) return Object.assign({}, PRESETS['ultra-compressed']);
      return Object.assign({}, PRESETS['mobile-safe']);
    }

    // 2. Very large file (> 20 MB) → ultra-compressed regardless of device
    if (fileMB > 20) return Object.assign({}, PRESETS['ultra-compressed']);

    // 3. Large file (10-20 MB) on mid device → mobile-safe
    if (fileMB > 10 && tier === 'mid') return Object.assign({}, PRESETS['mobile-safe']);

    // 4. High pixel count image (> 12 MP) → balanced to avoid memory spikes
    if (megaPx > 12) return Object.assign({}, PRESETS['balanced']);

    // 5. High-end device + small file → high-quality
    if (tier === 'high' && fileMB < 5 && !mobile) return Object.assign({}, PRESETS['high-quality']);

    // 6. High-end desktop + tiny file → desktop-optimal
    if (tier === 'high' && fileMB < 2 && !mobile) return Object.assign({}, PRESETS['desktop-optimal']);

    // Default: balanced
    return Object.assign({}, PRESETS['balanced']);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  G.RuntimeCompressionPresets = {
    select:  select,
    all:     function () { return PRESET_ORDER.map(function (n) { return Object.assign({}, PRESETS[n]); }); },
    names:   function () { return PRESET_ORDER.slice(); },
    getByName: function (n) { return PRESETS[n] ? Object.assign({}, PRESETS[n]) : null; },
  };

  console.debug(LOG, 'RuntimeCompressionPresets v1.0 ready —', PRESET_ORDER.length, 'presets');

}(window));
