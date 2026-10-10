import test from "node:test";
import assert from "node:assert/strict";
import { runJsonTool, runTool, type EmModule, type WasmTools } from "../src/browser/wasmCli";

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


function mockJsonModule(json: string, exitCode = 0): EmModule {
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
      assert.ok(files.has("/input.pdf"));
      files.set(args[args.length - 1], new TextEncoder().encode(json));
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

test("runTool accepts Ghostscript's -sOutputFile output argument", () => {
  const module = mockModule(0);
  const result = runTool({
    engine: "ghostscript",
    input: validPdf,
    args: ["-sDEVICE=pdfwrite", "-sOutputFile=/output.pdf", "/input.pdf"],
    tools: { ghostscript: module },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual([...result.output], [...validPdf]);
  assert.equal(module.FS.analyzePath?.("/input.pdf").exists, false);
  assert.equal(module.FS.analyzePath?.("/output.pdf").exists, false);
});

test("runTool rejects a command that omits the configured output path", () => {
  const module = mockModule(0);
  assert.throws(() => runTool({
    engine: "qpdf",
    input: validPdf,
    args: ["/input.pdf", "--check"],
    tools: { qpdf: module },
  }), /must include input and output paths/);
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

test("runJsonTool validates QPDF JSON and cleans temporary files", () => {
  const module = mockJsonModule(JSON.stringify({ qpdf: [{ jsonversion: 2 }, {}] }));
  const result = runJsonTool({
    engine: "qpdf",
    input: validPdf,
    args: ["--json", "--json-stream-data=none", "/input.pdf", "/output.json"],
    outputPath: "/output.json",
    tools: { qpdf: module },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.json).qpdf[0], { jsonversion: 2 });
  assert.equal(module.FS.analyzePath?.("/input.pdf").exists, false);
  assert.equal(module.FS.analyzePath?.("/output.json").exists, false);
});

test("runJsonTool rejects malformed JSON and cleans temporary files", () => {
  const module = mockJsonModule("not-json");
  assert.throws(() => runJsonTool({
    engine: "qpdf",
    input: validPdf,
    args: ["--json", "/input.pdf", "/output.json"],
    outputPath: "/output.json",
    tools: { qpdf: module },
  }), /invalid JSON inspection output/);
  assert.equal(module.FS.analyzePath?.("/input.pdf").exists, false);
  assert.equal(module.FS.analyzePath?.("/output.json").exists, false);
});
