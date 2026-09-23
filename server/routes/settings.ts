import type { FastifyInstance } from 'fastify';
import { getDb, listSettings, setSetting } from '../db';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listSettings(getDb()));

  app.put('/:key', async (req, reply) => {
    const key = String((req.params as { key: string }).key);
    const body = req.body as { value?: string } | null;
    if (body?.value === undefined) {
      return reply.code(400).send({ error: 'value is required' });
    }
    setSetting(getDb(), key, String(body.value));
    return { key, value: String(body.value) };
  });

  app.delete('/:key', async (req, reply) => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(String((req.params as { key: string }).key));
    return reply.code(204).send();
  });
}
