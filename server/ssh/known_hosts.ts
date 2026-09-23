import crypto from 'node:crypto';

export function hostKeyFingerprint(key: Buffer | string | null | undefined): string | null {
  if (!key) return null;
  const buf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (buf.length === 0) return null;
  const digest = crypto.createHash('sha256').update(buf).digest('base64');
  return `SHA256:${digest}`;
}

export function hostKeyAlg(key: Buffer | null | undefined): string {
  if (!key || key.length < 5) return 'unknown';
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > key.length - 4) return 'unknown';
  const alg = key.subarray(4, 4 + len).toString('utf8');
  return /^[a-z0-9@.\-]+$/.test(alg) ? alg : 'unknown';
}
