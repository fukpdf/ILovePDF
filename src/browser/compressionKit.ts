import { compressInBrowser, type BrowserResult, type ImageReport } from "./browserCompressor";
import { compressDeep, wasmMemoryAllowed, type DeepResult } from "./deepEngine";
import { DEFAULT_WASM_LOCATE, loadWasmTool, runJsonTool, runTool, type EmModule, type WasmLocate, type WasmTools } from "./wasmCli";
import {
  assertCompressionEligible,
  assertDocumentStructureUnchanged,
  assertPageContentStreamsUnchanged,
  assertProtectedStreamsUnchanged,
  assertRgbImageStreamsUnchanged,
  assertRgbImageQuantizationNotFiner,
  hashPageContentStreams,
  hashProtectedStreams,
  selectPageContentObjects,
  selectProtectedStreamObjects,
  selectEligibleRgbImageObjects,
  snapshotEligibleRgbImageStreams,
  type EligibleRgbImageSnapshot,
  qpdfCatalogHasKey,
} from "./pdfContentIntegrity";
import { startsWithPdf, endsWithPdfEof } from "../shared/bytes";
import type { GateReport } from "../shared/quality";
import { LIMITS, MODE_POLICY, type Mode } from "../shared/policy";
import { decideCompressionRoute } from "../router/smartRouter";

export type CompressionMode = "deep" | "custom";
export type CompressionStage = "loading-engine" | "structural-pass" | "validating" | "complete";

export interface CompressionKitOptions {
  mode: CompressionMode;
  targetBytes?: number | null;
  qpdfWasmUrl?: string;
  ghostscriptWasmUrl?: string;
  onProgress?: (stage: CompressionStage, message: string, percent?: number) => void;
  signal?: AbortSignal;
}

export interface CompressionKitReport {
  mode: CompressionMode;
  method: "qpdf-lossless-structure" | "browser-rgb-image" | "ghostscript-quality-gated" | "original-preserved";
  originalBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  targetBytes: number | null;
  targetReached: boolean | null;
  contentStreamsVerified: boolean;
  message: string;
  engine?: "light" | "qpdf" | "ghostscript" | "original";
  warnings?: string[];
  images?: ImageReport[];
  qualityGate?: GateReport;
}

export interface CompressionKitResult {
  bytes: Uint8Array;
  report: CompressionKitReport;
}

function resultForOriginal(
  original: Uint8Array, mode: CompressionMode, targetBytes: number | null, message: string,
  warnings: string[] = [], contentStreamsVerified = false, images: ImageReport[] = [],
): CompressionKitResult {
  return {
    bytes: original.byteOffset === 0 && original.byteLength === original.buffer.byteLength ? original : original.slice(),
    report: {
      mode, method: "original-preserved", originalBytes: original.byteLength, outputBytes: original.byteLength,
      savedBytes: 0, savedPercent: 0, targetBytes,
      targetReached: targetBytes === null ? null : original.byteLength <= targetBytes,
      contentStreamsVerified, message, engine: "original", warnings: [...warnings], images,
    },
  };
}

function qpdfJsonSelector(selector: string): string {
  if (selector === "trailer") return selector;
  const match = /^obj:(\d+) (\d+) R$/.exec(selector);
  if (!match) throw new Error(`Invalid QPDF JSON object selector: ${selector}`);
  return `${match[1]},${match[2]}`;
}

async function inspectJson(
  input: Uint8Array, qpdf: EmModule, selectors: string[], withStreamData: boolean,
  decodeLevel: "all" | "none" = withStreamData ? "all" : "none",
): Promise<string> {
  const inputPath = "/input.pdf", outputPath = "/inspection.json";
  const args = [
    "--json",
    withStreamData ? "--json-stream-data=inline" : "--json-stream-data=none",
    `--decode-level=${decodeLevel}`,
    ...selectors.map(selector => `--json-object=${qpdfJsonSelector(selector)}`),
    inputPath, outputPath,
  ];
  return runJsonTool({ engine: "qpdf", input, args, inputPath, outputPath, tools: { qpdf } }).json;
}

async function hashProtectedInBatches(input: Uint8Array, qpdf: EmModule, refs: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (let i = 0; i < refs.length; i += 48) {
    const batch = refs.slice(i, i + 48);
    const json = await inspectJson(input, qpdf, batch, true, "none");
    Object.assign(hashes, await hashProtectedStreams(json, crypto.subtle, batch));
  }
  return hashes;
}

