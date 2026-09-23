import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSyncApp, initSyncDb } from '../server/sync/server';
import { createToken } from '../server/tokens';
import type { SyncEntity, SyncState } from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${what}`);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`waitForHttp timeout: ${url}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  return body;
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}

const t1 = test('sync server: auth, LWW merge, tombstones, device registry', async () => {
  const dir = tempDir('tf-m9-sync-');
  const db = initSyncDb(path.join(dir, 'sync.db'));
  const app = buildSyncApp({ db });
  await app.ready();

  // auth: no token -> 401
  const noTok = await app.inject({ method: 'GET', url: '/sync/state' });
  assert.equal(noTok.statusCode, 401);

  // read-scoped token cannot push/sync -> 403
  const reader = createToken(db, 'reader', 'read');
  const forbidden = await app.inject({
    method: 'GET',
    url: '/sync/state',
    headers: { authorization: `Bearer ${reader.token}` },
  });
  assert.equal(forbidden.statusCode, 403);

  // sync-scoped token via the sync server's own token endpoint
  const created = await app.inject({ method: 'POST', url: '/sync/tokens', payload: { name: 'device-a' } });
  assert.equal(created.statusCode, 201);
  const { token } = created.json() as { token: string };
  const auth = { authorization: `Bearer ${token}` };

  // register + push with LWW
  const reg = await app.inject({
    method: 'POST',
    url: '/sync/register',
    payload: { deviceId: 'dev-1', name: 'device-a' },
  });
  assert.equal(reg.statusCode, 200);
  assert.equal((reg.json() as { id: string }).id, 'dev-1');

  const t1ms = Date.parse('2026-01-01T00:00:01Z');
  const t2ms = Date.parse('2026-01-01T00:00:02Z');
  const entity = (name: string, ms: number, deleted = false): SyncEntity => ({
    type: 'host',
    id: 1,
    payload: deleted ? null : { id: 1, name },
    updated_at_ms: ms,
    deleted,
  });

  const push1 = await app.inject({ method: 'POST', url: '/sync/push', headers: auth, payload: { entities: [entity('first', t1ms)] } });
  assert.equal(push1.statusCode, 200);
  assert.equal((push1.json() as { accepted: number }).accepted, 1);

  // strictly newer write wins
  const push2 = await app.inject({ method: 'POST', url: '/sync/push', headers: auth, payload: { entities: [entity('second', t2ms)] } });
  let state = (push2.json() as { state: SyncState }).state;
  assert.equal(state.entities[0].rev, 2);
  assert.equal((state.entities[0].payload as { name: string }).name, 'second');

  // stale write does not regress
  const push3 = await app.inject({ method: 'POST', url: '/sync/push', headers: auth, payload: { entities: [entity('stale', t1ms)] } });
  state = (push3.json() as { state: SyncState }).state;
  assert.equal(state.entities[0].rev, 2);
  assert.equal((state.entities[0].payload as { name: string }).name, 'second');

  // tombstone
  const push4 = await app.inject({ method: 'POST', url: '/sync/push', headers: auth, payload: { entities: [entity('', t2ms + 1000, true)] } });
  state = (push4.json() as { state: SyncState }).state;
  assert.equal(state.entities[0].deleted, true);
  assert.equal(state.entities[0].payload, null);

  // device registry
  const devices = await app.inject({ method: 'GET', url: '/sync/devices', headers: auth });
  assert.equal((devices.json() as { id: string }[]).length, 1);

  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const t2 = test('two devices converge through a real sync server (LWW + offline queue)', async () => {
  const dir = tempDir('tf-m9-e2e-');
  const syncPort = await freePort();
  const syncDb = initSyncDb(path.join(dir, 'sync.db'));
  const syncApp = buildSyncApp({ db: syncDb });
  await syncApp.listen({ port: syncPort, host: '127.0.0.1' });
  const syncUrl = `http://127.0.0.1:${syncPort}`;

  const created = await syncApp.inject({ method: 'POST', url: '/sync/tokens', payload: { name: 'devices' } });
  const { token } = created.json() as { token: string };

  const appAPort = await freePort();
  const appBPort = await freePort();
  const spawnApp = (dbPath: string, port: number): ChildProcess =>
    spawn(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'server', 'index.ts')], {
      env: { ...process.env, TERMUS_DB: dbPath, PORT: String(port), HOST: '127.0.0.1' },
      stdio: 'ignore',
    });

  const appA = spawnApp(path.join(dir, 'a.db'), appAPort);
  const appB = spawnApp(path.join(dir, 'b.db'), appBPort);
  const urlA = `http://127.0.0.1:${appAPort}`;
  const urlB = `http://127.0.0.1:${appBPort}`;
  const cleanup = () => {
    appA.kill();
    appB.kill();
  };
  process.on('exit', cleanup);

  try {
    await Promise.all([waitForHttp(`${urlA}/health`, 20000), waitForHttp(`${urlB}/health`, 20000)]);
  } catch (e) {
    cleanup();
    throw new Error(`failed to boot test apps: ${String(e)}`);
  }

  const config = (base: string) => fetch(`${base}/api/sync/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server_url: syncUrl, token, device_name: base === urlA ? 'device-a' : 'device-b', enabled: true }) }).then((r) => r.json());
  const merge = (base: string) => fetch(`${base}/api/sync/merge`, { method: 'POST' }).then((r) => r.json());
  const hosts = (base: string) => fetch(`${base}/api/hosts`).then((r) => r.json() as Promise<{ id: number; name: string }[]>);

  // configure both devices and do an initial (empty) merge
  const cfgA = await config(urlA);
  const cfgB = await config(urlB);
  assert.ok(cfgA.device_id && cfgB.device_id && cfgA.device_id !== cfgB.device_id);
  assert.equal((await merge(urlA)).ok, true);
  assert.equal((await merge(urlB)).ok, true);

  // A creates alpha -> B merges -> B has alpha
  await fetch(`${urlA}/api/hosts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alpha', host: 'a.example', port: 22 }) });
  assert.equal((await merge(urlA)).ok, true);
  assert.equal((await merge(urlB)).ok, true);
  let hostsB = await hosts(urlB);
  assert.ok(hostsB.some((h) => h.name === 'alpha'), 'B should have alpha');
  const alphaIdB = hostsB.find((h) => h.name === 'alpha')!.id;

  // B creates beta -> A merges -> A has beta (convergence)
  await fetch(`${urlB}/api/hosts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'beta', host: 'b.example', port: 22 }) });
  assert.equal((await merge(urlB)).ok, true);
  assert.equal((await merge(urlA)).ok, true);
  const hostsA = await hosts(urlA);
  assert.ok(hostsA.some((h) => h.name === 'beta'), 'A should have beta');
  assert.ok(hostsA.some((h) => h.name === 'alpha'), 'A should keep its own alpha');

  // LWW: both edit alpha; the strictly-later write must win on both devices
  const alphaIdA = hostsA.find((h) => h.name === 'alpha')!.id;
  await fetch(`${urlA}/api/hosts/${alphaIdA}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alpha-from-a' }) });
  assert.equal((await merge(urlA)).ok, true);
  await sleep(1100); // next second, so B's write is strictly newer
  await fetch(`${urlB}/api/hosts/${alphaIdB}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alpha-from-b' }) });
  assert.equal((await merge(urlB)).ok, true);
  assert.equal((await merge(urlA)).ok, true);
  const finalA = await hosts(urlA);
  const finalB = await hosts(urlB);
  assert.equal(finalA.find((h) => h.id === alphaIdA)?.name, 'alpha-from-b', 'later write wins on A');
  assert.equal(finalB.find((h) => h.id === alphaIdB)?.name, 'alpha-from-b', 'later write wins on B');

  // offline queue: point A at a dead port, change something, merge -> queued, then recover
  await fetch(`${urlA}/api/sync/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server_url: 'http://127.0.0.1:1' }) });
  await fetch(`${urlA}/api/hosts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'gamma', host: 'g.example', port: 22 }) });
  const offlineCfg = await fetch(`${urlA}/api/sync/config`).then((r) => r.json() as Promise<{ pending: number }>);
  assert.equal(offlineCfg.pending, 1, 'change queued while offline');
  const offline = await merge(urlA);
  assert.equal(offline.ok, false);
  assert.ok(offline.error);
  assert.equal(offline.pending, 1);

  await fetch(`${urlA}/api/sync/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server_url: syncUrl }) });
  const recovered = await merge(urlA);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.pending, 0, 'queue drained after reconnect');
  const serverState = (await syncApp.inject({ method: 'GET', url: '/sync/state', headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as SyncState));
  assert.ok(serverState.entities.some((e) => e.type === 'host' && (e.payload as { name?: string })?.name === 'gamma'));
  assert.equal((await merge(urlB)).ok, true);
  assert.ok((await hosts(urlB)).some((h) => h.name === 'gamma'), 'B receives gamma after A reconnects');

  cleanup();
  process.off('exit', cleanup);
  await Promise.all([
    new Promise((r) => appA.once('exit', r)),
    new Promise((r) => appB.once('exit', r)),
  ]);
  await syncApp.close();
  syncDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

void t1;
void t2;
