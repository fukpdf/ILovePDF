import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { PDFDocument, StandardFonts } from "pdf-lib";
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
  const input=new Uint8Array(await source.save({useObjectStreams:false}));
  const result=await compressLosslessly(input,{
    mode:"deep",
    qpdfWasmUrl:resolve(process.cwd(),"node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm"),
    ghostscriptWasmUrl:"/deliberately-not-loaded/gs.wasm",
  });
  assert.ok(result.bytes.byteLength<=input.byteLength);
  const output=await PDFDocument.load(result.bytes);
  assert.equal(output.getForm().getFields().length,1);
  assert.ok(!result.report.warnings?.some(w=>/Ghostscript-WASM only|Ghostscript pass failed/i.test(w)),
    "AcroForm route must not initialize Ghostscript");
});

const ENCRYPTED_PDF_B64 = "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDI1OTQxZTE2ZDhiNWFjYzNiMDk5OTg5MWNiMGVjYzcxZDA5NWZlNmVlYTJiYzJiOTg4NzRhNDk4MWUxZDk5OWQ+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9Db250ZW50cyA1IDAgUgovTWVkaWFCb3ggWyAwIDAgNjEyIDc5MiBdCi9SZXNvdXJjZXMgPDwKL0ZvbnQgNiAwIFIKL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4KL1JvdGF0ZSAwCi9UcmFucyA8PAo+PgovVHlwZSAvUGFnZQovUGFyZW50IDIgMCBSCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXQovTGVuZ3RoIDE2MAo+PgpzdHJlYW0K1puyOt1rXsgeJvFVCMfGdEg2I1ZXLQik/8tdCE86Ea+HX0TU6dAt3bDyAGorh+gYP2GMaU8stFSgz5yb8srXhrpO+DJVyAfycp1zEB9u9JaigxCzFQSreev1WgzLcNIBwA1mtV1I5pxaxCBOJ10NnW8KeKwjPBELx0+D79qZROAmz16qG+m3VoF1MAjzVpf37feSl8T2VyPZuGfVL9a1AgplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwKL0YxIDcgMCBSCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhCi9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nCi9OYW1lIC9GMQovU3VidHlwZSAvVHlwZTEKL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjggMCBvYmoKPDwKL1YgNQovUiA2Ci9MZW5ndGggMjU2Ci9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDU5NDExMzVmYzY0YjdmNjk1OTliMGQwZTYwZWJkNDE5MTU1NmZmYzI4ZWFhYzRiZmJjNTIxY2QzMGI2MjBiNDA3MDQyYjM2ODY1MTZhYzA5NjViYTFhODBjNjk0YWFjOD4KL1UgPDQ4YjIxZDhmMTc0MDA1ZDg3YzdlZDc2MGU2NWM3YTdlMjI1ZjE3YzUxNGQ1MDRiZmY5ZmRiNjNiYzczMzJmZmFhM2U2ODIxNTc0MWVkNWVmMjg3NmFmMWU3YjkzYjJhMD4KL0NGIDw8Ci9TdGRDRiA8PAovQXV0aEV2ZW50IC9Eb2NPcGVuCi9DRk0gL0FFU1YzCi9MZW5ndGggMzIKPj4KPj4KL1N0bUYgL1N0ZENGCi9TdHJGIC9TdGRDRgovT0UgPDU4MWViZDFiZDRlM2M4ZDdkZGJhYzQ3ZGIwZjYzNjRjZmJhYzkwNzQ3MDE5YzJjYzc2MDZlMjNmYTQzMzg2M2I+Ci9VRSA8YWEyOGEwMjk3NzIyYzVmN2U1ZDZjYWUzZmFkMmViODhkNjkzZmQ3NTM0OTBlZjM1ZDkxZmMzMmI2NTdkMGRmMj4KL1Blcm1zIDw5OWUxZDgyNTU3M2Y1ZTNjZjllYTRmNDc1ZjEyNTZmNz4KPj4KZW5kb2JqCnhyZWYKMCA5CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNzIgMDAwMDAgbiAKMDAwMDAwMDIyMSAwMDAwMCBuIAowMDAwMDAwNDEwIDAwMDAwIG4gCjAwMDAwMDA2NjEgMDAwMDAgbiAKMDAwMDAwMDY5MiAwMDAwMCBuIAowMDAwMDAwNzk5IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgOQovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzIzNTMwMzQ2NDYxMzMzOTY2MzQzODM2NjQzNTMzMzkzNjY2NjQzNjYzNjEzNzY2NjIzMjY1NjUzNTY0MzUzOT4gPDMyMzUzMDM0NjQ2MTMzMzk2NjM0MzgzNjY0MzUzMzM5MzY2NjY0MzY2MzYxMzc2NjYyMzI2NTY1MzU2NDM1Mzk+IF0KL0VuY3J5cHQgOCAwIFIKPj4Kc3RhcnR4cmVmCjEzNTQKJSVFT0YK";

test("encrypted PDF bytes are returned unchanged", async () => {
  const encrypted = new Uint8Array(Buffer.from(ENCRYPTED_PDF_B64,"base64"));
  assert.ok(encrypted.includes(0x25) && new TextDecoder().decode(encrypted).includes("/Encrypt"),
    "fixture must contain a real PDF encryption dictionary");
  const result=await compressLosslessly(encrypted,{mode:"deep"});
  assert.deepEqual(Array.from(result.bytes),Array.from(encrypted),
    "encrypted PDFs must never be rewritten, even when the parser rejects them");
  assert.equal(result.report.method,"original-preserved");
});