async function snapshotRgbImagesInBatches(
  input: Uint8Array, qpdf: EmModule, refs: string[],
): Promise<EligibleRgbImageSnapshot> {
  const snapshot: EligibleRgbImageSnapshot = { hashes: {}, profiles: {} };
  for (let i = 0; i < refs.length; i += 8) {
    const batch = refs.slice(i, i + 8);
    const json = await inspectJson(input, qpdf, batch, true, "none");
    const current = await snapshotEligibleRgbImageStreams(json, batch);
    Object.assign(snapshot.hashes, current.hashes);
    Object.assign(snapshot.profiles, current.profiles);
  }
  return snapshot;
}

interface Baseline {
  discovery: string;
  pageRefs: string[];
  protectedRefs: string[];
  pageHashes: Awaited<ReturnType<typeof hashPageContentStreams>>;
  protectedHashes: Record<string, string>;
  rgbImageRefs: string[];
  rgbImageSnapshot: EligibleRgbImageSnapshot;
  qpdfOnly: boolean;
}
async function createBaseline(original: Uint8Array, qpdf: EmModule): Promise<Baseline> {
  const discovery = await inspectJson(original, qpdf, [], false);
  assertCompressionEligible(discovery);
  const pageRefs = selectPageContentObjects(discovery);
  const protectedRefs = selectProtectedStreamObjects(discovery);
  const rgbImageRefs = selectEligibleRgbImageObjects(discovery);
  const pageJson = await inspectJson(original, qpdf, pageRefs, true, "all");
  const pageHashes = await hashPageContentStreams(pageJson);
  const protectedHashes = await hashProtectedInBatches(original, qpdf, protectedRefs);
  const rgbImageSnapshot = await snapshotRgbImagesInBatches(original, qpdf, rgbImageRefs);
  return { discovery, pageRefs, protectedRefs, pageHashes, protectedHashes, rgbImageRefs, rgbImageSnapshot, qpdfOnly: qpdfCatalogHasKey(discovery, "/AcroForm") };
}

async function certifyCandidate(
  original: Uint8Array, candidate: Uint8Array, qpdf: EmModule, baseline: Baseline,
  allowRgbImageChanges: boolean,
): Promise<void> {
  if (candidate.byteLength >= original.byteLength) throw new Error("candidate.byteLength >= original.byteLength; larger/equal output is not accepted");
  if (!startsWithPdf(candidate) || !endsWithPdfEof(candidate)) throw new Error("candidate PDF signature/EOF validation failed");
  const outputDiscovery = await inspectJson(candidate, qpdf, [], false);
  assertCompressionEligible(outputDiscovery);
  if (allowRgbImageChanges) assertDocumentStructureUnchanged(baseline.discovery, outputDiscovery, true);
  else assertDocumentStructureUnchanged(baseline.discovery, outputDiscovery);
  const outputRgbImageRefs = selectEligibleRgbImageObjects(outputDiscovery);
  if (JSON.stringify(baseline.rgbImageRefs) !== JSON.stringify(outputRgbImageRefs)) {
    throw new Error("Candidate changed the eligible RGB image object set.");
  }
  const outputRgbImageSnapshot = await snapshotRgbImagesInBatches(candidate, qpdf, baseline.rgbImageRefs);
  if (allowRgbImageChanges) assertRgbImageQuantizationNotFiner(baseline.rgbImageSnapshot, outputRgbImageSnapshot);
  else assertRgbImageStreamsUnchanged(baseline.rgbImageSnapshot, outputRgbImageSnapshot);
  const outputPageRefs = selectPageContentObjects(outputDiscovery);
  const outputPageJson = await inspectJson(candidate, qpdf, outputPageRefs, true, "all");
  const after = await hashPageContentStreams(outputPageJson);
  assertPageContentStreamsUnchanged(baseline.pageHashes, after);
  const outputProtectedRefs = selectProtectedStreamObjects(outputDiscovery);
  if (JSON.stringify(baseline.protectedRefs) !== JSON.stringify(outputProtectedRefs)) {
    throw new Error("Protected stream object set changed.");
  }
  const outputProtectedHashes = await hashProtectedInBatches(candidate, qpdf, outputProtectedRefs);
  assertProtectedStreamsUnchanged(baseline.protectedHashes, outputProtectedHashes);
}

