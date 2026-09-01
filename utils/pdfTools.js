// Thin wrappers around qpdf / Ghostscript / ImageMagick.
// Each exported function returns a Promise that resolves to a Buffer of the
// resulting PDF. If the system tool is missing or fails, the caller can fall
// back to its existing pdf-lib / sharp implementation.
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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
