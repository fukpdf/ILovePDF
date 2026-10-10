import * as jpeg from "jpeg-js";
import { Buffer } from "buffer";
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream,
} from "pdf-lib";
import { LIMITS, MODE_POLICY, type Mode } from "../shared/policy";
import { containsAscii, endsWithPdfEof, latin1, startsWithPdf } from "../shared/bytes";
import { jpegQuantizationNoFiner, maxSafeJpegQuality, readJpegInfo } from "../shared/jpeg";
import { boxResizeRGBA, computeUniformTarget } from "../shared/imageMath";
import { parsePlacements } from "../shared/placements";

const globals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
globals.Buffer ??= Buffer;

export interface BrowserOptions {
  mode: Mode;
  targetKB?: number;
  onProgress?: (percent: number, stage: string) => void;
  signal?: AbortSignal;
}
export interface ImageReport {
  ref: string; width: number; height: number; newWidth?: number; newHeight?: number;
  effectiveDpi: number | null; bytesBefore: number; bytesAfter: number;
  action: "recompressed" | "skipped" | "deduplicated"; reason?: string;
}
export interface BrowserResult {
  ok: boolean; bytes: Uint8Array; inputBytes: number; outputBytes: number; savedPercent: number;
  keptOriginal: boolean; needsDeep: boolean; deepReason?: string; targetReached?: boolean;
  passes: number; images: ImageReport[]; warnings: string[]; errors: string[];
}
const fail = (input: Uint8Array, msg: string, needsDeep = false, deepReason?: string): BrowserResult => ({
  ok: false, bytes: input.slice(), inputBytes: input.length, outputBytes: input.length, savedPercent: 0,
  keptOriginal: true, needsDeep, deepReason, passes: 0, images: [], warnings: [], errors: [msg],
});
const noChange = (input: Uint8Array, mode: Mode, msg: string, needsDeep = false, deepReason?: string): BrowserResult => ({
  ok: true, bytes: input.slice(), inputBytes: input.length, outputBytes: input.length, savedPercent: 0,
  keptOriginal: true, needsDeep, deepReason, targetReached: mode === "custom" ? undefined : undefined,
  passes: 0, images: [], warnings: [msg], errors: [],
});

function fnv(bytes: Uint8Array | string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= typeof bytes === "string" ? bytes.charCodeAt(i) & 0xff : bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const num = (o: unknown): number => o instanceof PDFNumber ? o.asNumber() : 0;
const isImage = (s: PDFRawStream) => s.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image");

function pageContentStreams(doc: PDFDocument, pageIndex: number): Uint8Array[] {
  const contents = doc.getPages()[pageIndex].node.Contents();
  const refs: unknown[] = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, i) => contents.get(i))
    : contents ? [contents] : [];
  return refs.map((item) => {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (!(stream instanceof PDFRawStream)) throw new Error(`Page ${pageIndex + 1} has an unreadable content stream.`);
    return decodePDFRawStream(stream).decode();
  });
}
async function digest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable; refusing to certify the PDF.");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
async function pageContentHashes(doc: PDFDocument): Promise<string[][]> {
  const pages: string[][] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const streams = pageContentStreams(doc, i), hashes: string[] = [];
    for (const stream of streams) hashes.push(await digest(stream));
    pages.push(hashes);
  }
  return pages;
}
function assertHashesEqual(before: string[][], after: string[][]): void {
  if (before.length !== after.length) throw new Error("Page count changed.");
  for (let i = 0; i < before.length; i++) {
    if (before[i].length !== after[i].length || before[i].some((h, j) => h !== after[i][j])) {
      throw new Error(`Decoded page content stream SHA-256 mismatch on page ${i + 1}.`);
    }
  }
}
function decodedPageContentText(doc: PDFDocument, pageIndex: number): string {
  return pageContentStreams(doc, pageIndex).map(bytes => latin1(bytes)).join("\n");
}

