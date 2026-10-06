// Thin wrappers around qpdf / Ghostscript / ImageMagick.
// Each exported function returns a Promise that resolves to a Buffer of the
// resulting PDF. If the system tool is missing or fails, the caller can fall
// back to its existing pdf-lib / sharp implementation.
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { UPLOAD_DIR } from './upload.js';

const TIMEOUT_MS = 90 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;

function tmpOut(ext = 'pdf') {
  return path.join(UPLOAD_DIR, `out-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString() || '';
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readAndUnlink(p) {
  const buf = await fs.promises.readFile(p);
  fs.promises.unlink(p).catch(() => {});
  return buf;
}

export async function qpdfMerge(inputPaths) {
  const out = tmpOut();
  await run('qpdf', ['--empty', '--pages', ...inputPaths, '--', out]);
  return readAndUnlink(out);
}

export async function qpdfSplit(inputPath, range) {
  const out = tmpOut();
  await run('qpdf', [inputPath, '--pages', inputPath, range, '--', out]);
  return readAndUnlink(out);
}

export async function qpdfRotate(inputPath, degrees = 90, scope = 'all') {
  const out = tmpOut();
  const rotateArg = `--rotate=+${degrees}:${scope === 'all' ? '1-z' : scope}`;
  await run('qpdf', [rotateArg, inputPath, out]);
  return readAndUnlink(out);
}

export async function qpdfReorder(inputPath, orderArray) {
  const out = tmpOut();
  const range = orderArray.join(',');
  await run('qpdf', ['--empty', '--pages', inputPath, range, '--', out]);
  return readAndUnlink(out);
}

export async function qpdfProtect(inputPath, userPwd, ownerPwd = userPwd) {
  const out = tmpOut();
  await run('qpdf', ['--encrypt', userPwd, ownerPwd, '256', '--', inputPath, out]);
  return readAndUnlink(out);
}

export async function qpdfUnlock(inputPath, password = '') {
  const out = tmpOut();
  await run('qpdf', [`--password=${password}`, '--decrypt', inputPath, out]);
  return readAndUnlink(out);
}

export async function secureRedactPdf(inputPath, options = {}) {
  const dpi = 150;
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ilovepdf-redact-'));
  try {
    const outputPattern = path.join(workDir, 'page-%04d.png');
    await run('gs', [
      '-dSAFER', '-dBATCH', '-dNOPAUSE',
      '-sDEVICE=png16m', `-r${dpi}`,
      `-sOutputFile=${outputPattern}`,
      inputPath,
    ]);

    const pageFiles = (await fs.promises.readdir(workDir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (!pageFiles.length) throw new Error('No pages could be rendered for redaction.');

    const pageSpec = String(options.pages || 'all').trim().toLowerCase();
    const selected = new Set();
    if (pageSpec === 'all' || pageSpec === '*') {
      pageFiles.forEach((_, index) => selected.add(index));
    } else {
      for (const part of pageSpec.split(',').map((value) => value.trim()).filter(Boolean)) {
        const match = part.match(/^(\d+)(?:-(\d+))?$/);
        if (!match) throw new Error('Enter valid page numbers for redaction.');
        const first = Number(match[1]);
        const last = Number(match[2] || match[1]);
        if (first < 1 || last < first || last > pageFiles.length) {
          throw new Error('A selected redaction page is outside this document.');
        }
        for (let page = first; page <= last; page++) selected.add(page - 1);
      }
    }
    if (!selected.size) throw new Error('Select at least one page to redact.');

    const percent = (value, fallback, min, max) => {
      const parsed = Number(value);
      const number = Number.isFinite(parsed) ? parsed : fallback;
      return Math.min(max, Math.max(min, number)) / 100;
    };
    const x = percent(options.x, 10, 0, 99);
    const y = percent(options.y, 40, 0, 99);
    const width = Math.min(percent(options.width, 30, 1, 100), 1 - x);
    const height = Math.min(percent(options.height, 10, 1, 100), 1 - y);
    const output = await PDFDocument.create();

    for (let index = 0; index < pageFiles.length; index++) {
      const source = await fs.promises.readFile(path.join(workDir, pageFiles[index]));
      const metadata = await sharp(source).metadata();
      if (!metadata.width || !metadata.height) throw new Error('A rendered page could not be read.');

      let rendered = source;
      if (selected.has(index)) {
        const left = Math.floor(metadata.width * x);
        const top = Math.floor(metadata.height * y);
        const rectWidth = Math.max(1, Math.floor(metadata.width * width));
        const rectHeight = Math.max(1, Math.floor(metadata.height * height));
        const overlay = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${metadata.width}" height="${metadata.height}"><rect x="${left}" y="${top}" width="${rectWidth}" height="${rectHeight}" fill="#000"/></svg>`
        );
        rendered = await sharp(source).composite([{ input: overlay }]).png().toBuffer();
      }

      const image = await output.embedPng(rendered);
      const pageWidth = metadata.width * 72 / dpi;
      const pageHeight = metadata.height * 72 / dpi;
      const page = output.addPage([pageWidth, pageHeight]);
      page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    }

    const bytes = Buffer.from(await output.save({ useObjectStreams: true }));
    const verified = await PDFDocument.load(bytes);
    if (verified.getPageCount() !== pageFiles.length) {
      throw new Error('The redacted PDF failed its page-count check.');
    }
    return bytes;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

export async function gsCompress(inputPath, quality = 'ebook') {
  const out = tmpOut();
  await run('gs', [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=/${quality}`,
    '-dNOPAUSE', '-dQUIET', '-dBATCH',
    `-sOutputFile=${out}`,
    inputPath,
  ]);
  return readAndUnlink(out);
}

export async function magickImagesToPdf(inputPaths) {
  const out = tmpOut();
  const bin = await which('magick').catch(() => 'convert');
  await run(bin, [...inputPaths, out]);
  return readAndUnlink(out);
}

function which(name) {
  return new Promise((resolve, reject) => {
    execFile('which', [name], (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

export function hasBinary(name) {
  try {
    const r = execFileSync('which', [name], { stdio: ['ignore','pipe','ignore'] });
    return !!r.toString().trim();
  } catch { return false; }
}
