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
  let componentQuantTableIds: number[] = [];
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
      if (len < 8 + components * 3) return null;
      componentQuantTableIds = Array.from({ length: components }, (_, n) => bytes[start + 8 + n * 3]);
      sof = marker;
    }
    i = end;
  }
  if (!width || !height || !components || sof < 0) return null;
  return { width, height, components, precision, unsupportedSof: sof !== 0xc0 && sof !== 0xc1 && sof !== 0xc2, quantTables, componentQuantTableIds };
}


const ZIGZAG = [
  0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,
  12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63,
];
function expectedQuantTable(base: number[], quality: number): number[] {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const natural = base.map(value => Math.max(1, Math.min(255, Math.floor((value * scale + 50) / 100))));
  return ZIGZAG.map(index => natural[index]);
}

/** Highest standard jpeg-js quality whose actual quantisers are no finer than the source. */
export function maxSafeJpegQuality(bytes: Uint8Array): number | null {
  const info = readJpegInfo(bytes);
  if (!info || info.components !== 3 || info.precision !== 8 || info.unsupportedSof ||
      info.componentQuantTableIds.length !== 3) return null;
  const sourceTables = info.componentQuantTableIds.map(id => info.quantTables[id]);
  if (sourceTables.some(table => !table || table.length < 64 || table.some(value => value > 255))) return null;
  for (let quality = 100; quality >= 1; quality--) {
    const outputTables = [expectedQuantTable(BASE_LUMA, quality), expectedQuantTable(BASE_CHROMA, quality)];
    let safe = true;
    for (let component = 0; component < 3 && safe; component++) {
      const outputTable = outputTables[component === 0 ? 0 : 1];
      const sourceTable = sourceTables[component]!;
      for (let i = 0; i < 64; i++) if (outputTable[i] < sourceTable[i]) { safe = false; break; }
    }
    if (safe) return quality;
  }
  return null;
}

/** Compare encoded quantisers directly; output coefficients may never be finer than source coefficients. */
export function jpegQuantizationNoFiner(sourceBytes: Uint8Array, outputBytes: Uint8Array): boolean {
  const source = readJpegInfo(sourceBytes), output = readJpegInfo(outputBytes);
  if (!source || !output || source.components !== 3 || output.components !== 3 ||
      source.precision !== 8 || output.precision !== 8 || source.unsupportedSof || output.unsupportedSof ||
      source.componentQuantTableIds.length !== 3 || output.componentQuantTableIds.length !== 3) return false;
  for (let component = 0; component < 3; component++) {
    const src = source.quantTables[source.componentQuantTableIds[component]];
    const out = output.quantTables[output.componentQuantTableIds[component]];
    if (!src || !out || src.length < 64 || out.length < 64) return false;
    for (let i = 0; i < 64; i++) if (out[i] < src[i]) return false;
  }
  return true;
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
    // JPEG DQT entries are stored in zig-zag order. Comparing sorted quantisers
    // avoids a false quality estimate caused by comparing zig-zag bytes to the
    // standard tables' natural order.
    const sortedTable = table.slice(0, 64).sort((a, b) => a - b);
    const sortedBase = base.slice().sort((a, b) => a - b);
    for (let i = 0; i < Math.min(sortedTable.length, sortedBase.length); i++) {
      if (sortedBase[i] > 0) ratios.push((sortedTable[i] / sortedBase[i]) * 100);
    }
  }
  if (!ratios.length) return null;
  ratios.sort((a,b)=>a-b);
  const scale = ratios[Math.floor(ratios.length / 2)];
  const quality = scale <= 100 ? 100 - scale / 2 : 5000 / Math.max(1, scale);
  return Math.max(1, Math.min(100, Math.round(quality)));
}
