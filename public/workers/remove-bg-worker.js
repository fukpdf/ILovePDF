// remove-bg-worker.js v1.0 — Dedicated terminate-after-job background removal worker
// Phase 2C: Isolated replacement for runAdvancedWorker({op:'remove-bg'}) via WorkerPool.
//           Spawned per-job by remove-background-app.js. Terminated after each job.
//
// PROBLEM SOLVED:
//   background-remover processor calls runAdvancedWorker({op:'remove-bg'}) up to TWICE
//   (pass 1 + retry pass 2) consuming up to 2 shared WorkerPool slots.
//   On withTimeout() abandonment, both slots are leaked permanently — the shared
//   WorkerPool reaches exhaustion after only 2-3 timeout events. Next runs hang.
//
//   This worker is spawned directly (new Worker('/workers/remove-bg-worker.js'))
//   by remove-background-app.js — NO WorkerPool involvement — and terminated after
//   the response is received.  If the job times out, remove-background-app.js
//   calls worker.terminate() in _cleanup() BEFORE the timeout rejects.
//
// Algorithm: 12-pass K-means++ background clustering + BFS flood-fill + confidence
//   scoring + edge feathering + spill decontamination + ultra sharpening.
//   Exact replica of removeBg() + helpers from advanced-worker.js — self-contained.
//
// Protocol:
//   IN:  { op: 'remove-bg', pixels: ArrayBuffer, width: number, height: number,
//          threshold: number, qualityMode: string, subjectMode: string, jobId: string }
//   OUT: { pixels: ArrayBuffer, width: number, height: number, jobId: string }
//   ERR: { __error: string }

'use strict';

// ── Neighbor tables ───────────────────────────────────────────────────────────
// Pre-computed offsets for color-weighted edge feathering loop (P8)
var _FN = [
  [-1, -1, 0.5], [0, -1, 1.0], [1, -1, 0.5],
  [-1,  0, 1.0],                [1,  0, 1.0],
  [-1,  1, 0.5], [0,  1, 1.0], [1,  1, 0.5],
];
// 4-connected BFS neighbor offsets
var _BFS4X = [-1, 1, 0, 0];
var _BFS4Y = [0, 0, -1, 1];

// ── Auto-classify subject from pixel statistics ───────────────────────────────
function _bgClassify(d, width, height) {
  var S  = 56;
  var sX = width  / S;
  var sY = height / S;
  var skinPx = 0, brightPx = 0, lowSatPx = 0, vividPx = 0;
  var total  = S * S;

  for (var sy2 = 0; sy2 < S; sy2++) {
    for (var sx2 = 0; sx2 < S; sx2++) {
      var px  = Math.min(width  - 1, Math.floor(sx2 * sX));
      var py  = Math.min(height - 1, Math.floor(sy2 * sY));
      var idx = (py * width + px) * 4;
      var r2  = d[idx], g2 = d[idx + 1], b2 = d[idx + 2];
      var br  = (r2 + g2 + b2) / 3;
      var mx  = r2 > g2 ? (r2 > b2 ? r2 : b2) : (g2 > b2 ? g2 : b2);
      var mn  = r2 < g2 ? (r2 < b2 ? r2 : b2) : (g2 < b2 ? g2 : b2);
      var sat = mx > 0 ? (mx - mn) / mx : 0;

      if (br > 185) brightPx++;
      if (sat < 0.10) lowSatPx++;
      if (sat > 0.42 && mx > 75) vividPx++;
      if (r2 > 115 && r2 < 245 && g2 > 65 && g2 < 215 && b2 > 45 && b2 < 190
          && r2 > g2 + 8 && g2 > b2 && sat > 0.07) skinPx++;
    }
  }

  if (skinPx   / total > 0.08) return 'portrait';
  if (lowSatPx / total > 0.60 && brightPx / total < 0.40) return 'logo';
  if (vividPx  / total > 0.24 || brightPx / total > 0.54) return 'product';
  return 'auto';
}

