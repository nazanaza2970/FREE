import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

process.env.RECONNECT_COOLDOWN_MS = '0';
import { buildApp } from '../server/index';
import { createGroup, createHost, initDb, listAudit, setDb } from '../server/db';
import { extractVariables, renderSnippet } from '../shared/snippets';
import { startSftpServer } from './helpers/sftp-server';

function withEnvConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-snippet-cfg-'));
  process.env.TERMUS_CONFIG_DIR = dir;
  return dir;
}

test('snippets: CRUD + group scoping via API', async () => {
  process.env.NODE_ENV = 'test';
  const cfgDir = withEnvConfigDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-snippet-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });

  try {
    const group = createGroup(db, { name: 'ops' })!;

    const created = await app.inject({
      method: 'POST',
      url: '/api/snippets',
      payload: { name: 'uptime', content: 'uptime', tags: 'sys', group_id: group.id },
    });
    assert.equal(created.statusCode, 200);
    const body = created.json() as { id: number; content: string; group_id: number | null; protected: boolean };
    assert.equal(body.content, 'uptime');
    assert.equal(body.group_id, group.id);
    assert.equal(body.protected, false);

    const inGroup = (await app.inject({ method: 'GET', url: `/api/snippets?group_id=${group.id}` })).json() as unknown[];
    assert.equal(inGroup.length, 1);
    const globalOnly = (await app.inject({ method: 'GET', url: '/api/snippets?group_id=global' })).json() as unknown[];
    assert.equal(globalOnly.length, 0);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/snippets/${body.id}`,
      payload: { name: 'uptime-all' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal((updated.json() as { name: string }).name, 'uptime-all');
    assert.equal((updated.json() as { content: string }).content, 'uptime');

    const del = await app.inject({ method: 'DELETE', url: `/api/snippets/${body.id}` });
    assert.equal(del.statusCode, 204);
    const after = (await app.inject({ method: 'GET', url: '/api/snippets' })).json() as unknown[];
    assert.equal(after.length, 0);
  } finally {
    await app.close();
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('snippets: protected snippets encrypted at rest, masked in API, revealed on demand', async () => {
  process.env.NODE_ENV = 'test';
  const cfgDir = withEnvConfigDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-snippet-p-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });

  try {
    const secret = 'hunter2-{{token}}';
    const created = (await app.inject({
      method: 'POST',
      url: '/api/snippets',
      payload: { name: 'prod-login', content: secret, protected: true },
    })).json() as { id: number; content: string; protected: boolean };
    assert.equal(created.protected, true);
    assert.equal(created.content, '');

    // at rest: encrypted blob, no plaintext
    const raw = db.prepare('SELECT content FROM snippets WHERE id = ?').get(created.id) as { content: string };
    assert.ok(raw.content.startsWith('v1.'), 'stored content should be a versioned blob');
    assert.ok(!raw.content.includes('hunter2'), 'plaintext must not be stored');
    assert.ok(!raw.content.includes(secret));

    // list + detail stay masked
    const listed = (await app.inject({ method: 'GET', url: '/api/snippets' })).json() as { content: string }[];
    assert.equal(listed[0].content, '');
    const detail = (await app.inject({ method: 'GET', url: `/api/snippets/${created.id}` })).json() as { content: string };
    assert.equal(detail.content, '');

    // reveal returns plaintext and is audited
    const revealed = (await app.inject({ method: 'GET', url: `/api/snippets/${created.id}/reveal` })).json() as {
      content: string;
    };
    assert.equal(revealed.content, secret);
    const audits = listAudit(db, 50);
    assert.ok(audits.some((a) => a.action === 'snippet.reveal'));

    // update re-encrypts
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/snippets/${created.id}`,
      payload: { content: 'rotated-{{token}}' },
    });
    assert.equal((updated.json() as { content: string }).content, '');
    const raw2 = db.prepare('SELECT content FROM snippets WHERE id = ?').get(created.id) as { content: string };
    assert.ok(!raw2.content.includes('rotated-'), 'updated plaintext must not be stored');
    const revealed2 = (await app.inject({ method: 'GET', url: `/api/snippets/${created.id}/reveal` })).json() as {
      content: string;
    };
    assert.equal(revealed2.content, 'rotated-{{token}}');

    // keystore exists in the config dir
    assert.ok(fs.existsSync(path.join(cfgDir, 'keystore.json')));
  } finally {
    await app.close();
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('snippets: variable extraction + rendering', () => {
  assert.deepEqual(extractVariables('echo {{user}} on {{host}} (again {{user}})'), ['user', 'host']);
  assert.equal(renderSnippet('echo {{user}} on {{host}}', { user: 'alice' }), 'echo alice on {{host}}');
  assert.equal(renderSnippet('echo {{user}}', { user: 'bob', host: 'x' }), 'echo bob');
  assert.deepEqual(extractVariables('no vars here'), []);
});

test('snippets: insert rendered snippet into a live session', async () => {
  process.env.NODE_ENV = 'test';
  const cfgDir = withEnvConfigDir();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-snippet-live-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const httpPort = Number(address.split(':').pop());

  const ssh = await startSftpServer();
  const host = createHost(db, {
    name: 'box',
    host: '127.0.0.1',
    port: ssh.port,
    username: ssh.user,
    auth_method: 'key',
    private_key: ssh.privateKey(),
  });

  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws/terminal`);
  const messages: { type: string; data?: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; data?: string };
      messages.push(m);
    });
  });

  try {
    ws.send(JSON.stringify({ type: 'connect', sessionId: 'sn1', hostId: host.id }));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((m) => m.type === 'status' && (m as { state?: string }).state === 'connected')) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });

    // what the picker would send: rendered vars + newline
    const rendered = renderSnippet('echo {{msg}}', { msg: 'SNIPPET-OK' }) + '\n';
    ws.send(JSON.stringify({ type: 'input', sessionId: 'sn1', data: rendered }));

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((m) => m.type === 'output' && Buffer.from(m.data ?? '', 'base64').toString('utf8').includes('SNIPPET-OK'))) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });
    assert.ok(
      messages.some((m) => m.type === 'output' && Buffer.from(m.data ?? '', 'base64').toString('utf8').includes('SNIPPET-OK')),
      'shell output should contain the inserted snippet result',
    );
  } finally {
    ws.close();
    await app.close();
    setDb(null);
    void ssh.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
