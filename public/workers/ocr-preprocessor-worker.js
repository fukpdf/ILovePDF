// OCR Preprocessor Worker — Phase 19B (hardened)
// Applies a full image preprocessing pipeline to RGBA pixel buffers before
// they are sent to Tesseract. Runs entirely off the main thread.
//
// Protocol (all messages use transferable ArrayBuffers — zero copy):
//   IN:  { id, pixels: ArrayBuffer (RGBA), width, height, mode }
//   OUT: { id, pixels: ArrayBuffer (RGBA), width, height }
//     or { id, __error: 'message' }
//
// Mode strings:
//   'auto'    — adaptive local threshold (best for mixed/printed docs)
//   'strong'  — Otsu global threshold + contrast boost (harsh binarization)
//   'denoise' — 5×5 box blur then Otsu (noisy/grainy scans)
//   'table'   — contrast boost + Otsu (table / form extraction)
//
// Pipeline per mode:
//   1. Grayscale (BT.601 luma)
//   2. Histogram normalization (percentile-clipped auto-levels — Phase 19B)
//   3. Mode-dependent enhancement (adaptive or Otsu)
//   4. Speckle cleanup — 3×3 majority vote (Phase 19B: removes isolated noise pixels)
//   5. Deskew detection via horizontal projection variance (Phase 19B: finer angle set)
//   6. Rotation correction (nearest-neighbour, white bg fill)
//   7. RGBA output reconstruction

'use strict';

self.onmessage = function (e) {
  var d = e.data;
  if (!d || !d.pixels) {
    self.postMessage({ id: d && d.id, __error: 'missing_pixels' });
    return;
  }
  try {
    var out = runPipeline(d.pixels, d.width | 0, d.height | 0, d.mode || 'auto');
    self.postMessage(
      { id: d.id, pixels: out.pixels, width: out.width, height: out.height },
      [out.pixels]
    );
  } catch (err) {
    self.postMessage({ id: d.id, __error: String((err && err.message) || err || 'pipeline_error') });
  }
};

// ── Main pipeline ─────────────────────────────────────────────────────────────

function runPipeline(pixelsBuf, w, h, mode) {
  if (w < 4 || h < 4) throw new Error('image_too_small');

  var rgba = new Uint8ClampedArray(pixelsBuf);

  // Step 1: Grayscale (BT.601)
  var gray = rgbaToGray(rgba, w, h);
  rgba = null;

  // Step 2: Histogram normalization (percentile-clipped auto-levels — Phase 19B)
  // Clips 1% of pixels at each end to handle shadowed / unevenly lit documents.
  normalizeHistogram(gray);

  // Step 3: Mode-dependent enhancement
  // Guard: for very large images (>4MP) skip adaptive threshold to avoid
  // ~50 MB SAT allocation — use Otsu (O(W*H), histogram only).
  var large = (w * h > 4000000);
  var binary;
  if (mode === 'strong' || mode === 'table' || large) {
    binary = otsuThreshold(gray);
  } else if (mode === 'denoise') {
    // Phase 19B: 5×5 box blur for heavier noise — more aggressive than 3×3
    gray = boxBlurN(gray, w, h, 2); // radius 2 = 5×5 kernel
    binary = otsuThreshold(gray);
  } else {
    // 'auto': adaptive local threshold with resolution-scaled window (Phase 19B)
    var hw = adaptiveWindowSize(w, h);
    binary = adaptiveThreshold(gray, w, h, hw, 0.12);
  }
  gray = null;

  // Step 4: Speckle cleanup — 3×3 majority vote (Phase 19B)
  // Removes isolated noise pixels without damaging text strokes.
  // Skipped for 'table' mode to preserve fine grid lines.
  if (mode !== 'table') {
    binary = cleanBinarySpeckles(binary, w, h);
  }

  // Step 5: Deskew detection + correction (Phase 19B: finer angles, lower trigger)
  var skew = detectSkew(binary, w, h);
  var finalGray, finalW = w, finalH = h;
  if (Math.abs(skew) >= 0.5) {            // Phase 19B: lowered from 0.8° to 0.5°
    var rotated = rotateGray(binary, w, h, skew);
    binary = null;
    finalGray = rotated.data;
    finalW    = rotated.w;
    finalH    = rotated.h;
  } else {
    finalGray = binary;
    binary    = null;
  }

  // Step 6: RGBA output
  var outRgba = grayToRgba(finalGray, finalW, finalH);
  finalGray = null;

  return { pixels: outRgba.buffer, width: finalW, height: finalH };
}

// ── Colour ────────────────────────────────────────────────────────────────────

function rgbaToGray(rgba, w, h) {
  var n    = w * h;
  var gray = new Uint8Array(n);
  for (var i = 0, px = 0; i < n; i++, px += 4) {
    gray[i] = (0.299 * rgba[px] + 0.587 * rgba[px + 1] + 0.114 * rgba[px + 2]) | 0;
  }
  return gray;
}

