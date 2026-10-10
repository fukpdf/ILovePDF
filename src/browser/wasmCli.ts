import ghostscriptWasmUrl from "@jspawn/ghostscript-wasm/gs.wasm?url";
import qpdfWasmUrl from "@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url";

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

/** Vite emits these as same-origin asset URLs; importing the URL does not fetch the WASM bytes. */
export const DEFAULT_WASM_LOCATE: WasmLocate = { ghostscriptWasmUrl, qpdfWasmUrl };

export interface EmscriptenFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, options?: { encoding?: string }): Uint8Array;
  unlink(path: string): void;
  analyzePath?(path: string): { exists: boolean };
}

export interface EmModule {
  FS: EmscriptenFS;
  callMain(args: string[]): number | void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}


export interface WasmTools {
  ghostscript: EmModule;
  qpdf: EmModule;
}

const cachedModules = new Map<WasmEngine, Promise<EmModule>>();
const logBuffers = new WeakMap<EmModule, { stdout: string[]; stderr: string[] }>();

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

async function createEngineModule(engine: WasmEngine, wasmUrl: string, logs: { stdout: string[]; stderr: string[] }): Promise<EmModule> {
  if (engine === "qpdf") {
    // Use QPDF's published factory signature exactly. Its published
    // declarations expose callMain/FS.readFile; writeFile/unlink are verified
    // at runtime because the Emscripten FS declarations are incomplete.
    const mod = await import("@neslinesli93/qpdf-wasm");
    const instance = await mod.default({ locateFile: () => wasmUrl });
    return assertRuntimeFs(instance as unknown as EmModule, engine);
  }

  const mod = await import("@jspawn/ghostscript-wasm");
  const instance = await mod.default({
    locateFile: (path) => path.endsWith(".wasm") ? wasmUrl : path,
    noInitialRun: true,
    print: (line) => logs.stdout.push(String(line)),
    printErr: (line) => logs.stderr.push(String(line)),
  });
  return assertRuntimeFs(instance, engine);
}

/**
 * Load only the requested engine. Call from a user-triggered compression path
 * so unused WASM binaries are not downloaded/initialized.
 */
export function loadWasmTool(engine: WasmEngine, locate: WasmLocate): Promise<EmModule> {
  const existing = cachedModules.get(engine);
  if (existing) return existing;

  const wasmUrl = engine === "qpdf" ? locate.qpdfWasmUrl : locate.ghostscriptWasmUrl;
  const pending = (async () => {
    try {
      const logs = { stdout: [] as string[], stderr: [] as string[] };
      const module = await createEngineModule(engine, wasmUrl, logs);
      logBuffers.set(module, logs);
      return module;
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
  const logs = logBuffers.get(module) ?? { stdout: [], stderr: [] };
  logs.stdout.length = 0;
  logs.stderr.length = 0;

  try {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
    module.FS.writeFile(inputPath, input);
    const exitCode = Number(module.callMain(args) ?? 0);
    if (exitCode !== 0) {
      throw new Error(`${engine} exited with code ${exitCode}: ${logs.stderr.join("\n")}`);
    }
    if (module.FS.analyzePath && !module.FS.analyzePath(outputPath).exists) {
      throw new Error(`${engine} exited successfully but produced no output file.`);
    }
    let output: Uint8Array;
    try {
      output = module.FS.readFile(outputPath);
    } catch {
      throw new Error(`${engine} did not create readable output at ${outputPath}: ${logs.stderr.join("\n")}`);
    }
    if (!(output instanceof Uint8Array) || output.byteLength < 5 ||
        output[0] !== 0x25 || output[1] !== 0x50 ||
        output[2] !== 0x44 || output[3] !== 0x46 || output[4] !== 0x2d) {
      throw new Error(`${engine} produced an invalid PDF signature.`);
    }
    return { output: output.slice(), exitCode, stdout: [...logs.stdout], stderr: [...logs.stderr] };
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
  const logs = logBuffers.get(module) ?? { stdout: [], stderr: [] };
  logs.stdout.length = 0;
  logs.stderr.length = 0;
  try {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
    module.FS.writeFile(inputPath, input);
    const exitCode = Number(module.callMain(args) ?? 0);
    if (exitCode !== 0) {
      throw new Error(`${engine} JSON inspection exited with code ${exitCode}: ${logs.stderr.join("\\n")}`);
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
    return { json, exitCode, stdout: [...logs.stdout], stderr: [...logs.stderr] };
  } finally {
    try { module.FS.unlink(inputPath); } catch {}
    try { module.FS.unlink(outputPath); } catch {}
  }
}
