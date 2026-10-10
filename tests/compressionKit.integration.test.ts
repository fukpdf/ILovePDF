import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loadWasmTool, runTool } from "../src/browser/wasmCli";
import { compressLosslessly } from "../src/browser/compressionKit";

test("QPDF WASM lossless pass preserves decoded content streams in a 100-page PDF", async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 100; i++) {
    const page = source.addPage([612, 792]);
    page.drawText(`Page ${i} — lossless compression fixture`, {
      x: 48,
      y: 744,
      size: 12,
      font,
    });
    page.drawText("Repeated body text used to make object-stream compaction measurable.", {
      x: 48,
      y: 710,
      size: 10,
      font,
    });
  }
  const input = new Uint8Array(await source.save({ useObjectStreams: false }));
  const result = await compressLosslessly(input, {
    mode: "deep",
    qpdfWasmUrl: resolve(process.cwd(), "node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
  });

  assert.equal(result.bytes[0], 0x25);
  assert.equal(result.bytes[1], 0x50);
  assert.equal(result.bytes[2], 0x44);
  assert.equal(result.bytes[3], 0x46);
  assert.equal(result.bytes[4], 0x2d);
  assert.ok(result.bytes.byteLength < input.byteLength, "100-page fixture should benefit from object-stream compaction");
  assert.equal(result.report.method, "qpdf-lossless-structure");
  assert.equal(result.report.contentStreamsVerified, true);
  assert.ok(result.report.savedBytes > 0);
  assert.equal(result.report.outputBytes, result.bytes.byteLength);
});

test("AcroForm PDFs stay on the lossless QPDF-only route", async () => {
  const source=await PDFDocument.create(),page=source.addPage([612,792]),form=source.getForm();
  const field=form.createTextField("customer.name");field.setText("Ada Lovelace");field.addToPage(page,{x:48,y:700,width:240,height:24});
  const input=new Uint8Array(await source.save({useObjectStreams:false,updateMetadata:false}));
  const result=await compressLosslessly(input,{
    mode:"deep",
    qpdfWasmUrl:resolve(process.cwd(),"node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
    ghostscriptWasmUrl:"/deliberately-not-loaded/gs.wasm",
  });
  assert.ok(result.bytes.byteLength<=input.byteLength);
  const output=await PDFDocument.load(result.bytes,{updateMetadata:false});
  assert.equal(output.getForm().getFields().length,1);
  assert.ok(!result.report.warnings?.some(w=>/Ghostscript-WASM only|Ghostscript pass failed/i.test(w)),
    "AcroForm route must not initialize Ghostscript");
});

test("encrypted PDF bytes are returned unchanged", async () => {
  const source=await PDFDocument.create(),page=source.addPage([612,792]),font=await source.embedFont(StandardFonts.Helvetica);
  page.drawText("Encrypted preservation fixture",{x:48,y:720,font,size:14});
  const plain=new Uint8Array(await source.save({useObjectStreams:false,updateMetadata:false}));
  const qpdf=await loadWasmTool("qpdf",{
    qpdfWasmUrl:resolve(process.cwd(),"node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
    ghostscriptWasmUrl:resolve(process.cwd(),"node_modules/@jspawn/ghostscript-wasm/gs.wasm"),
  });
  const encrypted=await runTool({
    engine:"qpdf",input:plain,inputPath:"/plain.pdf",outputPath:"/encrypted.pdf",
    args:["--encrypt","user-pass","owner-pass","256","--","/plain.pdf","/encrypted.pdf"],
    tools:{qpdf},
  });
  const result=await compressLosslessly(encrypted.output,{
    mode:"deep",
    qpdfWasmUrl:resolve(process.cwd(),"node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
  });
  assert.deepEqual(Array.from(result.bytes),Array.from(encrypted.output),
    "encrypted PDFs must never be rewritten, even when the parser rejects them");
  assert.equal(result.report.method,"original-preserved");
});
