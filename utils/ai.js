// Hugging Face Inference API helpers — used ONLY for AI tools (summarize / translate).
// All other tools continue to use existing in-process logic.
// Accept any of the historical names — keeps the env config flexible.
const HF_TOKEN = process.env.HF_API_TOKEN
              || process.env.HUGGINGFACE_API_TOKEN
              || process.env.HUGGING_FACE_TOKEN;
const HF_BASE  = 'https://api-inference.huggingface.co/models';
// Optional self-hosted Space (HF_SPACE_URL) — used as a fallback if the public
// inference API is rate-limited or unavailable.
const HF_SPACE_URL = (process.env.HF_SPACE_URL || '').replace(/\/+$/, '');

export function isHfConfigured() { return !!HF_TOKEN; }

async function hfCall(model, payload, { timeoutMs = 25000 } = {}) {
  if (!HF_TOKEN) throw new Error('HUGGINGFACE_API_TOKEN not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${HF_BASE}/${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type':  'application/json',
        'x-wait-for-model': 'true',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HF ${model} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Splits text into ~chunkChars pieces on sentence-ish boundaries.
function chunkText(text, chunkChars = 1800) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkChars, text.length);
    if (end < text.length) {
      const dot = text.lastIndexOf('. ', end);
      if (dot > i + chunkChars * 0.5) end = dot + 1;
    }
    out.push(text.slice(i, end).trim());
    i = end;
  }
  return out.filter(Boolean);
}

// Summarise long text by recursively summarising chunks.
// Model: facebook/bart-large-cnn (works well for English news/document text).
export async function summariseText(text, { sentences = 7 } = {}) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const chunks = chunkText(trimmed, 1800).slice(0, 8); // cap to control cost
  const summaries = [];
  for (const c of chunks) {
    try {
      const r = await hfCall('facebook/bart-large-cnn', {
        inputs: c,
        parameters: { max_length: 180, min_length: 60, do_sample: false },
      });
      const s = Array.isArray(r) ? (r[0]?.summary_text || '') : (r?.summary_text || '');
      if (s) summaries.push(s.trim());
    } catch (e) {
      console.error('[ai] summarise chunk failed:', e.message);
    }
  }
  let combined = summaries.join(' ');
  if (!combined) return '';

  // Second pass to compress to roughly the requested sentence count
  if (summaries.length > 1) {
    try {
      const r = await hfCall('facebook/bart-large-cnn', {
        inputs: combined.slice(0, 3500),
        parameters: { max_length: Math.min(400, sentences * 35), min_length: Math.min(120, sentences * 18), do_sample: false },
      });
      combined = (Array.isArray(r) ? r[0]?.summary_text : r?.summary_text) || combined;
    } catch (e) { /* keep first-pass */ }
  }
  return combined.trim();
}

// Translate English -> targetLang using Helsinki-NLP Opus models.
// Example targetLang values: 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ar', 'hi'.
const HELSINKI = {
  es: 'Helsinki-NLP/opus-mt-en-es', fr: 'Helsinki-NLP/opus-mt-en-fr',
  de: 'Helsinki-NLP/opus-mt-en-de', it: 'Helsinki-NLP/opus-mt-en-it',
  pt: 'Helsinki-NLP/opus-mt-tc-big-en-pt', ru: 'Helsinki-NLP/opus-mt-en-ru',
  zh: 'Helsinki-NLP/opus-mt-en-zh', ja: 'Helsinki-NLP/opus-mt-en-jap',
  ar: 'Helsinki-NLP/opus-mt-en-ar', hi: 'Helsinki-NLP/opus-mt-en-hi',
  nl: 'Helsinki-NLP/opus-mt-en-nl', ko: 'Helsinki-NLP/opus-mt-tc-big-en-ko',
};

export async function translateText(text, targetLang) {
  const model = HELSINKI[targetLang];
  if (!model) throw new Error(`Unsupported language: ${targetLang}`);
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const chunks = chunkText(trimmed, 900).slice(0, 12);
  const out = [];
  for (const c of chunks) {
    try {
      const r = await hfCall(model, { inputs: c });
      const t = Array.isArray(r) ? (r[0]?.translation_text || '') : (r?.translation_text || '');
      out.push(t || c);
    } catch (e) {
      console.error('[ai] translate chunk failed:', e.message);
      out.push(c);
    }
  }
  return out.join(' ');
}

// Background remover — model returns PNG bytes with transparency.
// Used as an optional upgrade for /api/image/bg-remove if Sharp-only path is insufficient.
export async function removeBackground(imageBuffer) {
  if (!HF_TOKEN) throw new Error('HUGGINGFACE_API_TOKEN not set');
  const r = await fetch(`${HF_BASE}/briaai/RMBG-1.4`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'x-wait-for-model': 'true',
    },
    body: imageBuffer,
  });
  if (!r.ok) throw new Error(`HF RMBG HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}
