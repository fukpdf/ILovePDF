export interface GraySample { w: number; h: number; px: Uint8Array; }
export interface GateSample { page: number; psnrDb: number; sharpnessRatio: number; }
export interface GateReport {
  passed: boolean; pagesIn: number; pagesOut: number; textCharsIn: number; textCharsOut: number;
  samples: GateSample[]; failures: string[]; notes: string[];
}
export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  const mse = sum / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}
export function sharpness(px: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3 || px.length !== w * h) return 0;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, lap = 4 * px[i] - px[i - 1] - px[i + 1] - px[i - w] - px[i + w];
    sum += lap; sum2 += lap * lap; n++;
  }
  return n ? Math.max(0, sum2 / n - (sum / n) ** 2) : 0;
}
export function pickSamplePages(total: number, max = 5): number[] {
  if (!Number.isInteger(total) || total < 1) return [];
  const count = Math.max(1, Math.min(total, Math.floor(max)));
  if (count === 1) return [1];
  const values = new Set<number>();
  for (let i = 0; i < count; i++) values.add(1 + Math.round(i * (total - 1) / (count - 1)));
  return [...values].sort((a, b) => a - b);
}
export function judgeSample(page: number, before: GraySample, after: GraySample, minPsnrDb: number, minSharpnessRatio: number, report: GateReport): void {
  if (before.w !== after.w || before.h !== after.h || before.px.length !== after.px.length) {
    report.failures.push(`page ${page}: render has different size`); return;
  }
  const p = psnr(before.px, after.px);
  const sa = sharpness(before.px, before.w, before.h), sb = sharpness(after.px, after.w, after.h);
  const ratio = sa <= 1e-9 ? (sb <= 1e-9 ? 1 : 0) : sb / sa;
  report.samples.push({ page, psnrDb: Number(p.toFixed(2)), sharpnessRatio: Number(ratio.toFixed(3)) });
  if (p < minPsnrDb) report.failures.push(`page ${page}: PSNR ${p.toFixed(2)} dB is below ${minPsnrDb} dB`);
  if (ratio < minSharpnessRatio) report.failures.push(`page ${page}: output is blurrier (sharpness ratio ${ratio.toFixed(3)} < ${minSharpnessRatio})`);
}
export function textCheck(before: number, after: number, failures: string[], notes: string[]): void {
  if (before < 20) { notes.push("Text sample is too small for a meaningful character-retention ratio; visual and structural checks remain required."); return; }
  const ratio = after / before;
  if (ratio < 0.98) failures.push(`Extracted text retention is ${(ratio * 100).toFixed(2)}%, below 98%.`);
}
