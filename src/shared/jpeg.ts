export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  precision: number;
  unsupportedSof: boolean;
  quantTables: number[][];
}

const SOF_MARKERS = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const BASE_LUMA = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
const BASE_CHROMA = [17,18,24,47,99,99,99,99,18,21,26,66,99,99,99,99,24,26,56,99,99,99,99,99,47,66,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99,99];

export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2, width = 0, height = 0, components = 0, precision = 0, sof = -1;
  const quantTables: number[][] = [];
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > bytes.length) return null;
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2 || i + len > bytes.length) return null;
    const start = i + 2, end = i + len;
    if (marker === 0xdb) {
      let p = start;
      while (p < end) {
        const info = bytes[p++], precisionBits = info >> 4, tableId = info & 0x0f;
        const count = precisionBits === 0 ? 64 : 128;
        if (p + count > end || tableId > 3) break;
        const vals: number[] = [];
        for (let n = 0; n < 64; n++) vals.push(precisionBits === 0 ? bytes[p + n] : ((bytes[p + n*2] << 8) | bytes[p + n*2+1]));
        quantTables[tableId] = vals;
        p += count;
      }
    } else if (SOF_MARKERS.has(marker)) {
      if (len < 8) return null;
      precision = bytes[start];
      height = (bytes[start + 1] << 8) | bytes[start + 2];
      width = (bytes[start + 3] << 8) | bytes[start + 4];
      components = bytes[start + 5];
      sof = marker;
    }
    i = end;
  }
  if (!width || !height || !components || sof < 0) return null;
  return { width, height, components, precision, unsupportedSof: sof !== 0xc0 && sof !== 0xc1 && sof !== 0xc2, quantTables };
}

/** Estimate the original JPEG quality from its quantisation tables; null means unknown. */
export function estimateJpegQuality(bytes: Uint8Array): number | null {
  const info = readJpegInfo(bytes);
  if (!info || !info.quantTables.length) return null;
  const ratios: number[] = [];
  for (let id = 0; id < info.quantTables.length; id++) {
    const table = info.quantTables[id];
    if (!table?.length) continue;
    const base = id === 0 ? BASE_LUMA : BASE_CHROMA;
    for (let i = 0; i < Math.min(64, table.length); i++) {
      if (base[i] > 0) ratios.push((table[i] / base[i]) * 100);
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a,b)=>a-b);
  const scale = ratios[Math.floor(ratios.length / 2)];
  const quality = scale <= 100 ? 5000 / Math.max(1, scale) : 200 - 2 * scale;
  return Math.max(1, Math.min(100, Math.round(quality)));
}
