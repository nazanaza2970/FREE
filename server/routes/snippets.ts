import type { FastifyInstance } from 'fastify';
import {
  createSnippet,
  deleteSnippet,
  getDb,
  getSnippet,
  listSnippets,
  updateSnippet,
  addAudit,
} from '../db';
import { decryptContent, encryptContent } from '../crypto';
import type { Snippet, SnippetInput } from '../../shared/types';

function num(value: unknown): number {
  return Number(value);
}

/** Protected snippets never expose plaintext in list/detail views. */
function mask(s: Snippet): Snippet {
  return s.protected ? { ...s, content: '' } : s;
}

export async function snippetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    const q = (req.query ?? {}) as { group_id?: string };
    const raw = q.group_id;
    const groupId = raw === undefined ? null : raw === 'global' ? ('global' as const) : Number(raw);
    return listSnippets(getDb(), groupId).map(mask);
  });

  app.post('/', async (req, reply) => {
    const body = req.body as Partial<SnippetInput>;
    if (!body?.name || !body?.content) {
      return reply.code(400).send({ error: 'name and content are required' });
    }
    const protectedFlag = body.protected === true;
    const record = {
      ...body,
      content: protectedFlag ? encryptContent(body.content) : body.content,
      protected: protectedFlag,
    } as SnippetInput;
    const created = createSnippet(getDb(), record);
    addAudit(getDb(), 'snippet.create', null, `${created.name}${protectedFlag ? ' (protected)' : ''}`);
    return mask(created);
  });

  app.get('/:id', async (req, reply) => {
    const s = getSnippet(getDb(), num((req.params as { id: string }).id));
    if (!s) return reply.code(404).send({ error: 'snippet not found' });
    return mask(s);
  });

  app.get('/:id/reveal', async (req, reply) => {
    const s = getSnippet(getDb(), num((req.params as { id: string }).id));
    if (!s) return reply.code(404).send({ error: 'snippet not found' });
    if (!s.protected) {
      addAudit(getDb(), 'snippet.reveal', null, s.name);
      return { id: s.id, name: s.name, content: s.content };
    }
    try {
      const content = decryptContent(s.content);
      addAudit(getDb(), 'snippet.reveal', null, s.name);
      return { id: s.id, name: s.name, content };
    } catch (e) {
      return reply.code(500).send({ error: `decrypt failed: ${String(e instanceof Error ? e.message : e)}` });
    }
  });

  app.put('/:id', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Partial<SnippetInput>;
    const existing = getSnippet(getDb(), id);
    if (!existing) return reply.code(404).send({ error: 'snippet not found' });
    const willProtect = body.protected ?? existing.protected;
    const content =
      body.content !== undefined && willProtect ? encryptContent(body.content) : body.content;
    const updated = updateSnippet(getDb(), id, { ...body, content, protected: willProtect });
    if (!updated) return reply.code(404).send({ error: 'snippet not found' });
    addAudit(getDb(), 'snippet.update', null, updated.name);
    return mask(updated);
  });

  app.delete('/:id', async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const existing = getSnippet(getDb(), id);
    deleteSnippet(getDb(), id);
    if (existing) addAudit(getDb(), 'snippet.delete', null, existing.name);
    return reply.code(204).send();
  });
}
