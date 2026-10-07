import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

export async function validateOutputBuffer(buffer, mimeType = '') {
  if (!buffer || buffer.length === 0) {
    const err = new Error('Output validation failed: buffer is empty');
    err.code = 'OUTPUT_VALIDATION_FAILED';
    err.reason = 'EMPTY_BUFFER';
    throw err;
  }

  const mime = String(mimeType).toLowerCase();

  // PDF Validation ('application/pdf')
  if (mime.includes('application/pdf') || mime.includes('pdf') || buffer.slice(0, 5).toString('ascii') === '%PDF-') {
    if (buffer.slice(0, 5).toString('ascii') !== '%PDF-') {
      const err = new Error('Output validation failed: invalid PDF magic header');
      err.code = 'OUTPUT_VALIDATION_FAILED';
      err.reason = 'INVALID_PDF_HEADER';
      throw err;
    }
    try {
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      if (doc.getPageCount() < 1) {
        const err = new Error('Output validation failed: PDF contains no pages');
        err.code = 'OUTPUT_VALIDATION_FAILED';
        err.reason = 'ZERO_PAGES';
        throw err;
      }
    } catch (e) {
      const err = new Error('Output validation failed: corrupted PDF structure: ' + e.message);
      err.code = 'OUTPUT_VALIDATION_FAILED';
      err.reason = 'CORRUPT_PDF';
      throw err;
    }
    return true;
  }

  // ZIP / Office XML documents ('application/zip')
  if (
    mime.includes('application/zip') ||
    mime.includes('zip') ||
    mime.includes('word') ||
    mime.includes('excel') ||
    mime.includes('powerpoint') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation')
  ) {
    const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;
    if (!isZip) {
      const err = new Error('Output validation failed: missing ZIP container header');
      err.code = 'OUTPUT_VALIDATION_FAILED';
      err.reason = 'INVALID_ZIP_HEADER';
      throw err;
    }
    try {
      const zip = await JSZip.loadAsync(buffer);
      if (Object.keys(zip.files).length === 0) {
        const err = new Error('Output validation failed: ZIP archive contains no entries');
        err.code = 'OUTPUT_VALIDATION_FAILED';
        err.reason = 'EMPTY_ZIP_ARCHIVE';
        throw err;
      }
    } catch (e) {
      const err = new Error('Output validation failed: corrupted ZIP/Office document: ' + e.message);
      err.code = 'OUTPUT_VALIDATION_FAILED';
      err.reason = 'CORRUPT_ZIP';
      throw err;
    }
    return true;
  }

  // Images ('image/')
  if (mime.includes('image/')) {
    if (mime.includes('jpeg') || mime.includes('jpg')) {
      if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
        const err = new Error('Output validation failed: invalid JPEG header');
        err.code = 'OUTPUT_VALIDATION_FAILED';
        err.reason = 'INVALID_JPEG_HEADER';
        throw err;
      }
      return true;
    }

    if (mime.includes('png')) {
      if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
        const err = new Error('Output validation failed: invalid PNG header');
        err.code = 'OUTPUT_VALIDATION_FAILED';
        err.reason = 'INVALID_PNG_HEADER';
        throw err;
      }
      return true;
    }

    if (mime.includes('webp')) {
      if (buffer.length < 12 || buffer.slice(0, 4).toString('ascii') !== 'RIFF' || buffer.slice(8, 12).toString('ascii') !== 'WEBP') {
        const err = new Error('Output validation failed: invalid WebP header');
        err.code = 'OUTPUT_VALIDATION_FAILED';
        err.reason = 'INVALID_WEBP_HEADER';
        throw err;
      }
      return true;
    }
  }

  return true;
}
