import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostKeyAlg, hostKeyFingerprint } from '../server/ssh/known_hosts';
import {
  deleteKnownHost,
  getKnownHost,
  initDb,
  listKnownHosts,
  setDb,
  upsertKnownHost,
} from '../server/db';

function wireBlob(alg: string, payload: Buffer): Buffer {
  const name = Buffer.from(alg, 'utf8');
  const out = Buffer.alloc(4 + name.length + payload.length);
  out.writeUInt32BE(name.length, 0);
  name.copy(out, 4);
  payload.copy(out, 4 + name.length);
  return out;
}

test('hostKeyFingerprint matches manual sha256 of the raw key', () => {
  const key = wireBlob('ssh-ed25519', crypto.randomBytes(32));
  const expected = `SHA256:${crypto.createHash('sha256').update(key).digest('base64')}`;
  assert.equal(hostKeyFingerprint(key), expected);
  assert.equal(hostKeyFingerprint(null), null);
  assert.equal(hostKeyFingerprint(Buffer.alloc(0)), null);
});

test('hostKeyAlg reads the wire-format algorithm name', () => {
  assert.equal(hostKeyAlg(wireBlob('ssh-ed25519', crypto.randomBytes(32))), 'ssh-ed25519');
  assert.equal(hostKeyAlg(Buffer.alloc(2)), 'unknown');
  assert.equal(hostKeyAlg(null), 'unknown');
});

test('known_hosts TOFU: insert, lookup, overwrite, delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-kh-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  try {
    const key = wireBlob('ssh-ed25519', crypto.randomBytes(32));
    const fp = hostKeyFingerprint(key)!;
    const { entry, created } = upsertKnownHost(db, 'example.com', 22, 'ssh-ed25519', fp);
    assert.equal(created, true);
    assert.equal(entry.fingerprint, fp);

    const known = getKnownHost(db, 'example.com', 22);
    assert.equal(known?.fingerprint, fp);
    assert.equal(known?.key_type, 'ssh-ed25519');

    const otherFp = hostKeyFingerprint(wireBlob('ssh-ed25519', crypto.randomBytes(32)))!;
    assert.notEqual(known?.fingerprint, otherFp);

    upsertKnownHost(db, 'example.com', 22, 'ssh-ed25519', otherFp);
    assert.equal(getKnownHost(db, 'example.com', 22)?.fingerprint, otherFp);
    assert.equal(listKnownHosts(db).length, 1);

    deleteKnownHost(db, entry.id);
    assert.equal(listKnownHosts(db).length, 0);
  } finally {
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
