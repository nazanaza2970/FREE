import type { FastifyInstance } from 'fastify';
import { deleteKnownHost, getDb, listKnownHosts } from '../db';

function idParam(req: { params: unknown }): number {
  return Number((req.params as { id: string }).id);
}

export async function knownHostRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listKnownHosts());

  app.delete('/:id', async (req, reply) => {
    deleteKnownHost(getDb(), idParam(req));
    return reply.code(204).send();
  });
}
