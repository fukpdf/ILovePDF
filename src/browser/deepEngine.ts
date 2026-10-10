import { CUSTOM_GS_QFACTOR_LADDER, LIMITS, MODE_POLICY, type Mode } from "../shared/policy";
import { buildGsArgs } from "../shared/gsParams";
import { containsAscii, endsWithPdfEof, startsWithPdf } from "../shared/bytes";
import type { GateReport } from "../shared/quality";
import { runTool, type WasmTools } from "./wasmCli";

export interface DeepOptions {
  mode: Mode; targetKB?: number; tools: Partial<WasmTools>;
  onProgress?: (percent: number, stage: string) => void; signal?: AbortSignal;
}
export interface DeepResult {
  ok: boolean; bytes: Uint8Array; route: "unchanged" | "qpdf-wasm" | "ghostscript-wasm";
  inputBytes: number; outputBytes: number; savedPercent: number;
  gate?: GateReport; targetReached?: boolean; gatePassed: boolean; warnings: string[]; error?: string; fallbackBytes?: Uint8Array;
}
export function wasmMemoryAllowed(bytes: number): { allowed: boolean; reason?: string } {
  const deviceMemory = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const cap = deviceMemory !== undefined && deviceMemory < 4 ? LIMITS.wasmMaxBytesLowMemory : LIMITS.wasmMaxBytes;
  return bytes <= cap ? { allowed: true } : { allowed: false, reason: `file (${(bytes / 1048576).toFixed(0)} MB) exceeds the safe in-browser limit of ${(cap / 1048576).toFixed(0)} MB for this device` };
}

