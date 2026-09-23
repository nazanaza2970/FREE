import type { FastifyInstance } from 'fastify';
import {
  createHost,
  deleteHost,
  getDb,
  getHost,
  listHosts,
  updateHost,
} from '../db';
import type { Host, HostInput } from '../../shared/types';
import { decryptContent, encryptContent } from '../crypto';

function num(value: unknown): number {
  return Number(value);
}

function revealVncPassword(host: Host): Host {
  if (!host.vnc_password) return host;
  try {
    return { ...host, vnc_password: decryptContent(host.vnc_password) };
  } catch {
    return { ...host, vnc_password: '' };
  }
}

function encryptInput(input: Partial<HostInput>): Partial<HostInput> {
  if (input.vnc_password === undefined) return input;
  if (input.vnc_password === null || input.vnc_password === '') {
    return { ...input, vnc_password: null };
  }
  return { ...input, vnc_password: encryptContent(input.vnc_password) };
}

function idParam(req: { params: unknown }): number {
  return num((req.params as { id: string }).id);
}

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => listHosts(getDb()).map(revealVncPassword));

  app.get('/:id', async (req, reply) => {
    const host = getHost(getDb(), idParam(req));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    return revealVncPassword(host);
  });

  app.post('/', async (req, reply) => {
    const body = req.body as Partial<HostInput>;
    if (!body?.name || !body?.host) {
      return reply.code(400).send({ error: 'name and host are required' });
    }
    return revealVncPassword(createHost(getDb(), encryptInput(body) as HostInput));
  });

  app.put('/:id', async (req, reply) => {
    const updated = updateHost(getDb(), idParam(req), encryptInput((req.body ?? {}) as Partial<HostInput>));
    if (!updated) return reply.code(404).send({ error: 'host not found' });
    return revealVncPassword(updated);
  });

  app.delete('/:id', async (req, reply) => {
    const host = getHost(getDb(), idParam(req));
    if (!host) return reply.code(404).send({ error: 'host not found' });
    deleteHost(getDb(), host.id);
    return reply.code(204).send();
  });
}
