import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import ssh2 from 'ssh2';
import { buildApp } from '../server/index';
import { createHost, initDb, setDb } from '../server/db';
import { InAppAgent } from '../server/ssh/agent';
import { hasMosh } from '../server/mosh';
import { startSshServer } from './helpers/ssh-server';

const { utils, AgentProtocol } = ssh2;

process.env.RECONNECT_COOLDOWN_MS = '0';

interface WsMsg {
  type: string;
  [key: string]: unknown;
}

interface WsClient {
  send(msg: WsMsg): void;
  next(predicate: (m: WsMsg) => boolean, timeoutMs?: number): Promise<WsMsg>;
  close(): Promise<void>;
}

function openWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const all: WsMsg[] = [];
    const waiters: { predicate: (m: WsMsg) => boolean; resolve: (m: WsMsg) => void }[] = [];

    const client: WsClient = {
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

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-m7-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  return { db, dir };
}

test('InAppAgent: serves stored host keys, signs, rejects unknown keys', async () => {
  const { db, dir } = makeTempDb();
  try {
    const kp1 = utils.generateKeyPairSync('ed25519');
    const kp2 = utils.generateKeyPairSync('ed25519');
    createHost(db, {
      name: 'k1',
      host: 'h1',
      username: 'u',
      auth_method: 'key',
      private_key: kp1.private,
      connection_type: 'ssh',
      agent_forward: true,
    });
    createHost(db, {
      name: 'k2-dup',
      host: 'h2',
      username: 'u',
      auth_method: 'key',
      private_key: kp1.private,
    });
    createHost(db, {
      name: 'k3',
      host: 'h3',
      username: 'u',
      auth_method: 'key',
      private_key: kp2.private,
    });

    const agent = new InAppAgent(db);

    const identities = new Promise<ssh2.ParsedKey[]>((resolve, reject) => {
      agent.getIdentities((err, keys) => (err ? reject(err) : resolve(keys ?? [])));
    });
    const keys = await identities;
    assert.equal(keys.length, 2, 'duplicate keys must be deduplicated');

    const sig = await new Promise<Buffer>((resolve, reject) => {
      agent.sign(kp1.public, Buffer.from('ping'), {}, (err, s) => (err ? reject(err) : resolve(s as Buffer)));
    });
    assert.ok(Buffer.isBuffer(sig) && sig.length > 0);

    const unknown = await new Promise<string>((resolve) => {
      agent.sign(Buffer.from('not-a-key'), Buffer.from('ping'), {}, (err) => resolve(String(err?.message ?? 'null')));
    });
    assert.match(unknown, /no matching private key/);
  } finally {
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal WS: ssh agent forwarding exposes in-app keys to the remote', async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `ws://127.0.0.1:${Number(address.split(':').pop())}/ws/terminal`;

  const agentResult: { keys: ssh2.ParsedKey[] | null; signature: Buffer | null; error: string | null } = {
    keys: null,
    signature: null,
    error: null,
  };
  let resolveAgent: () => void;
  const agentDone = new Promise<void>((r) => (resolveAgent = r));

  const kp = utils.generateKeyPairSync('ed25519');
  const ssh = await startSshServer({
    user: 'bob',
    password: 'secret',
    publicKey: kp.private,
    onAuthAgent: (channel) => {
      const proto = new AgentProtocol(true);
      channel.pipe(proto).pipe(channel);
      proto.getIdentities((err, keys) => {
        if (err || !keys) {
          agentResult.error = String(err ?? 'no identities');
          resolveAgent();
          return;
        }
        agentResult.keys = keys;
        proto.sign(keys[0], Buffer.from('hello-remote'), {}, (err2, sig) => {
          if (err2) agentResult.error = String(err2);
          else agentResult.signature = sig ?? null;
          resolveAgent();
        });
      });
    },
  });
  const host = createHost(db, {
    name: 'agentbox',
    host: '127.0.0.1',
    port: ssh.port,
    username: 'bob',
    auth_method: 'key',
    private_key: kp.private,
    connection_type: 'ssh',
    agent_forward: true,
  });

  try {
    const ws = await openWs(wsUrl);
    ws.send({ type: 'connect', sessionId: 'ag1', hostId: host.id });
    await ws.next((m) => m.type === 'hostkey');
    await ws.next((m) => m.type === 'status' && m.state === 'connected');

    const timer = setTimeout(() => agentResult.error ??= 'agent timeout', 5000);
    await agentDone;
    clearTimeout(timer);
    assert.equal(agentResult.error, null);
    assert.ok(agentResult.keys && agentResult.keys.length >= 1, 'remote must see the stored key');
    assert.ok(agentResult.signature && agentResult.signature.length > 0, 'remote sign request must succeed');

    ws.send({ type: 'disconnect', sessionId: 'ag1' });
    await ws.close();
  } finally {
    await ssh.close();
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal WS: telnet connects, negotiates, and echoes', async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `ws://127.0.0.1:${Number(address.split(':').pop())}/ws/terminal`;

  const IAC = 0xff;
  const tcp = net.createServer((socket) => {
    socket.write(Buffer.from([IAC, 0x05, IAC, 0x18])); // IAC WILL ECHO, IAC DO TERM
    socket.write(Buffer.from('TELNET-READY\r\n'));
    socket.on('data', (data) => {
      socket.write(`TEL:${data.toString('utf8')}`);
    });
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const port = (tcp.address() as { port: number }).port;
  const host = createHost(db, {
    name: 'tnet',
    host: '127.0.0.1',
    port,
    connection_type: 'telnet',
  });

  try {
    const ws = await openWs(wsUrl);
    ws.send({ type: 'connect', sessionId: 't1', hostId: host.id });
    await ws.next((m) => m.type === 'status' && m.state === 'connected');
    await ws.next((m) => m.type === 'output' && toText(m).includes('TELNET-READY'));

    ws.send({ type: 'input', sessionId: 't1', data: 'hi' });
    await ws.next((m) => m.type === 'output' && toText(m).includes('TEL:hi'));

    ws.send({ type: 'disconnect', sessionId: 't1' });
    await ws.close();
  } finally {
    tcp.close();
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal WS: mosh reports missing binaries gracefully', { skip: hasMosh() }, async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const wsUrl = `ws://127.0.0.1:${Number(address.split(':').pop())}/ws/terminal`;

  const host = createHost(db, {
    name: 'moshy',
    host: '127.0.0.1',
    port: 60000,
    connection_type: 'mosh',
  });

  try {
    const ws = await openWs(wsUrl);
    ws.send({ type: 'connect', sessionId: 'm1', hostId: host.id });
    const err = await ws.next((m) => m.type === 'status' && m.state === 'error');
    assert.match(String(err.detail ?? ''), /mosh/);
    await ws.close();
  } finally {
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
