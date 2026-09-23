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

test('M10: max concurrent sessions limit', async () => {
  process.env.NODE_ENV = 'test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-m10-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `ws://127.0.0.1:${Number(address.split(':').pop())}/ws/terminal`;
  const ssh = await startSshServer({ user: 'alice', password: 'wonderland' });
  const host = createHost(db, {
    name: 'm10box',
    host: '127.0.0.1',
    port: ssh.port,
    username: 'alice',
    auth_method: 'password',
    password: 'wonderland',
  });

  try {
    process.env.MAX_SESSIONS = '2';
    process.env.RECONNECT_COOLDOWN_MS = '0';

    const ws1 = await openWs(wsUrl);
    ws1.send({ type: 'connect', sessionId: 'm1', hostId: host.id });
    await ws1.next((m) => m.type === 'status' && m.state === 'connected');

    const ws2 = await openWs(wsUrl);
    ws2.send({ type: 'connect', sessionId: 'm2', hostId: host.id });
    await ws2.next((m) => m.type === 'status' && m.state === 'connected');

    const ws3 = await openWs(wsUrl);
    ws3.send({ type: 'connect', sessionId: 'm3', hostId: host.id });
    const err = await ws3.next((m) => m.type === 'error');
    assert.match(String(err.message), /too many concurrent sessions \(max 2\)/);

    ws1.send({ type: 'disconnect', sessionId: 'm1' });
    ws2.send({ type: 'disconnect', sessionId: 'm2' });
    await ws1.close();
    await ws2.close();
    await ws3.close();
  } finally {
    delete process.env.MAX_SESSIONS;
    delete process.env.RECONNECT_COOLDOWN_MS;
    await ssh.close();
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M10: per-host reconnect cooldown prevents storms', async () => {
  process.env.NODE_ENV = 'test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-m10-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `ws://127.0.0.1:${Number(address.split(':').pop())}/ws/terminal`;
  const ssh = await startSshServer({ user: 'alice', password: 'wonderland' });
  const host = createHost(db, {
    name: 'm10cool',
    host: '127.0.0.1',
    port: ssh.port,
    username: 'alice',
    auth_method: 'password',
    password: 'wonderland',
  });

  try {
    process.env.MAX_SESSIONS = '32';
    process.env.RECONNECT_COOLDOWN_MS = '0';

    const ws1 = await openWs(wsUrl);
    ws1.send({ type: 'connect', sessionId: 'r1', hostId: host.id });
    await ws1.next((m) => m.type === 'status' && m.state === 'connected');
    ws1.send({ type: 'disconnect', sessionId: 'r1' });
    await new Promise((r) => setTimeout(r, 50));
    await ws1.close();

    process.env.RECONNECT_COOLDOWN_MS = '3000';
    const ws2 = await openWs(wsUrl);
    ws2.send({ type: 'connect', sessionId: 'r2', hostId: host.id });
    const err = await ws2.next((m) => m.type === 'status' && m.state === 'error');
    assert.match(String(err.detail), /reconnect cooldown/);

    process.env.RECONNECT_COOLDOWN_MS = '0';
    ws2.send({ type: 'connect', sessionId: 'r3', hostId: host.id });
    await ws2.next((m) => m.type === 'status' && m.state === 'connected');
    ws2.send({ type: 'disconnect', sessionId: 'r3' });
    await ws2.close();
  } finally {
    delete process.env.MAX_SESSIONS;
    delete process.env.RECONNECT_COOLDOWN_MS;
    await ssh.close();
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
