import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  assertCompressionEligible,
  assertDocumentStructureUnchanged,
  assertPageContentStreamsUnchanged,
  hashPageContentStreams,
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
