import Fastify, { type FastifyInstance } from 'fastify';
import Database from '../sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToken, hashToken, requireScope } from '../tokens';
import { createAppPassword, getAppPasswordByHash, listAppPasswords, revokeAppPassword } from '../db';
import type { SyncDevice, SyncEntity, SyncState } from '../../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = process.env.SYNC_DB || path.resolve(__dirname, '../../data/sync.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_entities (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, id)
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
`;

export function initSyncDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

type Row = Record<string, unknown>;

function mapEntity(row: Row): SyncEntity {
  return {
    type: row.type as SyncEntity['type'],
    id: Number.isInteger(Number(row.id)) ? (Number(row.id) as number) : (row.id as string),
    payload: row.deleted ? null : (row.payload ? (JSON.parse(row.payload as string) as unknown) : null),
    updated_at_ms: row.updated_at_ms as number,
    deleted: row.deleted === 1 || row.deleted === true,
    rev: row.rev as number,
  };
}

function snapshot(db: Database.Database): SyncState {
  const rows = db.prepare('SELECT * FROM sync_entities ORDER BY type ASC, id ASC').all() as Row[];
  return { entities: rows.map(mapEntity), server_time: new Date().toISOString() };
}

/**
 * Last-write-wins merge of one incoming entity. Strictly newer timestamps win;
 * exact ties keep the stored copy (deterministic). Returns true when changed.
 */
function mergeEntity(db: Database.Database, entity: SyncEntity): boolean {
  const existing = db
    .prepare('SELECT rev, updated_at_ms, deleted, payload FROM sync_entities WHERE type = ? AND id = ?')
    .get(entity.type, String(entity.id)) as Row | undefined;
  if (!existing) {
    db.prepare(`
      INSERT INTO sync_entities (type, id, rev, updated_at_ms, payload, deleted)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(entity.type, String(entity.id), entity.updated_at_ms, entity.payload ? JSON.stringify(entity.payload) : null, entity.deleted ? 1 : 0);
    return true;
  }
  if (entity.updated_at_ms > (existing.updated_at_ms as number)) {
    db.prepare('UPDATE sync_entities SET rev = rev + 1, updated_at_ms = ?, payload = ?, deleted = ? WHERE type = ? AND id = ?')
      .run(entity.updated_at_ms, entity.payload ? JSON.stringify(entity.payload) : null, entity.deleted ? 1 : 0, entity.type, String(entity.id));
    return true;
  }
  return false;
}

export interface SyncServerOptions {
  db?: Database.Database;
  logger?: boolean;
}

export function buildSyncApp(options: SyncServerOptions = {}): FastifyInstance {
  const db = options.db ?? initSyncDb();
  const app = Fastify({ logger: options.logger ?? false });
  const guard = requireScope('sync', db);

  app.get('/sync/health', async () => ({ ok: true, service: 'free-sync', time: new Date().toISOString() }));

  app.post('/sync/register', async (req, reply) => {
    const body = (req.body ?? {}) as { deviceId?: string; name?: string };
    const deviceId = String(body.deviceId ?? '').trim();
    if (!deviceId) return reply.code(400).send({ error: 'deviceId is required' });
    const name = String(body.name ?? deviceId).trim() || deviceId;
    db.prepare(`
      INSERT INTO devices (id, name) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen_at = datetime('now')
    `).run(deviceId, name);
    const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Row;
    const device: SyncDevice = {
      id: row.id as string,
      name: row.name as string,
      created_at: row.created_at as string,
      last_seen_at: row.last_seen_at as string,
    };
    return device;
  });

  app.post('/sync/push', { preHandler: guard }, async (req) => {
    const body = (req.body ?? {}) as { entities?: SyncEntity[] };
    const entities = Array.isArray(body.entities) ? body.entities : [];
    let accepted = 0;
    const tx = db.transaction((items: SyncEntity[]) => {
      for (const entity of items) {
        if (entity && entity.type && entity.id !== undefined && Number.isFinite(entity.updated_at_ms)) {
          if (mergeEntity(db, entity)) accepted++;
        }
      }
    });
    tx(entities);
    return { accepted, state: snapshot(db) };
  });

  app.get('/sync/state', { preHandler: guard }, async () => snapshot(db));

  app.get('/sync/devices', { preHandler: guard }, async () => {
    const rows = db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      created_at: r.created_at as string,
      last_seen_at: r.last_seen_at as string,
    }));
  });

  app.post('/sync/tokens', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; token?: string };
    const name = String(body.name ?? 'sync').trim() || 'sync';
    const provided = String(body.token ?? '').trim();
    if (provided) {
      // Register a token issued elsewhere (e.g. by the main app) so both can
      // be used against this sync server.
      const existing = getAppPasswordByHash(db, hashToken(provided));
      if (existing) return { ...existing, token: provided };
      const password = createAppPassword(db, name, 'sync', hashToken(provided));
      return reply.code(201).send({ ...password, token: provided });
    }
    const { password, token } = createToken(db, name, 'sync');
    return reply.code(201).send({ ...password, token });
  });

  app.get('/sync/tokens', async () => listAppPasswords(db));

  app.delete('/sync/tokens/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!listAppPasswords(db).some((t) => t.id === id)) return reply.code(404).send({ error: 'token not found' });
    revokeAppPassword(db, id);
    return reply.code(204).send();
  });

  return app;
}

function parseArgs(argv: string[]): { port: number; host: string; db: string } {
  const out = { port: Number(process.env.PORT || 3901), host: process.env.HOST || '127.0.0.1', db: DEFAULT_DB_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') out.port = Number(argv[++i]);
    else if (argv[i] === '--host' || argv[i] === '-H') out.host = String(argv[++i]);
    else if (argv[i] === '--db' || argv[i] === '-d') out.db = String(argv[++i]);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith(path.join('sync', 'server.ts'))) {
  const { port, host, db } = parseArgs(process.argv.slice(2));
  const app = buildSyncApp({ db: initSyncDb(db) });
  app
    .listen({ port, host })
    .then((url) => console.log(`FREE sync server listening on ${url} (db: ${db})`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