/** Record the largest physical placement on each axis so every placement stays above the DPI floor. */
function collectPlacements(doc: PDFDocument): Map<string, { wPt: number; hPt: number }> {
  const result = new Map<string, { wPt: number; hPt: number }>();
  for (let p = 0; p < doc.getPages().length; p++) {
    const xObjects = doc.getPages()[p].node.Resources()?.lookup(PDFName.of("XObject"));
    if (!(xObjects instanceof PDFDict)) continue;
    const nameToRef = new Map<string, PDFRef>();
    for (const [key, value] of xObjects.entries()) if (value instanceof PDFRef) nameToRef.set(key.decodeText(), value);
    for (const placement of parsePlacements(decodedPageContentText(doc, p))) {
      const ref = nameToRef.get(placement.name);
      if (!ref) continue;
      const prev = result.get(ref.tag);
      result.set(ref.tag, {
        wPt: Math.max(prev?.wPt ?? 0, placement.widthPt),
        hPt: Math.max(prev?.hPt ?? 0, placement.heightPt),
      });
    }
  }
  return result;
}
function walkRefs(obj: unknown, into: Set<string>, depth = 0): void {
  if (depth > 40 || !obj) return;
  if (obj instanceof PDFRef) { into.add(obj.tag); return; }
  if (obj instanceof PDFArray) { for (let i = 0; i < obj.size(); i++) walkRefs(obj.get(i), into, depth + 1); return; }
  const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : undefined;
  if (dict) for (const [, value] of dict.entries()) walkRefs(value, into, depth + 1);
}
function referencedTags(doc: PDFDocument): Set<string> {
  const tags = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) walkRefs(obj, tags);
  walkRefs(doc.context.trailerInfo.Root, tags);
  walkRefs(doc.context.trailerInfo.Info, tags);
  return tags;
}
function dedupeImages(doc: PDFDocument, report: ImageReport[]): { aliases: Map<string, string>; removed: Set<string> } {
  const canonical = new Map<string, { ref: PDFRef; bytes: Uint8Array }>();
  const replaced: Array<{ ref: PDFRef; canonicalRef: PDFRef }> = [];
  const aliases = new Map<string, string>(), removed = new Set<string>();
  for (const page of doc.getPages()) {
    const xObjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
    if (!(xObjects instanceof PDFDict)) continue;
    for (const [key, value] of xObjects.entries()) {
      if (!(value instanceof PDFRef)) continue;
      const stream = doc.context.lookup(value);
      if (!(stream instanceof PDFRawStream) || !isImage(stream)) continue;
      const dict = stream.dict, bytes = stream.contents;
      const dictionarySignature = dict.entries()
        .map(([dictKey, value]) => [dictKey.toString(), value.toString()] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([dictKey, value]) => `${dictKey}:${value}`).join("|");
      const signature = [dictionarySignature, bytes.length, fnv(bytes)].join("|");
      const hit = canonical.get(signature);
      if (hit && hit.ref.tag !== value.tag && sameBytes(hit.bytes, bytes)) {
        xObjects.set(key, hit.ref);
        replaced.push({ ref: value, canonicalRef: hit.ref });
        aliases.set(value.tag, hit.ref.tag);
        report.push({
          ref: value.tag, width: num(dict.lookup(PDFName.of("Width"))), height: num(dict.lookup(PDFName.of("Height"))),
          effectiveDpi: null, bytesBefore: bytes.length, bytesAfter: 0, action: "deduplicated",
          reason: `complete image dictionary and bytes match; reference redirected to ${hit.ref.tag}`,
        });
      } else if (!hit) canonical.set(signature, { ref: value, bytes });
    }
  }
  if (!replaced.length) return { aliases, removed };
  const stillReferenced = referencedTags(doc);
  for (const entry of replaced) {
    if (!stillReferenced.has(entry.ref.tag)) {
      doc.context.delete(entry.ref);
      removed.add(entry.ref.tag);
    }
  }
  return { aliases, removed };
}

