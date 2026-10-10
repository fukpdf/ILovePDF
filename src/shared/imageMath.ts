export interface UniformTarget {
  newWidth: number;
  newHeight: number;
  effectiveDpi: number | null;
  resized: boolean;
  scale: number;
}

/** Compute effective resolution from the actual placed image box, not page dimensions. */
export function computeUniformTarget(
  width: number, height: number, placedWidthPt: number | null, placedHeightPt: number | null,
  floorDpi: number, targetDpi: number,
): UniformTarget {
  const unchanged = { newWidth: width, newHeight: height, effectiveDpi: null as number | null, resized: false, scale: 1 };
  if (![width,height,floorDpi,targetDpi].every(Number.isFinite) || width < 1 || height < 1 ||
      placedWidthPt === null || placedHeightPt === null || !Number.isFinite(placedWidthPt) ||
      !Number.isFinite(placedHeightPt) || placedWidthPt <= 0 || placedHeightPt <= 0) return unchanged;
  const widthIn = placedWidthPt / 72, heightIn = placedHeightPt / 72;
  const dpiX = width / widthIn, dpiY = height / heightIn;
  const effectiveDpi = Math.min(dpiX, dpiY);
  const safeTarget = Math.max(floorDpi, targetDpi);
  if (!Number.isFinite(effectiveDpi) || effectiveDpi <= safeTarget) return { ...unchanged, effectiveDpi };
  // One scalar is used for both axes: aspect ratio is not independently squashed.
  let scale = Math.min(1, safeTarget / effectiveDpi);
  const floorScale = Math.min(1, floorDpi / effectiveDpi);
  scale = Math.max(scale, floorScale);
  let newWidth = Math.max(1, Math.min(width, Math.round(width * scale)));
  let newHeight = Math.max(1, Math.min(height, Math.round(height * scale)));
  let finalDpi = Math.min(newWidth / widthIn, newHeight / heightIn);
  // Pixel rounding can lower a dimension by a fraction of a pixel; move both
  // dimensions together by one pixel's worth of scale rather than violate 150 DPI.
  for (let attempt = 0; finalDpi + 1e-6 < floorDpi && attempt < 3; attempt++) {
    scale = Math.min(1, scale + Math.max(1 / width, 1 / height));
    newWidth = Math.max(1, Math.min(width, Math.round(width * scale)));
    newHeight = Math.max(1, Math.min(height, Math.round(height * scale)));
    finalDpi = Math.min(newWidth / widthIn, newHeight / heightIn);
  }
  if (newWidth >= width && newHeight >= height || finalDpi + 1e-6 < floorDpi) return { ...unchanged, effectiveDpi };
  return { newWidth, newHeight, effectiveDpi, resized: true, scale: Math.min(newWidth / width, newHeight / height) };
}

/** Area-weighted box resampling for downscales; no upscaling and no nearest-neighbour sampling. */
export function boxResizeRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw < 1 || sh < 1 || dw < 1 || dh < 1 || src.length !== sw * sh * 4) throw new Error("Invalid RGBA resize dimensions.");
  if (dw > sw || dh > sh) throw new Error("Upscaling is not allowed.");
  if (dw === sw && dh === sh) return src.slice();
  const out = new Uint8Array(dw * dh * 4), sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      const sums = [0,0,0,0]; let weightSum = 0;
      for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
        const wy = Math.max(0, Math.min(y1, iy + 1) - Math.max(y0, iy));
        for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
          const wx = Math.max(0, Math.min(x1, ix + 1) - Math.max(x0, ix));
          const weight = wx * wy, pos = (iy * sw + ix) * 4;
          for (let c = 0; c < 4; c++) sums[c] += src[pos + c] * weight;
          weightSum += weight;
        }
      }
      const pos = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) out[pos + c] = Math.round(sums[c] / weightSum);
    }
  }
  return out;
}
