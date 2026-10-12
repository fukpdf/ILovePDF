import admin from 'firebase-admin';

let isConfigured = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
    isConfigured = true;
  } else if (process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
    isConfigured = true;
  }
} catch (e) {
  console.warn('[firebase-admin] Not initialized:', e.message);
}

export function isFirebaseConfigured() {
  return isConfigured;
}

export async function verifyIdToken(token) {
  if (!isConfigured) {
    throw new Error('Firebase Admin is not configured');
  }
  return await admin.auth().verifyIdToken(token);
}

export default admin;
