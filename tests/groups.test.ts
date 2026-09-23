import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGroup, initDb, updateGroup } from '../server/db';

test('groups: create with parent, update, cycle prevention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-groups-'));
  const db = initDb(path.join(dir, 'test.db'));

  const a = createGroup(db, { name: 'A' })!;
  const b = createGroup(db, { name: 'B', parent_id: a.id })!;
  const c = createGroup(db, { name: 'C', parent_id: b.id })!;
  assert.equal(b.parent_id, a.id);
  assert.equal(c.parent_id, b.id);

  // unknown parent
  assert.equal(createGroup(db, { name: 'X', parent_id: 9999 }), null);

  // move B under C would create a cycle (C is a descendant of B)
  assert.equal(updateGroup(db, b.id, { parent_id: c.id }), null);
  // self-parent
  assert.equal(updateGroup(db, a.id, { parent_id: a.id }), null);
  // unknown parent on update
  assert.equal(updateGroup(db, a.id, { parent_id: 9999 }), null);

  // valid: move B back to root, rename A
  const b2 = updateGroup(db, b.id, { parent_id: null })!;
  assert.equal(b2.parent_id, null);
  const a2 = updateGroup(db, a.id, { name: 'A2' })!;
  assert.equal(a2.name, 'A2');
  assert.equal(a2.parent_id, null);
});
