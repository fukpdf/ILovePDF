// Thin wrappers around qpdf / Ghostscript / ImageMagick.
// Each exported function returns a Promise that resolves to a Buffer of the
// resulting PDF. If the system tool is missing or fails, the caller can fall
// back to its existing pdf-lib / sharp implementation.
import { execFile } from 'child_process';
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

// ── qpdf operations ────────────────────────────────────────────────────────

// Merge multiple PDFs in given order
export async function qpdfMerge(inputPaths) {
  const out = tmpOut();
  // qpdf --empty --pages a.pdf b.pdf -- out.pdf
  await run('qpdf', ['--empty', '--pages', ...inputPaths, '--', out]);
  return readAndUnlink(out);
}

// Split: extract pages described by a qpdf range string ("1-3,5,7-9")
export async function qpdfSplit(inputPath, range) {
  const out = tmpOut();
  await run('qpdf', [inputPath, '--pages', inputPath, range, '--', out]);
  return readAndUnlink(out);
}

// Rotate: degrees 90/180/270, scope "all" or qpdf range string
export async function qpdfRotate(inputPath, degrees = 90, scope = 'all') {
  const out = tmpOut();
  // --rotate=+90:1-z   (always passes scope)
  const rotateArg = `--rotate=+${degrees}:${scope === 'all' ? '1-z' : scope}`;
  await run('qpdf', [rotateArg, inputPath, out]);
  return readAndUnlink(out);
}

// Reorder pages: orderArray is 1-indexed page numbers in desired order
export async function qpdfReorder(inputPath, orderArray) {
  const out = tmpOut();
  const range = orderArray.join(',');
  await run('qpdf', ['--empty', '--pages', inputPath, range, '--', out]);
  return readAndUnlink(out);
}

// Encrypt with user/owner password (AES-256)
export async function qpdfProtect(inputPath, userPwd, ownerPwd = userPwd) {
  const out = tmpOut();
  await run('qpdf', ['--encrypt', userPwd, ownerPwd, '256', '--', inputPath, out]);
  return readAndUnlink(out);
}

// Decrypt — requires password (or empty if owner-only)
export async function qpdfUnlock(inputPath, password = '') {
  const out = tmpOut();
  await run('qpdf', [`--password=${password}`, '--decrypt', inputPath, out]);
  return readAndUnlink(out);
}

// ── Ghostscript ────────────────────────────────────────────────────────────

// Compress PDF. quality: 'screen' (smallest) | 'ebook' | 'printer' | 'prepress'
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

// ── ImageMagick ────────────────────────────────────────────────────────────

// Convert one or many images → PDF
export async function magickImagesToPdf(inputPaths) {
  const out = tmpOut();
  // `magick` (v7) preferred; falls back to `convert` automatically via PATH
  const bin = await which('magick').catch(() => 'convert');
  await run(bin, [...inputPaths, out]);
  return readAndUnlink(out);
}

function which(name) {
  return new Promise((resolve, reject) => {
    execFile('which', [name], (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

// Returns true if a binary is on PATH
export function hasBinary(name) {
  try {
    const r = require('child_process').execFileSync('which', [name], { stdio: ['ignore','pipe','ignore'] });
    return !!r.toString().trim();
  } catch { return false; }
}