function colorSpaceIsRgb(dict: PDFDict): boolean {
  // ICCBased profiles are skipped unless their RGB identity can be proven. DeviceRGB is unambiguous.
  return dict.lookup(PDFName.of("ColorSpace")) === PDFName.of("DeviceRGB");
}
async function runPass(input: Uint8Array, mode: Mode, quality: number, images: ImageReport[], signal?: AbortSignal): Promise<{ bytes: Uint8Array; aliases: Map<string, string>; removed: Set<string> }> {
  const policy = MODE_POLICY[mode];
  const doc = await PDFDocument.load(input);
  const dedupes = dedupeImages(doc, images);
  const placements = collectPlacements(doc);

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (signal?.aborted) throw new Error("CANCELLED");
    if (dedupes.aliases.has(ref.tag)) continue; // retained duplicate is still referenced elsewhere; keep its stream byte-identical.
    if (!(object instanceof PDFRawStream) || !isImage(object)) continue;
    const dict = object.dict, width = num(dict.lookup(PDFName.of("Width"))), height = num(dict.lookup(PDFName.of("Height")));
    const bytes = object.contents;
    const rep: ImageReport = { ref: ref.tag, width, height, effectiveDpi: null, bytesBefore: bytes.length, bytesAfter: bytes.length, action: "skipped" };
    const skip = (reason: string) => { rep.reason = reason; images.push(rep); };
    if (dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask")) || dict.has(PDFName.of("ImageMask"))) { skip("transparency / image mask must remain byte-identical"); continue; }
    if (dict.has(PDFName.of("Decode"))) { skip("custom /Decode array must remain byte-identical"); continue; }
    if (dict.lookup(PDFName.of("Filter")) !== PDFName.of("DCTDecode")) { skip("not a direct DCT JPEG; gray, CMYK, Indexed, Flate, CCITT and JBIG2 streams remain untouched"); continue; }
    if (mode === "lossless") { skip("lossless mode"); continue; }
    if (bytes.length < LIMITS.minImageBytesToTouch) { skip("already small"); continue; }
    if (!colorSpaceIsRgb(dict)) { skip("ColorSpace is not unambiguous DeviceRGB"); continue; }
    const info = readJpegInfo(bytes);
    if (!info || info.components !== 3 || info.precision !== 8 || info.unsupportedSof) { skip("unsupported JPEG variant"); continue; }
    if (info.width !== width || info.height !== height) { skip("JPEG dimensions disagree with the PDF image dictionary"); continue; }
    const placement = placements.get(ref.tag);
    if (!placement) { skip("image has no measurable page placement; preserved without re-encoding"); continue; }
    const target = computeUniformTarget(width, height, placement.wPt, placement.hPt, policy.floorDpi, policy.targetDpi);
    rep.effectiveDpi = target.effectiveDpi;
    if (target.effectiveDpi !== null && target.effectiveDpi < policy.floorDpi) {
      skip(`placed DPI ${target.effectiveDpi.toFixed(1)} is already below the ${policy.floorDpi} DPI floor; no upscaling or further image loss permitted`);
      continue;
    }
    const sourceQuality = maxSafeJpegQuality(bytes);
    if (sourceQuality === null) { skip("source JPEG quantization tables cannot establish a safe re-encode quality"); continue; }
    if (!target.resized && sourceQuality <= quality + 2) { skip(`source JPEG quality ~${sourceQuality} is already at/below target`); continue; }
    // Never request a higher encoder quality than the source JPEG.
    const outputQuality = Math.max(1, Math.min(95, quality, sourceQuality));
    try {
      const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) { skip("JPEG decoder dimensions did not match the source"); continue; }
      const resized = boxResizeRGBA(decoded.data as Uint8Array, decoded.width, decoded.height, target.newWidth, target.newHeight);
      const encoded = new Uint8Array(jpeg.encode({ data: Buffer.from(resized), width: target.newWidth, height: target.newHeight }, outputQuality).data);
      if (!jpegQuantizationNoFiner(bytes, encoded)) { skip("output JPEG quantization would be finer than the source; original stream preserved"); continue; }
      if (encoded.length >= bytes.length * (1 - LIMITS.minImageSavingRatio)) { skip("re-encode did not meet the minimum saving threshold"); continue; }
      dict.set(PDFName.of("Width"), PDFNumber.of(target.newWidth));
      dict.set(PDFName.of("Height"), PDFNumber.of(target.newHeight));
      dict.set(PDFName.of("Length"), PDFNumber.of(encoded.length));
      doc.context.assign(ref, PDFRawStream.of(dict, encoded));
      rep.action = "recompressed"; rep.newWidth = target.newWidth; rep.newHeight = target.newHeight; rep.bytesAfter = encoded.length;
      images.push(rep);
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") throw error;
      skip("JPEG decode/encode failed; source stream retained");
    }
  }
  return { bytes: new Uint8Array(await doc.save({ useObjectStreams: false, addDefaultPage: false, updateMetadata: false, updateFieldAppearances: false })), aliases: dedupes.aliases, removed: dedupes.removed };
}

