import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitAudit } from './audit-bus';
import type {
  AppPassword,
  AuditLog,
  GroupInput,
  Host,
  HostGroup,
  HostInput,
  KnownHost,
  PortForward,
  PortForwardInput,
  Snippet,
  SnippetInput,
  SyncEntity,
  Theme,
  ThemeInput,
} from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.TERMUS_DB || path.resolve(__dirname, '../data/termius.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  color TEXT NOT NULL DEFAULT '#6c5ce7',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL DEFAULT 'root',
  connection_type TEXT NOT NULL DEFAULT 'ssh',
  agent_forward INTEGER NOT NULL DEFAULT 0,
  auth_method TEXT NOT NULL DEFAULT 'password',
  password TEXT,
  private_key TEXT,
  pass_phrase TEXT,
  remote_command TEXT,
  keepalive INTEGER NOT NULL DEFAULT 30,
  color TEXT NOT NULL DEFAULT '#0ea5e9',
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL,
  protected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  colors TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  host_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS port_forwards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  local_port INTEGER NOT NULL,
  remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
  remote_port INTEGER NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'tcp',
  auto_start INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS known_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'unknown',
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (host, port)
);

CREATE TABLE IF NOT EXISTS app_passwords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
);

CREATE TABLE IF NOT EXISTS sync_queue (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (type, id)
);

CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts(group_id);
CREATE INDEX IF NOT EXISTS idx_forwards_host ON port_forwards(host_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

export function initDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const stmt of [
    'ALTER TABLE snippets ADD COLUMN group_id INTEGER REFERENCES host_groups(id) ON DELETE SET NULL',
    'ALTER TABLE snippets ADD COLUMN protected INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE hosts ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'ssh'",
    'ALTER TABLE hosts ADD COLUMN agent_forward INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE hosts ADD COLUMN vnc_transport TEXT DEFAULT 'ssh'",
    'ALTER TABLE hosts ADD COLUMN vnc_port INTEGER',
    'ALTER TABLE hosts ADD COLUMN vnc_password TEXT',
    'ALTER TABLE hosts ADD COLUMN vnc_ssh_host_id INTEGER',
    'ALTER TABLE hosts ADD COLUMN vnc_display INTEGER',
    "ALTER TABLE hosts ADD COLUMN vnc_desktop_mode TEXT DEFAULT 'auto'",
    'ALTER TABLE hosts ADD COLUMN vnc_auto_start INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE hosts ADD COLUMN vnc_auto_stop INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE hosts ADD COLUMN vnc_implementation TEXT DEFAULT 'auto'",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      /* column already present */
    }
  }
  return db;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) db = initDb();
  return db;
}

export function setDb(next: Database.Database | null): void {
  db = next;
}

type Row = Record<string, unknown>;

function asBool(v: unknown): boolean {
  return v === 1 || v === true;
}

