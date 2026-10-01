import type { FastifyInstance } from 'fastify';
import { getDb, getHost } from '../db';
import type { VncStatus } from '../../shared/types';
import { resolveVncConfig } from '../vnc/config';
import { openVncStream } from '../vnc/transport';
import { probeVnc } from '../vnc/probe';
import { diagnoseVncEnvironment } from '../vnc/diagnostics';
import { getVncRequirements, resolveImplementation } from '../vnc/requirements';
import { ensureSession, getSession, stopSession } from '../vnc/sessions';

function num(value: unknown): number {
  return Number(value);
}

function idParam(req: { params: unknown }): number {
  return num((req.params as { id: string }).id);
}

async function buildStatus(hostId: number, start: boolean): Promise<VncStatus | null> {
  const database = getDb();
  const host = getHost(database, hostId);
  if (!host || host.connection_type !== 'vnc') return null;
  const cfg = resolveVncConfig(database, host);
  const session = getSession(hostId);
  if (session) {
    return {
      host_id: hostId,
      transport: cfg.transport,
      port: session.port,
      running: true,
      started: session.managed,
      implementation: host.vnc_implementation,
      display: session.display,
      managed: session.managed,
      requirements: [],
    };
  }
  const probe = await probeVnc(() => openVncStream(database, host), 4000);
  if (probe.running) {
    return {
      host_id: hostId,
      transport: cfg.transport,
      port: cfg.vncPort,
      running: true,
      started: false,
      implementation: host.vnc_implementation,
      display: null,
      managed: false,
      requirements: [],
    };
  }
  const diagnostics = cfg.ssh ? await diagnoseVncEnvironment(database, host).catch(() => null) : null;
  return {
    host_id: hostId,
    transport: cfg.transport,
    port: cfg.vncPort,
    running: false,
    started: false,
    implementation: host.vnc_implementation,
    display: host.vnc_display,
    managed: false,
    requirements: getVncRequirements(diagnostics, resolveImplementation(diagnostics, host)),
  };
}

export async function vncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/status', async (req, reply) => {
    const status = await buildStatus(idParam(req), false);
    if (!status) return reply.code(404).send({ error: 'vnc host not found' });
    return status;
  });

  app.post('/:id/diagnose', async (req, reply) => {
    const database = getDb();
    const host = getHost(database, idParam(req));
    if (!host || host.connection_type !== 'vnc') return reply.code(404).send({ error: 'vnc host not found' });
    const cfg = resolveVncConfig(database, host);
    if (!cfg.ssh) {
      return reply.code(400).send({ error: 'diagnostics require an SSH transport' });
    }
    const diagnostics = await diagnoseVncEnvironment(database, host).catch((err: Error) => {
      return reply.code(502).send({ error: `diagnostics failed: ${err.message}` });
    });
    if (!diagnostics) return reply.code(502).send({ error: 'diagnostics unavailable' });
    diagnostics.requirements = getVncRequirements(diagnostics, resolveImplementation(diagnostics, host));
    return diagnostics;
  });

  app.post('/:id/ensure', async (req, reply) => {
    const database = getDb();
    const host = getHost(database, idParam(req));
    if (!host || host.connection_type !== 'vnc') return reply.code(404).send({ error: 'vnc host not found' });
    const body = (req.body ?? {}) as { start?: boolean };
    await ensureSession(host.id, { start: body.start === true }).catch((err: Error) => {
      return reply.code(502).send({ error: err.message });
    });
    const status = await buildStatus(host.id, body.start === true);
    if (!status) return reply.code(404).send({ error: 'vnc host not found' });
    return status;
  });

  app.post('/:id/stop', async (req, reply) => {
    const hostId = idParam(req);
    const host = getHost(getDb(), hostId);
    if (!host || host.connection_type !== 'vnc') return reply.code(404).send({ error: 'vnc host not found' });
    await stopSession(hostId).catch((err: Error) => reply.code(502).send({ error: err.message }));
    const status = await buildStatus(hostId, false);
    if (!status) return reply.code(404).send({ error: 'vnc host not found' });
    return status;
  });
}
