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

/** Rejects non-integer numeric host fields before they hit the DB / shell. */
function validateNumeric(input: Partial<HostInput>): string | null {
  const integerFields: Array<[keyof HostInput, number, number]> = [
    ['port', 1, 65535],
    ['vnc_port', 1, 65535],
    ['vnc_ssh_host_id', 1, Number.MAX_SAFE_INTEGER],
    ['vnc_display', 0, 99],
  ];
  for (const [field, min, max] of integerFields) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      return `${String(field)} must be an integer between ${min} and ${max}`;
    }
  }
  return null;
}

function coerceInput(input: Partial<HostInput>): Partial<HostInput> {
  return {
    ...input,
    port: input.port === undefined ? undefined : Number(input.port),
    vnc_port: input.vnc_port === undefined ? undefined : Number(input.vnc_port),
    vnc_ssh_host_id: input.vnc_ssh_host_id === undefined ? undefined : input.vnc_ssh_host_id === null ? null : Number(input.vnc_ssh_host_id),
    vnc_display: input.vnc_display === undefined ? undefined : input.vnc_display === null ? null : Number(input.vnc_display),
  };
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
    const invalid = validateNumeric(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    return revealVncPassword(createHost(getDb(), encryptInput(coerceInput(body)) as HostInput));
  });

  app.put('/:id', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<HostInput>;
    const invalid = validateNumeric(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const updated = updateHost(getDb(), idParam(req), encryptInput(coerceInput(body)));
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
