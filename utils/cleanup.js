import fs from 'fs';
import { registerTempArtifact, releaseTempArtifact } from './file-lifecycle.js';
import { validateOutputBuffer } from './output-validator.js';

export function cleanupFiles(...files) {
  const allFiles = files.flat().filter(Boolean);
  const entries = allFiles.map(file => {
    const filePath = typeof file === 'string' ? file : file?.path;
    if (!filePath) return null;
    return { filePath, id: registerTempArtifact(filePath, { kind: 'response-artifact' }) };
  }).filter(Boolean);

  setTimeout(() => {
    entries.forEach(({ filePath, id }) => {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlink(filePath, err => {
          if (err) console.error('Cleanup error:', err.message);
          if (id) releaseTempArtifact(id);
        });
      } else if (id) {
        releaseTempArtifact(id);
      }
    });
  }, 8000);
}

export async function sendPdf(res, bytes, filename = 'output.pdf') {
  try {
    const buffer = Buffer.from(bytes || []);
    await validateOutputBuffer(buffer, 'application/pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[output-validation] PDF rejected:', err.reason || err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Generated PDF failed structural validation.' });
    }
  }
}

export function placeholder(res, toolName) {
  return res.status(501).json({
    coming_soon: true,
    message: `${toolName} is coming soon and is currently in development.`
  });
}
