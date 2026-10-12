// Cloudflare R2 storage adapter — Disabled / Decoupled
// All document, image, and PDF tools use direct client-side (WASM/Workers)
// and Node.js server processing without external cloud bucket dependencies.

export function isR2Configured() {
  return false;
}

export async function putTempObject() {
  throw new Error('Cloudflare R2 storage is disabled. Direct browser and server processing is active.');
}

export async function putUserObject() {
  throw new Error('Cloudflare R2 storage is disabled. Direct browser and server processing is active.');
}

export async function getSignedDownloadUrl() {
  return null;
}

export async function headObject() {
  return null;
}

export async function listUserObjects() {
  return [];
}
