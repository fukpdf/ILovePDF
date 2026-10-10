/**
 * Browser-side Emscripten CLI adapter.
 *
 * PDF bytes are written only to each WASM module's in-memory virtual FS.
 * This module intentionally performs no fetch/XHR and never sends input bytes
 * to a server. The caller must provide same-origin WASM asset URLs.
 */
export type WasmEngine = "ghostscript" | "qpdf";

export interface WasmLocate {
  ghostscriptWasmUrl: string;
  qpdfWasmUrl: string;
}

/** Browser builds replace these fallback URLs with Vite-emitted ?url assets. */
export let DEFAULT_WASM_LOCATE: WasmLocate = {
  ghostscriptWasmUrl: "/vendor/compression/gs.wasm",
  qpdfWasmUrl: "/vendor/compression/qpdf.wasm",
};
export function configureWasmAssets(locate: WasmLocate): void {
  if (!locate.ghostscriptWasmUrl || !locate.qpdfWasmUrl) throw new Error("Both local WASM asset URLs are required.");
  DEFAULT_WASM_LOCATE = { ...locate };
}

export interface EmscriptenFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, options?: { encoding?: string }): Uint8Array;
  unlink(path: string): void;
  analyzePath?(path: string): { exists: boolean };
}

export interface EmModule {
  FS: EmscriptenFS;
  callMain(args: string[]): number | void;
}


export interface WasmTools {
  ghostscript: EmModule;
  qpdf: EmModule;
}

const cachedModules = new Map<WasmEngine, Promise<EmModule>>();

function assertRuntimeFs(module: EmModule, engine: WasmEngine): EmModule {
  const fs = module.FS as unknown as Record<string, unknown>;
  for (const method of ["writeFile", "readFile", "unlink"]) {
    if (typeof fs[method] !== "function") {
      throw new Error(`${engine} WASM runtime is missing the required FS.${method} API.`);
    }
  }
  if (typeof module.callMain !== "function") {
    throw new Error(`${engine} WASM runtime is missing callMain(args).`);
  }
  return module;
}

async function createEngineModule(engine: WasmEngine, wasmUrl: string): Promise<EmModule> {
  if (engine === "qpdf") {
    // Use QPDF's published factory signature exactly. Its published
    // declarations expose callMain/FS.readFile; writeFile/unlink are verified
    // at runtime because the Emscripten FS declarations are incomplete.
    const mod = await import("@neslinesli93/qpdf-wasm");
    const qpdfOptions = { locateFile: () => wasmUrl, noInitialRun: true } as Parameters<typeof mod.default>[0] & { noInitialRun: true };
    const instance = await mod.default(qpdfOptions);
    return assertRuntimeFs(instance as unknown as EmModule, engine);
  }

  const mod = await import("@jspawn/ghostscript-wasm");
  const instance = await mod.default({
    locateFile: (path) => path.endsWith(".wasm") ? wasmUrl : path,
    noInitialRun: true,
  });
  return assertRuntimeFs(instance, engine);
}

/**
 * Load only the requested engine. Call from a user-triggered compression path
 * so unused WASM binaries are not downloaded/initialized.
 */
export function loadWasmTool(engine: WasmEngine, locate: WasmLocate = DEFAULT_WASM_LOCATE): Promise<EmModule> {
  const existing = cachedModules.get(engine);
  if (existing) return existing;

  const wasmUrl = engine === "qpdf" ? locate.qpdfWasmUrl : locate.ghostscriptWasmUrl;
  const pending = (async () => {
    try {
      return await createEngineModule(engine, wasmUrl);
    } catch (error) {
      cachedModules.delete(engine);
      throw error;
    }
  })();
  cachedModules.set(engine, pending);
  return pending;
}

/** Compatibility helper for flows that genuinely need both engines. */
export async function loadWasmTools(locate: WasmLocate = DEFAULT_WASM_LOCATE): Promise<WasmTools> {
  const [ghostscript, qpdf] = await Promise.all([
    loadWasmTool("ghostscript", locate),
    loadWasmTool("qpdf", locate),
  ]);
  return { ghostscript, qpdf };
}