function hasIndirectDictionaryKey(doc: PDFDocument, key: string): boolean {
  const name = PDFName.of(key);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object instanceof PDFRawStream ? object.dict : undefined;
    if (dict?.has(name)) return true;
  }
  const root = doc.context.trailerInfo.Root;
  const rootObject = root instanceof PDFRef ? doc.context.lookup(root) : root;
  if (rootObject instanceof PDFDict && rootObject.has(name)) return true;
  return false;
}
function eligibleImageStream(stream: PDFRawStream): boolean {
  const dict = stream.dict;
  return isImage(stream) &&
    dict.lookup(PDFName.of("Filter")) === PDFName.of("DCTDecode") &&
    colorSpaceIsRgb(dict) &&
    !dict.has(PDFName.of("SMask")) && !dict.has(PDFName.of("Mask")) &&
    !dict.has(PDFName.of("Decode")) && !dict.has(PDFName.of("ImageMask"));
}
function dictFingerprint(dict: PDFDict, stripImageDimensions = false): string {
  const ignored = stripImageDimensions ? new Set(["/Width", "/Height", "/Length"]) : new Set<string>();
  const entries = dict.entries()
    .filter(([key]) => !ignored.has(key.toString()))
    .map(([key, value]) => [key.toString(), value.toString()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}
function samePdfObject(a: unknown, b: unknown, aliases: Map<string, string>): boolean {
  if (a instanceof PDFRef || b instanceof PDFRef) {
    return a instanceof PDFRef && b instanceof PDFRef && (aliases.get(a.tag) ?? a.tag) === b.tag;
  }
  if (a instanceof PDFRawStream || b instanceof PDFRawStream) {
    if (!(a instanceof PDFRawStream) || !(b instanceof PDFRawStream)) return false;
    if (eligibleImageStream(a) && eligibleImageStream(b)) return dictFingerprint(a.dict, true) === dictFingerprint(b.dict, true);
    return samePdfObject(a.dict, b.dict, aliases) && sameBytes(a.contents, b.contents);
  }
  if (a instanceof PDFDict || b instanceof PDFDict) {
    if (!(a instanceof PDFDict) || !(b instanceof PDFDict)) return false;
    const left = new Map(a.entries().map(([key, value]) => [key.toString(), value]));
    const right = new Map(b.entries().map(([key, value]) => [key.toString(), value]));
    if (left.size !== right.size) return false;
    for (const [key, value] of left) if (!right.has(key) || !samePdfObject(value, right.get(key), aliases)) return false;
    return true;
  }
  if (a instanceof PDFArray || b instanceof PDFArray) {
    if (!(a instanceof PDFArray) || !(b instanceof PDFArray) || a.size() !== b.size()) return false;
    for (let i = 0; i < a.size(); i++) if (!samePdfObject(a.get(i), b.get(i), aliases)) return false;
    return true;
  }
  if (a == null || b == null) return a === b;
  return (a as { constructor?: unknown }).constructor === (b as { constructor?: unknown }).constructor &&
    String(a) === String(b);
}
function assertObjectGraphPreserved(
  before: PDFDocument, after: PDFDocument, aliases: Map<string, string> = new Map(), removed: Set<string> = new Set(),
): void {
  const left = new Map(before.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.tag, obj]));
  const right = new Map(after.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.tag, obj]));
  const leftKeys = [...left.keys()].sort(), rightKeys = [...right.keys()].sort();
  const expectedKeys = leftKeys.filter(key => !removed.has(key));
  if (JSON.stringify(expectedKeys) !== JSON.stringify(rightKeys)) throw new Error("Indirect PDF object set changed beyond safe image deduplication.");
  for (const [duplicateTag, canonicalTag] of aliases) {
    const duplicate = left.get(duplicateTag), canonical = left.get(canonicalTag), canonicalAfter = right.get(canonicalTag);
    if (!(duplicate instanceof PDFRawStream) || !(canonical instanceof PDFRawStream) || !(canonicalAfter instanceof PDFRawStream) ||
        !isImage(duplicate) || !isImage(canonical) ||
        dictFingerprint(duplicate.dict) !== dictFingerprint(canonical.dict) ||
        !sameBytes(duplicate.contents, canonical.contents)) {
      throw new Error("Image deduplication attempted without an exact complete-dictionary and byte match.");
    }
  }
  for (const key of rightKeys) {
    const a = left.get(key), b = right.get(key);
    if (a === undefined || b === undefined) throw new Error(`Protected PDF object disappeared for ${key}.`);
    if (aliases.has(key)) {
      if (!(a instanceof PDFRawStream) || !(b instanceof PDFRawStream) ||
          dictFingerprint(a.dict) !== dictFingerprint(b.dict) || !sameBytes(a.contents, b.contents)) {
        throw new Error(`Referenced duplicate image object changed for ${key}.`);
      }
      continue;
    }
    if (!samePdfObject(a, b, aliases)) throw new Error(`Protected PDF object or stream changed for ${key}.`);
  }
  if (!samePdfObject(before.context.trailerInfo.Root, after.context.trailerInfo.Root, aliases) ||
      !samePdfObject(before.context.trailerInfo.Info, after.context.trailerInfo.Info, aliases)) {
    throw new Error("PDF trailer references changed.");
  }
}

