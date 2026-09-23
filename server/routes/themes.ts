import type { FastifyInstance } from 'fastify';
import {
  createTheme,
  deleteTheme,
  getDb,
  listThemes,
  updateTheme,
} from '../db';
import type { ThemeInput } from '../../shared/types';

function num(value: unknown): number {
  return Number(value);
}

export async function themeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listThemes(getDb()));

  app.post('/', async (req, reply) => {
    const body = req.body as Partial<ThemeInput>;
    if (!body?.name) return reply.code(400).send({ error: 'name is required' });
    return createTheme(getDb(), body as ThemeInput);
  });

  app.put('/:id', async (req, reply) => {
    const updated = updateTheme(getDb(), num((req.params as { id: string }).id), (req.body ?? {}) as Partial<ThemeInput>);
    if (!updated) return reply.code(404).send({ error: 'theme not found' });
    return updated;
  });

  app.delete('/:id', async (req, reply) => {
    deleteTheme(getDb(), num((req.params as { id: string }).id));
    return reply.code(204).send();
  });
}
