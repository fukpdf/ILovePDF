import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadWasmTool, type WasmLocate } from "../src/browser/wasmCli";

const locate: WasmLocate = {
  ghostscriptWasmUrl: resolve(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/dist/gs.wasm"),
  qpdfWasmUrl: resolve(process.cwd(), "node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
};

test("published qpdf-wasm package initializes its real WASM runtime", async () => {
  const module = await loadWasmTool("qpdf", locate);
  assert.equal(typeof module.callMain, "function");
  assert.equal(typeof module.FS.writeFile, "function");
  assert.equal(typeof module.FS.readFile, "function");
  assert.equal(typeof module.FS.unlink, "function");
});

test("published Ghostscript-WASM package initializes its real WASM runtime", async () => {
  const module = await loadWasmTool("ghostscript", locate);
  assert.equal(typeof module.callMain, "function");
  assert.equal(typeof module.FS.writeFile, "function");
  assert.equal(typeof module.FS.readFile, "function");
});