// ── Stratified background sampling (border + inner border layer) ──────────────
function _bgSample(d, width, height) {
  var samples = [];
  var step    = Math.max(1, Math.floor((width * 2 + height * 2) / 900));

  for (var bx = 0; bx < width; bx += step) {
    var it = bx * 4;
    samples.push([d[it], d[it + 1], d[it + 2]]);
    var ib = ((height - 1) * width + bx) * 4;
    samples.push([d[ib], d[ib + 1], d[ib + 2]]);
  }
  for (var by = 0; by < height; by += step) {
    var il = by * width * 4;
    samples.push([d[il], d[il + 1], d[il + 2]]);
    var ir = (by * width + width - 1) * 4;
    samples.push([d[ir], d[ir + 1], d[ir + 2]]);
  }

  var iX = Math.max(1, Math.round(width  * 0.03));
  var iY = Math.max(1, Math.round(height * 0.03));
  var iS = Math.max(1, Math.floor((width + height) / 220));

  for (var ix = iX; ix < width  - iX; ix += iS) {
    var itT = (iY * width + ix) * 4;
    samples.push([d[itT], d[itT + 1], d[itT + 2]]);
    var itB = ((height - 1 - iY) * width + ix) * 4;
    samples.push([d[itB], d[itB + 1], d[itB + 2]]);
  }
  for (var iy = iY; iy < height - iY; iy += iS) {
    var itL = (iy * width + iX) * 4;
    samples.push([d[itL], d[itL + 1], d[itL + 2]]);
    var itR = (iy * width + (width - 1 - iX)) * 4;
    samples.push([d[itR], d[itR + 1], d[itR + 2]]);
  }

  return samples;
}

// ── K-means++ background clustering ──────────────────────────────────────────
function _bgKmeans(samples, K, iters) {
  var ns = samples.length;
  if (ns === 0) return [[128, 128, 128]];
  K = Math.min(K, ns);

  var cents = [samples[0].slice()];
  for (var ci = 1; ci < K; ci++) {
    var best = samples[0], bestD = 0;
    for (var si = 0; si < ns; si++) {
      var minD = Infinity;
      for (var cj = 0; cj < cents.length; cj++) {
        var dr = samples[si][0] - cents[cj][0];
        var dg = samples[si][1] - cents[cj][1];
        var db = samples[si][2] - cents[cj][2];
        var d2 = dr * dr + dg * dg + db * db;
        if (d2 < minD) minD = d2;
      }
      if (minD > bestD) { bestD = minD; best = samples[si]; }
    }
    cents.push(best.slice());
  }

  for (var it = 0; it < iters; it++) {
    var sums = [];
    for (var ki = 0; ki < K; ki++) sums.push([0, 0, 0, 0]);
    for (var pi = 0; pi < ns; pi++) {
      var s = samples[pi], minDi = Infinity, bk = 0;
      for (var ki2 = 0; ki2 < K; ki2++) {
        var drK = s[0] - cents[ki2][0];
        var dgK = s[1] - cents[ki2][1];
        var dbK = s[2] - cents[ki2][2];
        var d2K = drK * drK + dgK * dgK + dbK * dbK;
        if (d2K < minDi) { minDi = d2K; bk = ki2; }
      }
      sums[bk][0] += s[0]; sums[bk][1] += s[1]; sums[bk][2] += s[2]; sums[bk][3]++;
    }
    for (var ki3 = 0; ki3 < K; ki3++) {
      if (sums[ki3][3] > 0) {
        cents[ki3] = [
          sums[ki3][0] / sums[ki3][3],
          sums[ki3][1] / sums[ki3][3],
          sums[ki3][2] / sums[ki3][3],
        ];
      }
    }
  }
  return cents;
}

// ── Connected foreground region protection ────────────────────────────────────
function _protectFgRegions(alpha, n, width, height) {
  var THRESH  = 100;
  var minSize = Math.max(40, Math.round(n * 0.00008));
  var visited = new Uint8Array(n);
  var queue   = new Int32Array(n);

  for (var start = 0; start < n; start++) {
    if (visited[start] || alpha[start] < THRESH) continue;
    var region = [];
    var qH = 0, qT = 0;
    queue[qT++] = start;
    visited[start] = 1;
    while (qH < qT) {
      var idx = queue[qH++];
      region.push(idx);
      var x = idx % width, y = (idx / width) | 0;
      for (var dd = 0; dd < 4; dd++) {
        var nx = x + _BFS4X[dd], ny = y + _BFS4Y[dd];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        var ni = ny * width + nx;
        if (visited[ni] || alpha[ni] < THRESH) continue;
        visited[ni] = 1;
        queue[qT++] = ni;
      }
    }
    if (region.length >= minSize) {
      for (var ri = 0; ri < region.length; ri++) {
        if (alpha[region[ri]] < 160) alpha[region[ri]] = 160;
      }
    }
  }
}

