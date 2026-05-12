// Background Remover Enterprise UX v8.0
// 3-phase flow: Settings → Processing → Result
// Mobile-first, self-healing 4-pass engine, no developer controls.
// Architecture: BgRemoverPro.mount(file, container, commitResult)
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  var ALLOWED_MIME = new Set([
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
    'image/gif',  'image/bmp', 'image/tiff',
  ]);
  var MAX_PREVIEW = 520; // px — max dimension of the settings preview

  // Background swatch definitions
  var BG_OPTS = [
    { id: 'transparent', label: 'None',       check: true },
    { id: 'white',       label: 'White',      hex: '#ffffff' },
    { id: '#f1f5f9',     label: 'Light',      hex: '#f1f5f9' },
    { id: 'black',       label: 'Black',      hex: '#000000' },
    { id: '#2563eb',     label: 'Blue',       hex: '#2563eb' },
    { id: '#16a34a',     label: 'Green',      hex: '#16a34a' },
    { id: '#dc2626',     label: 'Red',        hex: '#dc2626' },
    { id: 'gradient-blue', label: 'Gradient', grad: ['#1a56db', '#4f46e5'] },
  ];

  // Processing stage messages (v6.0 multi-pipeline AI)
  var STAGES = [
    { pct:  3, msg: 'Preparing image\u2026' },
    { pct: 12, msg: 'Classifying image type\u2026' },
    { pct: 26, msg: 'Loading AI model\u2026' },
    { pct: 40, msg: 'Running AI segmentation\u2026' },
    { pct: 58, msg: 'Generating precision trimap\u2026' },
    { pct: 73, msg: 'Refining edges\u2026' },
    { pct: 87, msg: 'Upsampling to full resolution\u2026' },
    { pct: 95, msg: 'Compositing result\u2026' },
  ];

  // ── Module state ─────────────────────────────────────────────────────────
  var _file          = null;
  var _container     = null;
  var _commitResult  = null;  // callback: (blob, filename, mime) → commits flow
  var _origImg       = null;  // original Image element
  var _origW         = 0;
  var _origH         = 0;
  var _origDataUrl   = null;  // compressed JPEG data URL for preview
  var _resultImg     = null;  // transparent result Image element
  var _bgColor       = 'transparent';
  var _exportFmt     = 'png';
  var _processing    = false;
  var _stageTimers   = [];

  // ── Public API ────────────────────────────────────────────────────────────
  async function mount(file, container, commitResult) {
    _file         = file;
    _container    = container;
    _commitResult = commitResult;
    _origImg      = null;
    _resultImg    = null;
    _bgColor      = 'transparent';
    _exportFmt    = 'png';
    _processing   = false;
    _stageTimers.forEach(clearTimeout);
    _stageTimers  = [];

    var mime = (file.type || '').toLowerCase();
    if (mime && !ALLOWED_MIME.has(mime)) {
      _showError(container,
        'Unsupported file type: ' + (file.type || 'unknown') + '.<br>' +
        'Please use JPG, PNG, WebP, or GIF.');
      return;
    }

    container.innerHTML =
      '<div class="bgr-loading">' +
        '<div class="bgr-spinner"></div>' +
        '<div class="bgr-loading-text">Loading image\u2026</div>' +
      '</div>';

    try {
      _origImg = await _loadImg(file);
    } catch (_e) {
      _showError(container, 'Cannot read this image. Please try a different file.');
      return;
    }

    _origW = _origImg.naturalWidth;
    _origH = _origImg.naturalHeight;
    if (_origW === 0 || _origH === 0) {
      _showError(container, 'Image has no valid dimensions. Please try a different file.');
      return;
    }

    // Generate compressed preview data URL for reuse
    var ps  = Math.min(1, MAX_PREVIEW / Math.max(_origW, _origH));
    var pw  = Math.round(_origW * ps);
    var ph  = Math.round(_origH * ps);
    var pc  = document.createElement('canvas');
    pc.width = pw; pc.height = ph;
    pc.getContext('2d').drawImage(_origImg, 0, 0, pw, ph);
    _origDataUrl = pc.toDataURL('image/jpeg', 0.82);
    pc.width = 0; pc.height = 0;

    // Auto-detect subject type from pixel analysis
    var detectedSubject = _detectSubject(_origImg);

    _renderSettings(container, detectedSubject);
  }

  // ════════════════════════════════════════════════════════════════
  //  PHASE 1 — SETTINGS
  // ════════════════════════════════════════════════════════════════
  function _renderSettings(container, detectedSubject) {
    var badge = (detectedSubject !== 'auto')
      ? '<div class="bgr-detect-badge">' +
          _subjectEmoji(detectedSubject) + ' ' + _subjectLabel(detectedSubject) + ' detected' +
        '</div>'
      : '';

    container.innerHTML =
      '<div class="bgr-settings-root">' +

        // ── Left: image preview ──────────────────────────────────
        '<div class="bgr-settings-left">' +
          '<div class="bgr-img-frame">' +
            '<img src="' + _origDataUrl + '" class="bgr-settings-img" alt="Preview">' +
            badge +
          '</div>' +
          '<div class="bgr-img-meta">' +
            _origW + '\u202f\xd7\u202f' + _origH + '\u202fpx\u2002\xb7\u2002' + _humanSize(_file.size) +
          '</div>' +
        '</div>' +

        // ── Right: controls ──────────────────────────────────────
        '<div class="bgr-settings-right">' +
          '<div class="bgr-settings-heading">Remove Background</div>' +
          '<div class="bgr-settings-subheading">Automatic removal \xb7 Runs locally \xb7 Free</div>' +

          '<div class="bgr-field">' +
            '<label class="bgr-field-label" for="bgr-bg-sel">Background</label>' +
            '<select class="bgr-select" id="bgr-bg-sel">' +
              '<option value="transparent">Transparent (PNG)</option>' +
              '<option value="white">White</option>' +
              '<option value="#f1f5f9">Light Grey</option>' +
              '<option value="black">Black</option>' +
              '<option value="#2563eb">Blue</option>' +
              '<option value="gradient-blue">Blue Gradient</option>' +
              '<option value="custom">Custom Color\u2026</option>' +
            '</select>' +
            '<input type="color" id="bgr-custom-col" class="bgr-color-pick" value="#6366f1">' +
          '</div>' +

          '<div class="bgr-field">' +
            '<label class="bgr-field-label" for="bgr-quality-sel">Quality</label>' +
            '<select class="bgr-select" id="bgr-quality-sel">' +
              '<option value="auto" selected>Auto (Recommended)</option>' +
              '<option value="hd">HD \u2014 44\u202fMB model</option>' +
              '<option value="ultra">Ultra \u2014 Best quality (slower)</option>' +
            '</select>' +
          '</div>' +

          '<div class="bgr-field">' +
            '<label class="bgr-field-label" for="bgr-subject-sel">Subject Type</label>' +
            '<select class="bgr-select" id="bgr-subject-sel">' +
              '<option value="auto"'       + (detectedSubject === 'auto'       ? ' selected' : '') + '>Auto Detect</option>' +
              '<option value="portrait"'   + (detectedSubject === 'portrait'   ? ' selected' : '') + '>Person / Portrait</option>' +
              '<option value="product"'    + (detectedSubject === 'product'    ? ' selected' : '') + '>Product / Object</option>' +
              '<option value="logo"'       + (detectedSubject === 'logo'       ? ' selected' : '') + '>Logo / Graphic</option>' +
              '<option value="screenshot"' + (detectedSubject === 'screenshot' ? ' selected' : '') + '>Screenshot / UI</option>' +
            '</select>' +
          '</div>' +

          '<button type="button" class="bgr-main-btn" id="bgr-process-btn">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M12 2L2 7l10 5 10-5-10-5z"/>' +
              '<path d="M2 17l10 5 10-5"/>' +
              '<path d="M2 12l10 5 10-5"/>' +
            '</svg>' +
            'Remove Background' +
          '</button>' +

          '<div class="bgr-trust-row">' +
            '<span class="bgr-trust-item">\uD83D\uDD12 100% private</span>' +
            '<span class="bgr-trust-sep">\xb7</span>' +
            '<span class="bgr-trust-item">\u2713 No upload</span>' +
            '<span class="bgr-trust-sep">\xb7</span>' +
            '<span class="bgr-trust-item">\u2713 Free forever</span>' +
          '</div>' +
        '</div>' +

      '</div>';

    var bgSel     = container.querySelector('#bgr-bg-sel');
    var customCol = container.querySelector('#bgr-custom-col');
    var processBtn = container.querySelector('#bgr-process-btn');

    bgSel.addEventListener('change', function () {
      customCol.style.display = bgSel.value === 'custom' ? 'block' : 'none';
    });

    processBtn.addEventListener('click', function () {
      if (_processing) return;
      var bg      = bgSel.value === 'custom' ? customCol.value : bgSel.value;
      var quality = container.querySelector('#bgr-quality-sel').value;
      var subject = container.querySelector('#bgr-subject-sel').value;
      _bgColor = bg;
      var qMode = (quality === 'auto') ? 'hd' : quality;
      _startProcessing(container, { bgColor: bg, qualityMode: qMode, subjectMode: subject });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  PHASE 2 — PROCESSING
  // ════════════════════════════════════════════════════════════════
  async function _startProcessing(container, opts) {
    if (_processing) return;
    _processing = true;

    container.innerHTML =
      '<div class="bgr-processing-root">' +
        '<div class="bgr-processing-img-wrap">' +
          '<img src="' + _origDataUrl + '" class="bgr-processing-img" alt="Processing">' +
          '<div class="bgr-processing-vignette"></div>' +
        '</div>' +
        '<div class="bgr-processing-body">' +
          '<div class="bgr-proc-label">Removing background\u2026</div>' +
          '<div class="bgr-proc-stage" id="bgr-stage-msg">' + STAGES[0].msg + '</div>' +
          '<div class="bgr-prog-track">' +
            '<div class="bgr-prog-fill" id="bgr-prog-fill" style="width:0%"></div>' +
          '</div>' +
          '<div class="bgr-prog-pct" id="bgr-prog-pct">0%</div>' +
          '<div class="bgr-proc-hint">Processing happens on your device \u2014 files never leave your browser.</div>' +
        '</div>' +
      '</div>';

    var fillEl = container.querySelector('#bgr-prog-fill');
    var pctEl  = container.querySelector('#bgr-prog-pct');
    var msgEl  = container.querySelector('#bgr-stage-msg');

    var _progFloor = 0;
    function setProgress(pct, msg) {
      var p = Math.round(pct);
      if (p > _progFloor) {
        _progFloor = p;
        if (fillEl) fillEl.style.width = p + '%';
        if (pctEl)  pctEl.textContent  = p + '%';
      }
      if (msg && msgEl) msgEl.textContent = msg;
    }

    // Animate stage messages (realistic timing, independent of actual processing)
    _stageTimers.forEach(clearTimeout);
    _stageTimers = [];
    var stageDelay = 300;
    STAGES.forEach(function (s, i) {
      var t = setTimeout(function () { setProgress(s.pct, s.msg); }, stageDelay);
      _stageTimers.push(t);
      stageDelay += 550 + i * 200;
    });

    var result  = null;
    var lastErr = null;

    try {
      result = await _runWithHealing(opts, setProgress, msgEl);
    } catch (err) {
      lastErr = err;
    }

    // Stop stage animation
    _stageTimers.forEach(clearTimeout);
    _stageTimers = [];
    _processing = false;

    if (!result || !result.blob || result.blob.size < 50) {
      setProgress(0, '');
      _renderEngineError(container, lastErr);
      return;
    }

    setProgress(100, 'Done!');
    await new Promise(function (r) { setTimeout(r, 380); });

    // Load transparent result as Image element (for canvas compositing)
    try {
      _resultImg = await _loadImgFromBlob(result.blob);
      _renderResult(container, result.blob, result.filename || _buildFilename());
    } catch (e) {
      _renderEngineError(container, e);
    }
  }

  // ── AI-first self-healing engine ──────────────────────────────────────────
  // Pass 1: AI engine (ONNX) with live progress callback
  // Pass 2: AI lite mode (if standard model failed to load)
  // Pass 3: CV fallback engine (when AI completely unavailable)
  async function _runWithHealing(opts, setProgress) {
    if (!window.BrowserTools || typeof window.BrowserTools.process !== 'function') {
      throw new Error('Processing engine not ready. Please wait a moment and try again.');
    }

    var baseOpts = { bgColor: 'transparent' };

    // Pass 1 — AI (standard quality, with real-time progress wired to UI)
    try {
      var r1 = await window.BrowserTools.process('background-remover', [_file], Object.assign({}, baseOpts, {
        qualityMode:  opts.qualityMode || 'hd',
        subjectMode:  opts.subjectMode || 'auto',
        _onProgress:  setProgress,
      }));
      if (r1 && r1.blob && r1.blob.size > 100) return r1;
    } catch (_e1) { /* fall through */ }

    // Pass 2 — AI lite (smaller model, guaranteed fast download)
    if (setProgress) setProgress(30, 'Switching to lightweight AI model\u2026');
    try {
      var r2 = await window.BrowserTools.process('background-remover', [_file], Object.assign({}, baseOpts, {
        qualityMode:  'lite',
        subjectMode:  'auto',
        _onProgress:  setProgress,
      }));
      if (r2 && r2.blob && r2.blob.size > 100) return r2;
    } catch (_e2) { /* fall through */ }

    // Pass 3 — pure CV fallback (no network required)
    if (setProgress) setProgress(50, 'Using offline processing\u2026');
    try {
      var r3 = await window.BrowserTools.process('background-remover', [_file], Object.assign({}, baseOpts, {
        qualityMode:  'ultra',
        subjectMode:  'auto',
        _forceCV:     true,
        _onProgress:  setProgress,
      }));
      if (r3 && r3.blob && r3.blob.size > 100) return r3;
    } catch (e3) {
      throw e3;
    }

    throw new Error('Could not remove the background. The subject may be too similar to the background.');
  }

  // ════════════════════════════════════════════════════════════════
  //  PHASE 3 — RESULT
  // ════════════════════════════════════════════════════════════════
  function _renderResult(container, transparentBlob, filename) {
    var swatchesHtml = BG_OPTS.map(function (b) {
      var style = b.check
        ? 'background:repeating-conic-gradient(#bbb 0% 25%,#fff 0% 50%) 0 0/12px 12px'
        : b.grad
          ? 'background:linear-gradient(135deg,' + b.grad[0] + ',' + b.grad[1] + ')'
          : 'background:' + b.hex;
      var active = (b.id === _bgColor) ? ' bgr-swatch-active' : '';
      return '<button type="button" class="bgr-swatch' + active + '" data-bgid="' + b.id +
             '" title="' + b.label + '" aria-label="' + b.label + ' background" style="' + style + '"></button>';
    }).join('');

    container.innerHTML =
      '<div class="bgr-result-root">' +

        // ── Before / After compare slider ────────────────────────
        '<div class="bgr-compare-outer" id="bgr-compare-outer">' +
          // Before: original
          '<div class="bgr-compare-layer bgr-compare-before" id="bgr-before">' +
            '<img src="' + _origDataUrl + '" class="bgr-compare-img" alt="Original">' +
            '<div class="bgr-compare-lbl bgr-compare-lbl--l">Before</div>' +
          '</div>' +
          // After: result canvas (clips from left)
          '<div class="bgr-compare-layer bgr-compare-after" id="bgr-after">' +
            '<canvas id="bgr-result-cvs" class="bgr-compare-img"></canvas>' +
            '<div class="bgr-compare-lbl bgr-compare-lbl--r">After</div>' +
          '</div>' +
          // Draggable handle
          '<div class="bgr-compare-handle" id="bgr-compare-handle" aria-label="Drag to compare">' +
            '<div class="bgr-handle-line"></div>' +
            '<div class="bgr-handle-knob">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5L1 12l7 7V5zm8 14l7-7-7-7v14z"/></svg>' +
            '</div>' +
          '</div>' +
          '<div class="bgr-compare-hint" id="bgr-compare-hint">\u21d4 Drag to compare</div>' +
        '</div>' +

        // ── Controls ─────────────────────────────────────────────
        '<div class="bgr-result-panel">' +

          '<div class="bgr-ctrl-row">' +
            // Background swatches
            '<div class="bgr-ctrl-section">' +
              '<div class="bgr-ctrl-label">Background</div>' +
              '<div class="bgr-swatch-row" id="bgr-swatch-row">' + swatchesHtml + '</div>' +
            '</div>' +
            // Format
            '<div class="bgr-ctrl-section">' +
              '<div class="bgr-ctrl-label">Format</div>' +
              '<div class="bgr-fmt-row">' +
                '<button type="button" class="bgr-fmt-btn bgr-fmt-active" data-fmt="png">PNG</button>' +
                '<button type="button" class="bgr-fmt-btn" data-fmt="jpg">JPG</button>' +
                '<button type="button" class="bgr-fmt-btn" data-fmt="webp">WebP</button>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="bgr-result-actions">' +
            '<button type="button" class="bgr-dl-btn" id="bgr-dl-btn">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
                '<polyline points="7 10 12 15 17 10"/>' +
                '<line x1="12" y1="15" x2="12" y2="3"/>' +
              '</svg>' +
              'Download' +
            '</button>' +
            '<button type="button" class="bgr-again-btn" id="bgr-again-btn">Try Again</button>' +
          '</div>' +

          '<div class="bgr-result-meta">' +
            _origW + '\u202f\xd7\u202f' + _origH + '\u202fpx \xb7 ' + _humanSize(_file.size) +
          '</div>' +

        '</div>' +

      '</div>';

    // Initial canvas draw
    _drawResultToCanvas(container.querySelector('#bgr-result-cvs'), _bgColor);

    // ── Wire: background swatches ───────────────────────────────
    container.querySelectorAll('[data-bgid]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _bgColor = btn.dataset.bgid;
        container.querySelectorAll('[data-bgid]').forEach(function (b) {
          b.classList.toggle('bgr-swatch-active', b.dataset.bgid === _bgColor);
        });
        // If transparent + JPG, auto-upgrade to PNG
        if (_bgColor === 'transparent' && _exportFmt === 'jpg') {
          _exportFmt = 'png';
          container.querySelectorAll('[data-fmt]').forEach(function (b) {
            b.classList.toggle('bgr-fmt-active', b.dataset.fmt === 'png');
          });
        }
        _drawResultToCanvas(container.querySelector('#bgr-result-cvs'), _bgColor);
      });
    });

    // ── Wire: format buttons ────────────────────────────────────
    container.querySelectorAll('[data-fmt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fmt = btn.dataset.fmt;
        // JPG requires opaque background
        if (fmt === 'jpg' && (!_bgColor || _bgColor === 'transparent')) {
          _bgColor = 'white';
          container.querySelectorAll('[data-bgid]').forEach(function (b) {
            b.classList.toggle('bgr-swatch-active', b.dataset.bgid === 'white');
          });
          _drawResultToCanvas(container.querySelector('#bgr-result-cvs'), _bgColor);
        }
        _exportFmt = fmt;
        container.querySelectorAll('[data-fmt]').forEach(function (b) {
          b.classList.toggle('bgr-fmt-active', b.dataset.fmt === fmt);
        });
      });
    });

    // ── Wire: download ──────────────────────────────────────────
    var dlBtn = container.querySelector('#bgr-dl-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', async function () {
        if (dlBtn.disabled) return;
        dlBtn.disabled = true;
        dlBtn.innerHTML =
          '<span class="bgr-dl-spin"></span>Preparing\u2026';
        try {
          var out = await _buildDownloadBlob();
          var url = URL.createObjectURL(out.blob);
          var a = document.createElement('a');
          a.href = url; a.download = out.filename;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 300000);
          // Commit to the download step (showStatus auto-commits flow)
          if (typeof _commitResult === 'function') {
            _commitResult(out.blob, out.filename, out.mime);
          }
        } catch (e) {
          console.error('[BgRemoverPro] Download failed:', e);
        } finally {
          dlBtn.disabled = false;
          dlBtn.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
              '<polyline points="7 10 12 15 17 10"/>' +
              '<line x1="12" y1="15" x2="12" y2="3"/>' +
            '</svg>Download';
        }
      });
    }

    // ── Wire: try again ─────────────────────────────────────────
    var againBtn = container.querySelector('#bgr-again-btn');
    if (againBtn) {
      againBtn.addEventListener('click', function () {
        if (window.Flow) window.Flow.navTo('upload');
        else window.location.href = window.location.pathname.replace(/\/(preview|download).*$/i, '');
      });
    }

    // ── Wire: compare slider ────────────────────────────────────
    _wireCompareSlider(container);
  }

  // ── Canvas: draw result with chosen background ────────────────────────────
  // RC-EXPORT-FIX: For transparent mode, we NO LONGER draw a checkerboard on
  // the canvas. The canvas only contains actual pixel data (transparent pixels
  // are zero-alpha). The checkerboard visual is provided by CSS background on
  // the compare-outer container so the transparent canvas pixels show through.
  // This means cvs.toBlob('image/png') will produce a clean PNG with real
  // transparency — no gray/white squares baked into pixel data.
  function _drawResultToCanvas(cvs, bgId) {
    if (!cvs || !_resultImg) return;
    var rW = _resultImg.naturalWidth;
    var rH = _resultImg.naturalHeight;
    cvs.width  = rW;
    cvs.height = rH;
    var ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, rW, rH);

    if (!bgId || bgId === 'transparent') {
      // Transparent mode: draw ONLY the result image (zero-alpha pixels remain transparent).
      // The checkerboard is shown via the CSS background of .bgr-compare-outer
      // and the canvas element's own CSS background — never baked into pixel data.
      ctx.drawImage(_resultImg, 0, 0);

      // Apply CSS checkerboard background to the canvas element itself for preview
      cvs.style.background = 'repeating-conic-gradient(#c0c0c0 0% 25%, #f0f0f0 0% 50%) 0 0 / 20px 20px';
    } else {
      // Solid or gradient background — draw BG first, then composite result on top
      if (bgId === 'gradient-blue') {
        var grd = ctx.createLinearGradient(0, 0, rW, rH);
        grd.addColorStop(0, '#1a56db'); grd.addColorStop(1, '#4f46e5');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, rW, rH);
      } else {
        ctx.fillStyle = (bgId === 'white') ? '#ffffff' : (bgId === 'black') ? '#000000' : bgId;
        ctx.fillRect(0, 0, rW, rH);
      }
      cvs.style.background = '';
      ctx.drawImage(_resultImg, 0, 0);
    }
  }

  // ── Build export blob — ALWAYS from _resultImg, NEVER from the display canvas ──
  // RC-EXPORT-FIX: The display canvas contains the checkerboard as pixel data when
  // in transparent mode (old bug). We now create a fresh off-screen canvas from
  // _resultImg so the export path is always clean and preview/export can never diverge.
  async function _buildDownloadBlob() {
    if (!_resultImg) throw new Error('Result image not ready');

    var fmt      = _exportFmt || 'png';
    var isTransp = !_bgColor || _bgColor === 'transparent';
    if (fmt === 'jpg' && isTransp) fmt = 'png'; // JPG can't store transparency

    var mime    = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    var ext     = '.' + (fmt === 'jpg' ? 'jpg' : fmt === 'webp' ? 'webp' : 'png');
    var quality = (fmt === 'jpg') ? 0.92 : (fmt === 'webp') ? 0.90 : undefined;

    // Always build from a fresh canvas — never read from the display canvas
    var expC   = document.createElement('canvas');
    expC.width = _resultImg.naturalWidth;
    expC.height = _resultImg.naturalHeight;
    var expCtx = expC.getContext('2d');

    if (!isTransp) {
      // Fill background then composite subject on top
      if (_bgColor === 'gradient-blue') {
        var grd2 = expCtx.createLinearGradient(0, 0, expC.width, expC.height);
        grd2.addColorStop(0, '#1a56db'); grd2.addColorStop(1, '#4f46e5');
        expCtx.fillStyle = grd2;
      } else {
        expCtx.fillStyle = (_bgColor === 'white') ? '#ffffff' : (_bgColor === 'black') ? '#000000' : _bgColor;
      }
      expCtx.fillRect(0, 0, expC.width, expC.height);
    }
    // For transparent: canvas default state is all-transparent — correct for PNG export

    // Composite the transparent result image
    expCtx.drawImage(_resultImg, 0, 0);

    var blob = await new Promise(function (res, rej) {
      expC.toBlob(function (b) {
        expC.width = 0; expC.height = 0; // free memory
        if (b && b.size > 10) res(b);
        else rej(new Error('Export canvas returned empty blob'));
      }, mime, quality);
    });

    var base     = (_file && _file.name ? _file.name : 'image').replace(/\.[^.]+$/, '');
    var filename = 'ILovePDF-' + base + '-bg-removed' + ext;
    return { blob: blob, filename: filename, mime: mime };
  }

  // ── Compare slider wiring ─────────────────────────────────────────────────
  function _wireCompareSlider(container) {
    var outer  = container.querySelector('#bgr-compare-outer');
    var after  = container.querySelector('#bgr-after');
    var handle = container.querySelector('#bgr-compare-handle');
    var hint   = container.querySelector('#bgr-compare-hint');
    if (!outer || !after || !handle) return;

    var pct      = 50;
    var dragging = false;

    function applySlider(clientX) {
      var rect = outer.getBoundingClientRect();
      pct = Math.max(2, Math.min(98, (clientX - rect.left) / rect.width * 100));
      handle.style.left       = pct + '%';
      after.style.clipPath    = 'inset(0 0 0 ' + pct + '%)';
    }

    // Set initial position
    handle.style.left    = '50%';
    after.style.clipPath = 'inset(0 0 0 50%)';

    function startDrag(e) {
      dragging = true;
      if (hint) hint.style.opacity = '0';
      applySlider(e.clientX || (e.touches && e.touches[0].clientX));
    }
    function moveDrag(e) {
      if (!dragging) return;
      applySlider(e.clientX || (e.touches && e.touches[0].clientX));
    }
    function stopDrag() { dragging = false; }

    handle.addEventListener('mousedown',  startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: true });

    document.addEventListener('mousemove',  moveDrag);
    document.addEventListener('mouseup',    stopDrag);
    document.addEventListener('touchmove',  function (e) {
      if (!dragging) return;
      e.preventDefault();
      applySlider(e.touches[0].clientX);
    }, { passive: false });
    document.addEventListener('touchend',   stopDrag);

    // Also drag anywhere on the compare container
    outer.addEventListener('mousedown', function (e) {
      dragging = true;
      if (hint) hint.style.opacity = '0';
      applySlider(e.clientX);
    });
    outer.addEventListener('touchstart', function (e) {
      dragging = true;
      if (hint) hint.style.opacity = '0';
      applySlider(e.touches[0].clientX);
    }, { passive: true });
  }

  // ── Error screen ──────────────────────────────────────────────────────────
  function _renderEngineError(container, err) {
    var msg = 'Processing failed. Please try a different image.';
    if (err && err.message) {
      var m = err.message;
      if (m.includes('No background detected') || m.includes('Could not remove')) {
        msg = 'No clear background was found. For best results, use an image with a solid or uniform background.';
      } else if (m.includes('engine not ready') || m.includes('not a function')) {
        msg = 'The engine is still initializing. Please wait a moment, then try again.';
      } else if (m.includes('memory') || m.includes('OOM')) {
        msg = 'Not enough memory. Please try a smaller image or close other browser tabs.';
      }
    }
    container.innerHTML =
      '<div class="bgr-error-card">' +
        '<div class="bgr-error-icon">\u26a0</div>' +
        '<div class="bgr-error-title">Could not remove background</div>' +
        '<div class="bgr-error-msg">' + msg + '</div>' +
        '<div class="bgr-error-actions">' +
          '<button type="button" class="bgr-main-btn" id="bgr-go-upload">Try a Different Image</button>' +
        '</div>' +
      '</div>';
    var goBtn = container.querySelector('#bgr-go-upload');
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        if (window.Flow) window.Flow.navTo('upload');
        else window.location.href = window.location.pathname.replace(/\/(preview|download).*$/i, '');
      });
    }
  }

  function _showError(container, msg) {
    container.innerHTML =
      '<div class="bgr-error-card">' +
        '<div class="bgr-error-icon">\u26a0</div>' +
        '<div class="bgr-error-msg">' + msg + '</div>' +
      '</div>';
  }

  // ── Auto subject detection ─────────────────────────────────────────────────
  // Uses BgAiEngine.classify when available; falls back to pixel heuristics.
  function _detectSubject(img) {
    // Prefer the full v6 classifier (12 features, 12 categories)
    if (window.BgAiEngine && typeof window.BgAiEngine.classify === 'function') {
      var SIZE = 200;
      var sc   = document.createElement('canvas');
      sc.width = SIZE; sc.height = SIZE;
      sc.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE);
      var d   = sc.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      sc.width = 0; sc.height = 0;
      var res = window.BgAiEngine.classify(d, SIZE, SIZE);
      var m   = res.mode;
      if (m === 'selfie' || m === 'portrait')    return 'portrait';
      if (m === 'product' || m === 'metallic')   return 'product';
      if (m === 'logo')                          return 'logo';
      if (m === 'screenshot' || m === 'darkScreenshot' || m === 'document') return 'screenshot';
      return 'auto';
    }

    // Fallback: lightweight pixel heuristic (used before BgAiEngine script loads)
    var SIZE2 = 64;
    var sc2   = document.createElement('canvas');
    sc2.width = SIZE2; sc2.height = SIZE2;
    sc2.getContext('2d').drawImage(img, 0, 0, SIZE2, SIZE2);
    var d2 = sc2.getContext('2d').getImageData(0, 0, SIZE2, SIZE2).data;
    sc2.width = 0; sc2.height = 0;

    var n = SIZE2 * SIZE2;
    var skinTone = 0, brightPx = 0, lowSatPx = 0, highSatPx = 0, textEdges = 0;
    for (var i = 0; i < n; i++) {
      var r = d2[i*4], g = d2[i*4+1], b = d2[i*4+2];
      var br  = (r+g+b)/3;
      var sat = Math.max(r,g,b) - Math.min(r,g,b);
      if (br  > 185) brightPx++;
      if (sat < 22)  lowSatPx++;
      if (sat > 60)  highSatPx++;
      if (r > 100 && r < 240 && g > 70 && g < 200 && b > 50 && b < 180
          && r > g+8 && g > b && sat > 15 && sat < 130) skinTone++;
    }
    var skinR   = skinTone / n;
    var brightR = brightPx / n;
    var flatR   = lowSatPx / n;
    var W2 = img.naturalWidth, H2 = img.naturalHeight;
    var isPortraitAspect = H2 > W2 * 1.5;

    if (flatR > 0.55 && brightR > 0.45 && isPortraitAspect) return 'screenshot';
    if (skinR  > 0.09)                                       return 'portrait';
    if (flatR  > 0.55 && brightR < 0.35)                    return 'logo';
    if (brightR > 0.52 || (highSatPx/n) < 0.12)             return 'product';
    return 'auto';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _loadImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload  = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Cannot decode image')); };
      img.src = url;
    });
  }

  function _loadImgFromBlob(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload  = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Cannot decode result image')); };
      img.src = url;
    });
  }

  function _humanSize(bytes) {
    if (bytes < 1024)         return bytes + ' B';
    if (bytes < 1024 * 1024)  return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function _buildFilename() {
    var base = (_file && _file.name ? _file.name : 'image').replace(/\.[^.]+$/, '');
    return 'ILovePDF-' + base + '-bg-removed.png';
  }

  function _subjectLabel(s) {
    return {
      portrait:   'Portrait',
      product:    'Product',
      logo:       'Logo',
      screenshot: 'Screenshot',
    }[s] || 'Subject';
  }

  function _subjectEmoji(s) {
    return {
      portrait:   '\uD83D\uDC64',
      product:    '\uD83D\uDCE6',
      logo:       '\uD83D\uDD37',
      screenshot: '\uD83D\uDCF1',
    }[s] || '';
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  window.BgRemoverPro = { mount: mount };
}());
