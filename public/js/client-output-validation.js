/* Shared client output validation boundary — browser-only. */
(function (G) {
  'use strict';
  if (G.ClientOutputValidation) return;

  const VERSION = '1.1.0';

  function toBytes(output) {
    if (output instanceof ArrayBuffer) return new Uint8Array(output);
    if (ArrayBuffer.isView(output)) return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
    if (output instanceof Blob) return null;
    throw new TypeError('Processing output must be a Blob, ArrayBuffer, or typed array');
  }

  function signature(bytes, offset, values) {
    if (!bytes || bytes.length < offset + values.length) return false;
    for (let i = 0; i < values.length; i++) if (bytes[offset + i] !== values[i]) return false;
    return true;
  }

  function validate(output, options) {
    const o = options || {};
    const size = output instanceof Blob ? output.size :
      output instanceof ArrayBuffer ? output.byteLength :
      ArrayBuffer.isView(output) ? output.byteLength : -1;
    if (size < 0) throw new TypeError('Unsupported processing output');
    if (size === 0) throw new Error('processing_output_empty');

    // Output validation must not impose a product file-size ceiling. Memory
    // safety is handled by streaming/backpressure and runtime emergency guards.
    const maxBytes = Number(o.maxBytes);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) {
      throw new Error('processing_output_too_large');
    }

    const bytes = toBytes(output);
    if (bytes && o.mime) {
      const mime = String(o.mime).toLowerCase();
      if (mime === 'application/pdf' && !signature(bytes, 0, [0x25,0x50,0x44,0x46,0x2D])) {
        throw new Error('processing_output_invalid_pdf_signature');
      }
      if (mime === 'image/png' && !signature(bytes, 0, [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])) {
        throw new Error('processing_output_invalid_png_signature');
      }
      if (mime === 'image/jpeg' && !signature(bytes, 0, [0xFF,0xD8,0xFF])) {
        throw new Error('processing_output_invalid_jpeg_signature');
      }
      if (mime === 'application/zip' ||
          mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        if (!signature(bytes, 0, [0x50,0x4B,0x03,0x04]) && !signature(bytes, 0, [0x50,0x4B,0x05,0x06])) {
          throw new Error('processing_output_invalid_zip_signature');
        }
      }
    }

    if (typeof o.invariant === 'function') {
      const ok = o.invariant(output);
      if (ok === false) throw new Error('processing_output_invariant_failed');
    }
    return Object.freeze({ size, mime: o.mime || '', validated: true });
  }

  // No default output-size ceiling. maxBytes remains an explicit caller-level
  // policy hook for contexts that intentionally require a bounded artifact.
  G.ClientOutputValidation = Object.freeze({ VERSION, validate });
}(window));