export function mapHost(row: Row): Host {
  return {
    id: row.id as number,
    group_id: (row.group_id as number | null) ?? null,
    name: row.name as string,
    host: row.host as string,
    port: row.port as number,
    username: row.username as string,
    connection_type: (row.connection_type as Host['connection_type']) ?? 'ssh',
    agent_forward: asBool(row.agent_forward),
    auth_method: row.auth_method as Host['auth_method'],
    password: (row.password as string | null) ?? null,
    private_key: (row.private_key as string | null) ?? null,
    pass_phrase: (row.pass_phrase as string | null) ?? null,
    remote_command: (row.remote_command as string | null) ?? null,
    keepalive: row.keepalive as number,
    color: row.color as string,
    favorite: asBool(row.favorite),
    notes: row.notes as string,
    vnc_transport: (row.vnc_transport as Host['vnc_transport']) ?? null,
    vnc_port: (row.vnc_port as number | null) ?? null,
    vnc_password: (row.vnc_password as string | null) ?? null,
    vnc_ssh_host_id: (row.vnc_ssh_host_id as number | null) ?? null,
    vnc_display: (row.vnc_display as number | null) ?? null,
    vnc_desktop_mode: (row.vnc_desktop_mode as Host['vnc_desktop_mode']) ?? null,
    vnc_auto_start: asBool(row.vnc_auto_start),
    vnc_auto_stop: asBool(row.vnc_auto_stop),
    vnc_implementation: (row.vnc_implementation as Host['vnc_implementation']) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapGroup(row: Row): HostGroup {
  return {
    id: row.id as number,
    name: row.name as string,
    parent_id: (row.parent_id as number | null) ?? null,
    color: row.color as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapSnippet(row: Row): Snippet {
  const groupId = row.group_id;
  return {
    id: row.id as number,
    name: row.name as string,
    content: row.content as string,
    tags: row.tags as string,
    favorite: asBool(row.favorite),
    group_id: groupId === null || groupId === undefined ? null : (groupId as number),
    protected: asBool(row.protected),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapTheme(row: Row): Theme {
  return {
    id: row.id as number,
    name: row.name as string,
    colors: JSON.parse((row.colors as string) || '{}') as Record<string, string>,
    is_default: asBool(row.is_default),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function mapAudit(row: Row): AuditLog {
  return {
    id: row.id as number,
    action: row.action as string,
    host_id: (row.host_id as number | null) ?? null,
    detail: row.detail as string,
    created_at: row.created_at as string,
  };
}

export function mapAppPassword(row: Row): AppPassword {
  return {
    id: row.id as number,
    name: row.name as string,
    scope: row.scope as string,
    revoked: asBool(row.revoked),
    created_at: row.created_at as string,
    last_used_at: (row.last_used_at as string | null) ?? null,
  };
}

export function mapForward(row: Row): PortForward {
  return {
    id: row.id as number,
    host_id: row.host_id as number,
    local_port: row.local_port as number,
    remote_host: row.remote_host as string,
    remote_port: row.remote_port as number,
    protocol: row.protocol as string,
    auto_start: asBool(row.auto_start),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ---- hosts ----

export function listHosts(database: Database.Database = getDb()): Host[] {
  const rows = database.prepare('SELECT * FROM hosts ORDER BY favorite DESC, name ASC').all() as Row[];
  return rows.map(mapHost);
}

export function getHost(database: Database.Database, id: number): Host | null {
  const row = database.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as Row | undefined;
  return row ? mapHost(row) : null;
}

export function createHost(database: Database.Database, input: HostInput): Host {
  const isVnc = (input.connection_type ?? 'ssh') === 'vnc';
  const stmt = database.prepare(`
    INSERT INTO hosts (name, host, port, username, connection_type, agent_forward, auth_method, password, private_key, pass_phrase, remote_command, keepalive, color, favorite, notes, group_id, vnc_transport, vnc_port, vnc_password, vnc_ssh_host_id, vnc_display, vnc_desktop_mode, vnc_auto_start, vnc_auto_stop, vnc_implementation)
    VALUES (@name, @host, @port, @username, @connection_type, @agent_forward, @auth_method, @password, @private_key, @pass_phrase, @remote_command, @keepalive, @color, @favorite, @notes, @group_id, @vnc_transport, @vnc_port, @vnc_password, @vnc_ssh_host_id, @vnc_display, @vnc_desktop_mode, @vnc_auto_start, @vnc_auto_stop, @vnc_implementation)
  `);
  const info = stmt.run({
    name: input.name,
    host: input.host,
    port: input.port ?? 22,
    username: input.username ?? 'root',
    connection_type: input.connection_type ?? 'ssh',
    agent_forward: input.agent_forward ? 1 : 0,
    auth_method: input.auth_method ?? 'password',
    password: input.password ?? null,
    private_key: input.private_key ?? null,
    pass_phrase: input.pass_phrase ?? null,
    remote_command: input.remote_command ?? null,
    keepalive: input.keepalive ?? 30,
    color: input.color ?? '#0ea5e9',
    favorite: input.favorite ? 1 : 0,
    notes: input.notes ?? '',
    group_id: input.group_id ?? null,
    vnc_transport: isVnc ? (input.vnc_transport ?? 'ssh') : null,
    vnc_port: isVnc ? (input.vnc_port ?? 5900) : null,
    vnc_password: input.vnc_password ?? null,
    vnc_ssh_host_id: input.vnc_ssh_host_id ?? null,
    vnc_display: input.vnc_display ?? null,
    vnc_desktop_mode: isVnc ? (input.vnc_desktop_mode ?? 'auto') : null,
    vnc_auto_start: isVnc && input.vnc_auto_start !== false ? 1 : 0,
    vnc_auto_stop: input.vnc_auto_stop ? 1 : 0,
    vnc_implementation: isVnc ? (input.vnc_implementation ?? 'auto') : null,
  });
  const host = getHost(database, Number(info.lastInsertRowid))!;
  markDirty(database, 'host', host.id);
  return host;
}

export function updateHost(database: Database.Database, id: number, input: Partial<HostInput>): Host | null {
  const existing = getHost(database, id);
  if (!existing) return null;
  const next: HostInput = {
    name: input.name ?? existing.name,
    host: input.host ?? existing.host,
    port: input.port ?? existing.port,
    username: input.username ?? existing.username,
    connection_type: input.connection_type ?? existing.connection_type,
    agent_forward: input.agent_forward ?? existing.agent_forward,
    auth_method: input.auth_method ?? existing.auth_method,
    password: input.password !== undefined ? input.password : existing.password,
    private_key: input.private_key !== undefined ? input.private_key : existing.private_key,
    pass_phrase: input.pass_phrase !== undefined ? input.pass_phrase : existing.pass_phrase,
    remote_command: input.remote_command !== undefined ? input.remote_command : existing.remote_command,
    keepalive: input.keepalive ?? existing.keepalive,
    color: input.color ?? existing.color,
    favorite: input.favorite ?? existing.favorite,
    notes: input.notes ?? existing.notes,
    group_id: input.group_id !== undefined ? input.group_id : existing.group_id,
    vnc_transport: input.vnc_transport !== undefined ? input.vnc_transport : (existing.vnc_transport ?? undefined),
    vnc_port: input.vnc_port !== undefined ? input.vnc_port : existing.vnc_port,
    vnc_password: input.vnc_password !== undefined ? input.vnc_password : existing.vnc_password,
    vnc_ssh_host_id: input.vnc_ssh_host_id !== undefined ? input.vnc_ssh_host_id : existing.vnc_ssh_host_id,
    vnc_display: input.vnc_display !== undefined ? input.vnc_display : existing.vnc_display,
    vnc_desktop_mode: input.vnc_desktop_mode !== undefined ? input.vnc_desktop_mode : (existing.vnc_desktop_mode ?? undefined),
    vnc_auto_start: input.vnc_auto_start !== undefined ? input.vnc_auto_start : existing.vnc_auto_start,
    vnc_auto_stop: input.vnc_auto_stop !== undefined ? input.vnc_auto_stop : existing.vnc_auto_stop,
    vnc_implementation: input.vnc_implementation !== undefined ? input.vnc_implementation : (existing.vnc_implementation ?? undefined),
  };
  database.prepare(`
    UPDATE hosts SET name = @name, host = @host, port = @port, username = @username,
    connection_type = @connection_type, agent_forward = @agent_forward, auth_method = @auth_method,
    password = @password, private_key = @private_key, pass_phrase = @pass_phrase, remote_command = @remote_command,
    keepalive = @keepalive, color = @color, favorite = @favorite, notes = @notes, group_id = @group_id,
    vnc_transport = @vnc_transport, vnc_port = @vnc_port, vnc_password = @vnc_password,
    vnc_ssh_host_id = @vnc_ssh_host_id, vnc_display = @vnc_display, vnc_desktop_mode = @vnc_desktop_mode,
    vnc_auto_start = @vnc_auto_start, vnc_auto_stop = @vnc_auto_stop, vnc_implementation = @vnc_implementation,
    updated_at = datetime('now')
    WHERE id = @id
  `).run({
    ...next,
    favorite: next.favorite ? 1 : 0,
    agent_forward: next.agent_forward ? 1 : 0,
    vnc_auto_start: next.vnc_auto_start ? 1 : 0,
    vnc_auto_stop: next.vnc_auto_stop ? 1 : 0,
    id,
  });
  markDirty(database, 'host', id);
  return getHost(database, id);
}

export function deleteHost(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM hosts WHERE id = ?').run(id);
  markDirty(database, 'host', id);
}

export interface KeyMaterial {
  name: string;
  private_key: string;
  pass_phrase: string | null;
}

export function getKeyMaterial(database: Database.Database = getDb()): KeyMaterial[] {
  const rows = database
    .prepare('SELECT name, private_key, pass_phrase FROM hosts WHERE private_key IS NOT NULL AND private_key != \'\'')
    .all() as { name: string; private_key: string; pass_phrase: string | null }[];
  const seen = new Set<string>();
  const out: KeyMaterial[] = [];
  for (const row of rows) {
    if (seen.has(row.private_key)) continue;
    seen.add(row.private_key);
    out.push({ name: row.name, private_key: row.private_key, pass_phrase: row.pass_phrase ?? null });
  }
  return out;
}

// ---- groups ----

export function listGroups(database: Database.Database = getDb()): HostGroup[] {
  const rows = database.prepare('SELECT * FROM host_groups ORDER BY name ASC').all() as Row[];
  return rows.map(mapGroup);
}

function groupParentExists(database: Database.Database, parentId: number | null | undefined): boolean {
  if (parentId === null || parentId === undefined) return true;
  return database.prepare('SELECT 1 FROM host_groups WHERE id = ?').get(parentId) !== undefined;
}

function isDescendant(database: Database.Database, ancestorId: number, candidateId: number): boolean {
  let current: number | null = candidateId;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    if (current === ancestorId) return true;
    const row = database.prepare('SELECT parent_id FROM host_groups WHERE id = ?').get(current) as Row | undefined;
    current = (row?.parent_id as number | null) ?? null;
  }
  return false;
}

export function createGroup(database: Database.Database, input: GroupInput): HostGroup | null {
  if (!groupParentExists(database, input.parent_id)) return null;
  const info = database.prepare(`
    INSERT INTO host_groups (name, parent_id, color) VALUES (@name, @parent_id, @color)
  `).run({ name: input.name, parent_id: input.parent_id ?? null, color: input.color ?? '#6c5ce7' });
  const row = database.prepare('SELECT * FROM host_groups WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  const group = mapGroup(row);
  markDirty(database, 'group', group.id);
  return group;
}

export function updateGroup(database: Database.Database, id: number, input: Partial<GroupInput>): HostGroup | null {
  const existing = database.prepare('SELECT * FROM host_groups WHERE id = ?').get(id) as Row | undefined;
  if (!existing) return null;
  const parentId = input.parent_id !== undefined ? input.parent_id : (existing.parent_id as number | null);
  if (parentId !== null && (parentId === id || !groupParentExists(database, parentId) || isDescendant(database, id, parentId))) {
    return null;
  }
  database.prepare(`
    UPDATE host_groups SET name = @name, parent_id = @parent_id, color = @color, updated_at = datetime('now') WHERE id = @id
  `).run({
    name: input.name ?? (existing.name as string),
    parent_id: input.parent_id !== undefined ? input.parent_id : existing.parent_id,
    color: input.color ?? (existing.color as string),
    id,
  });
  markDirty(database, 'group', id);
  const row = database.prepare('SELECT * FROM host_groups WHERE id = ?').get(id) as Row;
  return mapGroup(row);
}

export function deleteGroup(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM host_groups WHERE id = ?').run(id);
  markDirty(database, 'group', id);
}

// ---- snippets ----

export function listSnippets(database: Database.Database = getDb(), groupId?: number | 'global' | null): Snippet[] {
  let sql = 'SELECT * FROM snippets';
  const params: (number | null)[] = [];
  if (groupId === 'global') {
    sql += ' WHERE group_id IS NULL';
  } else if (groupId !== null && groupId !== undefined) {
    sql += ' WHERE group_id = ?';
    params.push(groupId);
  }
  sql += ' ORDER BY favorite DESC, name ASC';
  const rows = database.prepare(sql).all(...params) as Row[];
  return rows.map(mapSnippet);
}

export function getSnippet(database: Database.Database = getDb(), id: number): Snippet | null {
  const row = database.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as Row | undefined;
  return row ? mapSnippet(row) : null;
}

export function createSnippet(database: Database.Database, input: SnippetInput): Snippet {
  const info = database.prepare(`
    INSERT INTO snippets (name, content, tags, favorite, group_id, protected)
    VALUES (@name, @content, @tags, @favorite, @group_id, @protected)
  `).run({
    name: input.name,
    content: input.content,
    tags: input.tags ?? '',
    favorite: input.favorite ? 1 : 0,
    group_id: input.group_id ?? null,
    protected: input.protected ? 1 : 0,
  });
  const row = database.prepare('SELECT * FROM snippets WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  const snippet = mapSnippet(row);
  markDirty(database, 'snippet', snippet.id);
  return snippet;
}

export function updateSnippet(database: Database.Database, id: number, input: Partial<SnippetInput>): Snippet | null {
  const existing = database.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as Row | undefined;
  if (!existing) return null;
  database.prepare(`
    UPDATE snippets SET name = @name, content = @content, tags = @tags, favorite = @favorite,
      group_id = @group_id, protected = @protected, updated_at = datetime('now') WHERE id = @id
  `).run({
    name: input.name ?? (existing.name as string),
    content: input.content ?? (existing.content as string),
    tags: input.tags ?? (existing.tags as string),
    favorite: (input.favorite ?? asBool(existing.favorite)) ? 1 : 0,
    group_id: input.group_id === undefined ? (existing.group_id as number | null) : input.group_id,
    protected: (input.protected ?? asBool(existing.protected)) ? 1 : 0,
    id,
  });
  markDirty(database, 'snippet', id);
  const row = database.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as Row;
  return mapSnippet(row);
}

export function deleteSnippet(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM snippets WHERE id = ?').run(id);
  markDirty(database, 'snippet', id);
}

// ---- themes ----

export function listThemes(database: Database.Database = getDb()): Theme[] {
  const rows = database.prepare('SELECT * FROM themes ORDER BY is_default DESC, name ASC').all() as Row[];
  return rows.map(mapTheme);
}

export function createTheme(database: Database.Database, input: ThemeInput): Theme {
  if (input.is_default) {
    database.prepare('UPDATE themes SET is_default = 0').run();
  }
  const info = database.prepare(`
    INSERT INTO themes (name, colors, is_default) VALUES (@name, @colors, @is_default)
  `).run({
    name: input.name,
    colors: JSON.stringify(input.colors ?? {}),
    is_default: input.is_default ? 1 : 0,
  });
  const row = database.prepare('SELECT * FROM themes WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  const theme = mapTheme(row);
  markDirty(database, 'theme', theme.id);
  return theme;
}

export function updateTheme(database: Database.Database, id: number, input: Partial<ThemeInput>): Theme | null {
  const existing = database.prepare('SELECT * FROM themes WHERE id = ?').get(id) as Row | undefined;
  if (!existing) return null;
  if (input.is_default) {
    database.prepare('UPDATE themes SET is_default = 0').run();
  }
  database.prepare(`
    UPDATE themes SET name = @name, colors = @colors, is_default = @is_default, updated_at = datetime('now') WHERE id = @id
  `).run({
    name: input.name ?? (existing.name as string),
    colors: JSON.stringify(input.colors ?? (JSON.parse(existing.colors as string) as Record<string, string>)),
    is_default: (input.is_default ?? asBool(existing.is_default)) ? 1 : 0,
    id,
  });
  markDirty(database, 'theme', id);
  const row = database.prepare('SELECT * FROM themes WHERE id = ?').get(id) as Row;
  return mapTheme(row);
}

export function deleteTheme(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM themes WHERE id = ?').run(id);
  markDirty(database, 'theme', id);
}

// ---- known hosts ----

export function mapKnownHost(row: Row): KnownHost {
  return {
    id: row.id as number,
    host: row.host as string,
    port: row.port as number,
    key_type: row.key_type as string,
    fingerprint: row.fingerprint as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function listKnownHosts(database: Database.Database = getDb()): KnownHost[] {
  const rows = database.prepare('SELECT * FROM known_hosts ORDER BY host ASC, port ASC').all() as Row[];
  return rows.map(mapKnownHost);
}

export function getKnownHost(
  database: Database.Database,
  host: string,
  port: number,
): KnownHost | null {
  const row = database.prepare('SELECT * FROM known_hosts WHERE host = ? AND port = ?').get(host, port) as
    | Row
    | undefined;
  return row ? mapKnownHost(row) : null;
}

export function upsertKnownHost(
  database: Database.Database,
  host: string,
  port: number,
  keyType: string,
  fingerprint: string,
): { entry: KnownHost; created: boolean } {
  const existing = getKnownHost(database, host, port);
  if (!existing) {
    database.prepare(
      'INSERT INTO known_hosts (host, port, key_type, fingerprint) VALUES (?, ?, ?, ?)',
    ).run(host, port, keyType, fingerprint);
    return { entry: getKnownHost(database, host, port)!, created: true };
  }
  database.prepare(
    'UPDATE known_hosts SET key_type = ?, fingerprint = ?, updated_at = datetime(\'now\') WHERE id = ?',
  ).run(keyType, fingerprint, existing.id);
  return { entry: getKnownHost(database, host, port)!, created: false };
}

export function deleteKnownHost(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM known_hosts WHERE id = ?').run(id);
}

// ---- audit ----

export function addAudit(
  database: Database.Database = getDb(),
  action: string,
  hostId: number | null = null,
  detail = '',
): AuditLog | undefined {
  const info = database.prepare('INSERT INTO audit_log (action, host_id, detail) VALUES (?, ?, ?)').run(action, hostId, detail);
  const id = Number(info.lastInsertRowid);
  const row = database.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as Row | undefined;
  const record = row ? mapAudit(row) : undefined;
  if (record) emitAudit(record);
  return record;
}

export function listAudit(database: Database.Database = getDb(), limit = 200): AuditLog[] {
  const rows = database.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as Row[];
  return rows.map(mapAudit);
}

// ---- app passwords (scoped tokens) ----

export function createAppPassword(
  database: Database.Database = getDb(),
  name: string,
  scope: string,
  tokenHash: string,
): AppPassword {
  database.prepare('INSERT INTO app_passwords (name, scope, token_hash) VALUES (?, ?, ?)').run(name, scope, tokenHash);
  const row = database.prepare('SELECT * FROM app_passwords WHERE token_hash = ?').get(tokenHash) as Row;
  return mapAppPassword(row);
}

export function listAppPasswords(database: Database.Database = getDb()): AppPassword[] {
  const rows = database.prepare('SELECT * FROM app_passwords ORDER BY id DESC').all() as Row[];
  return rows.map(mapAppPassword);
}

export function getAppPasswordByHash(
  database: Database.Database = getDb(),
  tokenHash: string,
): AppPassword | undefined {
  const row = database.prepare('SELECT * FROM app_passwords WHERE token_hash = ?').get(tokenHash) as Row | undefined;
  return row ? mapAppPassword(row) : undefined;
}

export function revokeAppPassword(database: Database.Database = getDb(), id: number): void {
  database.prepare('UPDATE app_passwords SET revoked = 1 WHERE id = ?').run(id);
}

export function touchAppPassword(database: Database.Database = getDb(), id: number): void {
  database.prepare("UPDATE app_passwords SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

// ---- settings ----

export function getSetting(database: Database.Database = getDb(), key: string): string | null {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
  return row ? (row.value as string) : null;
}

export function setSetting(database: Database.Database = getDb(), key: string, value: string): void {
  database.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  markDirty(database, 'setting', key);
}

export function listSettings(database: Database.Database = getDb()): Record<string, string> {
  const rows = database.prepare('SELECT key, value FROM settings').all() as Row[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key as string] = r.value as string;
  return out;
}

// ---- port forwards ----

export function listForwards(database: Database.Database = getDb(), hostId?: number): PortForward[] {
  const rows = hostId
    ? (database.prepare('SELECT * FROM port_forwards WHERE host_id = ? ORDER BY local_port ASC').all(hostId) as Row[])
    : (database.prepare('SELECT * FROM port_forwards ORDER BY host_id, local_port ASC').all() as Row[]);
  return rows.map(mapForward);
}

export function createForward(database: Database.Database, input: PortForwardInput): PortForward {
  const info = database.prepare(`
    INSERT INTO port_forwards (host_id, local_port, remote_host, remote_port, protocol, auto_start)
    VALUES (@host_id, @local_port, @remote_host, @remote_port, @protocol, @auto_start)
  `).run({
    host_id: input.host_id,
    local_port: input.local_port,
    remote_host: input.remote_host ?? '127.0.0.1',
    remote_port: input.remote_port,
    protocol: input.protocol ?? 'tcp',
    auto_start: input.auto_start ? 1 : 0,
  });
  const row = database.prepare('SELECT * FROM port_forwards WHERE id = ?').get(Number(info.lastInsertRowid)) as Row;
  return mapForward(row);
}

export function deleteForward(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM port_forwards WHERE id = ?').run(id);
}

// ---- sync: dirty tracking + entity collection/apply ----

/** Parse a SQLite `datetime('now')` value (UTC, second precision) to epoch millis. */
export function toUtcMs(value: string | null | undefined): number {
  if (!value) return 0;
  const norm = value.trim().replace(' ', 'T');
  const withZ = /Z|[+-]\d{2}:?\d{2}$/.test(norm) ? norm : `${norm}Z`;
  const ms = Date.parse(withZ);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Queue an entity for its next sync push (offline queue). `sync.*` settings are device-local. */
export function markDirty(
  database: Database.Database = getDb(),
  type: 'host' | 'group' | 'snippet' | 'theme' | 'setting',
  id: number | string,
): void {
  if (type === 'setting' && String(id).startsWith('sync.')) return;
  database.prepare(`
    INSERT INTO sync_queue (type, id) VALUES (?, ?)
    ON CONFLICT(type, id) DO NOTHING
  `).run(type, String(id));
}

export function countPending(database: Database.Database = getDb()): number {
  const row = database.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as Row;
  return Number(row.n ?? 0);
}

export function hasSyncMeta(database: Database.Database = getDb()): boolean {
  const row = database.prepare('SELECT 1 FROM sync_meta LIMIT 1').get();
  return row !== undefined;
}

export function getMetaRev(
  database: Database.Database,
  type: string,
  id: number | string,
): { rev: number; updated_at_ms: number } | null {
  const row = database
    .prepare('SELECT rev, updated_at_ms FROM sync_meta WHERE type = ? AND id = ?')
    .get(type, String(id)) as Row | undefined;
  return row ? { rev: row.rev as number, updated_at_ms: row.updated_at_ms as number } : null;
}

export function recordMeta(
  database: Database.Database,
  type: string,
  id: number | string,
  rev: number,
  updatedAtMs: number,
): void {
  database.prepare(`
    INSERT INTO sync_meta (type, id, rev, updated_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(type, id) DO UPDATE SET rev = excluded.rev, updated_at_ms = excluded.updated_at_ms
  `).run(type, String(id), rev, updatedAtMs);
}

export function clearQueue(
  database: Database.Database,
  entries: { type: string; id: number | string }[],
): void {
  const stmt = database.prepare('DELETE FROM sync_queue WHERE type = ? AND id = ?');
  const tx = database.transaction((items: { type: string; id: number | string }[]) => {
    for (const item of items) stmt.run(item.type, String(item.id));
  });
  tx(entries);
}

function rowEntity(database: Database.Database, table: string, id: number, map: (row: Row) => unknown): unknown {
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  return row ? map(row) : null;
}

/** Collect the queued (dirty) entities to push. First sync (no meta) exports everything. */
export function collectPending(database: Database.Database = getDb()): SyncEntity[] {
  const out: SyncEntity[] = [];
  if (!hasSyncMeta(database)) {
    for (const row of database.prepare('SELECT * FROM hosts').all() as Row[])
      out.push({ type: 'host', id: row.id as number, payload: mapHost(row), updated_at_ms: toUtcMs(row.updated_at as string), deleted: false });
    for (const row of database.prepare('SELECT * FROM host_groups').all() as Row[])
      out.push({ type: 'group', id: row.id as number, payload: mapGroup(row), updated_at_ms: toUtcMs(row.updated_at as string), deleted: false });
    for (const row of database.prepare('SELECT * FROM snippets').all() as Row[])
      out.push({ type: 'snippet', id: row.id as number, payload: mapSnippet(row), updated_at_ms: toUtcMs(row.updated_at as string), deleted: false });
    for (const row of database.prepare('SELECT * FROM themes').all() as Row[])
      out.push({ type: 'theme', id: row.id as number, payload: mapTheme(row), updated_at_ms: toUtcMs(row.updated_at as string), deleted: false });
    for (const row of database.prepare('SELECT key, value FROM settings').all() as Row[]) {
      const key = row.key as string;
      if (key.startsWith('sync.')) continue;
      out.push({ type: 'setting', id: key, payload: { key, value: row.value as string }, updated_at_ms: Date.now(), deleted: false });
    }
    return out;
  }
  const rows = database.prepare('SELECT type, id FROM sync_queue').all() as Row[];
  for (const row of rows) {
    const type = row.type as SyncEntity['type'];
    const id = row.id as string;
    if (type === 'setting') {
      const value = getSetting(database, id);
      out.push({
        type,
        id,
        payload: value === null ? null : { key: id, value },
        updated_at_ms: value === null ? Date.now() : Date.now(),
        deleted: value === null,
      });
      continue;
    }
    const table =
      type === 'host' ? 'hosts' : type === 'group' ? 'host_groups' : type === 'snippet' ? 'snippets' : 'themes';
    const map = type === 'host' ? mapHost : type === 'group' ? mapGroup : type === 'snippet' ? mapSnippet : mapTheme;
    const numId = Number(id);
    const payload = rowEntity(database, table, numId, map);
    out.push({
      type,
      id: numId,
      payload,
      updated_at_ms: payload ? toUtcMs((payload as { updated_at: string }).updated_at) : Date.now(),
      deleted: payload === null,
    });
  }
  return out;
}

/** Apply a remote entity (LWW winner) into the local database. */
export function applyRemoteEntity(
  database: Database.Database,
  entity: { type: string; id: number | string; payload: unknown; deleted: boolean },
): boolean {
  const { type, id, payload, deleted } = entity;
  if (type === 'setting') {
    const key = String(id);
    if (key.startsWith('sync.')) return false;
    if (deleted || payload === null) {
      database.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      setSetting(database, key, (payload as { value: string }).value);
    }
    return true;
  }
  if (type === 'host') {
    if (deleted || payload === null) {
      database.prepare('DELETE FROM hosts WHERE id = ?').run(Number(id));
      return true;
    }
    const p = payload as Host;
    database.prepare(`
      INSERT INTO hosts (id, group_id, name, host, port, username, connection_type, agent_forward, auth_method, password, private_key, pass_phrase, remote_command, keepalive, color, favorite, notes, vnc_transport, vnc_port, vnc_password, vnc_ssh_host_id, vnc_display, vnc_desktop_mode, vnc_auto_start, vnc_auto_stop, vnc_implementation, created_at, updated_at)
      VALUES (@id, @group_id, @name, @host, @port, @username, @connection_type, @agent_forward, @auth_method, @password, @private_key, @pass_phrase, @remote_command, @keepalive, @color, @favorite, @notes, @vnc_transport, @vnc_port, @vnc_password, @vnc_ssh_host_id, @vnc_display, @vnc_desktop_mode, @vnc_auto_start, @vnc_auto_stop, @vnc_implementation, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        group_id = excluded.group_id, name = excluded.name, host = excluded.host, port = excluded.port,
        username = excluded.username, connection_type = excluded.connection_type, agent_forward = excluded.agent_forward,
        auth_method = excluded.auth_method, password = excluded.password, private_key = excluded.private_key,
        pass_phrase = excluded.pass_phrase, remote_command = excluded.remote_command, keepalive = excluded.keepalive,
        color = excluded.color, favorite = excluded.favorite, notes = excluded.notes,
        vnc_transport = excluded.vnc_transport, vnc_port = excluded.vnc_port, vnc_password = excluded.vnc_password,
        vnc_ssh_host_id = excluded.vnc_ssh_host_id, vnc_display = excluded.vnc_display,
        vnc_desktop_mode = excluded.vnc_desktop_mode, vnc_auto_start = excluded.vnc_auto_start,
        vnc_auto_stop = excluded.vnc_auto_stop, vnc_implementation = excluded.vnc_implementation,
        created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run({
      id: p.id,
      group_id: p.group_id,
      name: p.name,
      host: p.host,
      port: p.port,
      username: p.username,
      connection_type: p.connection_type,
      agent_forward: p.agent_forward ? 1 : 0,
      auth_method: p.auth_method,
      password: p.password,
      private_key: p.private_key,
      pass_phrase: p.pass_phrase,
      remote_command: p.remote_command,
      keepalive: p.keepalive,
      color: p.color,
      favorite: p.favorite ? 1 : 0,
      notes: p.notes,
      vnc_transport: p.vnc_transport ?? null,
      vnc_port: p.vnc_port ?? null,
      vnc_password: p.vnc_password ?? null,
      vnc_ssh_host_id: p.vnc_ssh_host_id ?? null,
      vnc_display: p.vnc_display ?? null,
      vnc_desktop_mode: p.vnc_desktop_mode ?? null,
      vnc_auto_start: p.vnc_auto_start ? 1 : 0,
      vnc_auto_stop: p.vnc_auto_stop ? 1 : 0,
      vnc_implementation: p.vnc_implementation ?? null,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
    return true;
  }
  if (type === 'group') {
    if (deleted || payload === null) {
      database.prepare('DELETE FROM host_groups WHERE id = ?').run(Number(id));
      return true;
    }
    const p = payload as HostGroup;
    database.prepare(`
      INSERT INTO host_groups (id, name, parent_id, color, created_at, updated_at)
      VALUES (@id, @name, @parent_id, @color, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, color = excluded.color,
        created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run({ id: p.id, name: p.name, parent_id: p.parent_id, color: p.color, created_at: p.created_at, updated_at: p.updated_at });
    return true;
  }
  if (type === 'snippet') {
    if (deleted || payload === null) {
      database.prepare('DELETE FROM snippets WHERE id = ?').run(Number(id));
      return true;
    }
    const p = payload as Snippet;
    database.prepare(`
      INSERT INTO snippets (id, name, content, tags, favorite, group_id, protected, created_at, updated_at)
      VALUES (@id, @name, @content, @tags, @favorite, @group_id, @protected, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, tags = excluded.tags,
        favorite = excluded.favorite, group_id = excluded.group_id, protected = excluded.protected,
        created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run({
      id: p.id,
      name: p.name,
      content: p.content,
      tags: p.tags,
      favorite: p.favorite ? 1 : 0,
      group_id: p.group_id,
      protected: p.protected ? 1 : 0,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
    return true;
  }
  if (type === 'theme') {
    if (deleted || payload === null) {
      database.prepare('DELETE FROM themes WHERE id = ?').run(Number(id));
      return true;
    }
    const p = payload as Theme;
    database.prepare(`
      INSERT INTO themes (id, name, colors, is_default, created_at, updated_at)
      VALUES (@id, @name, @colors, @is_default, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, colors = excluded.colors, is_default = excluded.is_default,
        created_at = excluded.created_at, updated_at = excluded.updated_at
    `).run({
      id: p.id,
      name: p.name,
      colors: JSON.stringify(p.colors ?? {}),
      is_default: p.is_default ? 1 : 0,
      created_at: p.created_at,
      updated_at: p.updated_at,
    });
    return true;
  }
  return false;
}
