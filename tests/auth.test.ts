import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthConfig } from '../server/ssh/auth';
import type { Host } from '../shared/types';

function makeHost(over: Partial<Host> = {}): Host {
  return {
    id: 1,
    group_id: null,
    name: 'h',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    connection_type: 'ssh',
    agent_forward: false,
    auth_method: 'password',
    password: 'pw',
    private_key: null,
    pass_phrase: null,
    remote_command: null,
    keepalive: 30,
    color: '#000',
    favorite: false,
    notes: '',
    vnc_transport: null,
    vnc_port: null,
    vnc_password: null,
    vnc_ssh_host_id: null,
    vnc_display: null,
    vnc_desktop_mode: null,
    vnc_auto_start: false,
    vnc_auto_stop: false,
    vnc_implementation: null,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

test('password auth builds password config', () => {
  const res = buildAuthConfig(makeHost({ auth_method: 'password', password: 'secret' }));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.password, 'secret');
    assert.equal(res.config.privateKey, undefined);
  }
});

test('key auth builds private key config with passphrase', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----';
  const res = buildAuthConfig(makeHost({ auth_method: 'key', private_key: key, pass_phrase: 'pp' }));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.privateKey, key);
    assert.equal(res.config.passphrase, 'pp');
  }
});

test('key auth without private key fails', () => {
  const res = buildAuthConfig(makeHost({ auth_method: 'key', private_key: null }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /private key/);
});

test('password auth without password fails', () => {
  const res = buildAuthConfig(makeHost({ auth_method: 'password', password: null }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /credentials/);
});