async function validate(input: Uint8Array, output: Uint8Array, aliases: Map<string, string>, removed: Set<string>): Promise<string[]> {
  const errors: string[] = [];
  try {
    if (!startsWithPdf(output) || !endsWithPdfEof(output)) errors.push("output PDF header or EOF marker is invalid");
    const before = await PDFDocument.load(input);
    const after = await PDFDocument.load(output);
    if (before.getPageCount() !== after.getPageCount()) errors.push("page count changed");
    if (before.getPageCount() > LIMITS.maxPages) errors.push("page count exceeds supported limit");
    try { assertObjectGraphPreserved(before, after, aliases, removed); } catch (e) { errors.push(e instanceof Error ? e.message : "PDF object graph changed"); }
    const hashesBefore = await pageContentHashes(before);
    const hashesAfter = await pageContentHashes(after);
    try { assertHashesEqual(hashesBefore, hashesAfter); } catch (e) { errors.push(e instanceof Error ? e.message : "decoded content hash mismatch"); }
    for (let i = 0; i < Math.min(before.getPageCount(), after.getPageCount()); i++) {
      const a = before.getPage(i), b = after.getPage(i), sa = a.getSize(), sb = b.getSize();
      if (Math.abs(sa.width - sb.width) > 0.01 || Math.abs(sa.height - sb.height) > 0.01 || a.getRotation().angle !== b.getRotation().angle) errors.push(`page ${i + 1} geometry changed`);
      if ((a.node.Annots()?.size() ?? 0) !== (b.node.Annots()?.size() ?? 0)) errors.push(`page ${i + 1} annotation count changed`);
    }
    let fieldsBefore = 0, fieldsAfter = 0;
    try { fieldsBefore = before.getForm().getFields().length; } catch {}
    try { fieldsAfter = after.getForm().getFields().length; } catch {}
    if (fieldsBefore !== fieldsAfter) errors.push("form field count changed");
  } catch (e) {
    errors.push(`output failed PDF parse / hash validation: ${e instanceof Error ? e.message : "unknown"}`);
  }
  return errors;
}

