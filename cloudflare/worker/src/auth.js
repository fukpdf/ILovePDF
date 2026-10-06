// Lightweight Firebase ID-token verifier for Cloudflare Workers.
// - Pulls Google's public certs (cached in-memory) and verifies the RS256 JWT
//   using Web Crypto.
// - Falls back to "guest" identity (keyed by client IP) if no/invalid token.
//
// We deliberately keep this dependency-free; firebase-admin doesn't run on
// Workers. The verification matches how `utils/firebase-admin.js` validates
// tokens server-side in your existing Express backend.

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certsCache = { at: 0, certs: null };

async function fetchCerts() {
  if (certsCache.certs && Date.now() - certsCache.at < 60 * 60 * 1000) {
    return certsCache.certs;
  }
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error('cert fetch failed: ' + r.status);
  const certs = await r.json();
  certsCache = { at: Date.now(), certs };
  return certs;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

// PEM (X.509 cert) → SubtleCrypto public key for RS256.
async function importPemKey(pem) {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');
  const der = b64urlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_'));
  // The cert blob's SubjectPublicKeyInfo lives inside the X.509 wrapper.
  // Parse minimal ASN.1 to extract it.
  const spki = extractSpkiFromCert(der);
  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

// Minimal X.509 → SPKI extraction. Walks the TBSCertificate to find the
// SubjectPublicKeyInfo SEQUENCE. Good enough for Google's RSA certs.
function extractSpkiFromCert(der) {
  let i = 0;
  function readLen() {
    let len = der[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
    }
    return len;
  }
  function readTLV() {
    const tag = der[i++];
    const len = readLen();
    const start = i;
    i += len;
    return { tag, start, len };
  }
  // outer SEQUENCE → tbsCertificate SEQUENCE
  readTLV();
  const tbs = readTLV();
  i = tbs.start;
  // version [0] EXPLICIT
  if (der[i] === 0xa0) readTLV();
  readTLV(); // serialNumber
  readTLV(); // signature AlgorithmIdentifier
  readTLV(); // issuer
  readTLV(); // validity
  readTLV(); // subject
  // subjectPublicKeyInfo SEQUENCE — capture entire TLV
  const spkiStart = i;
  readTLV();
  return der.slice(spkiStart, i);
}

export async function verifyFirebaseToken(token, projectId) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, s] = token.split('.');
  let header, payload;
  try { header = b64urlToJson(h); payload = b64urlToJson(p); } catch { return null; }

  if (header.alg !== 'RS256' || !header.kid) return null;
  if (!payload.sub) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return null;
  if (payload.iat && now + 5 < payload.iat) return null;
  if (projectId) {
    if (payload.aud !== projectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  }

  const certs = await fetchCerts();
  const pem = certs[header.kid];
  if (!pem) return null;
  const key = await importPemKey(pem);
  const sig = b64urlToBytes(s);
  const data = new TextEncoder().encode(`${h}.${p}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) return null;
  return {
    uid: payload.sub,
    email: payload.email || null,
    plan: payload.plan || 'free', // custom claim if set; otherwise default
  };
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
         '0.0.0.0';
}

export async function identify(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = /^bearer\s+(.+)$/i.exec(auth);
  if (m) {
    try {
      const u = await verifyFirebaseToken(m[1], env.FIREBASE_PROJECT_ID);
      if (u) return { kind: 'user', user_id: u.uid, plan: u.plan, ip: clientIp(request) };
    } catch (e) {
      // fall through to guest
    }
  }
  return { kind: 'guest', user_id: null, plan: 'guest', ip: clientIp(request) };
}
