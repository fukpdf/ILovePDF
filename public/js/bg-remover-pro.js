// Background Remover PRO MAX — full interactive mini-editor
// 100% browser-side: canvas pixel manipulation, no upload, no server, no paid API.
// Architecture: self-contained module — BgRemoverPro.mount(file, container, onResult)
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _file = null;
  let _img = null;
  let _W = 0, _H = 0;
  let _origPixels = null;   // Uint8ClampedArray RGBA of original image
  let _mask = null;         // Float32Array [0..1] per pixel (1 = keep, 0 = remove)
  let _workCtx = null;      // 2d context of work canvas
  let _overlayCtx = null;   // 2d context of overlay canvas (brush cursor preview)
  let _onResult = null;

  // Brush
  let _activeTool = 'erase';
  let _brushSize = 24;
  let _brushHardness = 0.8;
  let _brushOpacity = 1.0;
  let _isPainting = false;
  let _lastPX = -1, _lastPY = -1;

  // Zoom / pan
  let _zoom = 1.0;
  let _panX = 0, _panY = 0;
  let _isPanning = false;
  let _panStartX = 0, _panStartY = 0;
  let _spaceDown = false;
  let _pinchDist = null;

  // Undo/redo
  const MAX_UNDO = 18;
  let _undoStack = [];
  let _redoStack = [];

  // View
  let _showBA = false;
  let _showGrid = true;
  let _bgOption = 'transparent';
  let _bgColor = '#ffffff';
  let _exportFmt = 'png';
  let _exportQuality = 0.92;
  let _exportResolution = 'original';
  let _qualityMode = 'balanced';

  // Quality presets
  const PRESETS = {
    fast:           { threshold: 228, feather: 0, smooth: 0, noise: 0 },
    balanced:       { threshold: 238, feather: 1, smooth: 2, noise: 1 },
    'hair-detail':  { threshold: 195, feather: 3, smooth: 6, noise: 0 },
    'product-photo':{ threshold: 244, feather: 2, smooth: 3, noise: 2 },
    'high-precision':{ threshold: 233, feather: 4, smooth: 8, noise: 3 },
  };

  // ── Public mount ──────────────────────────────────────────────────────────
  async function mount(file, container, onResult) {
    _file = file; _onResult = onResult;
    _reset();

    container.innerHTML = _html();
    _bindControls(container);

    try {
      _img = await _loadImg(file);
    } catch (e) {
      container.innerHTML = `<div style="padding:24px;color:red">Cannot load image: ${e.message}</div>`;
      return;
    }
    _W = _img.naturalWidth;
    _H = _img.naturalHeight;

    // Grab original pixels from off-screen canvas
    const offCtx = _offCanvas(_W, _H);
    offCtx.drawImage(_img, 0, 0);
    _origPixels = offCtx.getImageData(0, 0, _W, _H).data;

    // Setup canvases
    _workCtx = container.querySelector('#bgpro-work').getContext('2d');
    _overlayCtx = container.querySelector('#bgpro-overlay').getContext('2d');
    _workCtx.canvas.width = _W; _workCtx.canvas.height = _H;
    _overlayCtx.canvas.width = _W; _overlayCtx.canvas.height = _H;

    const origC = container.querySelector('#bgpro-orig');
    origC.width = _W; origC.height = _H;
    origC.getContext('2d').drawImage(_img, 0, 0);

    // Init mask to fully opaque, then apply removal
    _mask = new Float32Array(_W * _H).fill(1);
    _applyRemoval();
    _pushUndo();
    _redraw();
    _detectAndSuggest(container);
    _updateQuality(container);
    _updateStatusBar(container);

    // Wire canvas events
    _wireCanvas(container);
    _fitZoom(container);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  function _html() {
    return `<div class="bgpro" id="bgpro-root">
  <div class="bgpro-toolbar">
    <div class="bgpro-tg">
      <button class="bgpro-tb" id="bgpro-undo" title="Undo">&#8630;</button>
      <button class="bgpro-tb" id="bgpro-redo" title="Redo">&#8631;</button>
    </div>
    <div class="bgpro-tsep"></div>
    <div class="bgpro-tg">
      <button class="bgpro-tb" id="bgpro-zin" title="Zoom In">+</button>
      <span class="bgpro-zlbl" id="bgpro-zlbl">100%</span>
      <button class="bgpro-tb" id="bgpro-zout" title="Zoom Out">&minus;</button>
      <button class="bgpro-tb" id="bgpro-zfit" title="Fit">&#x26F6;</button>
    </div>
    <div class="bgpro-tsep"></div>
    <div class="bgpro-tg">
      <button class="bgpro-tb bgpro-toggle" id="bgpro-ba" title="Before/After">B/A</button>
      <button class="bgpro-tb bgpro-toggle bgpro-on" id="bgpro-grid" title="Transparency Grid">&#9638;</button>
    </div>
    <div class="bgpro-detect" id="bgpro-detect"></div>
    <button class="bgpro-tb bgpro-dl-tb" id="bgpro-dl-tb">&#11123; Download</button>
  </div>

  <div class="bgpro-body">
    <!-- Left: original -->
    <div class="bgpro-panel bgpro-panel-orig">
      <div class="bgpro-plabel">Original</div>
      <div class="bgpro-orig-wrap"><canvas id="bgpro-orig"></canvas></div>
    </div>
    <!-- Center: workspace -->
    <div class="bgpro-panel bgpro-panel-work">
      <div class="bgpro-plabel">Edit Mask <small>· Scroll to zoom · Space to pan</small></div>
      <div class="bgpro-scroll" id="bgpro-scroll">
        <div class="bgpro-vp" id="bgpro-vp">
          <canvas id="bgpro-bg-canvas" class="bgpro-bg-c"></canvas>
          <canvas id="bgpro-work" class="bgpro-work-c"></canvas>
          <canvas id="bgpro-overlay" class="bgpro-overlay-c"></canvas>
          <div class="bgpro-cursor" id="bgpro-cursor"></div>
        </div>
      </div>
    </div>
    <!-- Right: controls -->
    <div class="bgpro-panel bgpro-panel-ctrl" id="bgpro-ctrl">

      <div class="bgpro-section">
        <div class="bgpro-slbl">Brush Tool</div>
        <div class="bgpro-tools">
          <button class="bgpro-tool bgpro-on" id="bgpro-t-erase">&#9003; Erase</button>
          <button class="bgpro-tool" id="bgpro-t-keep">&#128393; Keep</button>
          <button class="bgpro-tool" id="bgpro-t-smart">&#10024; Smart</button>
        </div>
      </div>

      <div class="bgpro-section">
        <div class="bgpro-slbl">Brush</div>
        <div class="bgpro-srow"><label>Size <b id="bgpro-sv">24</b>px</label><input type="range" id="bgpro-bs" min="2" max="150" value="24"></div>
        <div class="bgpro-srow"><label>Hardness <b id="bgpro-hv">80</b>%</label><input type="range" id="bgpro-bh" min="0" max="100" value="80"></div>
        <div class="bgpro-srow"><label>Opacity <b id="bgpro-ov">100</b>%</label><input type="range" id="bgpro-bo" min="10" max="100" value="100"></div>
      </div>

      <div class="bgpro-section">
        <div class="bgpro-slbl">Quality Mode</div>
        <select class="bgpro-sel" id="bgpro-qmode">
          <option value="fast">&#9889; Fast</option>
          <option value="balanced" selected>&#9878; Balanced</option>
          <option value="hair-detail">&#128148; Hair Detail</option>
          <option value="product-photo">&#128230; Product Photo</option>
          <option value="high-precision">&#127919; High Precision</option>
        </select>
        <button class="bgpro-btn-sm" id="bgpro-reapply" style="margin-top:6px;width:100%">Re-apply Removal</button>
      </div>

      <div class="bgpro-section">
        <div class="bgpro-slbl">Background</div>
        <select class="bgpro-sel" id="bgpro-bg">
          <option value="transparent">Transparent</option>
          <option value="white">White</option>
          <option value="black">Black</option>
          <option value="custom">Custom Color</option>
          <option value="blur">Blurred Original</option>
        </select>
        <input type="color" id="bgpro-bgcol" value="#ffffff" style="display:none;margin-top:6px;width:100%;height:30px;border-radius:6px;border:1px solid #e2e8f0;cursor:pointer">
      </div>

      <div class="bgpro-section">
        <div class="bgpro-slbl">Edge Quality</div>
        <div class="bgpro-qmeter" id="bgpro-qmeter">
          <div class="bgpro-qscore" id="bgpro-qscore">Analyzing…</div>
          <div class="bgpro-qdetail" id="bgpro-qdetail"></div>
          <div class="bgpro-qsuggest" id="bgpro-qsuggest"></div>
        </div>
      </div>

      <div class="bgpro-section bgpro-expsec">
        <div class="bgpro-slbl">Export</div>
        <div class="bgpro-erow"><label>Format</label>
          <select class="bgpro-sel-sm" id="bgpro-fmt"><option value="png">PNG</option><option value="webp">WEBP</option><option value="jpeg">JPEG</option></select></div>
        <div class="bgpro-erow"><label>Quality</label>
          <select class="bgpro-sel-sm" id="bgpro-eq"><option value="1.0">100%</option><option value="0.92" selected>92%</option><option value="0.85">85%</option><option value="0.7">70%</option></select></div>
        <div class="bgpro-erow"><label>Resolution</label>
          <select class="bgpro-sel-sm" id="bgpro-er"><option value="original">Original</option><option value="2x">2× Upscale</option><option value="0.5x">50% Size</option></select></div>
        <button class="bgpro-btn-primary" id="bgpro-dl">&#11123; Download</button>
      </div>
    </div>
  </div>

  <div class="bgpro-status" id="bgpro-status">
    <span id="bgpro-st-res">—</span>
    <span class="bgpro-stsep">|</span>
    <span id="bgpro-st-edge">—</span>
    <span class="bgpro-stsep">|</span>
    <span id="bgpro-st-mode">Mode: Balanced</span>
  </div>
</div>`;
  }

  // ── Core: apply initial background removal ────────────────────────────────
  function _applyRemoval() {
    const p = PRESETS[_qualityMode] || PRESETS.balanced;
    const d = _origPixels;
    const n = _W * _H;

    // Step 1: threshold pass
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const brightness = (r + g + b) / 3;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      // Remove near-white or near-gray-unsaturated pixels
      if (brightness >= p.threshold && saturation < 40) {
        _mask[i] = 0;
      } else {
        _mask[i] = 1;
      }
    }

    // Step 2: noise cleanup
    if (p.noise > 0) _noiseClean(p.noise);

    // Step 3: feathering
    if (p.feather > 0) _featherMask(p.feather);

    // Step 4: edge smoothing
    if (p.smooth > 0) _smoothEdge(p.smooth);
  }

  // ── Noise cleanup (median-like erosion of isolated pixels) ─────────────
  function _noiseClean(passes) {
    for (let pass = 0; pass < passes; pass++) {
      const next = new Float32Array(_mask);
      for (let y = 1; y < _H - 1; y++) {
        for (let x = 1; x < _W - 1; x++) {
          const ci = y * _W + x;
          if (_mask[ci] < 0.5) {
            // Check if surrounded by opaque neighbors — fill isolated transparent hole
            const neighbors = [
              _mask[(y-1)*_W+x], _mask[(y+1)*_W+x],
              _mask[y*_W+x-1],   _mask[y*_W+x+1]
            ];
            const opaqueCount = neighbors.filter(v => v > 0.5).length;
            if (opaqueCount >= 4) next[ci] = 1;
          }
        }
      }
      _mask = next;
    }
  }

  // ── Feathering (box blur the mask at edges) ────────────────────────────
  function _featherMask(radius) {
    const r = Math.max(1, Math.round(radius));
    const tmp = new Float32Array(_mask);
    // Horizontal pass
    for (let y = 0; y < _H; y++) {
      for (let x = 0; x < _W; x++) {
        let sum = 0, count = 0;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < _W) { sum += _mask[y * _W + nx]; count++; }
        }
        tmp[y * _W + x] = sum / count;
      }
    }
    // Vertical pass
    for (let y = 0; y < _H; y++) {
      for (let x = 0; x < _W; x++) {
        let sum = 0, count = 0;
        for (let dy = -r; dy <= r; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < _H) { sum += tmp[ny * _W + x]; count++; }
        }
        _mask[y * _W + x] = sum / count;
      }
    }
  }

  // ── Edge smoothing (only blur pixels near alpha transitions) ───────────
  function _smoothEdge(radius) {
    const r = Math.max(1, Math.round(radius / 2));
    const tmp = new Float32Array(_mask);
    for (let y = r; y < _H - r; y++) {
      for (let x = r; x < _W - r; x++) {
        const v = _mask[y * _W + x];
        if (v > 0.05 && v < 0.95) {
          let sum = 0, count = 0;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              sum += _mask[(y + dy) * _W + (x + dx)]; count++;
            }
          }
          tmp[y * _W + x] = sum / count;
        }
      }
    }
    _mask = tmp;
  }

  // ── Redraw work canvas ─────────────────────────────────────────────────
  function _redraw() {
    if (!_workCtx) return;
    const ctx = _workCtx;
    const W = _W, H = _H;
    const id = ctx.createImageData(W, H);
    const od = id.data;
    const src = _origPixels;

    if (_showBA) {
      // Show original on left half, masked on right half
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (x < W / 2) {
            od[i] = src[i]; od[i+1] = src[i+1]; od[i+2] = src[i+2]; od[i+3] = 255;
          } else {
            const a = _mask[y * W + x];
            _blendPixel(od, i, src, a);
          }
        }
      }
      // Draw divider line
      ctx.putImageData(id, 0, 0);
      ctx.strokeStyle = 'rgba(99,102,241,0.8)';
      ctx.lineWidth = 2 / _zoom;
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    } else {
      for (let i = 0; i < W * H; i++) {
        const pi = i * 4;
        _blendPixel(od, pi, src, _mask[i]);
      }
      ctx.putImageData(id, 0, 0);
    }

    _redrawBgCanvas();
  }

  function _blendPixel(od, i, src, alpha) {
    if (_bgOption === 'transparent' || _bgOption === 'blur') {
      od[i] = src[i]; od[i+1] = src[i+1]; od[i+2] = src[i+2];
      od[i+3] = Math.round(alpha * 255);
    } else {
      const bg = _parseBgColor();
      od[i]   = Math.round(src[i]   * alpha + bg[0] * (1 - alpha));
      od[i+1] = Math.round(src[i+1] * alpha + bg[1] * (1 - alpha));
      od[i+2] = Math.round(src[i+2] * alpha + bg[2] * (1 - alpha));
      od[i+3] = 255;
    }
  }

  function _parseBgColor() {
    if (_bgOption === 'white') return [255, 255, 255];
    if (_bgOption === 'black') return [0, 0, 0];
    const hex = _bgColor.replace('#', '');
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }

  function _redrawBgCanvas() {
    const bgC = document.getElementById('bgpro-bg-canvas');
    if (!bgC) return;
    bgC.width = _W; bgC.height = _H;
    const ctx = bgC.getContext('2d');
    if (_bgOption === 'blur') {
      ctx.filter = 'blur(20px)';
      ctx.drawImage(_img, 0, 0);
      ctx.filter = 'none';
    } else if (_showGrid && (_bgOption === 'transparent')) {
      _drawCheckered(ctx, _W, _H);
    } else {
      ctx.fillStyle = _bgOption === 'transparent' ? 'transparent' : (_bgOption === 'white' ? '#fff' : _bgOption === 'black' ? '#000' : _bgColor);
      ctx.fillRect(0, 0, _W, _H);
    }
  }

  function _drawCheckered(ctx, W, H) {
    const size = Math.max(8, Math.min(24, Math.round(Math.min(W, H) / 40)));
    for (let y = 0; y < H; y += size) {
      for (let x = 0; x < W; x += size) {
        ctx.fillStyle = ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) ? '#c8c8c8' : '#f0f0f0';
        ctx.fillRect(x, y, Math.min(size, W - x), Math.min(size, H - y));
      }
    }
  }

  // ── Brush painting ────────────────────────────────────────────────────
  function _paintAt(cx, cy, isFirst) {
    const r = Math.max(1, _brushSize);
    const r2 = r * r;
    const op = _brushOpacity;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(_W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(_H - 1, Math.ceil(cy + r));

    if (!isFirst && _lastPX >= 0) {
      // Interpolate line for smooth strokes
      const dx = cx - _lastPX, dy = cy - _lastPY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.floor(dist / (r * 0.3)));
      for (let s = 1; s < steps; s++) {
        _paintDot(_lastPX + dx * s / steps, _lastPY + dy * s / steps);
      }
    }
    _paintDot(cx, cy);
    _lastPX = cx; _lastPY = cy;
  }

  function _paintDot(cx, cy) {
    const r = Math.max(1, _brushSize);
    const r2 = r * r;
    const op = _brushOpacity;
    const hard = _brushHardness;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(_W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(_H - 1, Math.ceil(cy + r));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const norm = Math.sqrt(d2) / r;
        // Hardness curve: hard=1 → step at edge, hard=0 → smooth gradient
        const influence = hard >= 1 ? 1 : (norm < hard ? 1 : (1 - (norm - hard) / (1 - hard + 0.001)));
        const strength = op * Math.max(0, Math.min(1, influence));
        const idx = y * _W + x;

        if (_activeTool === 'erase') {
          _mask[idx] = Math.max(0, _mask[idx] - strength);
        } else if (_activeTool === 'keep') {
          _mask[idx] = Math.min(1, _mask[idx] + strength);
        } else if (_activeTool === 'smart') {
          _smartDot(x, y, strength);
        }
      }
    }
    // Partial redraw (bounding box of brush for performance)
    _redrawRegion(
      Math.max(0, Math.floor(cx - r) - 2), Math.max(0, Math.floor(cy - r) - 2),
      Math.min(_W, Math.ceil(cx + r) + 2), Math.min(_H, Math.ceil(cy + r) + 2)
    );
  }

  function _smartDot(x, y, strength) {
    // Smart edge: blur only transition pixels near this point
    const idx = y * _W + x;
    const v = _mask[idx];
    // Only affect pixels that are already partially transparent (near edge)
    if (v > 0.05 && v < 0.95) {
      const sr = 3;
      let sum = 0, count = 0;
      for (let dy = -sr; dy <= sr; dy++) {
        for (let dx = -sr; dx <= sr; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < _W && ny >= 0 && ny < _H) { sum += _mask[ny * _W + nx]; count++; }
        }
      }
      _mask[idx] = _mask[idx] * (1 - strength) + (sum / count) * strength;
    } else if (v <= 0.05) {
      // Very transparent near edge — check neighbors to see if this should transition
      const neighbors = [
        y > 0 && _mask[(y-1)*_W+x] > 0.5,
        y < _H-1 && _mask[(y+1)*_W+x] > 0.5,
        x > 0 && _mask[y*_W+x-1] > 0.5,
        x < _W-1 && _mask[y*_W+x+1] > 0.5,
      ];
      if (neighbors.some(Boolean)) _mask[idx] = Math.min(1, _mask[idx] + strength * 0.5);
    }
  }

  function _redrawRegion(x0, y0, x1, y1) {
    if (!_workCtx) return;
    const W = x1 - x0, H = y1 - y0;
    if (W <= 0 || H <= 0) return;
    const id = _workCtx.createImageData(W, H);
    const od = id.data;
    const src = _origPixels;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const pi = ((y - y0) * W + (x - x0)) * 4;
        const si = (y * _W + x) * 4;
        _blendPixel(od, pi, src, _mask[y * _W + x]);
      }
    }
    _workCtx.putImageData(id, x0, y0);
  }

  // ── Quality analysis ──────────────────────────────────────────────────
  function _analyzeQuality() {
    const n = _W * _H;
    let transCount = 0, edgeJag = 0, halo = 0, total = 0;
    for (let y = 1; y < _H - 1; y++) {
      for (let x = 1; x < _W - 1; x++) {
        const idx = y * _W + x;
        const v = _mask[idx];
        if (v < 0.5) transCount++;
        total++;
        // Jagged edge detection: abrupt transition without gradual feather
        const left = _mask[y * _W + x - 1], right = _mask[y * _W + x + 1];
        const top  = _mask[(y-1)*_W+x],    bottom= _mask[(y+1)*_W+x];
        if ((Math.abs(v - left) > 0.7 || Math.abs(v - right) > 0.7 ||
             Math.abs(v - top)  > 0.7 || Math.abs(v - bottom) > 0.7)) edgeJag++;
        // White halo: semi-transparent pixel next to fully opaque with bright original
        if (v > 0.05 && v < 0.4) {
          const pi = idx * 4;
          const br = (_origPixels[pi] + _origPixels[pi+1] + _origPixels[pi+2]) / 3;
          if (br > 200) halo++;
        }
      }
    }
    const transRatio = transCount / total;
    const jagScore = Math.min(100, Math.round(edgeJag / Math.max(1, total) * 10000));
    const haloScore = Math.min(100, Math.round(halo / Math.max(1, total) * 5000));
    return { transRatio, jagScore, haloScore };
  }

  function _updateQuality(container) {
    const { transRatio, jagScore, haloScore } = _analyzeQuality();
    const score = document.getElementById('bgpro-qscore');
    const detail = document.getElementById('bgpro-qdetail');
    const suggest = document.getElementById('bgpro-qsuggest');
    if (!score) return;

    const pct = Math.round(transRatio * 100);
    if (transRatio < 0.05) {
      score.textContent = '⚠ Too Little Removed'; score.className = 'bgpro-qscore bgpro-q-warn';
    } else if (jagScore > 30 || haloScore > 15) {
      score.textContent = '🔶 Needs Refinement'; score.className = 'bgpro-qscore bgpro-q-med';
      const tips = [];
      if (jagScore > 30) tips.push('jagged edges detected');
      if (haloScore > 15) tips.push('white halo detected');
      if (detail) detail.textContent = tips.join(' · ');
      if (suggest) suggest.textContent = jagScore > 30 ? 'Try Hair Detail mode or Smart Edge brush' : 'Use Smart Edge brush on bright outlines';
    } else {
      score.textContent = '✓ Good'; score.className = 'bgpro-qscore bgpro-q-good';
      if (pct > 20) { score.textContent = '✓ Excellent'; score.className = 'bgpro-qscore bgpro-q-excel'; }
      if (detail) detail.textContent = `${pct}% transparent · Clean edges`;
      if (suggest) suggest.textContent = '';
    }

    // Status bar edge info
    const st = document.getElementById('bgpro-st-edge');
    if (st) st.textContent = `${pct}% removed · Jag: ${jagScore} · Halo: ${haloScore}`;
  }

  // ── Auto-detect image type ────────────────────────────────────────────
  function _detectImageType() {
    const n = _W * _H;
    const d = _origPixels;
    let skinTones = 0, lowSat = 0, brightPct = 0, totalOpaque = 0;
    for (let i = 0; i < n; i++) {
      const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
      const brightness = (r + g + b) / 3;
      const sat = Math.max(r,g,b) - Math.min(r,g,b);
      if (brightness > 200) brightPct++;
      if (sat < 30) lowSat++;
      // Rough skin tone range
      if (r > 120 && r < 230 && g > 80 && g < 180 && b > 60 && b < 160 && r > g && g > b) skinTones++;
      totalOpaque++;
    }
    const skinRatio = skinTones / totalOpaque;
    const brightRatio = brightPct / totalOpaque;
    const flatRatio = lowSat / totalOpaque;
    if (skinRatio > 0.12) return 'portrait';
    if (flatRatio > 0.6 && brightRatio < 0.4) return 'logo';
    if (brightRatio > 0.5) return 'product';
    return 'illustration';
  }

  function _detectAndSuggest(container) {
    const type = _detectImageType();
    const badge = document.getElementById('bgpro-detect');
    if (!badge) return;
    const modeMap = { portrait:'balanced', logo:'high-precision', product:'product-photo', illustration:'hair-detail' };
    const labelMap = { portrait:'👤 Portrait detected', logo:'🔷 Logo detected', product:'📦 Product detected', illustration:'🎨 Illustration detected' };
    const suggMap  = { portrait:'Balanced mode recommended', logo:'High Precision recommended', product:'Product Photo recommended', illustration:'Hair Detail recommended' };
    badge.title = suggMap[type] || '';
    badge.textContent = labelMap[type] || '';
    badge.style.display = 'block';
    // Auto-set the quality mode dropdown
    const sel = document.getElementById('bgpro-qmode');
    if (sel) { sel.value = modeMap[type]; _qualityMode = modeMap[type]; }
    const stMode = document.getElementById('bgpro-st-mode');
    if (stMode) stMode.textContent = `Mode: ${sel ? sel.options[sel.selectedIndex].text : ''}`;
  }

  // ── Status bar ────────────────────────────────────────────────────────
  function _updateStatusBar(container) {
    const res = document.getElementById('bgpro-st-res');
    if (res) res.textContent = `${_W} × ${_H} px`;
  }

  // ── Zoom / pan ────────────────────────────────────────────────────────
  function _applyZoomPan() {
    const vp = document.getElementById('bgpro-vp');
    if (!vp) return;
    vp.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
    vp.style.transformOrigin = '0 0';
    const lbl = document.getElementById('bgpro-zlbl');
    if (lbl) lbl.textContent = Math.round(_zoom * 100) + '%';
  }

  function _fitZoom(container) {
    const scroll = document.getElementById('bgpro-scroll');
    if (!scroll || !_W) return;
    const sw = scroll.clientWidth - 32, sh = scroll.clientHeight - 32;
    if (sw <= 0 || sh <= 0) return;
    _zoom = Math.min(sw / _W, sh / _H, 1);
    _panX = (sw - _W * _zoom) / 2;
    _panY = Math.max(8, (sh - _H * _zoom) / 2);
    _applyZoomPan();
  }

  // ── Export ────────────────────────────────────────────────────────────
  async function _exportImage() {
    const fmt = _exportFmt;
    const q = _exportQuality;
    const res = _exportResolution;
    let W = _W, H = _H;
    if (res === '2x') { W *= 2; H *= 2; }
    if (res === '0.5x') { W = Math.round(W / 2); H = Math.round(H / 2); }

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');

    // Background
    if (_bgOption === 'blur') {
      ctx.filter = 'blur(20px)'; ctx.drawImage(_img, 0, 0, W, H); ctx.filter = 'none';
    } else if (_bgOption !== 'transparent') {
      ctx.fillStyle = _bgOption === 'white' ? '#fff' : _bgOption === 'black' ? '#000' : _bgColor;
      ctx.fillRect(0, 0, W, H);
    }

    // Draw masked image using current mask scaled to output size
    const masked = document.createElement('canvas');
    masked.width = _W; masked.height = _H;
    const mCtx = masked.getContext('2d');
    const id = mCtx.createImageData(_W, _H);
    const od = id.data;
    for (let i = 0; i < _W * _H; i++) {
      const pi = i * 4;
      od[pi] = _origPixels[pi]; od[pi+1] = _origPixels[pi+1]; od[pi+2] = _origPixels[pi+2];
      od[pi+3] = Math.round(_mask[i] * 255);
    }
    mCtx.putImageData(id, 0, 0);
    ctx.drawImage(masked, 0, 0, W, H);

    // Validate
    const pixels = ctx.getImageData(0, 0, W, H).data;
    let transPixels = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 128) transPixels++;
    const transRatio = transPixels / (W * H);
    if (transRatio < 0.03) throw new Error('Less than 3% of the image was removed. Adjust threshold or quality mode, then re-apply.');

    const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const ext  = fmt === 'jpeg' ? '.jpg' : fmt === 'webp' ? '.webp' : '.png';
    return new Promise((res, rej) => {
      out.toBlob(b => {
        if (!b || b.size < 100) return rej(new Error('Export failed — canvas encode returned empty blob'));
        res({ blob: b, ext, mime });
      }, mime, q);
    });
  }

  // ── Undo/redo ────────────────────────────────────────────────────────
  function _pushUndo() {
    _undoStack.push(new Float32Array(_mask));
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    _redoStack = [];
  }

  function _undo() {
    if (_undoStack.length < 2) return;
    _redoStack.push(_undoStack.pop());
    _mask = new Float32Array(_undoStack[_undoStack.length - 1]);
    _redraw();
  }

  function _redo() {
    if (!_redoStack.length) return;
    const state = _redoStack.pop();
    _undoStack.push(state);
    _mask = new Float32Array(state);
    _redraw();
  }

  // ── Canvas coordinate conversion ──────────────────────────────────────
  function _canvasCoords(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) / _zoom,
      y: (clientY - rect.top) / _zoom,
    };
  }

  function _vpCoords(e) {
    const vp = document.getElementById('bgpro-vp');
    if (!vp) return { x: 0, y: 0 };
    return _canvasCoords(e, vp);
  }

  // ── Event wiring ──────────────────────────────────────────────────────
  function _wireCanvas(container) {
    const overlay = container.querySelector('#bgpro-overlay');
    const cursor  = container.querySelector('#bgpro-cursor');
    if (!overlay) return;

    overlay.addEventListener('mousedown', e => {
      e.preventDefault();
      if (_spaceDown) return; // pan mode
      _isPainting = true;
      _pushUndo();
      _lastPX = -1; _lastPY = -1;
      const { x, y } = _vpCoords(e);
      _paintAt(x, y, true);
      _redraw();
    });
    overlay.addEventListener('mousemove', e => {
      const { x, y } = _vpCoords(e);
      _moveCursor(cursor, x, y);
      if (!_isPainting) return;
      _paintAt(x, y, false);
      _redraw();
    });
    overlay.addEventListener('mouseup', () => {
      if (_isPainting) { _isPainting = false; _updateQuality(container); }
    });
    overlay.addEventListener('mouseleave', () => {
      if (cursor) cursor.style.display = 'none';
      if (_isPainting) { _isPainting = false; _updateQuality(container); }
    });
    overlay.addEventListener('mouseenter', () => { if (cursor) cursor.style.display = 'block'; });

    // Touch events
    overlay.addEventListener('touchstart', e => {
      if (e.touches.length === 2) { _pinchDist = _getTouchDist(e); return; }
      e.preventDefault();
      _isPainting = true;
      _pushUndo();
      _lastPX = -1; _lastPY = -1;
      const { x, y } = _vpCoords(e);
      _paintAt(x, y, true); _redraw();
    }, { passive: false });
    overlay.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        const dist = _getTouchDist(e);
        if (_pinchDist) { _zoom = Math.max(0.15, Math.min(8, _zoom * (dist / _pinchDist))); _applyZoomPan(); }
        _pinchDist = dist; return;
      }
      if (!_isPainting) return;
      e.preventDefault();
      const { x, y } = _vpCoords(e);
      _paintAt(x, y, false); _redraw();
    }, { passive: false });
    overlay.addEventListener('touchend', () => {
      _pinchDist = null;
      if (_isPainting) { _isPainting = false; _updateQuality(container); }
    });

    // Wheel zoom
    const scroll = container.querySelector('#bgpro-scroll');
    if (scroll) {
      scroll.addEventListener('wheel', e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        _zoom = Math.max(0.1, Math.min(12, _zoom * factor));
        _applyZoomPan();
      }, { passive: false });
    }

    // Space pan
    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && !e.target.matches('input,textarea,select')) {
        _spaceDown = true;
        overlay.style.cursor = 'grab';
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); _redo(); }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { _spaceDown = false; overlay.style.cursor = 'crosshair'; }
    });

    // Pan drag on scroll area when space held
    scroll && scroll.addEventListener('mousedown', e => {
      if (!_spaceDown) return;
      _isPanning = true;
      _panStartX = e.clientX - _panX;
      _panStartY = e.clientY - _panY;
    });
    window.addEventListener('mousemove', e => {
      if (!_isPanning) return;
      _panX = e.clientX - _panStartX;
      _panY = e.clientY - _panStartY;
      _applyZoomPan();
    });
    window.addEventListener('mouseup', () => { _isPanning = false; });
  }

  function _moveCursor(cursor, x, y) {
    if (!cursor) return;
    const size = _brushSize * 2 * _zoom;
    cursor.style.display = 'block';
    cursor.style.width  = size + 'px';
    cursor.style.height = size + 'px';
    cursor.style.left   = (x * _zoom - size / 2) + 'px';
    cursor.style.top    = (y * _zoom - size / 2) + 'px';
    cursor.style.borderRadius = '50%';
    cursor.style.border = _activeTool === 'erase' ? '2px solid rgba(239,68,68,0.8)' :
                          _activeTool === 'keep'  ? '2px solid rgba(16,185,129,0.8)' :
                                                    '2px solid rgba(99,102,241,0.8)';
  }

  function _getTouchDist(e) {
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  // ── Bind control panel events ────────────────────────────────────────
  function _bindControls(container) {
    // Deferred — called after innerHTML set, before image load
    setTimeout(() => {
      _b(container, '#bgpro-undo', () => _undo());
      _b(container, '#bgpro-redo', () => _redo());
      _b(container, '#bgpro-zin',  () => { _zoom = Math.min(12, _zoom * 1.25); _applyZoomPan(); });
      _b(container, '#bgpro-zout', () => { _zoom = Math.max(0.1, _zoom * 0.8); _applyZoomPan(); });
      _b(container, '#bgpro-zfit', () => _fitZoom(container));
      _b(container, '#bgpro-ba',   () => { _showBA = !_showBA; _toggleClass(container, '#bgpro-ba', 'bgpro-on', _showBA); _redraw(); });
      _b(container, '#bgpro-grid', () => { _showGrid = !_showGrid; _toggleClass(container, '#bgpro-grid', 'bgpro-on', _showGrid); _redraw(); });

      _b(container, '#bgpro-t-erase', () => _setTool(container, 'erase'));
      _b(container, '#bgpro-t-keep',  () => _setTool(container, 'keep'));
      _b(container, '#bgpro-t-smart', () => _setTool(container, 'smart'));

      _on(container, '#bgpro-bs', 'input', e => { _brushSize = +e.target.value; _q(container, '#bgpro-sv', e.target.value); });
      _on(container, '#bgpro-bh', 'input', e => { _brushHardness = +e.target.value / 100; _q(container, '#bgpro-hv', e.target.value); });
      _on(container, '#bgpro-bo', 'input', e => { _brushOpacity  = +e.target.value / 100; _q(container, '#bgpro-ov', e.target.value); });

      _on(container, '#bgpro-qmode', 'change', e => {
        _qualityMode = e.target.value;
        const stMode = container.querySelector('#bgpro-st-mode');
        if (stMode) stMode.textContent = 'Mode: ' + e.target.options[e.target.selectedIndex].text.replace(/^\S+\s*/,'');
      });
      _b(container, '#bgpro-reapply', () => {
        _pushUndo();
        _mask = new Float32Array(_W * _H).fill(1);
        _applyRemoval();
        _redraw();
        _updateQuality(container);
      });

      _on(container, '#bgpro-bg', 'change', e => {
        _bgOption = e.target.value;
        const col = container.querySelector('#bgpro-bgcol');
        if (col) col.style.display = _bgOption === 'custom' ? 'block' : 'none';
        _redraw();
      });
      _on(container, '#bgpro-bgcol', 'input', e => { _bgColor = e.target.value; _redraw(); });

      _on(container, '#bgpro-fmt',  'change', e => { _exportFmt = e.target.value; });
      _on(container, '#bgpro-eq',   'change', e => { _exportQuality = parseFloat(e.target.value); });
      _on(container, '#bgpro-er',   'change', e => { _exportResolution = e.target.value; });

      const doDownload = async () => {
        const btn = container.querySelector('#bgpro-dl');
        if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
        try {
          const { blob, ext, mime } = await _exportImage();
          const fname = 'ILovePDF-' + (_file.name.replace(/\.[^.]+$/, '') || 'image') + ext;
          if (_onResult) _onResult(blob, fname, mime);
          else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
        } catch (err) {
          alert('Export failed: ' + (err.message || 'Unknown error'));
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '⬇ Download'; }
        }
      };
      _b(container, '#bgpro-dl', doDownload);
      _b(container, '#bgpro-dl-tb', doDownload);
    }, 50);
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function _b(c, sel, fn) { const el = c.querySelector(sel); if (el) el.addEventListener('click', fn); }
  function _on(c, sel, ev, fn) { const el = c.querySelector(sel); if (el) el.addEventListener(ev, fn); }
  function _q(c, sel, val) { const el = c.querySelector(sel); if (el) el.textContent = val; }
  function _toggleClass(c, sel, cls, force) { const el = c.querySelector(sel); if (el) el.classList.toggle(cls, force); }
  function _reset() { _mask = null; _origPixels = null; _undoStack = []; _redoStack = []; _zoom = 1; _panX = 0; _panY = 0; _isPainting = false; }
  function _offCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c.getContext('2d'); }
  function _loadImg(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Cannot decode image')); };
      img.src = url;
    });
  }
  function _setTool(container, tool) {
    _activeTool = tool;
    ['erase','keep','smart'].forEach(t => {
      const b = container.querySelector(`#bgpro-t-${t}`);
      if (b) b.classList.toggle('bgpro-on', t === tool);
    });
    const ov = container.querySelector('#bgpro-overlay');
    if (ov) ov.style.cursor = 'crosshair';
  }

  // ── Expose ────────────────────────────────────────────────────────────
  window.BgRemoverPro = { mount };
})();
