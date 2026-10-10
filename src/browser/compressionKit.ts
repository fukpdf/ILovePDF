import { loadWasmTool, runJsonTool, runTool, type WasmLocate } from "./wasmCli";
import {
  assertCompressionEligible,
  assertPageContentStreamsUnchanged,
  hashPageContentStreams,
  selectPageContentObjects,
} from "./pdfContentIntegrity";

export type CompressionMode = "deep" | "custom";
export type CompressionStage = "loading-engine" | "structural-pass" | "validating" | "complete";

export interface CompressionKitOptions {
  mode: CompressionMode;
  targetBytes?: number | null;
  qpdfWasmUrl?: string;
  ghostscriptWasmUrl?: string;
  onProgress?: (stage: CompressionStage, message: string) => void;
}

export interface CompressionKitReport {
  mode: CompressionMode;
  method: "qpdf-lossless-structure" | "original-preserved";
  originalBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  targetBytes: number | null;
  targetReached: boolean | null;
  contentStreamsVerified: boolean;
  message: string;
}

export interface CompressionKitResult {
  bytes: Uint8Array;
  report: CompressionKitReport;
}

const hasToken = (bytes: Uint8Array, token: string): boolean => {
  outer: for (let i = 0; i <= bytes.length - token.length; i++) {
    for (let j = 0; j < token.length; j++) {
      if (bytes[i + j] !== token.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
};

function resultForOriginal(
  original: Uint8Array,
  mode: CompressionMode,
  targetBytes: number | null,
  message: string,
  contentStreamsVerified = false,
): CompressionKitResult {
  return {
    bytes: original.slice(),
    report: {
      mode,
      method: "original-preserved",
      originalBytes: original.byteLength,
      outputBytes: original.byteLength,
      savedBytes: 0,
      savedPercent: 0,
      targetBytes,
      targetReached: targetBytes === null ? null : original.byteLength <= targetBytes,
      contentStreamsVerified,
      message,
    },
  };
}

async function inspectJson(
  input: Uint8Array,
  wasm: { qpdf: Awaited<ReturnType<typeof loadWasmTool>> },
  selectors: string[],
  withStreamData: boolean,
): Promise<string> {
  const inputPath = "/input.pdf";
  const outputPath = "/inspection.json";
  const args = [
    "--json",
    withStreamData ? "--json-stream-data=inline" : "--json-stream-data=none",
    withStreamData ? "--decode-level=all" : "--decode-level=none",
    ...selectors.map(selector => `--json-object=${selector}`),
    inputPath,
    outputPath,
  ];
  return runJsonTool({
    engine: "qpdf",
    input,
    args,
    inputPath,
    outputPath,
    tools: { qpdf: wasm.qpdf },
  }).json;
}

/**
 * Conservative, lossless structural compression for browser execution.
 * This pass never downsamples or re-encodes image streams. QPDF is explicitly
 * told to preserve all stream payloads and only compact indirect objects into
 * object streams. A smaller candidate is accepted only after SHA-256 equality
 * of every decoded page-content stream has been proved on input and output.
 */
export async function compressLosslessly(
  source: Uint8Array,
  options: CompressionKitOptions,
): Promise<CompressionKitResult> {
  const original = source.slice();
  const targetBytes = options.mode === "custom" &&
      Number.isSafeInteger(options.targetBytes) && (options.targetBytes ?? 0) > 0
    ? options.targetBytes as number
    : null;

  if (original.byteLength < 5 || ![0x25, 0x50, 0x44, 0x46, 0x2d].every((v, i) => original[i] === v)) {
    return resultForOriginal(original, options.mode, targetBytes, "Input is not a valid PDF header; original bytes were preserved.");
  }
  if (options.mode === "custom" && targetBytes === null) {
    return resultForOriginal(original, options.mode, null, "Custom target is invalid; original bytes were preserved.");
  }

  const sensitive = [
    ["/ByteRange", "Digitally signed PDFs are not modified."],
    ["/Encrypt", "Encrypted PDFs are not modified."],
    ["/XFA", "XFA PDFs are not modified."],
    ["/AcroForm", "Interactive form PDFs are not modified until form-safe processing is verified."],
  ].find(([token]) => hasToken(original, token));
  if (sensitive) return resultForOriginal(original, options.mode, targetBytes, sensitive[1]);

  const locate: WasmLocate = {
    qpdfWasmUrl: options.qpdfWasmUrl ?? "/vendor/compression/qpdf.wasm",
    ghostscriptWasmUrl: options.ghostscriptWasmUrl ?? "/vendor/compression/gs.wasm",
  };

  try {
    options.onProgress?.("loading-engine", "Loading the local QPDF WebAssembly engine…");
    const qpdf = await loadWasmTool("qpdf", locate);
    const tools = { qpdf };

    options.onProgress?.("validating", "Checking PDF structure before compression…");
    const sourceDiscovery = await inspectJson(original, { qpdf }, [], false);
    assertCompressionEligible(sourceDiscovery);
    const sourceSelectors = selectPageContentObjects(sourceDiscovery);

    options.onProgress?.("structural-pass", "Applying lossless PDF object-stream compression…");
    const inputPath = "/input.pdf";
    const outputPath = "/output.pdf";
    const compressed = runTool({
      engine: "qpdf",
      input: original,
      inputPath,
      outputPath,
      args: [
        "--stream-data=preserve",
        "--object-streams=generate",
        "--compression-level=9",
        inputPath,
        outputPath,
      ],
      tools,
    });
    const candidate = compressed.output;
    if (candidate.byteLength >= original.byteLength) {
      options.onProgress?.("complete", "The original PDF is already as small as the lossless structural pass can make it.");
      return resultForOriginal(
        original,
        options.mode,
        targetBytes,
        "Lossless structural compression did not reduce the file. The original PDF was preserved.",
      );
    }

    options.onProgress?.("validating", "Verifying decoded page-content streams with SHA-256…");
    const inputJson = await inspectJson(original, { qpdf }, sourceSelectors, true);
    const outputDiscovery = await inspectJson(candidate, { qpdf }, [], false);
    assertCompressionEligible(outputDiscovery);
    const outputSelectors = selectPageContentObjects(outputDiscovery);
    const outputJson = await inspectJson(candidate, { qpdf }, outputSelectors, true);
    const before = await hashPageContentStreams(inputJson);
    const after = await hashPageContentStreams(outputJson);
    assertPageContentStreamsUnchanged(before, after);

    if (candidate.byteLength > original.byteLength) {
      return resultForOriginal(original, options.mode, targetBytes, "The candidate was larger than the source; original preserved.", true);
    }

    const savedBytes = original.byteLength - candidate.byteLength;
    const savedPercent = Math.round((savedBytes / original.byteLength) * 1000) / 10;
    const targetReached = targetBytes === null ? null : candidate.byteLength <= targetBytes;
    const message = targetBytes !== null && !targetReached
      ? `Content was preserved and the file was reduced by ${savedPercent}%, but the requested target was unreachable with lossless structural compression. The target was not forced by degrading content.`
      : `Lossless structural compression reduced the file by ${savedPercent}%. Decoded page-content streams were verified with SHA-256.`;
    options.onProgress?.("complete", message);
    return {
      bytes: candidate,
      report: {
        mode: options.mode,
        method: "qpdf-lossless-structure",
        originalBytes: original.byteLength,
        outputBytes: candidate.byteLength,
        savedBytes,
        savedPercent,
        targetBytes,
        targetReached,
        contentStreamsVerified: true,
        message,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "validation failed";
    options.onProgress?.("complete", "Validation did not pass; original PDF preserved.");
    return resultForOriginal(
      original,
      options.mode,
      targetBytes,
      `Safe compression was skipped because validation could not be completed (${reason}). The original PDF was preserved unchanged.`,
    );
  }
}