// ── Main removeBg function ────────────────────────────────────────────────────
// Exact replica of removeBg() from advanced-worker.js — self-contained.
function removeBg(pixelsBuf, width, height, threshold, qualityMode, subjectMode) {
  var d = new Uint8ClampedArray(pixelsBuf);
  var n = width * height;
  qualityMode = qualityMode  || 'hd';
  subjectMode = subjectMode  || 'auto';

  var isFast  = (qualityMode === 'fast');
  var isUltra = (qualityMode === 'ultra');
  var isHd    = !isFast;
  var isHuge  = (n > 3000000);

  if (subjectMode === 'auto') subjectMode = _bgClassify(d, width, height);

  var centerWeight, satWeight, skinWeight, bfsLo, bfsHi, alphaLo, alphaHi, edgePow;
  if (subjectMode === 'portrait') {
    centerWeight = 0.48; satWeight = 0.32; skinWeight = 0.22;
    bfsLo = 0.12; bfsHi = 0.24; alphaLo = 0.18; alphaHi = 0.62; edgePow = 0.70;
  } else if (subjectMode === 'product') {
    centerWeight = 0.42; satWeight = 0.48; skinWeight = 0.10;
    bfsLo = 0.13; bfsHi = 0.26; alphaLo = 0.16; alphaHi = 0.58; edgePow = 0.55;
  } else if (subjectMode === 'logo') {
    centerWeight = 0.22; satWeight = 0.28; skinWeight = 0.05;
    bfsLo = 0.16; bfsHi = 0.28; alphaLo = 0.22; alphaHi = 0.68; edgePow = 0.40;
  } else {
    centerWeight = 0.40; satWeight = 0.42; skinWeight = 0.14;
    bfsLo = 0.13; bfsHi = 0.25; alphaLo = 0.18; alphaHi = 0.60; edgePow = 0.60;
  }

  var t      = Math.max(50, Math.min(255, threshold || 235));
  var tScale = 0.72 + (t - 50) / 205 * 0.58;
  bfsLo   = Math.max(0.04, bfsLo   * tScale);
  bfsHi   = Math.max(0.08, bfsHi   * tScale);
  alphaLo = Math.max(0.04, alphaLo * tScale);
  alphaHi = Math.min(0.96, alphaHi * tScale * 1.05);

  var bgSamples = _bgSample(d, width, height);
  var K         = isFast ? 4 : (isUltra ? 8 : 6);
  var centroids = _bgKmeans(bgSamples, K, isFast ? 6 : 10);
  bgSamples     = null;

  var bgSatSum = 0;
  for (var ksi = 0; ksi < K; ksi++) {
    var kcR = centroids[ksi][0], kcG = centroids[ksi][1], kcB = centroids[ksi][2];
    var kcMax = kcR > kcG ? (kcR > kcB ? kcR : kcB) : (kcG > kcB ? kcG : kcB);
    var kcMin = kcR < kcG ? (kcR < kcB ? kcR : kcB) : (kcG < kcB ? kcG : kcB);
    bgSatSum += kcMax > 0 ? (kcMax - kcMin) / kcMax : 0;
  }
  var bgSatAvg = bgSatSum / K;

  var bgDomR = 0, bgDomG = 0, bgDomB = 0;
  for (var kdi = 0; kdi < K; kdi++) {
    bgDomR += centroids[kdi][0]; bgDomG += centroids[kdi][1]; bgDomB += centroids[kdi][2];
  }
  bgDomR /= K; bgDomG /= K; bgDomB /= K;

  var confidence  = new Float32Array(n);
  var cxC         = width  / 2;
  var cyC         = height / 2;
  var maxR        = Math.sqrt(cxC * cxC + cyC * cyC);
  var invR        = maxR > 0 ? 1 / maxR : 0;
  var invColorMax = 1 / (Math.sqrt(3) * 255);

  for (var pi = 0; pi < n; pi++) {
    var ri0 = pi * 4;
    var pR  = d[ri0], pG = d[ri0 + 1], pB = d[ri0 + 2];
    var pX  = pi % width, pY = (pi / width) | 0;

    var minCD = Infinity;
    for (var kci = 0; kci < K; kci++) {
      var dR = pR - centroids[kci][0], dG2 = pG - centroids[kci][1], dB2 = pB - centroids[kci][2];
      var cd = dR * dR + dG2 * dG2 + dB2 * dB2;
      if (cd < minCD) minCD = cd;
    }
    var colorConf  = Math.min(1.0, Math.sqrt(minCD) * invColorMax * 2.4);
    var dx         = (pX - cxC) * invR, dy = (pY - cyC) * invR;
    var centerBoost = centerWeight * Math.exp(-(dx * dx + dy * dy) * 2.8);
    var pMax = pR > pG ? (pR > pB ? pR : pB) : (pG > pB ? pG : pB);
    var pMin = pR < pG ? (pR < pB ? pR : pB) : (pG < pB ? pG : pB);
    var pSat = pMax > 0 ? (pMax - pMin) / pMax : 0;
    var satExcess = pSat - bgSatAvg - 0.07;
    var satBoost  = satExcess > 0 ? Math.min(satWeight, satExcess * satWeight * 2.2) : 0;
    var skinBoost = 0;
    if (pR > 115 && pR < 245 && pG > 65 && pG < 215 && pB > 45 && pB < 190
        && pR > pG + 8 && pG > pB && pSat > 0.06 && pSat < 0.65) {
      skinBoost = skinWeight;
    }
    var vividBoost = (pSat > 0.38 && pMax > 70) ? 0.11 : 0;
    confidence[pi] = Math.min(1.0, Math.max(0.0, colorConf + centerBoost + satBoost + skinBoost + vividBoost));
  }

  var bgMask = new Uint8Array(n);
  var bfsQ   = new Int32Array(n);
  var bfsH   = 0, bfsT = 0;

  function _seed(idx) {
    if (!bgMask[idx] && confidence[idx] < bfsLo) {
      bgMask[idx] = 1; bfsQ[bfsT++] = idx;
    }
  }
  for (var bxs = 0; bxs < width;  bxs++) { _seed(bxs); _seed((height - 1) * width + bxs); }
  for (var bys = 0; bys < height; bys++) { _seed(bys * width); _seed(bys * width + width - 1); }

  while (bfsH < bfsT) {
    var qI = bfsQ[bfsH++];
    var qX = qI % width, qY = (qI / width) | 0;
    for (var d4 = 0; d4 < 4; d4++) {
      var nXb = qX + _BFS4X[d4], nYb = qY + _BFS4Y[d4];
      if (nXb < 0 || nXb >= width || nYb < 0 || nYb >= height) continue;
      var nIb = nYb * width + nXb;
      if (bgMask[nIb]) continue;
      if (confidence[nIb] < bfsHi) { bgMask[nIb] = 1; bfsQ[bfsT++] = nIb; }
    }
  }

  var alpha = new Uint8Array(n);
  for (var i6 = 0; i6 < n; i6++) {
    var c6 = confidence[i6];
    if (bgMask[i6]) {
      alpha[i6] = c6 > 0.55 ? Math.round((c6 - 0.55) / 0.45 * 180) : 0;
    } else if (c6 >= alphaHi) {
      alpha[i6] = 255;
    } else if (c6 <= alphaLo) {
      alpha[i6] = 0;
    } else {
      var ratio = (c6 - alphaLo) / (alphaHi - alphaLo);
      ratio     = ratio * ratio * (3 - 2 * ratio);
      ratio     = Math.pow(ratio, edgePow);
      alpha[i6] = Math.round(ratio * 255);
    }
  }
  confidence = null; bgMask = null;

  if (isHd && !isHuge) _protectFgRegions(alpha, n, width, height);

  var featherPasses = isFast ? 0 : (isUltra ? (isHuge ? 3 : 5) : (isHuge ? 2 : 3));
  for (var fp = 0; fp < featherPasses; fp++) {
    var alpha2 = new Uint8Array(alpha);
    for (var fy = 1; fy < height - 1; fy++) {
      for (var fx = 1; fx < width - 1; fx++) {
        var fi = fy * width + fx;
        var fa = alpha[fi];
        if (fa === 0 || fa === 255) continue;
        var cR2  = d[fi * 4], cG3 = d[fi * 4 + 1], cB3 = d[fi * 4 + 2];
        var wSum = 4.0, aSum = fa * 4.0;
        for (var ni2 = 0; ni2 < 8; ni2++) {
          var nfDx = _FN[ni2][0], nfDy = _FN[ni2][1], posW = _FN[ni2][2];
          var nf   = fi + nfDy * width + nfDx;
          var nR2  = d[nf * 4], nG2b = d[nf * 4 + 1], nB2b = d[nf * 4 + 2];
          var cdSq = (cR2 - nR2) * (cR2 - nR2) + (cG3 - nG2b) * (cG3 - nG2b) + (cB3 - nB2b) * (cB3 - nB2b);
          var cW   = posW * Math.exp(-cdSq / 2888);
          aSum += alpha[nf] * cW;
          wSum += cW;
        }
        alpha2[fi] = Math.min(255, Math.max(0, Math.round(aSum / wSum)));
      }
    }
    alpha = alpha2;
  }

  if (isHd) {
    for (var di2 = 0; di2 < n; di2++) {
      var da = alpha[di2];
      if (da === 0 || da === 255) continue;
      var riD = di2 * 4;
      var pRd = d[riD], pGd = d[riD + 1], pBd = d[riD + 2];
      var bdR = pRd - bgDomR, bdG = pGd - bgDomG, bdB = pBd - bgDomB;
      var bgDist = Math.sqrt(bdR * bdR + bdG * bdG + bdB * bdB);
      if (bgDist < 75) {
        var contamination = (1 - bgDist / 75);
        var transparency  = 1 - da / 255;
        var reduction     = Math.round(contamination * transparency * 55);
        alpha[di2] = Math.max(0, da - reduction);
      }
    }
  }

  if (isUltra) {
    var alpha3 = new Uint8Array(alpha);
    for (var sy = 1; sy < height - 1; sy++) {
      for (var sx = 1; sx < width - 1; sx++) {
        var si2 = sy * width + sx;
        var sa  = alpha[si2];
        if (sa < 8 || sa > 247) continue;
        var maxN = 0, minN = 255;
        for (var sdy = -1; sdy <= 1; sdy++) {
          for (var sdx = -1; sdx <= 1; sdx++) {
            if (sdx === 0 && sdy === 0) continue;
            var sn = alpha[si2 + sdy * width + sdx];
            if (sn > maxN) maxN = sn;
            if (sn < minN) minN = sn;
          }
        }
        if (sa > 128) {
          alpha3[si2] = Math.min(255, sa + Math.round((maxN - sa) * 0.38));
        } else {
          alpha3[si2] = Math.max(0,   sa - Math.round((sa - minN) * 0.38));
        }
      }
    }
    alpha = alpha3;
  }

  for (var ai = 0; ai < n; ai++) d[ai * 4 + 3] = alpha[ai];
  alpha = null;

  var fgPx = 0;
  for (var qi2 = 3; qi2 < n * 4; qi2 += 4) if (d[qi2] > 64) fgPx++;
  if (fgPx / n < 0.004) {
    throw new Error('No background detected. Try a different image or quality setting.');
  }

  return { pixels: d.buffer, width: width, height: height };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
self.onmessage = function (e) {
  var data = e.data || {};
  var op   = data.op;

  if (op !== 'remove-bg') {
    self.postMessage({ __error: 'remove-bg-worker: unknown op: ' + op });
    return;
  }
  if (!(data.pixels instanceof ArrayBuffer)) {
    self.postMessage({ __error: 'remove-bg-worker: pixels must be ArrayBuffer' });
    return;
  }
  if (!data.width || !data.height) {
    self.postMessage({ __error: 'remove-bg-worker: width and height are required' });
    return;
  }

  try {
    var result = removeBg(
      data.pixels,
      data.width,
      data.height,
      data.threshold,
      data.qualityMode,
      data.subjectMode
    );
    self.postMessage(
      { pixels: result.pixels, width: result.width, height: result.height, jobId: data.jobId || '' },
      [result.pixels]
    );
  } catch (err) {
    self.postMessage({ __error: err.message || String(err), jobId: data.jobId || '' });
  }
};
