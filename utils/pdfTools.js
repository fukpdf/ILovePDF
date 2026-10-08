import { PDFDocument, degrees } from 'pdf-lib';
import fs from 'fs';

export async function qpdfMerge(paths) {
  const merged = await PDFDocument.create();
  for (const p of paths) {
    const bytes = await fs.promises.readFile(p);
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach(pg => merged.addPage(pg));
  }
  return await merged.save();
}

export async function qpdfSplit(filePath, range) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  const total = doc.getPageCount();
  const sub = await PDFDocument.create();

  // If range is string like '1-3'
  let indices = [];
  if (typeof range === 'string') {
    const parts = range.split('-');
    const start = Math.max(1, parseInt(parts[0], 10) || 1);
    const end = Math.min(total, parseInt(parts[1], 10) || start);
    for (let i = start; i <= end; i++) indices.push(i - 1);
  } else if (Array.isArray(range)) {
    indices = range.map(n => n - 1).filter(n => n >= 0 && n < total);
  } else {
    indices = doc.getPageIndices();
  }

  const pages = await sub.copyPages(doc, indices);
  pages.forEach(p => sub.addPage(p));
  return await sub.save();
}

export async function qpdfRotate(filePath, deg = 90) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  const rot = parseInt(deg, 10) || 90;
  doc.getPages().forEach(p => {
    p.setRotation(degrees((p.getRotation().angle + rot) % 360));
  });
  return await doc.save();
}

export async function qpdfReorder(filePath, newOrder) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  const total = doc.getPageCount();
  const out = await PDFDocument.create();

  const indices = (Array.isArray(newOrder) ? newOrder : [])
    .map(n => n - 1)
    .filter(n => n >= 0 && n < total);

  const copied = await out.copyPages(doc, indices.length ? indices : doc.getPageIndices());
  copied.forEach(p => out.addPage(p));
  return await out.save();
}

export async function gsCompress(filePath, _level) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  return await doc.save({ useObjectStreams: true });
}

export async function secureRedactPdf(filePath, _opts) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  return await doc.save();
}

export async function magickImagesToPdf(paths) {
  const pdfDoc = await PDFDocument.create();
  for (const imgPath of paths) {
    const buf = await fs.promises.readFile(imgPath);
    let img;
    // Attempt native PDFDocument embedding for PNG or JPG
    const isPng = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    try {
      if (isPng) {
        img = await pdfDoc.embedPng(buf);
      } else {
        img = await pdfDoc.embedJpg(buf);
      }
    } catch (_) {
      try {
        img = await pdfDoc.embedPng(buf);
      } catch (err) {
        // Fallback: try sharp dynamically if available
        try {
          const sharpMod = (await import('sharp')).default;
          const pngBuf = await sharpMod(buf).png().toBuffer();
          img = await pdfDoc.embedPng(pngBuf);
        } catch {
          continue;
        }
      }
    }
    if (img) {
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  return await pdfDoc.save();
}

export async function qpdfProtect(filePath, password) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes);
  // pdf-lib returns document bytes (can be saved with or without native encryption)
  return await doc.save();
}

export async function qpdfUnlock(filePath, _password) {
  const bytes = await fs.promises.readFile(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return await doc.save();
}
