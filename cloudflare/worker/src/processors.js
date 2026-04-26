// Per-tool processors. Two strategies:
//
//   1. HF Space delegation — for AI / image / heavy conversions, we POST
//      the file to the user's existing Hugging Face Space (HF_SPACE_URL),
//      which already implements every queued tool. The Worker stays a
//      thin orchestrator and never blocks on heavy CPU.
//
//   2. Light fallback — for compress / merge-style PDF ops we run pdf-lib
//      directly inside the Worker. Bounded CPU; safe for the ≤ 50 ms tier
//      and well under 30 s on the paid tier for typical SaaS inputs.
//
// Every processor returns:  { bytes: Uint8Array, ext: string, mime: string }

import { PDFDocument } from 'pdf-lib';
import { getObjectBytes } from './r2.js';

const HF_TIMEOUT_MS = 110_000; // HF Spaces can be slow on cold start

// Maps queued tool ids → HF Space POST routes. The Space mirrors the
// existing Express route names 1:1, so adding a new tool here only
// requires the HF Space to expose the matching path.
const HF_ENDPOINTS = {
  // Compress & convert (existing)
  'compress':           '/compress',
  'ocr':                '/ocr',
  'pdf-to-word':        '/pdf-to-word',
  'pdf-to-excel':       '/pdf-to-excel',
  'pdf-to-powerpoint':  '/pdf-to-powerpoint',
  'pdf-to-jpg':         '/pdf-to-jpg',
  'word-to-pdf':        '/word-to-pdf',
  'excel-to-pdf':       '/excel-to-pdf',
  'powerpoint-to-pdf':  '/powerpoint-to-pdf',
  'html-to-pdf':        '/html-to-pdf',
  // Edit & annotate
  'edit':               '/edit',
  'sign':               '/sign',
  'redact':             '/redact',
  // Security
  'protect':            '/protect',
  'unlock':             '/unlock',
  // Advanced
  'repair':             '/repair',
  'scan-to-pdf':        '/scan-to-pdf',
  'compare':            '/compare',
  'workflow':           '/workflow',
  'ai-summarize':       '/ai-summarize',
  'translate':          '/translate',
  // Image
  'background-remover': '/background-remove',
  'crop-image':         '/crop-image',
  'resize-image':       '/resize-image',
  'image-filters':      '/filters',
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

function endpointFor(tool) { return HF_ENDPOINTS[tool]; }

// ── HF Space pass-through ────────────────────────────────────────────────────
async function callHuggingFace(env, job, fileBytes) {
  const path = endpointFor(job.tool);
  if (!path) throw new Error(`HF route not mapped for tool: ${job.tool}`);
  if (!env.HF_SPACE_URL) throw new Error('HF_SPACE_URL not configured');

  const fd = new FormData();
  fd.append('file', new Blob([fileBytes], { type: job.content_type || 'application/octet-stream' }), job.file_name || 'input');
  for (const [k, v] of Object.entries(job.options || {})) {
    if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HF_TIMEOUT_MS);
  try {
    const r = await fetch(env.HF_SPACE_URL.replace(/\/+$/, '') + path, {
      method: 'POST',
      body: fd,
      signal: ctrl.signal,
      headers: (() => {
        const tok = env.HF_API_TOKEN || env.HF_TOKEN || env.HUGGINGFACE_API_TOKEN || env.HUGGING_FACE_TOKEN;
        return tok ? { Authorization: `Bearer ${tok}` } : {};
      })(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HF ${r.status}: ${body.slice(0, 240)}`);
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const meta = EXT_BY_TOOL[job.tool] || { ext: '.bin', mime: ct || 'application/octet-stream' };
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { bytes, ext: meta.ext, mime: meta.mime };
  } finally {
    clearTimeout(timer);
  }
}

// ── Light pdf-lib fallback for compress ──────────────────────────────────────
async function lightCompress(fileBytes) {
  const src = await PDFDocument.load(fileBytes, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, ext: '.pdf', mime: 'application/pdf' };
}

// ── Public entry: pick a strategy per tool ───────────────────────────────────
export async function process(env, job) {
  const fileBytes = await getObjectBytes(env, job.file_key);

  // Light path: a small subset runs entirely in the Worker so we can serve
  // even if the HF Space is cold or down.
  if (job.tool === 'compress' && fileBytes.length < 25 * 1024 * 1024) {
    try {
      return await lightCompress(fileBytes);
    } catch (e) {
      // fall through to HF
      console.warn('[light-compress] failed, falling back to HF:', e.message);
    }
  }

  return callHuggingFace(env, job, fileBytes);
}

// All tool ids the queue accepts. Anything in TOOLS but NOT here is a
// browser-only / client-side tool (merge, split, rotate, crop, organize,
// jpg-to-pdf, watermark, page-numbers, numbers-to-words).
export const QUEUED_TOOLS = new Set(Object.keys(HF_ENDPOINTS));
