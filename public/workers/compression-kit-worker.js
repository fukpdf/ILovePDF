import { compressLosslessly } from "/js/compression-kit.js?v=20261010-qpdf-lossless-kit-v1";

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type !== "compress" || !(Number.isInteger(message.id) || (typeof message.id === "string" && message.id.length > 0))) return;
  const id = message.id;
  try {
    if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength === 0) {
      throw new Error("Compression worker received an empty PDF buffer.");
    }
    if (message.mode !== "deep" && message.mode !== "custom") {
      throw new Error("Compression mode is missing or invalid.");
    }
    const input = new Uint8Array(message.buffer);
    const result = await compressLosslessly(input, {
      mode: message.mode,
      targetBytes: Number.isSafeInteger(message.targetBytes) ? message.targetBytes : null,
      qpdfWasmUrl: "/vendor/compression/qpdf.wasm?v=20261010-qpdf-lossless-kit-v1",
      ghostscriptWasmUrl: "/vendor/compression/gs.wasm?v=20261010-qpdf-lossless-kit-v1",
      onProgress(stage, text) {
        self.postMessage({ id, type: "progress", stage, text });
      },
    });
    const outputBuffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    );
    self.postMessage(
      { id, type: "result", buffer: outputBuffer, report: result.report },
      [outputBuffer],
    );
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : "Compression worker failed.",
    });
  }
});
