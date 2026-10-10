import test from "node:test";
import assert from "node:assert/strict";
import { runTool, type EmModule, type WasmTools } from "../src/browser/wasmCli";

const validPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function mockModule(exitCode: number, output: Uint8Array = validPdf): EmModule {
  const files = new Map<string, Uint8Array>();
  const fs: EmModule["FS"] = {
    writeFile(path, data) { files.set(path, data.slice()); },
    readFile(path) {
      const data = files.get(path);
      if (!data) throw new Error("ENOENT: " + path);
      return data.slice();
    },
    unlink(path) { files.delete(path); },
    analyzePath(path) { return { exists: files.has(path) }; },
  };
  return {
    FS: fs,
    callMain(args) {
      assert.ok(files.has("/input.pdf"), "input must be staged in WASM FS");
      assert.ok(args.includes("/input.pdf"), "argv should refer to staged input");
      files.set("/output.pdf", output.slice());
      return exitCode;
    },
  };
}

function toolsWith(module: EmModule): WasmTools {
  const unused = mockModule(0);
  return { qpdf: module, ghostscript: unused };
}

test("runTool stages input in virtual FS, validates output, and cleans temporary files", () => {
  const module = mockModule(0);
  const result = runTool({
    engine: "qpdf",
    input: validPdf,
    args: ["/input.pdf", "--check", "/output.pdf"],
    tools: toolsWith(module),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual([...result.output], [...validPdf]);
  assert.equal(module.FS.analyzePath?.("/input.pdf").exists, false);
  assert.equal(module.FS.analyzePath?.("/output.pdf").exists, false);
});

test("runTool rejects a non-zero WASM exit code and still cleans files", () => {
  const module = mockModule(2);
  assert.throws(() => runTool({
    engine: "qpdf",
    input: validPdf,
    args: ["/input.pdf", "--check", "/output.pdf"],
    tools: toolsWith(module),
  }), /exited with code 2/);
  assert.equal(module.FS.analyzePath?.("/input.pdf").exists, false);
  assert.equal(module.FS.analyzePath?.("/output.pdf").exists, false);
});

test("runTool rejects output without a PDF signature", () => {
  const module = mockModule(0, new Uint8Array([0, 1, 2, 3, 4, 5]));
  assert.throws(() => runTool({
    engine: "qpdf",
    input: validPdf,
    args: ["/input.pdf", "--check", "/output.pdf"],
    tools: toolsWith(module),
  }), /invalid PDF signature/);
});

test("runTool fails closed when the requested engine is not initialized", () => {
  assert.throws(() => runTool({
    engine: "qpdf",
    input: validPdf,
    args: ["/input.pdf", "--check", "/output.pdf"],
    tools: {},
  }), /was not initialized/);
});
