import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/index';
import { initDb, setDb } from '../server/db';
import {
  DEFAULT_COLORS,
  exportThemesJson,
  parseThemesImport,
  toXtermTheme,
} from '../shared/theme';
import { comboMatches, parseCombo, pushClipboardHistory } from '../shared/shortcuts';
import { escapePayload } from '../src/termSettings';

test('theme: toXtermTheme maps xterm keys, drops extras', () => {
  const t = toXtermTheme({ ...DEFAULT_COLORS });
  assert.equal(t.background, DEFAULT_COLORS.background);
  assert.equal(t.foreground, DEFAULT_COLORS.foreground);
  assert.equal(t.cursor, DEFAULT_COLORS.cursor);
  assert.equal(t.brightWhite, DEFAULT_COLORS.brightWhite);
  assert.equal((t as Record<string, string>).accent, undefined);

  const partial = toXtermTheme({ background: '#111111' });
  assert.equal(partial.background, '#111111');
  assert.equal(partial.foreground, undefined);
});

test('theme: import/export JSON round-trip', () => {
  const themes: { name: string; colors: Record<string, string> }[] = [
    { name: 'A', colors: { background: '#000001', foreground: '#000002' } },
    { name: 'B', colors: { cursor: '#000003' } },
  ];
  const parsed = parseThemesImport(exportThemesJson(themes));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'A');
  assert.equal(parsed[0].colors.background, '#000001');
  // missing colors merged with defaults
  assert.equal(parsed[1].colors.foreground, DEFAULT_COLORS.foreground);

  const single = parseThemesImport(JSON.stringify({ name: 'Solo', colors: { red: '#123456' } }));
  assert.equal(single.length, 1);
  assert.equal(single[0].colors.red, '#123456');

  assert.throws(() => parseThemesImport('not json'));
  assert.throws(() => parseThemesImport(JSON.stringify({ colors: {} })));
  assert.throws(() => parseThemesImport(JSON.stringify({ name: 'X' })));
});

test('shortcuts: combo parsing + matching', () => {
  const c = parseCombo('Ctrl+Shift+K');
  assert.deepEqual(c, { ctrl: true, shift: true, alt: false, meta: false, key: 'k' });
  assert.throws(() => parseCombo('ctrl+shift'));

  const mk = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

  assert.ok(comboMatches('ctrl+shift+k', mk('k', { ctrlKey: true, shiftKey: true })));
  assert.ok(!comboMatches('ctrl+shift+k', mk('k', { ctrlKey: true })));
  assert.ok(!comboMatches('ctrl+shift+k', mk('l', { ctrlKey: true, shiftKey: true })));
  assert.ok(comboMatches('escape', mk('Escape')));
  assert.ok(comboMatches('ctrl+shift+bad combo', mk('x')) === false);
});

test('shortcuts: clipboard history dedup + cap', () => {
  let list = pushClipboardHistory([], 'first');
  list = pushClipboardHistory(list, 'second');
  list = pushClipboardHistory(list, 'first');
  assert.deepEqual(
    list.map((x) => x.text),
    ['first', 'second'],
  );
  list = pushClipboardHistory(list, '   ');
  assert.equal(list.length, 2);
  for (let i = 0; i < 30; i++) list = pushClipboardHistory(list, `item-${i}`);
  assert.equal(list.length, 20);
});

test('termSettings: escapePayload', () => {
  assert.equal(escapePayload('\\n'), '\n');
  assert.equal(escapePayload('\\t'), '\t');
  assert.equal(escapePayload('\\e'), '\x1b');
  assert.equal(escapePayload('\\c-c'), '\x03');
  assert.equal(escapePayload('echo hi\\n'), 'echo hi\n');
});

test('themes API: default exclusivity', async () => {
  process.env.NODE_ENV = 'test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-themes-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  const app = await buildApp({ logger: false });
  try {
    const a = await app.inject({ method: 'POST', url: '/api/themes', payload: { name: 'a', colors: { background: '#111111' } } });
    assert.equal(a.statusCode, 200);
    const b = await app.inject({ method: 'POST', url: '/api/themes', payload: { name: 'b', colors: { foreground: '#222222' } } });
    const idB = (b.json() as { id: number }).id;

    const upd = await app.inject({ method: 'PUT', url: `/api/themes/${idB}`, payload: { is_default: true } });
    assert.equal(upd.statusCode, 200);
    assert.equal((upd.json() as { is_default: boolean }).is_default, true);

    const list = (await app.inject({ method: 'GET', url: '/api/themes' })).json() as { name: string; is_default: boolean }[];
    const defaults = list.filter((t) => t.is_default);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].name, 'b');
  } finally {
    await app.close();
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