export async function compressDeep(raw: Uint8Array, options: DeepOptions): Promise<DeepResult> {
  const input = raw.slice();
  const make = (bytes: Uint8Array, route: DeepResult["route"], p: Partial<DeepResult> = {}): DeepResult => {
    const safe = bytes.length < input.length ? bytes.slice() : input.slice();
    return {
      ok: true, bytes: safe, route: safe.length < input.length ? route : "unchanged",
      inputBytes: input.length, outputBytes: safe.length,
      savedPercent: Number((((input.length - safe.length) / input.length) * 100).toFixed(2)),
      gatePassed: false, warnings: [], ...p,
    };
  };
  if (!input.length) return make(input, "unchanged", { ok: false, error: "The file is empty." });
  if (!startsWithPdf(input) || !endsWithPdfEof(input)) return make(input, "unchanged", { ok: false, error: "Input is not a complete PDF." });
  const memory = wasmMemoryAllowed(input.length);
  if (!memory.allowed) return make(input, "unchanged", { ok: false, error: memory.reason });
  if (containsAscii(input, "/ByteRange") || containsAscii(input, "/SigFlags")) return make(input, "unchanged", { warnings: ["Signed PDF detected; no modification attempted."] });
  if (containsAscii(input, "/Encrypt")) return make(input, "unchanged", { warnings: ["Encrypted PDF detected; no modification attempted."] });
  if (containsAscii(input, "/XFA")) return make(input, "unchanged", { warnings: ["XFA PDF detected; no modification attempted."] });
  if (options.mode === "custom" && !(Number.isFinite(options.targetKB) && (options.targetKB ?? 0) > 0)) {
    return make(input, "unchanged", { ok: false, error: "Custom mode needs a target size greater than 0 KB." });
  }

  const warnings: string[] = [];
  const run = (engine: "qpdf" | "ghostscript", source: Uint8Array, args: string[]) => runTool({
    engine, input: source, inputPath: "/input.pdf", outputPath: "/output.pdf", args, tools: options.tools,
  });
  let qpdfCandidate: Uint8Array = input;
  try {
    options.onProgress?.(10, "Optimising PDF structure with local QPDF-WASM");
    const qpdf = run("qpdf", input, ["--stream-data=preserve", "--object-streams=generate", "--compression-level=9", "/input.pdf", "/output.pdf"]);
    if (qpdf.output.length < input.length) qpdfCandidate = qpdf.output;
    else warnings.push("QPDF structural pass did not reduce the file; original retained as the safe baseline.");
  } catch (error) {
    warnings.push(`QPDF structural pass unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // Interactive AcroForms must never pass through Ghostscript. The outer
  // integrity gate verifies the QPDF candidate's page streams and object graph.
  if (containsAscii(input, "/AcroForm") || options.mode === "lossless") {
    return make(qpdfCandidate, "qpdf-wasm", { gatePassed: true, warnings });
  }

  const policy = MODE_POLICY[options.mode];
  const ladder: readonly number[] = options.mode === "custom" ? CUSTOM_GS_QFACTOR_LADDER.slice(0, 2) : [policy.gsQFactor];
  const targetBytes = options.mode === "custom" ? Math.round((options.targetKB ?? 0) * 1024) : undefined;
  let best = qpdfCandidate, bestGate: GateReport | undefined;
  if (typeof OffscreenCanvas === "undefined") {
    warnings.push("Visual quality gate is unavailable in this runtime; Ghostscript candidates are not accepted.");
    return qpdfCandidate.length < input.length
      ? make(qpdfCandidate, "qpdf-wasm", { gatePassed: true, warnings })
      : make(input, "unchanged", { gatePassed: true, warnings });
  }
  const { qualityGateInBrowser } = await import("./browserQualityGate");

  for (let i = 0; i < ladder.length && i < 4; i++) {
    if (options.signal?.aborted) return make(input, "unchanged", { ok: false, error: "Cancelled.", warnings });
    options.onProgress?.(20 + Math.round(((i + 1) / Math.min(ladder.length, 4)) * 55), `Ghostscript-WASM quality pass ${i + 1}/${Math.min(ladder.length, 4)}`);
    let candidate: Uint8Array;
    try {
      // Every target-size pass starts from the original input, never the previous candidate.
      const gs = run("ghostscript", input, buildGsArgs(options.mode, ladder[i], "/input.pdf", "/output.pdf"));
      candidate = gs.output;
    } catch (error) {
      warnings.push(`Ghostscript pass ${i + 1} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      break;
    }
    if (candidate.length >= input.length) {
      warnings.push(`Ghostscript pass ${i + 1} was not smaller than the original; candidate discarded.`);
      continue;
    }
    options.onProgress?.(80, "Checking sampled rendering and text retention");
    const gate = await qualityGateInBrowser(input, candidate, {
      minPsnrDb: policy.minPsnrDb, minSharpnessRatio: policy.minSharpnessRatio, sampleDpi: 100, maxSamplePages: 5,
    });
    if (!gate.passed) {
      warnings.push(`Quality gate rejected Ghostscript pass ${i + 1}: ${gate.failures.join("; ")}`);
      continue;
    }
    if (candidate.length < best.length) { best = candidate; bestGate = gate; }
    if (targetBytes !== undefined && best.length <= targetBytes) break;
  }

  if (bestGate) {
    const result = make(best, "ghostscript-wasm", { gate: bestGate, gatePassed: true, warnings, fallbackBytes: qpdfCandidate.length < input.length ? qpdfCandidate.slice() : undefined });
    if (targetBytes !== undefined) {
      result.targetReached = result.outputBytes <= targetBytes;
      if (!result.targetReached) result.warnings.push(`Target ${options.targetKB} KB is unreachable without violating the ${policy.floorDpi} DPI floor or quality gate; best safe result delivered.`);
    }
    options.onProgress?.(100, "Deep compression complete");
    return result;
  }
  if (qpdfCandidate.length < input.length) {
    return make(qpdfCandidate, "qpdf-wasm", { gatePassed: true, warnings: [...warnings, "Ghostscript candidate was not certified; lossless QPDF output retained."] });
  }
  const result = make(input, "unchanged", { gatePassed: true, warnings: [...warnings, "No smaller candidate passed validation; original preserved."] });
  if (targetBytes !== undefined) {
    result.targetReached = input.length <= targetBytes;
    if (!result.targetReached) result.warnings.push(`Target ${options.targetKB} KB is unreachable without violating the ${policy.floorDpi} DPI floor or quality gate.`);
  }
  options.onProgress?.(100, "Original PDF preserved");
  return result;
}
