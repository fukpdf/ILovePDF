#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = readFileSync(path.join(root, "src/browser/wasmCli.ts"), "utf8");
const declarations = readFileSync(path.join(root, "src/browser/wasm-modules.d.ts"), "utf8");

const checks = [
  ["only the requested WASM engine can be lazy-loaded", cli.includes("export function loadWasmTool(")],
  ["failed WASM imports clear the lazy-load cache", cli.includes("cachedModules.delete(engine)")],
  ["WASM CLI uses in-memory FS.writeFile for input bytes", cli.includes("module.FS.writeFile(inputPath, input)")],
  ["WASM CLI reads output from in-memory FS", cli.includes("module.FS.readFile(outputPath)")],
  ["non-zero exit codes are rejected", cli.includes("if (exitCode !== 0)")],
  ["output PDF signature is validated", cli.includes("output[0] !== 0x25") && cli.includes("output[4] !== 0x2d")],
  ["input and output virtual files are cleaned up", cli.includes("module.FS.unlink(inputPath)") && cli.includes("module.FS.unlink(outputPath)")],
  ["no network APIs are used in WASM CLI", !/\b(fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(cli)],
  ["qpdf module factory has declared API", declarations.includes('declare module "@neslinesli93/qpdf-wasm"') && declarations.includes("callMain(args: string[]): number")],
  ["Ghostscript factory is explicitly declared", declarations.includes('declare module "@jspawn/ghostscript-wasm"')],
  ["no stale unbound stderr identifier remains", !/(?<![.\w])stderr\.join\(/.test(cli)],
];

for (const [name, passed] of checks) {
  assert.equal(passed, true, "FAIL: " + name);
  console.log("PASS: " + name);
}
console.log("WASM CLI static checks passed: " + checks.length);
