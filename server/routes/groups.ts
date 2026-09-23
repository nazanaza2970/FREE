import type { FastifyInstance } from 'fastify';
import {
  createGroup,
  deleteGroup,
  getDb,
  listGroups,
  updateGroup,
} from '../db';
import type { GroupInput } from '../../shared/types';

function num(value: unknown): number {
  return Number(value);
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listGroups(getDb()));

  app.post('/', async (req, reply) => {
    const body = req.body as Partial<GroupInput>;
    if (!body?.name) return reply.code(400).send({ error: 'name is required' });
    const created = createGroup(getDb(), body as GroupInput);
    if (!created) return reply.code(400).send({ error: 'parent group not found' });
    return created;
  });

  app.put('/:id', async (req, reply) => {
    const db = getDb();
    const id = num((req.params as { id: string }).id);
    if (!listGroups(db).some((g) => g.id === id)) return reply.code(404).send({ error: 'group not found' });
    const updated = updateGroup(db, id, (req.body ?? {}) as Partial<GroupInput>);
    if (!updated) return reply.code(400).send({ error: 'invalid parent (not found or would create a cycle)' });
    return updated;
  });

  app.delete('/:id', async (req, reply) => {
    deleteGroup(getDb(), num((req.params as { id: string }).id));
    return reply.code(204).send();
  });
}
