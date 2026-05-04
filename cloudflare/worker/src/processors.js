// Per-tool processors for the Cloudflare Queue consumer.
//
// Strategy:
//   1. Light path  — small compress jobs run pdf-lib directly inside the
//      Worker (no cold-start, < 30 ms, zero egress).
//   2. Backend proxy — everything else is forwarded to the Express backend
//      running on Cloud Run (env.BACKEND_URL).  The Worker is a thin
//      orchestrator; it never blocks on heavy CPU itself.
//
// HuggingFace / HF_SPACE_URL is no longer used.  All AI tasks are handled
// either browser-side (extractive summarise, MyMemory translate) or by the
// Express backend routes.
//
// Every processor returns:  { bytes: Uint8Array, ext: string, mime: string }

import { PDFDocument } from 'pdf-lib';
import { getObjectBytes } from './r2.js';

const BACKEND_TIMEOUT_MS = 120_000;

// Maps queued tool ids → Express route paths (same as the backend's
// /api/<path> convention).  Adding a new tool only requires the Express
// backend to expose the matching route.
const BACKEND_ROUTES = {
  // Compress & convert from PDF
  'compress':           { path: '/compress',          field: 'pdf' },
  'ocr':                { path: '/ocr',               field: 'pdf' },
  'pdf-to-word':        { path: '/pdf-to-word',       field: 'pdf' },
  'pdf-to-excel':       { path: '/pdf-to-excel',      field: 'pdf' },
  'pdf-to-powerpoint':  { path: '/pdf-to-powerpoint', field: 'pdf' },
  'pdf-to-jpg':         { path: '/pdf-to-jpg',        field: 'pdf' },
  // Convert to PDF
  'word-to-pdf':        { path: '/word-to-pdf',       field: 'pdf' },
  'excel-to-pdf':       { path: '/excel-to-pdf',      field: 'pdf' },
  'powerpoint-to-pdf':  { path: '/powerpoint-to-pdf', field: 'pdf' },
  'html-to-pdf':        { path: '/html-to-pdf',       field: 'pdf' },
  // Edit & annotate
  'edit':               { path: '/edit',              field: 'pdf' },
  'sign':               { path: '/sign',              field: 'pdf' },
  'redact':             { path: '/redact',            field: 'pdf' },
  // Security
  'protect':            { path: '/protect',           field: 'pdf' },
  'unlock':             { path: '/unlock',            field: 'pdf' },
  // Advanced tools
  'repair':             { path: '/repair',            field: 'pdf' },
  'scan-to-pdf':        { path: '/scan-to-pdf',       field: 'images' },
  'compare':            { path: '/compare',           field: 'pdfs' },
  'workflow':           { path: '/workflow',          field: 'pdf' },
  'ai-summarize':       { path: '/ai-summarize',      field: 'pdf' },
  'translate':          { path: '/translate',         field: 'pdf' },
  // Image tools
  'background-remover': { path: '/image/bg-remove',  field: 'image' },
  'crop-image':         { path: '/image/crop',        field: 'image' },
  'resize-image':       { path: '/image/resize',      field: 'image' },
  'image-filters':      { path: '/image/filters',     field: 'image' },
};

const EXT_BY_TOOL = {
  'compress':           { ext: '.pdf',  mime: 'application/pdf' },
  'ocr':                { ext: '.pdf',  mime: 'application/pdf' },
  'pdf-to-word':        { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  'pdf-to-excel':       { ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  'pdf-to-powerpoint':  { ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  'pdf-to-jpg':         { ext: '.zip',  mime: 'application/zip' },
  'word-to-pdf':        { ext: '.pdf',  mime: 'application/pdf' },
  'excel-to-pdf':       { ext: '.pdf',  mime: 'application/pdf' },
  'powerpoint-to-pdf':  { ext: '.pdf',  mime: 'application/pdf' },
  'html-to-pdf':        { ext: '.pdf',  mime: 'application/pdf' },
  'edit':               { ext: '.pdf',  mime: 'application/pdf' },
  'sign':               { ext: '.pdf',  mime: 'application/pdf' },
  'redact':             { ext: '.pdf',  mime: 'application/pdf' },
  'protect':            { ext: '.pdf',  mime: 'application/pdf' },
  'unlock':             { ext: '.pdf',  mime: 'application/pdf' },
  'repair':             { ext: '.pdf',  mime: 'application/pdf' },
  'scan-to-pdf':        { ext: '.pdf',  mime: 'application/pdf' },
  'workflow':           { ext: '.pdf',  mime: 'application/pdf' },
  'ai-summarize':       { ext: '.txt',  mime: 'text/plain; charset=utf-8' },
  'translate':          { ext: '.txt',  mime: 'text/plain; charset=utf-8' },
  'compare':            { ext: '.json', mime: 'application/json' },
  'background-remover': { ext: '.png',  mime: 'image/png' },
  'crop-image':         { ext: '.png',  mime: 'image/png' },
  'resize-image':       { ext: '.png',  mime: 'image/png' },
  'image-filters':      { ext: '.png',  mime: 'image/png' },
};

// ── Light pdf-lib path for small compress jobs ────────────────────────────────
async function lightCompress(fileBytes) {
  const src = await PDFDocument.load(fileBytes, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach(p => out.addPage(p));
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, ext: '.pdf', mime: 'application/pdf' };
}

// ── Backend (Cloud Run) pass-through ─────────────────────────────────────────
async function callBackend(env, job, fileBytes) {
  const route = BACKEND_ROUTES[job.tool];
  if (!route) throw new Error(`No backend route mapped for tool: ${job.tool}`);
  if (!env.BACKEND_URL) throw new Error('BACKEND_URL not configured in worker env');

  const fd = new FormData();
  const contentType = job.content_type || 'application/octet-stream';
  const fileName    = job.file_name    || 'input';
  fd.append(route.field, new Blob([fileBytes], { type: contentType }), fileName);

  for (const [k, v] of Object.entries(job.options || {})) {
    if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
  }

  const backendBase = env.BACKEND_URL.replace(/\/+$/, '');
  const url         = `${backendBase}/api${route.path}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', body: fd, signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Backend ${r.status} for ${job.tool}: ${body.slice(0, 300)}`);
    }
    const ct   = (r.headers.get('content-type') || '').toLowerCase();
    const meta = EXT_BY_TOOL[job.tool] || { ext: '.bin', mime: ct || 'application/octet-stream' };
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { bytes, ext: meta.ext, mime: meta.mime };
  } finally {
    clearTimeout(timer);
  }
}

// ── Public entry ──────────────────────────────────────────────────────────────
export async function process(env, job) {
  const fileBytes = await getObjectBytes(env, job.file_key);

  // Light path: compress < 25 MB runs entirely in the Worker.
  if (job.tool === 'compress' && fileBytes.length < 25 * 1024 * 1024) {
    try {
      return await lightCompress(fileBytes);
    } catch (e) {
      console.warn('[light-compress] failed, falling back to backend:', e.message);
    }
  }

  return callBackend(env, job, fileBytes);
}

// All tool ids the queue consumer accepts.
export const QUEUED_TOOLS = new Set(Object.keys(BACKEND_ROUTES));
