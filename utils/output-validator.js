import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

function startsWithBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function isZipBuffer(buffer) {
  return ZIP_MAGIC.some(signature => startsWithBytes(buffer, signature));
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPng(buffer) {
  return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isGif(buffer) {
  return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
}

function isWebp(buffer) {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function isBmp(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

function isTiff(buffer) {
  return startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a]);
}

function fail(reason) {
  const error = new Error('Generated output failed structural validation.');
  error.code = 'OUTPUT_VALIDATION_FAILED';
  error.reason = reason;
  throw error;
}

/**
 * Validate generated output before it is delivered to a user.
 *
 * This is intentionally structural rather than semantic: it confirms that
 * the generated artifact has the expected container/signature and, for PDFs,
 * can actually be parsed and contains at least one page.
 */
export async function validateOutputBuffer(bytes, contentType = '') {
  const buffer = Buffer.from(bytes || []);
  if (!buffer.length) fail('empty-output');

  const type = String(contentType).toLowerCase().split(';', 1)[0].trim();

  if (type === 'application/pdf' || buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) fail('pdf-signature');
    try {
      const doc = await PDFDocument.load(buffer, { updateMetadata: false });
      if (doc.getPageCount() < 1) fail('pdf-no-pages');
      return { valid: true, kind: 'pdf', pages: doc.getPageCount(), bytes: buffer.length };
    } catch (error) {
      if (error?.code === 'OUTPUT_VALIDATION_FAILED') throw error;
      fail('pdf-parse');
    }
  }

  const officeTypes = new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip',
  ]);

  if (officeTypes.has(type)) {
    if (!isZipBuffer(buffer)) fail('zip-signature');
    try {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.keys(zip.files);
      if (!entries.length) fail('zip-empty');
      return { valid: true, kind: 'zip', entries: entries.length, bytes: buffer.length };
    } catch (error) {
      if (error?.code === 'OUTPUT_VALIDATION_FAILED') throw error;
      fail('zip-parse');
    }
  }

  if (type === 'image/jpeg' && !isJpeg(buffer)) fail('jpeg-signature');
  if (type === 'image/png' && !isPng(buffer)) fail('png-signature');
  if (type === 'image/gif' && !isGif(buffer)) fail('gif-signature');
  if (type === 'image/webp' && !isWebp(buffer)) fail('webp-signature');
  if (type === 'image/bmp' && !isBmp(buffer)) fail('bmp-signature');
  if (type === 'image/tiff' && !isTiff(buffer)) fail('tiff-signature');

  if (type === 'application/json') {
    try {
      JSON.parse(buffer.toString('utf8'));
    } catch (_) {
      fail('json-parse');
    }
  }

  return { valid: true, kind: type || 'unknown', bytes: buffer.length };
}
