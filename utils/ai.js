// AI utilities — HuggingFace removed.
// All summarisation uses extractive logic in utils/pdfText.js.
// All translation uses the MyMemory public API in routes/advanced.js.
// This file is kept only for the isHfConfigured() export consumed by server.js.

const HF_TOKEN = process.env.HF_API_TOKEN
              || process.env.HUGGINGFACE_API_TOKEN
              || process.env.HUGGING_FACE_TOKEN;

/** Returns true when an HF token is present in env (informational only). */
export function isHfConfigured() { return !!HF_TOKEN; }

// ── Legacy stubs — NOT called anywhere in active code paths ──────────────────
// Kept so that any lingering import doesn't crash the process. They throw
// immediately if somehow invoked so failures are loud, not silent.

export async function summariseText() {
  throw new Error('[ai] summariseText is deprecated — use extractiveSummarize() in utils/pdfText.js');
}

export async function translateText() {
  throw new Error('[ai] translateText is deprecated — use MyMemory API in routes/advanced.js');
}

export async function removeBackground() {
  throw new Error('[ai] removeBackground is deprecated — use Sharp-based route in routes/image.js');
}
