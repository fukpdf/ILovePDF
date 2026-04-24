// Firebase Admin SDK — verifies ID tokens minted by the web SDK on the client.
// Initialised lazily so the server still boots if credentials are missing.
import admin from 'firebase-admin';

let initialised = false;
let initError = null;

export function getFirebaseAdmin() {
  if (initialised) return admin;
  if (initError) throw initError;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    initError = new Error('FIREBASE_SERVICE_ACCOUNT_JSON not set');
    throw initError;
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    initError = new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
    throw initError;
  }
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(creds),
    projectId: creds.project_id || process.env.FIREBASE_PROJECT_ID,
  });
  initialised = true;
  console.log('[firebase] admin initialised for project', creds.project_id);
  return admin;
}

export async function verifyIdToken(idToken) {
  const a = getFirebaseAdmin();
  return a.auth().verifyIdToken(idToken);
}

export function isFirebaseConfigured() {
  return !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON
         && process.env.FIREBASE_API_KEY
         && process.env.FIREBASE_PROJECT_ID);
}