/**
 * The UI still submits its original Deep/Custom mode names. The adapter maps
 * Deep to the kit's recommended policy while preserving the public result/report
 * fields. Light processing runs first without downloading WASM. WASM is loaded
 * only when the light engine cannot safely finish or the target is still unmet.
 */
export async function compressLosslessly(
  source: Uint8Array,
  options: CompressionKitOptions,
): Promise<CompressionKitResult> {
  const targetBytes = options.mode === "custom" &&
      Number.isSafeInteger(options.targetBytes) && (options.targetBytes ?? 0) > 0
    ? options.targetBytes as number : null;

  if (!startsWithPdf(source) || !endsWithPdfEof(source)) {
    return resultForOriginal(source, options.mode, targetBytes, "Input is not a complete PDF; original bytes were preserved.");
  }
  if (options.mode === "custom" && targetBytes === null) {
    return resultForOriginal(source, options.mode, null, "Custom target is invalid; original bytes were preserved.");
  }
  if (targetBytes !== null && source.byteLength <= targetBytes) {
    return resultForOriginal(source, options.mode, targetBytes, "The original PDF already meets the requested target size.");
  }
  if (source.byteLength > LIMITS.maxFileBytes) {
    return resultForOriginal(source, options.mode, targetBytes, `Input exceeds the ${LIMITS.maxFileBytes / (1024 * 1024)} MB safe processing limit; original bytes were preserved.`);
  }
  const earlyMemory = wasmMemoryAllowed(source.byteLength);
  if (source.byteLength > LIMITS.browserComfortBytes && !earlyMemory.allowed) {
    const reached = targetBytes === null ? null : source.byteLength <= targetBytes;
    const message = `Deep engine skipped due to memory safety (${earlyMemory.reason}). ${reached === false ? "The custom target is unreachable without exceeding the safe memory limit; original bytes preserved." : "Original bytes preserved."}`;
    return resultForOriginal(source, options.mode, targetBytes, message, [earlyMemory.reason ?? ""], false);
  }
  const original = source.slice();

  const engineMode: Mode = options.mode === "custom" ? "custom" : "recommended";
  const locate: WasmLocate = {
    qpdfWasmUrl: options.qpdfWasmUrl ?? DEFAULT_WASM_LOCATE.qpdfWasmUrl,
    ghostscriptWasmUrl: options.ghostscriptWasmUrl ?? DEFAULT_WASM_LOCATE.ghostscriptWasmUrl,
  };
  let light: BrowserResult;
  if (original.byteLength > LIMITS.browserComfortBytes) {
    light = {
      ok: true, bytes: original, inputBytes: original.byteLength, outputBytes: original.byteLength,
      savedPercent: 0, keptOriginal: true, needsDeep: true,
      deepReason: "file exceeds the light-engine memory budget", passes: 0, images: [],
      warnings: ["Light engine skipped due to memory safety; attempting the bounded deep route."], errors: [],
    };
  } else {
    try {
      light = await compressInBrowser(original, {
        mode: engineMode,
        targetKB: targetBytes === null ? undefined : targetBytes / 1024,
        signal: options.signal,
        onProgress(percent, text) {
          options.onProgress?.(percent >= 95 ? "validating" : "structural-pass", text, percent);
        },
      });
    } catch (error) {
      light = {
        ok: false, bytes: original, inputBytes: original.byteLength, outputBytes: original.byteLength,
        savedPercent: 0, keptOriginal: true, needsDeep: true,
        deepReason: "light engine failed; try the bounded lossless/deep route", passes: 0, images: [], warnings: [],
        errors: [`Light engine failed closed: ${error instanceof Error ? error.message : "unknown error"}`],
      };
    }
  }
  const warnings = [...light.warnings, ...light.errors];
  let images = light.images;
  let lightCandidate = light.ok && light.bytes.byteLength < original.byteLength ? light.bytes.slice() : null;
  let qualityGate: GateReport | undefined;
  if (lightCandidate) {
    if (typeof OffscreenCanvas === "undefined") {
      warnings.push("Light candidate rejected because the visual quality gate is unavailable in this runtime.");
      lightCandidate = null;
    } else {
      try {
        options.onProgress?.("validating", "Running the visual quality gate on the browser-compressed candidate…", 88);
        const { qualityGateInBrowser } = await import("./browserQualityGate");
        const lightGate = await qualityGateInBrowser(original, lightCandidate, {
          minPsnrDb: MODE_POLICY[engineMode].minPsnrDb,
          minSharpnessRatio: MODE_POLICY[engineMode].minSharpnessRatio,
          sampleDpi: 100, maxSamplePages: 5,
        });
        if (!lightGate.passed) {
          warnings.push(`Light candidate rejected by the visual quality gate: ${(lightGate.failures.length ? lightGate.failures.join("; ") : lightGate.notes.join("; "))}`);
          lightCandidate = null;
        } else {
          qualityGate = lightGate;
        }
      } catch (error) {
        warnings.push(`Light candidate rejected because its visual quality gate failed closed: ${error instanceof Error ? error.message : "gate unavailable"}`);
        lightCandidate = null;
      }
    }
  }
  let best = lightCandidate ?? original;
  let method: CompressionKitReport["method"] = lightCandidate ? "browser-rgb-image" : "original-preserved";
  let engine: NonNullable<CompressionKitReport["engine"]> = lightCandidate ? "light" : "original";
  let contentStreamsVerified = !!lightCandidate;

  // Never attempt any engine on a signed, encrypted, XFA or permission-controlled document.
  if (!light.needsDeep && light.keptOriginal && warnings.some(w => /signed PDF|encrypted PDF|XFA PDF|Signature or permission-controlled/i.test(w))) {
    const message = warnings[warnings.length - 1] ?? "Sensitive PDF detected; original preserved.";
    options.onProgress?.("complete", message, 100);
    return resultForOriginal(original, options.mode, targetBytes, message, warnings, false, images);
  }

  const routeDecision = decideCompressionRoute({
    mode: options.mode, originalBytes: original.byteLength, candidateBytes: lightCandidate?.byteLength ?? null,
    lightKeptOriginal: light.keptOriginal, lightNeedsDeep: light.needsDeep, targetBytes, deepReason: light.deepReason,
  });
  if (!routeDecision.useDeep) {
    const savedBytes = original.byteLength - best.byteLength;
    const savedPercent = Math.round(savedBytes / original.byteLength * 1000) / 10;
    const targetReached = targetBytes === null ? null : best.byteLength <= targetBytes;
    const message = `Browser image compression reduced the file by ${savedPercent}%. Non-image streams and decoded page-content SHA-256 hashes were preserved.`;
    options.onProgress?.("complete", message, 100);
    return { bytes: best, report: { mode: options.mode, method, originalBytes: original.byteLength, outputBytes: best.byteLength,
      savedBytes, savedPercent, targetBytes, targetReached, contentStreamsVerified, message, engine, warnings, images, qualityGate } };
  }

  const memory = wasmMemoryAllowed(original.byteLength);
  if (!memory.allowed) {
    const targetReached = targetBytes === null ? null : best.byteLength <= targetBytes;
    const message = `Deep engine skipped due to memory safety (${memory.reason}). ${targetReached === false ? "The custom target is unreachable without exceeding the safe memory limit; best validated output preserved." : "Best validated output preserved."}`;
    options.onProgress?.("complete", message, 100);
    if (best.byteLength >= original.byteLength) return resultForOriginal(original, options.mode, targetBytes, message, [...warnings, memory.reason ?? ""], false, images);
    return { bytes: best, report: { mode: options.mode, method, originalBytes: original.byteLength, outputBytes: best.byteLength,
      savedBytes: original.byteLength-best.byteLength, savedPercent: Math.round((original.byteLength-best.byteLength)/original.byteLength*1000)/10,
      targetBytes, targetReached, contentStreamsVerified, message, engine, warnings: [...warnings, memory.reason ?? ""], images, qualityGate } };
  }

  try {
    options.onProgress?.("loading-engine", "Loading the local QPDF WebAssembly engine…", 10);
    const qpdf = await loadWasmTool("qpdf", locate);
    options.onProgress?.("validating", "Creating SHA-256 baseline for page content and protected PDF streams…", 25);
    const baseline = await createBaseline(original, qpdf);

    options.onProgress?.("structural-pass", "Running bounded deep compression from the original PDF…", 35);
    const qpdfOnly = routeDecision.qpdfOnly || baseline.qpdfOnly;
    let tools: Partial<WasmTools> = { qpdf };
    if (!qpdfOnly) {
      options.onProgress?.("loading-engine", "Loading Ghostscript-WASM only because the safe target is still unmet…", 30);
      const ghostscript = await loadWasmTool("ghostscript", locate);
      tools = { qpdf, ghostscript };
    }
    const deep: DeepResult = await compressDeep(original, {
      mode: engineMode,
      targetKB: targetBytes === null ? undefined : targetBytes / 1024,
      tools,
      qpdfOnly,
      signal: options.signal,
      onProgress(percent, text) {
        options.onProgress?.(percent >= 95 ? "complete" : percent >= 80 ? "validating" : "structural-pass", text, percent);
      },
    });
    warnings.push(...deep.warnings);
    const candidates: Array<{ bytes: Uint8Array; route: "qpdf-wasm" | "ghostscript-wasm"; gate?: GateReport }> = [];
    if (deep.ok && deep.gatePassed && deep.route !== "unchanged") candidates.push({ bytes: deep.bytes, route: deep.route, gate: deep.gate });
    if (deep.fallbackBytes && deep.fallbackBytes.byteLength < original.byteLength) candidates.push({ bytes: deep.fallbackBytes, route: "qpdf-wasm" });
    for (const candidate of candidates) {
      if (candidate.bytes.byteLength >= best.byteLength) continue;
      try {
        options.onProgress?.("validating", `Verifying ${candidate.route} output structure and protected streams…`, 90);
        await certifyCandidate(original, candidate.bytes, qpdf, baseline, candidate.route === "ghostscript-wasm");
        best = candidate.bytes.slice();
        method = candidate.route === "ghostscript-wasm" ? "ghostscript-quality-gated" : "qpdf-lossless-structure";
        engine = candidate.route === "ghostscript-wasm" ? "ghostscript" : "qpdf";
        contentStreamsVerified = true;
        qualityGate = candidate.gate;
      } catch (error) {
        warnings.push(`${candidate.route} candidate rejected by the integrity gate: ${error instanceof Error ? error.message : "validation failed"}`);
      }
    }

    const savedBytes = original.byteLength - best.byteLength;
    const savedPercent = Math.round(savedBytes / original.byteLength * 1000) / 10;
    const targetReached = targetBytes === null ? null : best.byteLength <= targetBytes;
    let message = best.byteLength < original.byteLength
      ? `Compression reduced the file by ${savedPercent}%. Page-content SHA-256 and protected stream/object checks passed.`
      : "No smaller candidate passed the integrity and quality gates; original PDF preserved.";
    if (targetBytes !== null && !targetReached) {
      message += ` Requested target ${(targetBytes / 1024).toFixed(0)} KB is unreachable without violating the ${engineMode === "custom" ? "150 DPI floor, preservation checks or quality gate" : "preservation checks or quality gate"}; best safe output delivered.`;
    }
    options.onProgress?.("complete", message, 100);
    if (best.byteLength >= original.byteLength) return resultForOriginal(original, options.mode, targetBytes, message, warnings, false, images);
    return { bytes: best, report: { mode: options.mode, method, originalBytes: original.byteLength, outputBytes: best.byteLength,
      savedBytes, savedPercent, targetBytes, targetReached, contentStreamsVerified, message, engine, warnings, images, qualityGate } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "validation failed";
    warnings.push(reason);
    const targetReached = targetBytes === null ? null : best.byteLength <= targetBytes;
    const message = `Deep compression could not be certified (${reason}). ${targetReached === false ? "Custom target is unreachable with the remaining safe options." : "The best validated result is preserved."}`;
    options.onProgress?.("complete", message, 100);
    if (best.byteLength >= original.byteLength) return resultForOriginal(original, options.mode, targetBytes, message, warnings, false, images);
    return { bytes: best, report: { mode: options.mode, method, originalBytes: original.byteLength, outputBytes: best.byteLength,
      savedBytes: original.byteLength-best.byteLength, savedPercent: Math.round((original.byteLength-best.byteLength)/original.byteLength*1000)/10,
      targetBytes, targetReached, contentStreamsVerified, message, engine, warnings, images, qualityGate } };
  }
}
