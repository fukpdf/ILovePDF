// OCR Preprocessor Worker — Phase 18A
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
//   'denoise' — 3×3 box blur then Otsu (noisy scans)
//   'table'   — contrast boost + Otsu (table / form extraction)
//
// Pipeline per mode:
//   1. Grayscale (BT.601 luma)
//   2. Histogram normalization (auto-levels)
//   3. Mode-dependent enhancement (adaptive or Otsu)
//   4. Deskew detection via horizontal projection variance (±8° range)
//   5. Rotation correction (nearest-neighbour, white bg fill)
//   6. RGBA output reconstruction

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

// ── Main pipeline ────────────────────────────────────────────────────────────

function runPipeline(pixelsBuf, w, h, mode) {
  if (w < 4 || h < 4) throw new Error('image_too_small');

  var rgba = new Uint8ClampedArray(pixelsBuf);

  // Step 1: Grayscale (BT.601)
  var gray = rgbaToGray(rgba, w, h);
  rgba = null;

  // Step 2: Histogram normalization (auto-levels)
  normalizeHistogram(gray);

  // Step 3: Mode-dependent enhancement
  // Guard: for very large images (>4MP) skip adaptive threshold to avoid
  // ~50 MB SAT allocation — use Otsu (O(W*H), histogram only).
  var large = (w * h > 4000000);
  var binary;
  if (mode === 'strong' || mode === 'table' || large) {
    binary = otsuThreshold(gray);
  } else if (mode === 'denoise') {
    gray = boxBlur3x3(gray, w, h);
    binary = otsuThreshold(gray);
  } else {
    // 'auto': adaptive local threshold — best for typical scan quality
    binary = adaptiveThreshold(gray, w, h, 12, 0.12);
  }
  gray = null;

  // Step 4: Deskew detection + correction
  var skew = detectSkew(binary, w, h);
  var finalGray, finalW = w, finalH = h;
  if (Math.abs(skew) >= 0.8) {
    var rotated = rotateGray(binary, w, h, skew);
    binary = null;
    finalGray = rotated.data;
    finalW    = rotated.w;
    finalH    = rotated.h;
  } else {
    finalGray = binary;
    binary    = null;
  }

  // Step 5: RGBA output
  var outRgba = grayToRgba(finalGray, finalW, finalH);
  finalGray = null;

  return { pixels: outRgba.buffer, width: finalW, height: finalH };
}

// ── Colour ───────────────────────────────────────────────────────────────────

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

// ── Histogram normalization ───────────────────────────────────────────────────

function normalizeHistogram(gray) {
  var minV = 255, maxV = 0;
  for (var i = 0; i < gray.length; i++) {
    var v = gray[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  var range = maxV - minV;
  if (range < 8) return; // nearly uniform — skip to avoid amplifying noise
  var scale = 255 / range;
  for (var i = 0; i < gray.length; i++) {
    gray[i] = Math.min(255, ((gray[i] - minV) * scale) | 0);
  }
}

// ── Otsu global threshold ─────────────────────────────────────────────────────
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
// hw = half-window radius; k = sensitivity (0.05-0.2).

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

// ── 3×3 box blur (denoise mode) ───────────────────────────────────────────────

function boxBlur3x3(gray, w, h) {
  var out = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var sum = 0, cnt = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += gray[ny * w + nx]; cnt++;
        }
      }
      out[y * w + x] = (sum / cnt) | 0;
    }
  }
  return out;
}

// ── Deskew detection ──────────────────────────────────────────────────────────
// Horizontal projection variance method: downsample to ≤320px width,
// test ±8° range, pick the angle that maximises row variance.
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

  var DEG    = Math.PI / 180;
  var angles = [-8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8];
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

  return Math.abs(bestAngle) >= 1 ? bestAngle : 0;
}

// ── Rotation (nearest-neighbour, white background) ────────────────────────────
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
