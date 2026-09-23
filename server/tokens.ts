import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createAppPassword, getAppPasswordByHash, getDb, touchAppPassword } from './db';
import type { AppPassword } from '../shared/types';

export const TOKEN_PREFIX = 'tfp_';

/** SHA-256 (hex) of a plaintext token. Only the hash is persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generates a fresh opaque token and its storage hash. */
export function generateToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Creates a scoped app password. Returns the plaintext token exactly once. */
export function createToken(
  database: Database.Database = getDb(),
  name: string,
  scope: string = 'read',
): { password: AppPassword; token: string } {
  const { token, hash } = generateToken();
  const password = createAppPassword(database, name, scope, hash);
  return { password, token };
}

/**
 * Verifies a plaintext token, refreshing its last-used stamp. Returns the
 * record (hash excluded) or null when unknown/revoked. Intended to be reused
 * by the standalone M9 sync server, which can share this module + DB.
 */
export function verifyToken(database: Database.Database = getDb(), token: string): AppPassword | null {
  const record = getAppPasswordByHash(database, hashToken(token));
  if (!record || record.revoked) return null;
  touchAppPassword(database, record.id);
  return record;
}

/** A token satisfies a required scope when it matches, or is the wildcard `*`. */
export function scopeSatisfied(tokenScope: string, required: string): boolean {
  return tokenScope === '*' || tokenScope === required;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

declare module 'fastify' {
  interface FastifyRequest {
    appPassword?: AppPassword;
  }
}

/** Fastify preHandler that enforces a Bearer token carrying the given scope. */
export function requireScope(required: string, database?: Database.Database) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(req);
    if (!token) {
      await reply.code(401).send({ error: 'unauthorized: missing bearer token' });
      return;
    }
    const record = verifyToken(database ?? getDb(), token);
    if (!record) {
      await reply.code(401).send({ error: 'unauthorized: unknown or revoked token' });
      return;
    }
    if (!scopeSatisfied(record.scope, required)) {
      await reply.code(403).send({ error: `forbidden: requires scope '${required}'` });
      return;
    }
    req.appPassword = record;
  };
}
