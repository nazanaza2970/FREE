import type { FastifyInstance } from 'fastify';
import { createForward, deleteForward, getDb, listForwards } from '../db';
import { forwardStates, startForward, stopForward } from '../forwards';
import type { PortForwardInput } from '../../shared/types';

function num(value: unknown): number {
  return Number(value);
}

export async function forwardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    const hostId = (req.query as { hostId?: string })?.hostId;
    return listForwards(getDb(), hostId ? num(hostId) : undefined);
  });

  app.post('/', async (req, reply) => {
    const body = req.body as Partial<PortForwardInput>;
    if (!body?.host_id || !body?.local_port || !body?.remote_port) {
      return reply.code(400).send({ error: 'host_id, local_port and remote_port are required' });
    }
    return createForward(getDb(), body as PortForwardInput);
  });

  app.get('/status', async () => forwardStates());

  app.post('/:id/start', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    try {
      await startForward(id);
      return { id, active: true };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  app.post('/:id/stop', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    try {
      await stopForward(id);
      return { id, active: false };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });

  app.delete('/:id', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    try {
      await stopForward(id);
    } catch {
      /* not running */
    }
    deleteForward(getDb(), id);
    return reply.code(204).send();
  });
}
