import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { buildApp } from '../server/index';
import { createHost, initDb, listAudit, setDb } from '../server/db';
import { startSftpServer, type SftpServer } from './helpers/sftp-server';

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
      next: (predicate, timeoutMs = 15000) =>
        new Promise<WsMsg>((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.findIndex((w) => w.resolve === done);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`timeout waiting for sftp message; last: ${JSON.stringify(all.slice(-5))}`));
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
      if (all.length > 20) all.shift();
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

const toB64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');

async function withServer(fn: (srv: SftpServer, wsUrl: string, hostId: number) => Promise<void>): Promise<void> {
  const srv = await startSftpServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-sftp-test-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const port = Number(address.split(':').pop());
  const host = createHost(db, {
    name: 'sftpbox',
    host: '127.0.0.1',
    port: srv.port,
    username: srv.user,
    auth_method: 'key',
    private_key: srv.privateKey(),
  });
  try {
    await fn(srv, `ws://127.0.0.1:${port}/ws/sftp`, host.id);
  } finally {
    await app.close();
    setDb(null);
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sftp WS: list/mkdir/upload/download/chmod/chown/symlink/rename/remove + audit', async () => {
  await withServer(async (srv, wsUrl, hostId) => {
    const work = path.join(srv.home, `tf-sftp-${process.pid}-${Date.now()}`);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'welcome.txt'), 'hello sftp');

    try {
      const ws = await openWs(wsUrl);
      ws.send({ type: 'open', hostId });
      const opened = await ws.next((m) => m.type === 'opened');
      assert.equal(opened.cwd, srv.home);

      // list
      ws.send({ type: 'list', path: work });
      const entries = await ws.next((m) => m.type === 'entries');
      const names = (entries.entries as WsMsg[]).map((e) => e.name);
      assert.ok(names.includes('welcome.txt'));

      // mkdir
      ws.send({ type: 'mkdir', path: `${work}/sub` });
      await ws.next((m) => m.type === 'ok' && m.op === 'mkdir');
      assert.ok(fs.statSync(path.join(work, 'sub')).isDirectory());

      // upload 1 MiB
      const payload = new Uint8Array(randomBytes(1024 * 1024));
      const upId = 'up-1';
      ws.send({ type: 'upload-start', id: upId, path: `${work}/sub/upload.bin`, size: payload.length });
      const chunk = 256 * 1024;
      for (let off = 0; off < payload.length; off += chunk) {
        ws.send({ type: 'upload-chunk', id: upId, data: toB64(payload.subarray(off, off + chunk)) });
      }
      ws.send({ type: 'upload-end', id: upId });
      const upDone = await ws.next((m) => m.type === 'done' && m.id === upId && m.op === 'upload');
      assert.equal(upDone.bytes, payload.length);
      assert.deepEqual(fs.readFileSync(path.join(work, 'sub', 'upload.bin')), Buffer.from(payload));

      // download it back
      const downId = 'down-1';
      ws.send({ type: 'download-start', id: downId, path: `${work}/sub/upload.bin` });
      const chunks: Buffer[] = [];
      let done = false;
      while (!done) {
        const m = await ws.next((m) => (m.type === 'data' && m.id === downId) || (m.type === 'done' && m.id === downId));
        if (m.type === 'data') chunks.push(Buffer.from(String(m.data), 'base64'));
        else done = true;
      }
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(payload));

      // chmod
      ws.send({ type: 'chmod', path: `${work}/sub/upload.bin`, mode: 0o640 });
      await ws.next((m) => m.type === 'ok' && m.op === 'chmod');
      assert.equal(fs.statSync(path.join(work, 'sub', 'upload.bin')).mode & 0o777, 0o640);

      // chown (to itself — always succeeds)
      const st = fs.statSync(work);
      ws.send({ type: 'chown', path: `${work}/sub/upload.bin`, uid: st.uid, gid: st.gid });
      await ws.next((m) => m.type === 'ok' && m.op === 'chown');

      // symlink
      ws.send({ type: 'symlink', target: `${work}/sub/upload.bin`, path: `${work}/link` });
      await ws.next((m) => m.type === 'ok' && m.op === 'symlink');
      assert.equal(fs.readlinkSync(path.join(work, 'link')), `${work}/sub/upload.bin`);

      // list shows symlink + directory types
      ws.send({ type: 'list', path: work });
      const entries2 = await ws.next((m) => m.type === 'entries');
      const byName = new Map((entries2.entries as WsMsg[]).map((e) => [e.name, e]));
      assert.equal(byName.get('link')?.type, 'symlink');
      assert.equal(byName.get('sub')?.type, 'directory');

      // rename
      ws.send({ type: 'rename', from: `${work}/welcome.txt`, to: `${work}/renamed.txt` });
      await ws.next((m) => m.type === 'ok' && m.op === 'rename');
      assert.ok(fs.existsSync(path.join(work, 'renamed.txt')));
      assert.ok(!fs.existsSync(path.join(work, 'welcome.txt')));

      // recursive remove
      ws.send({ type: 'remove', path: `${work}/sub`, recursive: true });
      await ws.next((m) => m.type === 'ok' && m.op === 'remove');
      assert.ok(!fs.existsSync(path.join(work, 'sub')));

      // audit recorded the transfers + ops
      const audit = listAudit();
      const events = audit.map((a) => a.action);
      for (const ev of ['sftp.upload', 'sftp.download', 'sftp.mkdir', 'sftp.rename', 'sftp.remove', 'sftp.chmod', 'sftp.chown', 'sftp.symlink']) {
        assert.ok(events.includes(ev), `missing audit event ${ev}`);
      }

      ws.close();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

test('sftp WS: upload cancel mid-transfer', async () => {
  await withServer(async (srv, wsUrl, hostId) => {
    const work = path.join(srv.home, `tf-sftp-${process.pid}-${Date.now()}`);
    fs.mkdirSync(work);
    try {
      const ws = await openWs(wsUrl);
      ws.send({ type: 'open', hostId });
      await ws.next((m) => m.type === 'opened');

      const total = 4 * 1024 * 1024;
      const id = 'up-cancel';
      ws.send({ type: 'upload-start', id, path: `${work}/big.bin`, size: total });
      const chunk = 256 * 1024;
      for (let off = 0; off < 2 * chunk; off += chunk) {
        ws.send({ type: 'upload-chunk', id, data: toB64(new Uint8Array(randomBytes(chunk))) });
      }
      ws.send({ type: 'cancel', id });
      const done = await ws.next((m) => m.type === 'done' && m.id === id);
      assert.equal(done.op, 'upload');
      const onDisk = fs.existsSync(path.join(work, 'big.bin')) ? fs.statSync(path.join(work, 'big.bin')).size : 0;
      assert.ok(onDisk > 0, 'partial upload should exist on disk');
      assert.ok(onDisk < total);
      assert.equal(done.bytes, 2 * chunk); // bytes received; only part flushed to disk
      ws.close();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

test('sftp WS: host key mismatch rejected', async () => {
  await withServer(async (srv, wsUrl, hostId) => {
    const ws = await openWs(wsUrl);
    ws.send({ type: 'open', hostId });
    await ws.next((m) => m.type === 'opened');
    ws.close();

    await srv.rotateHostKey();

    const ws2 = await openWs(wsUrl);
    ws2.send({ type: 'open', hostId });
    const err = await ws2.next((m) => m.type === 'error');
    assert.match(String(err.message), /host key mismatch/);
    ws2.close();
  });
});
