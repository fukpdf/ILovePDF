import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import jpeg from "jpeg-js";
import { chromium } from "playwright";

const repoRoot = resolve(process.cwd());
const publicRoot = resolve(repoRoot, "public");
const mime = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
};

function safePath(root, pathname) {
  const file = resolve(root, "." + decodeURIComponent(pathname));
  if (file !== root && !file.startsWith(root + sep)) throw new Error("Path traversal blocked");
  return file;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/__compression-smoke") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>Compression worker smoke test</title><script src=\"/js/compress-worker-adapter.js\"></script><body>local worker smoke test</body>");
      return;
    }
    const root = url.pathname.startsWith("/node_modules/") ? repoRoot : publicRoot;
    const pathname = url.pathname.startsWith("/node_modules/") ? url.pathname : url.pathname;
    const file = safePath(root, pathname);
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (error) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

function makeRgba(width, height, seed) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const wave = Math.round(12 * Math.sin(x / 37) + 9 * Math.cos(y / 29) + 7 * Math.sin((x + y) / 53));
      const grain = ((x * 17 + y * 29 + seed) % 13) - 6;
      data[i] = Math.max(0, Math.min(255, 45 + Math.round(155 * x / width) + wave + grain));
      data[i + 1] = Math.max(0, Math.min(255, 35 + Math.round(165 * y / height) + wave - grain));
      data[i + 2] = Math.max(0, Math.min(255, 90 + Math.round(90 * (x + y) / (width + height)) - wave + grain));
      data[i + 3] = 255;
    }
  }
  return data;
}

function makeJpeg(width, height, seed) {
  return Buffer.from(jpeg.encode({ data: makeRgba(width, height, seed), width, height }, 95).data);
}

async function makeFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const wide = await doc.embedJpg(makeJpeg(2400, 1600, 7));
  const tall = await doc.embedJpg(makeJpeg(1200, 2000, 19));
  const page1 = doc.addPage([612, 792]);
  page1.drawText("Browser-only compression quality gate fixture", { x: 28, y: 752, size: 16, font, color: rgb(0.08, 0.12, 0.18) });
  page1.drawText("Text and vector content must remain identical after compression.", { x: 28, y: 728, size: 11, font });
  page1.drawImage(wide, { x: 0, y: 190, width: 612, height: 408 });
  page1.drawLine({ start: { x: 24, y: 150 }, end: { x: 588, y: 150 }, thickness: 1.2, color: rgb(0.12, 0.35, 0.6) });
  const page2 = doc.addPage([612, 792]);
  page2.drawText("Portrait image and mixed placement dimensions", { x: 28, y: 752, size: 14, font });
  page2.drawImage(tall, { x: 126, y: 95, width: 360, height: 600 });
  page2.drawText("Page 2 text must survive byte-for-byte at the decoded stream level.", { x: 28, y: 50, size: 10, font });
  return new Uint8Array(await doc.save({ useObjectStreams: false, addDefaultPage: false }));
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  }
  return btoa(binary);
}

