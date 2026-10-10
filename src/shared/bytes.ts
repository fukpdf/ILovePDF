export function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunkSize)));
  }
  return out;
}

export function containsAscii(bytes: Uint8Array, needle: string): boolean {
  if (!needle) return true;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

export function startsWithPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export function endsWithPdfEof(bytes: Uint8Array): boolean {
  const start = Math.max(0, bytes.length - 2048);
  return latin1(bytes.subarray(start)).includes("%%EOF");
}
