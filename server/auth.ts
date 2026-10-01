import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb, listAppPasswords } from './db';
import { verifyToken } from './tokens';

/** Token from the Authorization header (REST) or ?token= query (WebSockets). */
function presentToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value.trim();
  }
  const query = req.query as { token?: string } | undefined;
  if (query?.token) return String(query.token);
  return null;
}

function hasActiveToken(): boolean {
  return listAppPasswords(getDb()).some((p) => !p.revoked);
}

/**
 * Global gate for /api/* and /ws/*:
 * - Armed only once at least one token exists, so a fresh install stays open
 *   until the first token is created (browser bootstrap or curl).
 * - Once armed, every request needs a valid Bearer token.
 * - WebSockets must be same-origin (Origin header check).
 */
export function installApiAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    const path = url.split('?')[0];
    const isWs = path.startsWith('/ws/');
    if (!path.startsWith('/api/') && !isWs) return;

    if (!hasActiveToken()) return;

    if (isWs) {
      const origin = req.headers.origin;
      if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
        await reply.code(403).send({ error: 'forbidden: cross-origin websocket' });
        return;
      }
    }

    const token = presentToken(req);
    if (!token) {
      await reply.code(401).send({ error: 'unauthorized: missing bearer token' });
      return;
    }
    if (!verifyToken(getDb(), token)) {
      await reply.code(401).send({ error: 'unauthorized: unknown or revoked token' });
    }
  });
}
