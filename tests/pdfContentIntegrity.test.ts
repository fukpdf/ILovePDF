import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  assertCompressionEligible,
  assertDocumentStructureUnchanged,
  assertPageContentStreamsUnchanged,
  assertRgbImageQuantizationNotFiner,
  assertRgbImageStreamsUnchanged,
  hashPageContentStreams,
  snapshotEligibleRgbImageStreams,
  selectPageContentObjects,
} from "../src/browser/pdfContentIntegrity";

const subtle = webcrypto.subtle as SubtleCrypto;
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

function qpdfJson(content: string, options: { filter?: string; pages?: number; indirectContentsArray?: boolean } = {}): string {
  const pageCount = options.pages ?? 1;
  const objects: Record<string, unknown> = {
    "obj:1 0 R": { value: { "/Type": "/Catalog", "/Pages": "2 0 R" } },
    "obj:2 0 R": { value: { "/Type": "/Pages", "/Kids": pageCount === 1 ? ["3 0 R"] : ["3 0 R", "5 0 R"], "/Count": pageCount } },
    "obj:3 0 R": { value: { "/Type": "/Page", "/Parent": "2 0 R", "/Contents": options.indirectContentsArray ? "6 0 R" : "4 0 R" } },
    "obj:4 0 R": { stream: { dict: options.filter ? { "/Filter": options.filter } : {}, data: encode(content) } },
    trailer: { value: { "/Root": "1 0 R" } },
  };
  if (options.indirectContentsArray) {
    objects["obj:6 0 R"] = { value: ["4 0 R"] };
  }
  if (pageCount > 1) {
    objects["obj:5 0 R"] = { value: { "/Type": "/Page", "/Parent": "2 0 R" } };
  }
  return JSON.stringify({ qpdf: [{ jsonversion: 2, pdfversion: "1.7" }, objects] });
}


