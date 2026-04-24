// Cloudflare R2 storage helper (S3-compatible API).
// - Temporary uploads land under prefix `tmp/` and are auto-deleted after 10 min
// - Permanent user files land under `users/<uid>/` (for paid plans, future use)
// - Frontend never sees R2 credentials; downloads go through pre-signed URLs
import {
  S3Client, PutObjectCommand, GetObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET     = process.env.R2_BUCKET;

export function isR2Configured() {
  return !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET);
}

let client = null;
function getClient() {
  if (client) return client;
  if (!isR2Configured()) throw new Error('R2 is not configured');
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return client;
}

export async function putTempObject(buffer, originalName, contentType) {
  const id = crypto.randomBytes(12).toString('hex');
  const safe = (originalName || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60);
  const key = `tmp/${Date.now()}_${id}_${safe}`;
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

export async function putUserObject(uid, buffer, originalName, contentType) {
  if (!uid) throw new Error('uid required');
  const id = crypto.randomBytes(8).toString('hex');
  const safe = (originalName || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const key = `users/${uid}/${Date.now()}_${id}_${safe}`;
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return key;
}

export async function getSignedDownloadUrl(key, expiresInSeconds = 600) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: expiresInSeconds });
}

export async function headObject(key) {
  return getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function listUserObjects(uid) {
  if (!uid) return [];
  const r = await getClient().send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: `users/${uid}/`,
  }));
  return (r.Contents || []).map(o => ({
    key: o.Key,
    size: o.Size,
    lastModified: o.LastModified,
    name: o.Key.split('/').pop().replace(/^\d+_[a-f0-9]+_/, ''),
  }));
}

// Sweep: delete tmp/* objects older than maxAgeMs (default 10 min).
export async function sweepTempObjects(maxAgeMs = 10 * 60 * 1000) {
  if (!isR2Configured()) return { deleted: 0, skipped: true };
  const cutoff = Date.now() - maxAgeMs;
  let token = undefined;
  let deleted = 0;
  try {
    do {
      const r = await getClient().send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: 'tmp/', ContinuationToken: token,
      }));
      const stale = (r.Contents || []).filter(o => o.LastModified && o.LastModified.getTime() < cutoff);
      for (let i = 0; i < stale.length; i += 1000) {
        const chunk = stale.slice(i, i + 1000);
        if (!chunk.length) continue;
        await getClient().send(new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: chunk.map(o => ({ Key: o.Key })) },
        }));
        deleted += chunk.length;
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    console.error('[r2] sweep error:', e.message);
  }
  if (deleted) console.log(`[r2] swept ${deleted} stale tmp object(s)`);
  return { deleted };
}

export function startR2Sweeper() {
  if (!isR2Configured()) {
    console.log('[r2] sweeper disabled (R2 not configured)');
    return;
  }
  // Run every 5 minutes; objects older than 10 minutes are removed
  setInterval(() => sweepTempObjects().catch(() => {}), 5 * 60 * 1000);
  sweepTempObjects().catch(() => {});
  console.log('[r2] tmp sweeper started (10-min TTL, every 5 min)');
}
