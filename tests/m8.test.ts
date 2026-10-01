import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/index';
import { addAudit, createHost, initDb, setDb } from '../server/db';
import type { AppPassword, AppPasswordCreated } from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('waitFor timeout');
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
  });
}

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-m8-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  return { db, dir };
}

async function readSseEvents(
  url: string,
  onEvents: (events: { detail: string }[]) => void,
  runMidway: () => void,
  totalMs: number,
): Promise<void> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: { detail: string }[] = [];
  const parseFrames = () => {
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        try {
          events.push(JSON.parse(dataLine.slice(6)));
        } catch {
          /* ignore */
        }
      }
    }
  };
  const timer = setTimeout(runMidway, Math.floor(totalMs / 2));
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) buf += decoder.decode(value, { stream: true });
    parseFrames();
  }
  clearTimeout(timer);
  await reader.cancel().catch(() => {});
  onEvents(events);
}

test('audit: SSE stream replays tail + pushes live events; JSONL export', async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${Number(address.split(':').pop())}`;

  try {
    addAudit(db, 'session.start', null, 'seed-1');
    addAudit(db, 'session.start', null, 'seed-2');

    const exp = await fetch(`${base}/api/audit/export?limit=100`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-type') ?? '', /x-ndjson/);
    const lines = (await exp.text()).trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 2);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed.some((r) => r.detail === 'seed-2'));

    const seen: { detail: string }[] = [];
    await readSseEvents(
      `${base}/api/audit/stream`,
      (events) => seen.push(...events),
      () => addAudit(db, 'session.start', null, 'live-event'),
      500,
    );
    const details = seen.map((e) => e.detail);
    assert.ok(details.includes('seed-2'), 'SSE must replay the recent tail');
    assert.ok(details.includes('live-event'), 'SSE must stream live events');
  } finally {
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tokens: scoped app passwords (create, verify, scope, revoke)', async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });

  try {
    const c1 = await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'ci', scope: 'verify' } });
    assert.equal(c1.statusCode, 201);
    const t1 = c1.json() as AppPasswordCreated;
    assert.ok(t1.token.startsWith('tfp_'));
    assert.equal(t1.scope, 'verify');

    const ok = await app.inject({ method: 'GET', url: '/api/tokens/verify', headers: { authorization: `Bearer ${t1.token}` } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().name, 'ci');

    const missing = await app.inject({ method: 'GET', url: '/api/tokens/verify' });
    assert.equal(missing.statusCode, 401);

    const c2 = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: { authorization: `Bearer ${t1.token}` },
      payload: { name: 'ro', scope: 'read' },
    });
    assert.equal(c2.statusCode, 201);
    const t2 = c2.json() as AppPasswordCreated;
    const wrong = await app.inject({ method: 'GET', url: '/api/tokens/verify', headers: { authorization: `Bearer ${t2.token}` } });
    assert.equal(wrong.statusCode, 403);

    const unauthed = await app.inject({ method: 'GET', url: '/api/tokens' });
    assert.equal(unauthed.statusCode, 401);

    const list = await app.inject({ method: 'GET', url: '/api/tokens', headers: { authorization: `Bearer ${t1.token}` } });
    assert.equal(list.statusCode, 200);
    const items = list.json() as AppPassword[];
    assert.ok(items.some((p) => p.name === 'ci'));
    for (const p of items) {
      assert.ok(!('token' in p), 'plaintext token must not be listed');
      assert.ok(!('token_hash' in p), 'token hash must not be listed');
    }
    const ci = items.find((p) => p.name === 'ci')!;
    assert.ok(ci.last_used_at, 'last_used_at must be recorded on verify');

    const del = await app.inject({ method: 'DELETE', url: `/api/tokens/${t1.id}`, headers: { authorization: `Bearer ${t1.token}` } });
    assert.equal(del.statusCode, 204);
    const after = await app.inject({ method: 'GET', url: '/api/tokens/verify', headers: { authorization: `Bearer ${t1.token}` } });
    assert.equal(after.statusCode, 401);
  } finally {
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bin/term: attaches to a telnet host over the same WS API and echoes', async () => {
  const { db, dir } = makeTempDb();
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const server = `http://127.0.0.1:${Number(address.split(':').pop())}`;

  const IAC = 0xff;
  const tcp = net.createServer((socket) => {
    socket.write(Buffer.from([IAC, 0x05, IAC, 0x18]));
    socket.write(Buffer.from('CLI-READY\r\n'));
    socket.on('data', (data) => socket.write(`CLI:${data.toString('utf8')}`));
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const tport = (tcp.address() as { port: number }).port;
  createHost(db, { name: 'clibox', host: '127.0.0.1', port: tport, connection_type: 'telnet' });

  const child = spawn(process.execPath, ['bin/term.mjs', 'clibox', '--server', server, '-v'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString('utf8')));

  try {
    await waitFor(() => out.includes('CLI-READY'), 5000);
    child.stdin.write('ping');
    await waitFor(() => out.includes('CLI:ping'), 5000);
    assert.ok(out.includes('CLI-READY'));
    assert.ok(out.includes('CLI:ping'));
    child.stdin.end();
    const code = await exitCode(child);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    tcp.close();
    await app.close();
    setDb(null);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
