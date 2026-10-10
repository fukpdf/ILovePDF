import test from "node:test";
import assert from "node:assert/strict";
import { computeUniformTarget, boxResizeRGBA } from "../src/shared/imageMath";
import { parsePlacements } from "../src/shared/placements";
import { estimateJpegQuality, jpegQuantizationProfileNoFiner, readJpegInfo } from "../src/shared/jpeg";

test("aspect ratio is preserved for wide images", () => {
  const t = computeUniformTarget(3000, 1000, 612, 204, 150, 200);
  assert.ok(t.resized);
  assert.ok(Math.abs(t.newWidth / t.newHeight - 3) < 0.01);
  assert.ok(t.newWidth / (612 / 72) >= 199);
});
test("never resamples below the DPI floor or upscales", () => {
  assert.equal(computeUniformTarget(1000, 1000, 400, 400, 150, 200).resized, false);
  assert.equal(computeUniformTarget(300, 300, 600, 600, 150, 150).resized, false);
  const t = computeUniformTarget(2400, 2400, 400, 400, 150, 150);
  assert.ok(t.newWidth / (400 / 72) >= 149);
  assert.equal(computeUniformTarget(5000, 5000, null, null, 150, 150).resized, false);
});
test("box filter averages pixels and rejects upscaling", () => {
  const src = new Uint8Array([0,0,0,255, 100,100,100,255, 200,200,200,255, 100,100,100,255]);
  assert.deepEqual(Array.from(boxResizeRGBA(src,2,2,1,1)),[100,100,100,255]);
  assert.throws(()=>boxResizeRGBA(src,2,2,4,4));
});
test("placement parser follows q/Q and concatenated cm transforms", () => {
  const p = parsePlacements("q 612 0 0 204 0 300 cm /Im1 Do Q q 0.5 0 0 0.5 0 0 cm 200 0 0 100 0 0 cm /Im2 Do Q");
  assert.equal(p.length,2);
  assert.equal(Math.round(p[0].widthPt),612);
  assert.equal(Math.round(p[0].heightPt),204);
  assert.equal(Math.round(p[1].widthPt),100);
  assert.equal(Math.round(p[1].heightPt),50);
});
test("placement parser ignores strings, comments and inline images", () => {
  const p=parsePlacements("BT (fake 1 0 0 1 0 0 cm /X Do) Tj ET % /Y Do\nq 10 0 0 10 0 0 cm BI /W 1 ID abc EI /Z Do Q");
  assert.equal(p.length,1);
  assert.equal(p[0].name,"Z");
});
function fakeJpeg(scale:number, comps=3):Uint8Array {
  const std=[16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
  const table=std.map(v=>Math.max(1,Math.min(255,Math.floor((v*scale+50)/100))));
  const dqt=[0xff,0xdb,0,67,0,...table];
  const sof=[0xff,0xc0,0,8+comps*3,8,0x03,0xe8,0x07,0xd0,comps,...Array.from({length:comps},(_,i)=>[i+1,0x11,0]).flat()];
  return new Uint8Array([0xff,0xd8,...dqt,...sof,0xff,0xda,0,2]);
}
test("JPEG header reader and source-quality estimate",()=>{
  assert.equal(readJpegInfo(fakeJpeg(100))?.width,2000);
  assert.equal(readJpegInfo(fakeJpeg(100))?.height,1000);
  assert.equal(readJpegInfo(fakeJpeg(100))?.components,3);
  assert.ok(Math.abs((estimateJpegQuality(fakeJpeg(50))??0)-75)<=2);
  assert.ok(Math.abs((estimateJpegQuality(fakeJpeg(100))??0)-50)<=2);
  assert.ok(Math.abs((estimateJpegQuality(fakeJpeg(200))??0)-25)<=2);
  assert.equal(readJpegInfo(fakeJpeg(100,1))?.components,1);
});

test("source JPEG quantization profile forbids higher-quality re-encoding",()=>{
  const source=readJpegInfo(fakeJpeg(200));
  const same=readJpegInfo(fakeJpeg(200));
  const lowerQuality=readJpegInfo(fakeJpeg(250));
  const higherQuality=readJpegInfo(fakeJpeg(100));
  assert.ok(source && same && lowerQuality && higherQuality);
  assert.equal(jpegQuantizationProfileNoFiner(source, same), true);
  assert.equal(jpegQuantizationProfileNoFiner(source, lowerQuality), true);
  assert.equal(jpegQuantizationProfileNoFiner(source, higherQuality), false);
});
