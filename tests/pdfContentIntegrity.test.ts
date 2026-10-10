import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  assertPageContentStreamsUnchanged,
  hashPageContentStreams,
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
