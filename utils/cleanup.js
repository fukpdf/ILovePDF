import fs from 'fs';
import { validateOutputBuffer } from './output-validator.js';
import { registerTempArtifact, releaseTempArtifact } from './file-lifecycle.js';

export function cleanupFiles(files) {
  if (!files) return;
  const list = Array.isArray(files) ? files : Object.values(files).flat();
  for (const f of list) {
    const p = typeof f === 'string' ? f : f?.path;
    if (p) {
      const artId = registerTempArtifact(p, { kind: 'upload' });
      setTimeout(() => {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (_) {}
        releaseTempArtifact(artId);
      }, 8000);
    }
  }
}

export async function sendPdf(res, buffer, filename = 'document.pdf') {
  try {
    await validateOutputBuffer(buffer, 'application/pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[output-validation] PDF rejected:', filename, err.reason || err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Generated PDF failed structural validation.' });
    }
  }
}

export async function sendEncryptedPdf(res, buffer, filename = 'protected.pdf') {
  return sendPdf(res, buffer, filename);
}
