import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loadWasmTool, runTool, type WasmLocate } from "../src/browser/wasmCli";

const locate: WasmLocate = {
  ghostscriptWasmUrl: resolve(process.cwd(), "node_modules/@jspawn/ghostscript-wasm/gs.wasm"),
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
  assert.equal(typeof module.FS.unlink, "function");
});

async function smokePdf(): Promise<Uint8Array> {
  const doc=await PDFDocument.create(),page=doc.addPage([300,200]),font=await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Local WASM CLI smoke test",{x:24,y:150,size:14,font});
  return new Uint8Array(await doc.save({useObjectStreams:false,updateMetadata:false}));
}

test("published QPDF-WASM executes a real CLI transformation in its virtual FS", async () => {
  const module=await loadWasmTool("qpdf",locate),input=await smokePdf();
  const result=await runTool({
    engine:"qpdf",input,inputPath:"/input.pdf",outputPath:"/output.pdf",
    args:["--object-streams=generate","/input.pdf","/output.pdf"],
    tools:{qpdf:module},
  });
  assert.ok(result.output.byteLength>5);
  assert.equal(new TextDecoder().decode(result.output.subarray(0,5)),"%PDF-");
});

test("published Ghostscript-WASM executes a real pdfwrite CLI transformation in its virtual FS", async () => {
  const module=await loadWasmTool("ghostscript",locate),input=await smokePdf();
  const result=await runTool({
    engine:"ghostscript",input,inputPath:"/input.pdf",outputPath:"/output.pdf",
    args:["-sDEVICE=pdfwrite","-dNOPAUSE","-dBATCH","-dSAFER","-dCompatibilityLevel=1.7","-sOutputFile=/output.pdf","/input.pdf"],
    tools:{ghostscript:module},
  });
  assert.ok(result.output.byteLength>5);
  assert.equal(new TextDecoder().decode(result.output.subarray(0,5)),"%PDF-");
});
