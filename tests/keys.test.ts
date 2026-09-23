import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { generateKeyPair } from '../server/ssh/keys';

const { utils } = ssh2;

test('keys: generate ed25519 pair, PEM parses, fingerprint format', () => {
  const key = generateKeyPair('ed25519', 3072, 'test@free');
  assert.equal(key.type, 'ed25519');
  assert.match(key.private, /-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.match(key.public, /^ssh-ed25519 \S+ test@free$/);
  assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]+=$/);

  const parsed = utils.parseKey(key.private);
  assert.ok(!(parsed instanceof Error));
  assert.equal(parsed.isPrivateKey(), true);
});

test('keys: generate RSA pair', () => {
  const key = generateKeyPair('rsa', 2048);
  assert.equal(key.type, 'rsa');
  assert.match(key.private, /-----BEGIN OPENSSH PRIVATE KEY-----/);
  assert.match(key.public, /^ssh-rsa \S+$/);
  const parsed = utils.parseKey(key.private);
  assert.ok(!(parsed instanceof Error));
});