async function main() {
  const inputBytes = await makeFixture();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const requests = [];
  const requestsWithBodies = [];
  const externalRequests = [];
  try {
    const page = await browser.newPage();
    page.on("request", request => {
      const url = request.url();
      requests.push({ method: request.method(), url });
      const body = request.postDataBuffer();
      if (body && body.length) requestsWithBodies.push({ method: request.method(), url, bodyBytes: body.length });
      try {
        if (url.startsWith("http") && new URL(url).origin !== origin) externalRequests.push(url);
      } catch (_) {}
    });
    await page.goto(origin + "/__compression-smoke", { waitUntil: "load" });
    const result = await page.evaluate(async (inputBase64) => {
      const input = Uint8Array.from(atob(inputBase64), c => c.charCodeAt(0));
      const file = new File([input], "compression-quality-gate-fixture.pdf", { type: "application/pdf" });
      const progress = [];
      const adapter = window.CompressWorkerAdapter;
      if (!adapter || typeof adapter.dispatch !== "function") throw new Error("Dedicated compression worker adapter did not load.");
      const workerResult = await adapter.dispatch(file, { mode: "deep", targetBytes: null }, (percent, text) => {
        progress.push({ percent, text });
      }, { cancelled: false });
      const output = new Uint8Array(workerResult.buffer);
      const pdfjs = await import("/node_modules/pdfjs-dist/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs";
      async function extractText(bytes) {
        const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
        const document = await task.promise;
        let text = "";
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i);
          const content = await page.getTextContent();
          text += content.items.filter(item => "str" in item).map(item => item.str).join("");
          page.cleanup();
        }
        const pageCount = document.numPages;
        await document.destroy();
        return { text, pageCount, nonWhitespaceChars: text.replace(/\s+/g, "").length };
      }
      const inputText = await extractText(input);
      const outputText = await extractText(output);
      let outputBase64 = "";
      for (let i = 0; i < output.length; i += 0x8000) {
        outputBase64 += String.fromCharCode(...output.subarray(i, Math.min(output.length, i + 0x8000)));
      }
      return {
        outputBase64: btoa(outputBase64),
        outputBytes: output.byteLength,
        inputBytes: input.byteLength,
        report: workerResult.report,
        progress,
        inputText,
        outputText,
      };
    }, toBase64(inputBytes));

    const outputBytes = Buffer.from(result.outputBase64, "base64");
    const inputDoc = await PDFDocument.load(inputBytes);
    const outputDoc = await PDFDocument.load(outputBytes);
    assert.equal(outputDoc.getPageCount(), inputDoc.getPageCount(), "page count must remain equal");
    const inPages = inputDoc.getPages();
    const outPages = outputDoc.getPages();
    for (let i = 0; i < inPages.length; i++) {
      const before = inPages[i].getSize();
      const after = outPages[i].getSize();
      assert.ok(Math.abs(before.width - after.width) < 0.01, "page " + (i + 1) + " width changed");
      assert.ok(Math.abs(before.height - after.height) < 0.01, "page " + (i + 1) + " height changed");
    }

    const textRatio = result.outputText.nonWhitespaceChars / Math.max(1, result.inputText.nonWhitespaceChars);
    const report = result.report || {};
    const gate = report.qualityGate;
    const summary = {
      inputBytes: inputBytes.length,
      outputBytes: outputBytes.length,
      savedPercent: Number(((1 - outputBytes.length / inputBytes.length) * 100).toFixed(2)),
      method: report.method || report.engine || "unknown",
      pageCount: outputDoc.getPageCount(),
      textCharsIn: result.inputText.nonWhitespaceChars,
      textCharsOut: result.outputText.nonWhitespaceChars,
      textRetentionPercent: Number((textRatio * 100).toFixed(2)),
      qualityGate: gate || null,
      imageReports: report.images || [],
      progressEvents: result.progress.length,
      requestCount: requests.length,
      requestsWithBodies,
      externalRequests,
    };
    console.log("COMPRESSION_BROWSER_SMOKE_RESULT");
    console.log(JSON.stringify(summary, null, 2));

    assert.ok(outputBytes.length <= inputBytes.length, "engine must never return a larger PDF");
    assert.ok(outputBytes.length < inputBytes.length, "photo fixture should produce a smaller PDF");
    assert.ok(["browser-rgb-image", "ghostscript-quality-gated"].includes(report.method), "photo fixture must exercise a quality-gated image-compression route");
    assert.ok(textRatio >= 0.98, "extracted text retention must be at least 98%");
    assert.ok(gate && gate.passed === true, "real browser quality gate must pass");
    assert.ok(Array.isArray(gate.samples) && gate.samples.length > 0, "quality gate must report rendered page samples");
    assert.ok(result.progress.length >= 2, "worker must report progress");
    assert.equal(requestsWithBodies.length, 0, "no network request may carry a request body or PDF bytes");
    assert.equal(externalRequests.length, 0, "compression smoke page must not make external network requests");

    const cancelResult = await page.evaluate(async (inputBase64) => {
      const input = Uint8Array.from(atob(inputBase64), c => c.charCodeAt(0));
      const file = new File([input], "cancel-fixture.pdf", { type: "application/pdf" });
      const token = { cancelled: false };
      let sawWorkerProgress = false;
      try {
        await window.CompressWorkerAdapter.dispatch(file, { mode: "deep", targetBytes: null }, (percent) => {
          if (percent > 5) {
            sawWorkerProgress = true;
            token.cancelled = true;
          }
        }, token);
        return { cancelled: false, sawWorkerProgress, message: "worker returned output" };
      } catch (error) {
        return { cancelled: /cancel/i.test(String(error && error.message || error)), sawWorkerProgress, message: String(error && error.message || error) };
      }
    }, toBase64(inputBytes));
    assert.ok(cancelResult.cancelled && cancelResult.sawWorkerProgress,
      "active worker cancellation must reject after progress; observed: " + JSON.stringify(cancelResult));
    console.log("PASS: browser-only worker, quality gate, text/page integrity, no-upload network check and cancellation.");
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
