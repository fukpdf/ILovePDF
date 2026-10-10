import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { judgeSample, pickSamplePages, textCheck, type GateReport } from "../shared/quality";

export function configurePdfJs(workerSrc: string): void {
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
}
configurePdfJs(pdfWorkerUrl);

interface Gray { w: number; h: number; px: Uint8Array; }
async function renderGray(doc: pdfjs.PDFDocumentProxy, pageNo: number, dpi: number): Promise<Gray> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  if (width * height > 16_000_000) throw new Error("Quality-gate sample exceeds the safe pixel budget.");
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OffscreenCanvas 2D context is unavailable in the compression worker.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
  const rgba = context.getImageData(0, 0, width, height).data;
  const pixels = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
    pixels[i] = Math.round((rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000);
  }
  return { w: width, h: height, px: pixels };
}
async function textChars(doc: pdfjs.PDFDocumentProxy): Promise<number> {
  let count = 0;
  for (let page = 1; page <= doc.numPages; page++) {
    const text = await (await doc.getPage(page)).getTextContent();
    for (const item of text.items) if ("str" in item) count += item.str.replace(/\s+/g, "").length;
  }
  return count;
}

export async function qualityGateInBrowser(
  original: Uint8Array,
  candidate: Uint8Array,
  opts: { minPsnrDb: number; minSharpnessRatio: number; sampleDpi?: number; maxSamplePages?: number },
): Promise<GateReport> {
  const report: GateReport = { passed: false, pagesIn: 0, pagesOut: 0, textCharsIn: 0, textCharsOut: 0, samples: [], failures: [], notes: [] };
  let before: pdfjs.PDFDocumentProxy | undefined, after: pdfjs.PDFDocumentProxy | undefined;
  try {
    before = await pdfjs.getDocument({ data: original.slice() }).promise;
    after = await pdfjs.getDocument({ data: candidate.slice() }).promise;
    report.pagesIn = before.numPages; report.pagesOut = after.numPages;
    if (before.numPages !== after.numPages) {
      report.failures.push(`page count ${before.numPages} -> ${after.numPages}`);
      return report;
    }
    report.textCharsIn = await textChars(before);
    report.textCharsOut = await textChars(after);
    textCheck(report.textCharsIn, report.textCharsOut, report.failures, report.notes);
    for (const page of pickSamplePages(before.numPages, opts.maxSamplePages ?? 5)) {
      const dpi = Math.max(100, opts.sampleDpi ?? 100);
      judgeSample(page, await renderGray(before, page, dpi), await renderGray(after, page, dpi),
        opts.minPsnrDb, opts.minSharpnessRatio, report);
    }
    report.passed = report.failures.length === 0;
  } catch (error) {
    report.failures.push(`quality gate error: ${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await before?.destroy();
    await after?.destroy();
  }
  return report;
}
