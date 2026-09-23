import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BLOB_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Directory for device-level secrets (the "keystore"). Overridable for tests. */
export function configDir(): string {
  return process.env.TERMUS_CONFIG_DIR || path.join(os.homedir(), '.termius-free');
}

function keystorePath(): string {
  return path.join(configDir(), 'keystore.json');
}

let cachedKey: Buffer | null = null;

/** Loads the 256-bit master key, creating and persisting it on first use. */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = keystorePath();
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { key?: string };
      if (data.key && Buffer.from(data.key, 'base64').length === KEY_BYTES) {
        cachedKey = Buffer.from(data.key, 'base64');
        return cachedKey;
      }
    } catch {
      /* fall through and regenerate */
    }
  }
  cachedKey = randomBytes(KEY_BYTES);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key: cachedKey.toString('base64') }, null, 2) + '\n', { mode: 0o600 });
  return cachedKey;
}

/** Clears the in-memory key (tests). The on-disk keystore is untouched. */
export function resetMasterKeyCache(): void {
  cachedKey = null;
}

/** Encrypts plaintext into a `v1.<iv>.<tag>.<data>` base64 blob. */
export function encryptContent(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [BLOB_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

/** Reverses {@link encryptContent}; throws on tamper or version mismatch. */
export function decryptContent(blob: string): string {
  const [version, ivB64, tagB64, dataB64] = blob.split('.');
  if (version !== BLOB_VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('unsupported snippet blob');
  }
  const decipher = createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
