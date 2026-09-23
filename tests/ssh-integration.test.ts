import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { buildApp } from '../server/index';
import { createHost, initDb, setDb } from '../server/db';
import { startSshServer } from './helpers/ssh-server';

interface WsMsg {
  type: string;
  [key: string]: unknown;
}

interface WsClient {
  send(msg: WsMsg): void;
  next(predicate: (m: WsMsg) => boolean, timeoutMs?: number): Promise<WsMsg>;
  all: WsMsg[];
  close(): Promise<void>;
}

function openWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const all: WsMsg[] = [];
    const waiters: { predicate: (m: WsMsg) => boolean; resolve: (m: WsMsg) => void }[] = [];

    const client: WsClient = {
      all,
      send: (msg) => ws.send(JSON.stringify(msg)),
      next: (predicate, timeoutMs = 5000) =>
        new Promise<WsMsg>((res, rej) => {
          const idx = all.findIndex(predicate);
          if (idx >= 0) return res(all[idx]);
          const timer = setTimeout(() => {
            const i = waiters.findIndex((w) => w.resolve === done);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for message (got: ${all.map((m) => m.type).join(',')})`));
          }, timeoutMs);
          function done(m: WsMsg) {
            clearTimeout(timer);
            res(m);
          }
          waiters.push({ predicate, resolve: done });
        }),
      close: () =>
        new Promise<void>((res) => {
          ws.on('close', () => res());
          ws.close();
        }),
    };

    ws.on('open', () => resolve(client));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as WsMsg;
      all.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          const [w] = waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);
  });
}

const toText = (m: WsMsg): string => Buffer.from(String(m.data ?? ''), 'base64').toString('utf8');

test('terminal WS: TOFU, echo, verified, mismatch + trust, auth failure', async () => {
  process.env.NODE_ENV = 'test';
  process.env.RECONNECT_COOLDOWN_MS = '0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-int-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const httpPort = Number(address.split(':').pop());
  const wsUrl = `ws://127.0.0.1:${httpPort}/ws/terminal`;

  const ssh = await startSshServer({ user: 'alice', password: 'wonderland' });
  const host = createHost(db, {
    name: 'testbox',
    host: '127.0.0.1',
    port: ssh.port,
    username: 'alice',
    auth_method: 'password',
    password: 'wonderland',
  });

  try {
    // 1) First connection: unknown key -> TOFU, then interactive echo
    const ws1 = await openWs(wsUrl);
    ws1.send({ type: 'connect', sessionId: 's1', hostId: host.id });
    const hk1 = await ws1.next((m) => m.type === 'hostkey');
    assert.equal(hk1.state, 'new');
    assert.match(String(hk1.fingerprint), /^SHA256:/);
    await ws1.next((m) => m.type === 'status' && m.state === 'connected');

    ws1.send({ type: 'input', sessionId: 's1', data: 'hello' });
    await ws1.next((m) => m.type === 'output' && toText(m).includes('WELCOME-TEST'));
    await ws1.next((m) => m.type === 'output' && toText(m).includes('ECHO:hello'));

    ws1.send({ type: 'disconnect', sessionId: 's1' });
    await ws1.close();

    // 2) Second connection: key on record -> verified
    const ws2 = await openWs(wsUrl);
    ws2.send({ type: 'connect', sessionId: 's2', hostId: host.id });
    const hk2 = await ws2.next((m) => m.type === 'hostkey');
    assert.equal(hk2.state, 'verified');
    await ws2.next((m) => m.type === 'status' && m.state === 'connected');
    ws2.send({ type: 'disconnect', sessionId: 's2' });
    await ws2.close();

    // 3) Server rotates key: mismatch -> trust with new key
    const port3 = ssh.port;
    await ssh.close();
    const sshNew = await startSshServer({ user: 'alice', password: 'wonderland', port: port3 });
    try {
      const ws3 = await openWs(wsUrl);
      ws3.send({ type: 'connect', sessionId: 's3', hostId: host.id });
      const hk3 = await ws3.next((m) => m.type === 'hostkey' && m.state === 'mismatch');
      assert.equal(hk3.state, 'mismatch');
      assert.ok(String(hk3.fingerprint) !== String(hk3.expected));
      await ws3.next((m) => m.type === 'status' && m.state === 'error');

      ws3.send({ type: 'connect', sessionId: 's3b', hostId: host.id, trust: true });
      const hk4 = await ws3.next((m) => m.type === 'hostkey' && m.state === 'new');
      assert.equal(hk4.state, 'new');
      await ws3.next((m) => m.type === 'status' && m.state === 'connected');
      ws3.send({ type: 'disconnect', sessionId: 's3b' });
      await ws3.close();
    } finally {
      await sshNew.close();
    }

    // 4) Wrong password -> error status
    const ssh4 = await startSshServer({ user: 'alice', password: 'wonderland' });
    try {
      const badHost = createHost(db, {
        name: 'bad',
        host: '127.0.0.1',
        port: ssh4.port,
        username: 'alice',
        auth_method: 'password',
        password: 'nope',
      });
      const ws4 = await openWs(wsUrl);
      ws4.send({ type: 'connect', sessionId: 's4', hostId: badHost.id });
      const err = await ws4.next((m) => m.type === 'status' && m.state === 'error');
      assert.match(String(err.detail ?? err.message), /authentication methods failed/);
      await ws4.close();
    } finally {
      await ssh4.close();
    }
  } finally {
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
