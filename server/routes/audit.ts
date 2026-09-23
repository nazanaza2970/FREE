import type { FastifyInstance } from 'fastify';
import { getDb, listAudit } from '../db';
import { onAudit } from '../audit-bus';
import type { AuditLog } from '../../shared/types';

function parseLimit(req: { query: unknown }, fallback: number, max: number): number {
  const raw = (req.query as { limit?: string })?.limit;
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req) => {
    return listAudit(getDb(), parseLimit(req, 200, 1000));
  });

  // Server-Sent Events: replay the recent tail, then stream live events.
  app.get('/stream', (req, reply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 2000\n\n');

    const write = (record: AuditLog) => {
      if (raw.writableEnded) return;
      raw.write(`data: ${JSON.stringify(record)}\n\n`);
    };

    // Initial backlog, oldest -> newest.
    for (const record of listAudit(getDb(), 100).reverse()) write(record);

    const off = onAudit(write);
    const keepAlive = setInterval(() => {
      if (raw.writableEnded) return;
      raw.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      off();
      if (!raw.writableEnded) raw.end();
    };
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
  });

  // JSONL export (newline-delimited JSON), newest first.
  app.get('/export', (req, reply) => {
    const rows = listAudit(getDb(), parseLimit(req, 1000, 5000));
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="free-audit.log"');
    return reply.send(body);
  });
}