function grayToRgba(gray, w, h) {
  var out = new Uint8ClampedArray(w * h * 4);
  for (var i = 0, px = 0; i < gray.length; i++, px += 4) {
    var v = gray[i];
    out[px] = v; out[px + 1] = v; out[px + 2] = v; out[px + 3] = 255;
  }
  return out;
}

// ── Histogram normalization (percentile-clipped) ──────────────────────────────
// Phase 19B: clips the bottom and top 1% of pixel counts before stretching.
// Significantly better than pure min/max for:
//  — shadowed documents (shadow creates a bright cluster near maxV)
//  — faded documents (faint ink is well below the clip point)
//  — scans with dark borders (a few very dark pixels pull minV down)

function normalizeHistogram(gray) {
  var total = gray.length;
  if (total === 0) return;

  // Build histogram
  var hist = new Int32Array(256);
  for (var i = 0; i < total; i++) hist[gray[i]]++;

  // 1% clip count — small enough to preserve useful range
  var clip = Math.max(1, Math.ceil(total * 0.01));

  // Find clipped min (skip bottom 1% of pixel mass)
  var cumLow = 0, minV = 0;
  for (var v = 0; v < 256; v++) {
    cumLow += hist[v];
    if (cumLow >= clip) { minV = v; break; }
  }

  // Find clipped max (skip top 1% of pixel mass)
  var cumHigh = 0, maxV = 255;
  for (var v = 255; v >= 0; v--) {
    cumHigh += hist[v];
    if (cumHigh >= clip) { maxV = v; break; }
  }

  var range = maxV - minV;
  if (range < 8) return; // nearly uniform — skip to avoid amplifying flat noise

  var scale = 255 / range;
  for (var i = 0; i < total; i++) {
    var clamped = gray[i] < minV ? minV : gray[i] > maxV ? maxV : gray[i];
    gray[i] = ((clamped - minV) * scale) | 0;
  }
}

// ── Otsu global threshold ──────────────────────────────────────────────────────
// O(W*H) computation, O(256) histogram — memory-safe for any image size.

function otsuThreshold(gray) {
  var hist  = new Int32Array(256);
  var total = gray.length;
  for (var i = 0; i < total; i++) hist[gray[i]]++;

  var sum = 0;
  for (var i = 0; i < 256; i++) sum += i * hist[i];

  var sumB = 0, wB = 0, maxVar = 0, thresh = 128;
  for (var t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    var wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    var mB   = sumB / wB;
    var mF   = (sum - sumB) / wF;
    var diff = mB - mF;
    var between = wB * wF * diff * diff;
    if (between > maxVar) { maxVar = between; thresh = t; }
  }

  var out = new Uint8Array(total);
  for (var i = 0; i < total; i++) {
    out[i] = gray[i] >= thresh ? 255 : 0;
  }
  return out;
}

// ── Adaptive local threshold (Sauvola-inspired) ───────────────────────────────
// Uses a summed area table for O(W*H) regardless of window size.
// Phase 19B: hw is now dynamically computed via adaptiveWindowSize() instead
// of being hardcoded, so it scales with resolution.

function adaptiveWindowSize(w, h) {
  // Scale window radius proportionally to image width (~0.8% of width).
  // Clamped [6, 28] to stay useful for both thumbnails and high-DPI renders.
  // Reference: 300-dpi A4 page ≈ 2480px wide → hw ≈ 19.
  return Math.max(6, Math.min(28, Math.round(w * 0.008)));
}

function adaptiveThreshold(gray, w, h, hw, k) {
  // Build SAT (Float32Array — half the size of Float64, sufficient precision)
  var W1  = w + 1;
  var sat = new Float32Array(W1 * (h + 1));
  for (var y = 0; y < h; y++) {
    var rowSum = 0;
    for (var x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      sat[(y + 1) * W1 + (x + 1)] = rowSum + sat[y * W1 + (x + 1)];
    }
  }

  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var x1  = x > hw ? x - hw : 0;
      var y1  = y > hw ? y - hw : 0;
      var x2  = x + hw < w ? x + hw : w - 1;
      var y2  = y + hw < h ? y + hw : h - 1;
      var cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
      var s   = sat[(y2+1)*W1+(x2+1)] - sat[y1*W1+(x2+1)] - sat[(y2+1)*W1+x1] + sat[y1*W1+x1];
      var mean = s / cnt;
      out[y * w + x] = gray[y * w + x] >= mean * (1 - k) ? 255 : 0;
    }
  }
  return out;
}

// ── N×N box blur (configurable radius) ───────────────────────────────────────
// Phase 19B: replaces the fixed 3×3 boxBlur3x3.
// radius=1 → 3×3 kernel (unchanged behaviour for non-denoise modes)
// radius=2 → 5×5 kernel (used in denoise mode — heavier noise removal)

function boxBlurN(gray, w, h, radius) {
  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var sum = 0, cnt = 0;
      for (var dy = -radius; dy <= radius; dy++) {
        var ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -radius; dx <= radius; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += gray[ny * w + nx]; cnt++;
        }
      }
      out[y * w + x] = cnt > 0 ? ((sum / cnt) | 0) : gray[y * w + x];
    }
  }
  return out;
}

