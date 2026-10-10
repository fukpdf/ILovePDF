export interface UniformTarget {
  newWidth: number;
  newHeight: number;
  effectiveDpi: number | null;
  resized: boolean;
  scale: number;
}

/** Determine resolution from the image's real placed width and height, never the page size. */
export function computeUniformTarget(
  width: number,
  height: number,
  placedWidthPt: number | null,
  placedHeightPt: number | null,
  floorDpi: number,
  targetDpi: number,
): UniformTarget {
  const unchanged = { newWidth: width, newHeight: height, effectiveDpi: null as number | null, resized: false, scale: 1 };
  if (![width,height,floorDpi,targetDpi].every(Number.isFinite) || width < 1 || height < 1 ||
      placedWidthPt === null || placedHeightPt === null ||
      !Number.isFinite(placedWidthPt) || !Number.isFinite(placedHeightPt) ||
      placedWidthPt <= 0 || placedHeightPt <= 0) return unchanged;
  const widthIn = placedWidthPt / 72;
  const heightIn = placedHeightPt / 72;
  const dpiX = width / widthIn;
  const dpiY = height / heightIn;
  const effectiveDpi = Math.min(dpiX, dpiY);
  const safeTarget = Math.max(floorDpi, targetDpi);
  if (!Number.isFinite(effectiveDpi) || effectiveDpi <= safeTarget) return { ...unchanged, effectiveDpi };
  const scale = Math.min(1, safeTarget / effectiveDpi);
  const floorScale = Math.max(floorDpi / dpiX, floorDpi / dpiY);
  const safeScale = Math.min(1, Math.max(scale, floorScale));
  const newWidth = Math.max(1, Math.min(width, Math.floor(width * safeScale)));
  const newHeight = Math.max(1, Math.min(height, Math.floor(height * safeScale)));
  // Rounding must not cross the minimum DPI floor on either axis.
  const finalScale = Math.min(newWidth / width, newHeight / height);
  if (finalScale <= 0 || newWidth >= width && newHeight >= height) return { ...unchanged, effectiveDpi };
  const finalDpi = Math.min(newWidth / widthIn, newHeight / heightIn);
  if (finalDpi + 0.01 < floorDpi) return { ...unchanged, effectiveDpi };
  return { newWidth, newHeight, effectiveDpi, resized: true, scale: finalScale };
}

/** Area-weighted box resampling for downscales. Alpha is averaged with colour to avoid halos. */
export function boxResizeRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw < 1 || sh < 1 || dw < 1 || dh < 1 || src.length !== sw * sh * 4) throw new Error("Invalid RGBA resize dimensions.");
  if (dw > sw || dh > sh) throw new Error("Upscaling is not allowed.");
  if (dw === sw && dh === sh) return src.slice();
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      const sums = [0,0,0,0]; let weightSum = 0;
      for (let iy = Math.floor(y0); iy < Math.ceil(y1); iy++) {
        const wy = Math.max(0, Math.min(y1, iy + 1) - Math.max(y0, iy));
        for (let ix = Math.floor(x0); ix < Math.ceil(x1); ix++) {
          const wx = Math.max(0, Math.min(x1, ix + 1) - Math.max(x0, ix));
          const weight = wx * wy, p = (iy * sw + ix) * 4;
          for (let c = 0; c < 4; c++) sums[c] += src[p+c] * weight;
          weightSum += weight;
        }
      }
      const p = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) out[p+c] = Math.round(sums[c] / weightSum);
    }
  }
  return out;
}
