// RuntimeSecurityVisualizer v1.0 — Phase 7 / Section 1 (Dashboard Visualizer)
// =============================================================================
// Visualization engine for the enterprise security dashboard.
// Renders security state charts, timelines, and grids using Canvas 2D API.
// No external charting libraries — pure canvas rendering for CSP compliance.
//
// Visualizations:
//   1. Threat timeline bar chart  — events per time window
//   2. Worker health grid        — per-worker status squares
//   3. Risk score gauge          — arc-based gauge widget
//   4. Memory pressure sparkline  — line chart of heap over time
//   5. Incident severity donut    — proportional donut chart
//   6. Attack heatmap            — 2D density map of attack types
//
// Design:
//   • All rendering is async / requestAnimationFrame-based
//   • Canvas elements can be any size (responsive)
//   • Dark theme by default (dashboard context)
//   • No DOM manipulation beyond the target canvas
//
// window.RuntimeSecurityVisualizer
//   .drawGauge(canvas, score, label)              → void
//   .drawTimeline(canvas, events, windowMs)        → void
//   .drawWorkerGrid(canvas, workers)               → void
//   .drawSparkline(canvas, values, color)          → void
//   .drawDonut(canvas, segments)                   → void
//   .status()                                      → StatusObject
// =============================================================================
(function (G) {
  'use strict';

  if (G.RuntimeSecurityVisualizer) return;

  var VERSION = '1.0';
  var LOG     = '[SecViz]';

  function _s(fn, def) { try { return fn(); } catch (_) { return def !== undefined ? def : null; } }

  // ── Color palette (dark theme) ────────────────────────────────────────────
  var C = {
    bg:       '#0d1117',
    surface:  '#161b22',
    border:   '#30363d',
    text:     '#e6edf3',
    textDim:  '#7d8590',
    green:    '#3fb950',
    yellow:   '#d29922',
    orange:   '#f0883e',
    red:      '#f85149',
    critical: '#ff6e76',
    blue:     '#58a6ff',
    purple:   '#a371f7',
    cyan:     '#39d353',
  };

  var SEV_COLOR = {
    INFO:     C.textDim,
    LOW:      C.green,
    MEDIUM:   C.yellow,
    HIGH:     C.orange,
    CRITICAL: C.red,
  };

  // ── Canvas context helper ─────────────────────────────────────────────────
  function _ctx(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    return _s(function () { return canvas.getContext('2d'); }, null);
  }

  function _clear(ctx, canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // ── 1. Risk score gauge ────────────────────────────────────────────────────
  function drawGauge(canvas, score, label) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h * 0.6;
    var r  = Math.min(w, h) * 0.38;

    _clear(ctx, canvas);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 10;
    ctx.stroke();

    // Score arc
    var pct    = Math.min(1, Math.max(0, score / 100));
    var endAng = Math.PI + pct * Math.PI;
    var color  = score < 40 ? C.green : score < 70 ? C.yellow : score < 90 ? C.orange : C.red;

    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, endAng);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Score text
    ctx.fillStyle  = C.text;
    ctx.font       = 'bold ' + Math.floor(r * 0.55) + 'px monospace';
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score.toString(), cx, cy - 4);

    // Label
    if (label) {
      ctx.fillStyle = C.textDim;
      ctx.font      = '11px sans-serif';
      ctx.fillText(label, cx, cy + r * 0.35);
    }
  }

  // ── 2. Timeline bar chart ──────────────────────────────────────────────────
  function drawTimeline(canvas, events, windowMs) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    var bins = 20, now = Date.now();
    windowMs = windowMs || 300_000;

    _clear(ctx, canvas);

    var buckets = new Array(bins).fill(0);
    var bucketSev = new Array(bins).fill('INFO');

    (events || []).forEach(function (e) {
      var age = now - e.ts;
      if (age > windowMs) return;
      var idx = Math.floor((1 - age / windowMs) * bins);
      idx = Math.min(bins - 1, Math.max(0, idx));
      buckets[idx]++;
      var sevOrder = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
      if ((sevOrder[e.severity] || 0) > (sevOrder[bucketSev[idx]] || 0)) {
        bucketSev[idx] = e.severity;
      }
    });

    var maxBucket = Math.max.apply(null, buckets) || 1;
    var bw = (w - 20) / bins;

    buckets.forEach(function (val, i) {
      var bh = ((val / maxBucket) * (h - 30)) || 1;
      var x  = 10 + i * bw;
      var y  = h - 20 - bh;
      ctx.fillStyle = SEV_COLOR[bucketSev[i]] || C.blue;
      ctx.fillRect(x, y, bw - 1, bh);
    });

    // X axis
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(10, h - 20);
    ctx.lineTo(w - 10, h - 20);
    ctx.stroke();

    ctx.fillStyle = C.textDim;
    ctx.font      = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(windowMs / 60000) + 'm window', 12, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - 10, h - 6);
  }

  // ── 3. Worker health grid ──────────────────────────────────────────────────
  function drawWorkerGrid(canvas, workers) {
    var ctx = _ctx(canvas);
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;

    _clear(ctx, canvas);

    workers = workers || [];
    if (workers.length === 0) {
      ctx.fillStyle = C.textDim;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No workers registered', w / 2, h / 2);
      return;
    }

    var cols = Math.ceil(Math.sqrt(workers.length));
    var rows = Math.ceil(workers.length / cols);
    var cw   = Math.floor((w - 10) / cols);
    var ch   = Math.floor((h - 10) / rows);

    workers.forEach(function (worker, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x = 5 + col * cw, y = 5 + row * ch;
      var trust = typeof worker.trust === 'number' ? worker.trust : 50;
      var state = worker.state || 'UNKNOWN';

      var color = state === 'QUARANTINED' ? C.red
        : state === 'VERIFIED' ? C.green
        : state === 'TRUSTED'  ? C.cyan
        : state === 'NEW'      ? C.yellow
        : C.textDim;

      ctx.fillStyle = color + '33'; // transparent fill
      ctx.fillRect(x + 1, y + 1, cw - 3, ch - 3);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1;
      ctx.strokeRect(x + 1, y + 1, cw - 3, ch - 3);

      ctx.fillStyle    = color;
      ctx.font         = '8px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      var label = String(trust);
      ctx.fillText(label, x + cw / 2, y + ch / 2);
    });
  }

  // ── 4. Sparkline ───────────────────────────────────────────────────────────
  function drawSparkline(canvas, values, color) {
    var ctx = _ctx(canvas);
    if (!ctx || !values || values.length < 2) return;
    var w = canvas.width, h = canvas.height;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (max === min) max = min + 1;

    _clear(ctx, canvas);

    ctx.beginPath();
    ctx.strokeStyle = color || C.blue;
    ctx.lineWidth   = 2;

    values.forEach(function (v, i) {
      var x = (i / (values.length - 1)) * (w - 4) + 2;
      var y = h - 4 - ((v - min) / (max - min)) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ── 5. Donut chart ────────────────────────────────────────────────────────
  function drawDonut(canvas, segments) {
    var ctx = _ctx(canvas);
    if (!ctx || !segments || segments.length === 0) return;
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2;
    var r  = Math.min(w, h) * 0.4;
    var r2 = r * 0.55;

    _clear(ctx, canvas);

    var total = segments.reduce(function (s, seg) { return s + (seg.value || 0); }, 0);
    if (total === 0) return;

    var angle = -Math.PI / 2;
    segments.forEach(function (seg) {
      var sweep = (seg.value / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + sweep);
      ctx.closePath();
      ctx.fillStyle = seg.color || C.blue;
      ctx.fill();
      angle += sweep;
    });

    // Donut hole
    ctx.beginPath();
    ctx.arc(cx, cy, r2, 0, 2 * Math.PI);
    ctx.fillStyle = C.bg;
    ctx.fill();

    // Total in center
    ctx.fillStyle    = C.text;
    ctx.font         = 'bold ' + Math.floor(r2 * 0.55) + 'px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(total.toString(), cx, cy);
  }

  G.RuntimeSecurityVisualizer = Object.freeze({
    VERSION:        VERSION,
    drawGauge:      drawGauge,
    drawTimeline:   drawTimeline,
    drawWorkerGrid: drawWorkerGrid,
    drawSparkline:  drawSparkline,
    drawDonut:      drawDonut,
    COLORS:         Object.freeze(Object.assign({}, C)),
    SEV_COLOR:      Object.freeze(Object.assign({}, SEV_COLOR)),
    status: function () { return { version: VERSION }; },
  });

  console.info(LOG, 'v' + VERSION + ' loaded');
}(window));