export interface WasmCliRequest {
  engine: WasmEngine;
  input: Uint8Array;
  /** Full argv excluding the executable name; paths must match inputPath/outputPath. */
  args: string[];
  inputPath?: string;
  outputPath?: string;
  tools: Partial<WasmTools>;
}

export interface WasmCliResult {
  output: Uint8Array;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Run a CLI against an in-memory PDF. The caller owns argument correctness and
 * must independently validate the resulting PDF and quality contract.
 */
export function runTool(request: WasmCliRequest): WasmCliResult {
  const { engine, input, args, tools } = request;
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new Error("WASM CLI requires a non-empty PDF byte array.");
  }
  const module = tools[engine];
  if (!module) throw new Error(`WASM engine ${engine} was not initialized.`);
  const inputPath = request.inputPath ?? "/input.pdf";
  const outputPath = request.outputPath ?? "/output.pdf";

  try {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
    module.FS.writeFile(inputPath, input);
    const exitCode = Number(module.callMain(args) ?? 0);
    if (exitCode !== 0) {
      throw new Error(`${engine} exited with code ${exitCode}.`);
    }
    if (module.FS.analyzePath && !module.FS.analyzePath(outputPath).exists) {
      throw new Error(`${engine} exited successfully but produced no output file.`);
    }
    let output: Uint8Array;
    try {
      output = module.FS.readFile(outputPath);
    } catch {
      throw new Error(`${engine} did not create readable output at ${outputPath}.`);
    }
    if (!(output instanceof Uint8Array) || output.byteLength < 5 ||
        output[0] !== 0x25 || output[1] !== 0x50 ||
        output[2] !== 0x44 || output[3] !== 0x46 || output[4] !== 0x2d) {
      throw new Error(`${engine} produced an invalid PDF signature.`);
    }
    return { output: output.slice(), exitCode, stdout: [], stderr: [] };
  } finally {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
  }
}


export interface WasmJsonRequest {
  engine: WasmEngine;
  input: Uint8Array;
  /** Arguments must include inputPath followed by outputPath. */
  args: string[];
  inputPath?: string;
  outputPath?: string;
  tools: Partial<WasmTools>;
}

export interface WasmJsonResult {
  json: string;
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Run a QPDF JSON inspection pass with output written to the WASM filesystem.
 * The caller should use --json-stream-data=none for discovery and request
 * inline stream data only for selected page/content objects.
 */
export function runJsonTool(request: WasmJsonRequest): WasmJsonResult {
  const { engine, input, args, tools } = request;
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new Error("WASM JSON inspection requires a non-empty PDF byte array.");
  }
  const module = tools[engine];
  if (!module) throw new Error(`WASM engine ${engine} was not initialized.`);
  const inputPath = request.inputPath ?? "/input.pdf";
  const outputPath = request.outputPath ?? "/output.json";
  if (!args.includes(inputPath) || !args.includes(outputPath)) {
    throw new Error("WASM JSON arguments must include the configured input and output paths.");
  }
  try {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
    module.FS.writeFile(inputPath, input);
    const exitCode = Number(module.callMain(args) ?? 0);
    if (exitCode !== 0) {
      throw new Error(`${engine} JSON inspection exited with code ${exitCode}.`);
    }
    if (module.FS.analyzePath && !module.FS.analyzePath(outputPath).exists) {
      throw new Error(`${engine} did not create JSON output at ${outputPath}.`);
    }
    const bytes = module.FS.readFile(outputPath);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch {
      throw new Error(`${engine} returned invalid JSON inspection output.`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { qpdf?: unknown }).qpdf)) {
      throw new Error(`${engine} JSON output did not contain a QPDF object table.`);
    }
    return { json, exitCode, stdout: [], stderr: [] };
  } finally {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
  }
}
