import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createForward,
  createGroup,
  createHost,
  createSnippet,
  createTheme,
  deleteHost,
  getHost,
  getSetting,
  initDb,
  listForwards,
  listGroups,
  listHosts,
  listSnippets,
  listThemes,
  setSetting,
  updateHost,
} from '../server/db';

function tempDb(): { db: ReturnType<typeof initDb>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-test-'));
  const file = path.join(dir, 'test.db');
  const db = initDb(file);
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('host CRUD lifecycle', () => {
  const { db, cleanup } = tempDb();
  try {
    const created = createHost(db, { name: 'web-1', host: '10.0.0.5', port: 2222, username: 'deploy' });
    assert.ok(created.id > 0);
    assert.equal(created.name, 'web-1');
    assert.equal(created.port, 2222);

    const fetched = getHost(db, created.id);
    assert.ok(fetched);
    assert.equal(fetched?.host, '10.0.0.5');

    const updated = updateHost(db, created.id, { name: 'web-1-renamed', favorite: true });
    assert.ok(updated);
    assert.equal(updated?.name, 'web-1-renamed');
    assert.equal(updated?.favorite, true);

    assert.equal(listHosts(db).length, 1);

    deleteHost(db, created.id);
    assert.equal(listHosts(db).length, 0);
    assert.equal(getHost(db, created.id), null);
  } finally {
    cleanup();
  }
});

test('host defaults are applied', () => {
  const { db, cleanup } = tempDb();
  try {
    const h = createHost(db, { name: 'min', host: 'example.com' });
    assert.equal(h.port, 22);
    assert.equal(h.username, 'root');
    assert.equal(h.auth_method, 'password');
    assert.equal(h.keepalive, 30);
    assert.equal(h.favorite, false);
  } finally {
    cleanup();
  }
});

test('group CRUD and host grouping', () => {
  const { db, cleanup } = tempDb();
  try {
    const group = createGroup(db, { name: 'Production' });
    assert.ok(group);
    assert.ok(group.id > 0);
    const host = createHost(db, { name: 'api-1', host: '10.1.1.1', group_id: group.id });
    assert.equal(host.group_id, group.id);
    assert.equal(listGroups(db).length, 1);
  } finally {
    cleanup();
  }
});

test('snippet CRUD', () => {
  const { db, cleanup } = tempDb();
  try {
    const s = createSnippet(db, { name: 'restart', content: 'systemctl restart nginx', tags: 'ops' });
    assert.ok(s.id > 0);
    assert.equal(listSnippets(db).length, 1);
    assert.equal(s.tags, 'ops');
  } finally {
    cleanup();
  }
});

test('theme CRUD with default handling', () => {
  const { db, cleanup } = tempDb();
  try {
    const t1 = createTheme(db, { name: 'Dark', colors: { background: '#000' }, is_default: true });
    assert.equal(t1.is_default, true);
    const t2 = createTheme(db, { name: 'Light', colors: { background: '#fff' }, is_default: true });
    assert.equal(t2.is_default, true);
    const all = listThemes(db);
    assert.equal(all.length, 2);
    const defaults = all.filter((t) => t.is_default);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, t2.id);
    assert.equal(t2.colors.background, '#fff');
  } finally {
    cleanup();
  }
});

test('settings get/set/list', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(getSetting(db, 'theme'), null);
    setSetting(db, 'theme', 'dark');
    assert.equal(getSetting(db, 'theme'), 'dark');
    setSetting(db, 'theme', 'light');
    assert.equal(getSetting(db, 'theme'), 'light');
  } finally {
    cleanup();
  }
});

test('port forwards CRUD scoped by host', () => {
  const { db, cleanup } = tempDb();
  try {
    const h = createHost(db, { name: 'fw', host: '10.2.2.2' });
    const f = createForward(db, { host_id: h.id, local_port: 9000, remote_port: 80 });
    assert.ok(f.id > 0);
    assert.equal(f.remote_host, '127.0.0.1');
    assert.equal(f.protocol, 'tcp');
    assert.equal(listForwards(db, h.id).length, 1);
    assert.equal(listForwards(db).length, 1);
  } finally {
    cleanup();
  }
});