export async function compressInBrowser(rawInput: Uint8Array, opts: BrowserOptions): Promise<BrowserResult> {
  const input = rawInput.slice(), { mode, onProgress, signal } = opts;
  if (!input.length) return fail(input, "The file is empty.");
  if (input.length > LIMITS.maxFileBytes) return fail(input, "File exceeds the 100 MB browser processing limit.", true, "file exceeds the light-engine memory limit");
  if (!startsWithPdf(input) || !endsWithPdfEof(input)) return fail(input, "Not a complete PDF (missing %PDF- header or %%EOF marker).");
  if (containsAscii(input, "/ByteRange") || containsAscii(input, "/SigFlags")) return noChange(input, mode, "Signed PDF detected; it was not modified.");
  if (containsAscii(input, "/Encrypt")) return noChange(input, mode, "Encrypted PDF detected; it was not modified.");
  if (containsAscii(input, "/XFA")) return noChange(input, mode, "XFA PDF detected; it was not modified.");
  if (containsAscii(input, "/AcroForm")) return noChange(input, mode, "AcroForm detected; routing to the lossless QPDF-only path.", true, "interactive form requires the lossless QPDF route");
  if (input.length > LIMITS.browserComfortBytes) return noChange(input, mode, "Light engine skipped due to memory safety; attempting the bounded deep route.", true, "file exceeds the light-engine memory budget");
  if (mode === "custom" && !(typeof opts.targetKB === "number" && Number.isFinite(opts.targetKB) && opts.targetKB > 0)) return fail(input, "Custom mode needs a target size greater than 0 KB.");
  let parsed: PDFDocument;
  try { parsed = await PDFDocument.load(input); }
  catch (e) { return noChange(input, mode, `PDF parser rejected the file; original preserved (${e instanceof Error ? e.message : "unknown reason"}).`); }
  if (hasIndirectDictionaryKey(parsed, "ByteRange") || hasIndirectDictionaryKey(parsed, "SigFlags") || hasIndirectDictionaryKey(parsed, "Perms")) {
    return noChange(input, mode, "Signature or permission-controlled PDF detected after parsing; original preserved.");
  }
  if (hasIndirectDictionaryKey(parsed, "XFA")) return noChange(input, mode, "XFA PDF detected after parsing; original preserved.");
  if (hasIndirectDictionaryKey(parsed, "AcroForm")) return noChange(input, mode, "AcroForm detected after parsing; routing to lossless QPDF-only compression.", true, "interactive form requires the lossless QPDF route");

  const targetBytes = mode === "custom" ? Math.round(opts.targetKB! * 1024) : undefined;
  const ladder: readonly number[] = [MODE_POLICY[mode].jpegQuality];
  let best = input, bestImages: ImageReport[] = [], passes = 0, validationErrors: string[] = [];
  for (const quality of ladder.slice(0, 4)) {
    if (signal?.aborted) return fail(input, "Cancelled.");
    passes++;
    onProgress?.(15 + Math.round((passes / Math.min(ladder.length, 4)) * 65), `Image compression pass ${passes}/${Math.min(ladder.length, 4)} (quality ${quality})`);
    const images: ImageReport[] = [];
    const pass = await runPass(input, mode, quality, images, signal); // every target pass starts from ORIGINAL
    const output = pass.bytes;
    const errors = await validate(input, output, pass.aliases, pass.removed);
    if (errors.length) { validationErrors = errors; break; }
    if (output.length < best.length) { best = output; bestImages = images; }
    if (!targetBytes || best.length <= targetBytes) break;
  }
  onProgress?.(95, "Verifying PDF integrity");
  const keptOriginal = validationErrors.length > 0 || best.length >= input.length;
  const bytes = keptOriginal ? input : best;
  const warnings: string[] = [];
  if (validationErrors.length) warnings.push(`Safety gate failed; original kept: ${validationErrors.join("; ")}`);
  else if (best.length >= input.length) warnings.push("The candidate was not smaller; original kept.");
  const skippedUnhandled = bestImages.filter(image => image.action === "skipped" && /Flate|CCITT|JBIG2|not a direct DCT|ColorSpace/.test(image.reason ?? "")).length;
  const savedPercent = Number((((input.length - bytes.length) / input.length) * 100).toFixed(2));
  const targetReached = targetBytes === undefined ? undefined : bytes.length <= targetBytes;
  let needsDeep = false, deepReason: string | undefined;
  if (input.length > LIMITS.browserComfortBytes) { needsDeep = true; deepReason = "large file: the deep engine may use a safer route"; }
  else if (targetReached === false) { needsDeep = true; deepReason = "custom target was not reached by the light engine"; }
  else if (mode !== "lossless" && savedPercent < 10 && skippedUnhandled > 0) { needsDeep = true; deepReason = `${skippedUnhandled} image(s) use formats the light engine intentionally leaves untouched`; }
  onProgress?.(100, "Light compression complete");
  return { ok: true, bytes: bytes.slice(), inputBytes: input.length, outputBytes: bytes.length, savedPercent, keptOriginal,
    needsDeep, deepReason, targetReached, passes, images: bestImages, warnings, errors: [] };
}