// ── Speckle cleanup (Phase 19B) ───────────────────────────────────────────────
// 3×3 majority vote on binary image: each pixel adopts the value held by
// ≥6 of its 9 neighbours (including itself). This removes isolated noise pixels
// (stray black dots on white background and white gaps inside strokes) without
// structurally damaging character shapes.
// Skipped for very small images where the overhead isn't justified.

function cleanBinarySpeckles(binary, w, h) {
  if (w * h < 10000) return binary; // skip for tiny images
  var out = new Uint8Array(binary.length);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var whites = 0, cnt = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (binary[ny * w + nx] > 128) whites++;
          cnt++;
        }
      }
      // Majority threshold: needs clear supermajority to flip (≥ 6 of 9, or 4 of 5, etc.)
      var needed = Math.ceil(cnt * 0.62);
      out[y * w + x] = whites >= needed ? 255 : 0;
    }
  }
  return out;
}

// ── Deskew detection ──────────────────────────────────────────────────────────
// Horizontal projection variance method: downsample to ≤320px width,
// test a dense angle range ±8°, pick the angle that maximises row variance.
// Phase 19B: finer angle resolution (added ±0.5, ±4, ±6) for sub-degree tilts.
// Returns correction angle in degrees (positive = CCW fix for CW-tilted text).

function detectSkew(binary, w, h) {
  var sw = Math.min(w, 320);
  var sh = Math.round(h * sw / w);
  if (sh < 16 || sw < 16) return 0;

  var xRatio = w / sw, yRatio = h / sh;
  var thumb  = new Uint8Array(sw * sh);
  for (var y = 0; y < sh; y++) {
    var srcY = Math.min(h - 1, Math.round(y * yRatio));
    for (var x = 0; x < sw; x++) {
      thumb[y * sw + x] = binary[srcY * w + Math.min(w - 1, Math.round(x * xRatio))];
    }
  }

  var DEG = Math.PI / 180;
  // Phase 19B: denser angle sampling — added ±0.5, ±4, ±6 to catch subtle tilts
  var angles = [-8, -6, -5, -4, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 4, 5, 6, 8];
  var cxS    = sw / 2, cyS = sh / 2;
  var bestAngle = 0, bestVar = -1;

  for (var ai = 0; ai < angles.length; ai++) {
    var deg = angles[ai];
    var cos = Math.cos(deg * DEG), sin = Math.sin(deg * DEG);
    var rows = new Float32Array(sh);
    for (var y = 0; y < sh; y++) {
      for (var x = 0; x < sw; x++) {
        if (thumb[y * sw + x] < 128) { // dark pixel = likely text
          var ry = ((x - cxS) * sin + (y - cyS) * cos + cyS) | 0;
          if (ry >= 0 && ry < sh) rows[ry]++;
        }
      }
    }
    var mean = 0;
    for (var i = 0; i < sh; i++) mean += rows[i];
    mean /= sh;
    var v = 0;
    for (var i = 0; i < sh; i++) { var d = rows[i] - mean; v += d * d; }
    if (v > bestVar) { bestVar = v; bestAngle = deg; }
  }

  // Phase 19B: lowered minimum reportable skew from 0.8° to 0.5°
  // to correct subtle mobile-camera tilts that previously went undetected.
  return Math.abs(bestAngle) >= 0.5 ? bestAngle : 0;
}

// ── Rotation (nearest-neighbour, white background) ─────────────────────────────
// deg = correction angle to apply (positive = rotate CCW = counter-CW).

function rotateGray(gray, w, h, deg) {
  var RAD    = deg * Math.PI / 180;
  var cos    = Math.cos(RAD), sin = Math.sin(RAD);
  var absCos = Math.abs(cos), absSin = Math.abs(sin);
  var nW     = (Math.round(w * absCos + h * absSin)) | 0;
  var nH     = (Math.round(h * absCos + w * absSin)) | 0;

  var out = new Uint8Array(nW * nH);
  // Pre-fill with white (background colour for scanned docs)
  for (var i = 0; i < out.length; i++) out[i] = 255;

  var cxS = w / 2, cyS = h / 2;
  var cxD = nW / 2, cyD = nH / 2;

  // Inverse mapping: for each destination pixel find source via R^{-1}
  for (var y = 0; y < nH; y++) {
    var dy = y - cyD;
    for (var x = 0; x < nW; x++) {
      var dx = x - cxD;
      // Inverse rotation (transpose of rotation matrix)
      var sx = (dx * cos + dy * sin + cxS) | 0;
      var sy = (-dx * sin + dy * cos + cyS) | 0;
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        out[y * nW + x] = gray[sy * w + sx];
      }
    }
  }

  return { data: out, w: nW, h: nH };
}

importScripts("/workers/p4-heartbeat-mixin.js");
if (typeof _p4ApplyMixin === "function") _p4ApplyMixin();