function fakeRgbJpeg(scale:number):Uint8Array {
  const std=[16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
  const table=std.map(v=>Math.max(1,Math.min(255,Math.floor((v*scale+50)/100))));
  const dqt=[0xff,0xdb,0,67,0,...table];
  const components=3;
  const sof=[0xff,0xc0,0,8+components*3,8,0x03,0xe8,0x07,0xd0,components,...Array.from({length:components},(_,i)=>[i+1,0x11,0]).flat()];
  return new Uint8Array([0xff,0xd8,...dqt,...sof,0xff,0xda,0,2]);
}
function qpdfJsonWithRgbImage(jpeg:Uint8Array):string {
  const objects:Record<string,unknown>={
    "obj:1 0 R":{value:{"/Type":"/Catalog","/Pages":"2 0 R"}},
    "obj:2 0 R":{value:{"/Type":"/Pages","/Kids":["3 0 R"],"/Count":1}},
    "obj:3 0 R":{value:{"/Type":"/Page","/Parent":"2 0 R","/Contents":"4 0 R"}},
    "obj:4 0 R":{stream:{dict:{},data:encode("q Q")}},
    "obj:9 0 R":{stream:{dict:{"/Subtype":"/Image","/Filter":"/DCTDecode","/ColorSpace":"/DeviceRGB","/Width":2000,"/Height":1000,"/Length":jpeg.length},data:Buffer.from(jpeg).toString("base64")}},
    trailer:{value:{"/Root":"1 0 R"}},
  };
  return JSON.stringify({qpdf:[{jsonversion:2,pdfversion:"1.7"},objects]});
}

test("hashes decoded content streams with SHA-256 in page order", async () => {
  const hashes = await hashPageContentStreams(qpdfJson("BT /F1 12 Tf (Hello) Tj ET"), subtle);
  assert.equal(hashes.pageCount, 1);
  assert.equal(hashes.pages.length, 1);
  assert.equal(hashes.pages[0].length, 1);
  assert.match(hashes.pages[0][0], /^[0-9a-f]{64}$/);
});

test("supports an indirect Contents array", async () => {
  const hashes = await hashPageContentStreams(qpdfJson("q Q", { indirectContentsArray: true }), subtle);
  assert.equal(hashes.pages[0].length, 1);
});

test("rejects streams QPDF has not fully decoded", async () => {
  await assert.rejects(
    () => hashPageContentStreams(qpdfJson("encoded", { filter: "/FlateDecode" }), subtle),
    /did not fully decode/,
  );
});

test("content-stream preservation check accepts identical hashes", () => {
  const same = { pageCount: 1, pages: [["abc"]] };
  assert.doesNotThrow(() => assertPageContentStreamsUnchanged(same, same));
});

test("content-stream preservation check rejects changed streams and page counts", () => {
  assert.throws(
    () => assertPageContentStreamsUnchanged(
      { pageCount: 1, pages: [["before"]] },
      { pageCount: 1, pages: [["after"]] },
    ),
    /changed decoded page content streams on page 1/,
  );
  assert.throws(
    () => assertPageContentStreamsUnchanged(
      { pageCount: 1, pages: [[]] },
      { pageCount: 2, pages: [[], []] },
    ),
    /changed the PDF page count/,
  );
});

test("selects only trailer, catalog, page-tree, page, and content stream objects", () => {
  const selectors = selectPageContentObjects(qpdfJson("q Q"));
  for (const selector of ["trailer", "1,0", "2,0", "3,0", "4,0"]) {
    assert.ok(selectors.includes(selector), `missing selector ${selector}`);
  }
});

test("eligibility gate permits AcroForm only behind whole-object structure verification", () => {
  const parsed = JSON.parse(qpdfJson("q Q"));
  parsed.qpdf[1]["obj:1 0 R"].value["/AcroForm"] = "7 0 R";
  parsed.qpdf[1]["obj:7 0 R"] = { value: { "/Fields": ["8 0 R"] } };
  parsed.qpdf[1]["obj:8 0 R"] = { value: { "/FT": "/Tx", "/T": "CustomerName", "/V": "Safdar" } };
  const source = JSON.stringify(parsed);
  assert.doesNotThrow(() => assertCompressionEligible(source));
  assert.doesNotThrow(() => assertDocumentStructureUnchanged(source, source));

  const changed = JSON.parse(source);
  changed.qpdf[1]["obj:8 0 R"].value["/V"] = "Changed";
  assert.throws(
    () => assertDocumentStructureUnchanged(source, JSON.stringify(changed)),
    /changed document structure object obj:8 0 R/,
  );
});

test("links and annotations are accepted only if their dictionaries remain unchanged", () => {
  const parsed = JSON.parse(qpdfJson("q Q"));
  parsed.qpdf[1]["obj:3 0 R"].value["/Annots"] = ["5 0 R"];
  parsed.qpdf[1]["obj:5 0 R"] = {
    value: { "/Type": "/Annot", "/Subtype": "/Link", "/Rect": [0, 0, 100, 20], "/A": { "/S": "/URI", "/URI": "https://example.invalid" } },
  };
  const source = JSON.stringify(parsed);
  assert.doesNotThrow(() => assertCompressionEligible(source));
  assert.doesNotThrow(() => assertDocumentStructureUnchanged(source, source));

  const changed = JSON.parse(source);
  changed.qpdf[1]["obj:5 0 R"].value["/Rect"][2] = 101;
  assert.throws(
    () => assertDocumentStructureUnchanged(source, JSON.stringify(changed)),
    /changed document structure object obj:5 0 R/,
  );
});


test("eligibility gate detects signature dictionaries hidden in object streams or unreachable objects", () => {
  const parsed = JSON.parse(qpdfJson("q Q"));
  parsed.qpdf[1]["obj:7 0 R"] = {
    value: { "/Type": "/Sig", "/ByteRange": [0, 10, 20, 30] },
  };
  assert.throws(() => assertCompressionEligible(JSON.stringify(parsed)), /unsupported document structure.*ByteRange/);
});

test("eligibility gate rejects XFA and encrypted trailer dictionaries", () => {
  const xfa = JSON.parse(qpdfJson("q Q"));
  xfa.qpdf[1]["obj:7 0 R"] = { value: { "/XFA": "8 0 R" } };
  assert.throws(() => assertCompressionEligible(JSON.stringify(xfa)), /unsupported document structure.*XFA/);

  const encrypted = JSON.parse(qpdfJson("q Q"));
  encrypted.qpdf[1].trailer.value["/Encrypt"] = "9 0 R";
  assert.throws(() => assertCompressionEligible(JSON.stringify(encrypted)), /unsupported document structure.*Encrypt/);
});

test("eligible RGB image streams are byte-identical on QPDF route and never gain finer quantization",async()=>{
  const refs=["obj:9 0 R"];
  const source=await snapshotEligibleRgbImageStreams(qpdfJsonWithRgbImage(fakeRgbJpeg(200)),refs,subtle);
  const same=await snapshotEligibleRgbImageStreams(qpdfJsonWithRgbImage(fakeRgbJpeg(200)),refs,subtle);
  const lower=await snapshotEligibleRgbImageStreams(qpdfJsonWithRgbImage(fakeRgbJpeg(250)),refs,subtle);
  const higher=await snapshotEligibleRgbImageStreams(qpdfJsonWithRgbImage(fakeRgbJpeg(100)),refs,subtle);
  assert.doesNotThrow(()=>assertRgbImageStreamsUnchanged(source,same));
  assert.throws(()=>assertRgbImageStreamsUnchanged(source,lower),/changed RGB image bytes/);
  assert.doesNotThrow(()=>assertRgbImageQuantizationNotFiner(source,lower));
  assert.throws(()=>assertRgbImageQuantizationNotFiner(source,higher),/higher quality than its source/);
});
