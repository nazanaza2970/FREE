import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { createForward, createHost, initDb, listAudit, setDb } from '../server/db';
import { forwardStates, startForward, stopForward, stopHost } from '../server/forwards';
import { startSftpServer } from './helpers/sftp-server';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function startSvc(port: number): Promise<http.Server> {
  const svc = http.createServer((req, res) => {
    res.end(`svc:${req.url}`);
  });
  return new Promise((resolve, reject) => {
    svc.once('error', reject);
    svc.listen(port, '127.0.0.1', () => resolve(svc));
  });
}

async function withForwardedHost(fn: (hostId: number, db: import('../server/sqlite').Database.Database) => Promise<void>): Promise<void> {
  process.env.NODE_ENV = 'test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-fwd-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const srv = await startSftpServer();
  const host = createHost(db, {
    name: 'fwdbox',
    host: '127.0.0.1',
    port: srv.port,
    username: srv.user,
    auth_method: 'key',
    private_key: srv.privateKey(),
  });
  try {
    await fn(host.id, db);
  } finally {
    await stopHost(host.id).catch(() => undefined);
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('local forward: 127.0.0.1:PORT tunnels to remote service', async () => {
  await withForwardedHost(async (hostId, db) => {
    const svcPort = await freePort();
    const svc = await startSvc(svcPort);
    const localPort = await freePort();
    const fwd = createForward(db, {
      host_id: hostId,
      local_port: localPort,
      remote_host: '127.0.0.1',
      remote_port: svcPort,
      protocol: 'local',
    });

    try {
      await startForward(fwd.id);
      const res = await fetch(`http://127.0.0.1:${localPort}/hello`);
      assert.equal(await res.text(), 'svc:/hello');
      assert.equal(forwardStates()[fwd.id].active, true);

      await stopForward(fwd.id);
      assert.equal(forwardStates()[fwd.id].active, false);
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: localPort });
        s.once('connect', () => {
          s.destroy();
          reject(new Error('local port still accepting after stop'));
        });
        s.once('error', () => resolve());
      });

      const audit = listAudit();
      assert.ok(audit.some((a) => a.action === 'forward.start' && a.detail.includes(`:${localPort}`)));
      assert.ok(audit.some((a) => a.action === 'forward.stop'));
    } finally {
      await stopForward(fwd.id).catch(() => undefined);
      await new Promise<void>((r) => svc.close(() => r()));
    }
  });
});

test('dynamic forward: SOCKS5 proxy verified with curl --socks5', async () => {
  await withForwardedHost(async (hostId, db) => {
    const svcPort = await freePort();
    const svc = await startSvc(svcPort);
    const socksPort = await freePort();
    const fwd = createForward(db, {
      host_id: hostId,
      local_port: socksPort,
      remote_host: '127.0.0.1',
      remote_port: svcPort,
      protocol: 'socks',
    });

    try {
      await startForward(fwd.id);
      // async execFile: a sync spawn would block the loop and stall the in-process socks listener
      const out = await new Promise<string>((resolve, reject) => {
        execFile('curl', ['-s', '--socks5', `127.0.0.1:${socksPort}`, `http://127.0.0.1:${svcPort}/via-socks`], { timeout: 10000 }, (err, so) =>
          err ? reject(err) : resolve(so.toString()),
        );
      });
      assert.equal(out, 'svc:/via-socks');
    } finally {
      await stopForward(fwd.id).catch(() => undefined);
      await new Promise<void>((r) => svc.close(() => r()));
    }
  });
});

test('remote forward: remote binds a port into the local network', async () => {
  await withForwardedHost(async (hostId, db) => {
    const svcPort = await freePort();
    const svc = await startSvc(svcPort);
    const bindPort = await freePort();
    const fwd = createForward(db, {
      host_id: hostId,
      local_port: bindPort,
      remote_host: '127.0.0.1',
      remote_port: svcPort,
      protocol: 'remote',
    });

    try {
      await startForward(fwd.id);
      const st = forwardStates()[fwd.id];
      assert.equal(st.active, true);
      assert.equal(st.realPort, bindPort);

      const res = await fetch(`http://127.0.0.1:${bindPort}/from-remote`);
      assert.equal(await res.text(), 'svc:/from-remote');

      await stopForward(fwd.id);
      // sshd closes its listener slightly after acking cancel-tcpip-forward;
      // probe with fresh TCP connects (fetch would reuse pooled keep-alive sockets)
      const deadline = Date.now() + 3000;
      let refused = false;
      while (Date.now() < deadline) {
        refused = await new Promise<boolean>((resolve) => {
          const s = net.createConnection({ host: '127.0.0.1', port: bindPort });
          s.once('connect', () => {
            s.destroy();
            resolve(false);
          });
          s.once('error', () => resolve(true));
        });
        if (refused) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(refused, 'remote bound port should stop accepting after stop');
    } finally {
      await stopForward(fwd.id).catch(() => undefined);
      await new Promise<void>((r) => svc.close(() => r()));
    }
  });
});
