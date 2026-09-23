import type { FastifyInstance } from 'fastify';
import { addAudit, getDb, listAppPasswords, revokeAppPassword } from '../db';
import { createToken, requireScope } from '../tokens';
import type { AppPasswordInput, AppPasswordCreated } from '../../shared/types';

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppPasswordInput>;
    const name = String(body.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const scope = String(body.scope ?? 'read').trim() || 'read';
    const { password, token } = createToken(getDb(), name, scope);
    const created: AppPasswordCreated = { ...password, token };
    addAudit(getDb(), 'token.create', null, `${name} (scope: ${scope})`);
    return reply.code(201).send(created);
  });

  app.get('/', async () => listAppPasswords(getDb()));

  app.get('/verify', { preHandler: requireScope('verify') }, async (req) => {
    const record = req.appPassword!;
    return { id: record.id, name: record.name, scope: record.scope };
  });

  app.delete('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = listAppPasswords(getDb()).find((p) => p.id === id);
    if (!existing) return reply.code(404).send({ error: 'token not found' });
    revokeAppPassword(getDb(), id);
    addAudit(getDb(), 'token.revoke', null, existing.name);
    return reply.code(204).send();
  });
}
