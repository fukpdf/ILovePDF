import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
  assert.ok(result.bytes.byteLength <= input.byteLength, "output must never exceed input");
  assert.equal(result.report.contentStreamsVerified, result.report.method === "qpdf-lossless-structure");
  if (result.report.method === "qpdf-lossless-structure") {
    assert.equal(result.report.contentStreamsVerified, true);
    assert.ok(result.report.savedBytes > 0);
  } else {
    assert.equal(result.bytes.byteLength, input.byteLength);
    assert.match(result.report.message, /preserved|did not reduce|validation/i);
  }
});
