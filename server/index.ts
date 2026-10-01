import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb } from './db';
import { installApiAuth } from './auth';
import { registerTerminalRoutes } from './terminal';
import { registerSftpRoutes } from './sftp';
import { hostRoutes } from './routes/hosts';
import { groupRoutes } from './routes/groups';
import { snippetRoutes } from './routes/snippets';
import { themeRoutes } from './routes/themes';
import { auditRoutes } from './routes/audit';
import { settingsRoutes } from './routes/settings';
import { forwardRoutes } from './routes/forwards';
import { knownHostRoutes } from './routes/known_hosts';
import { keyRoutes } from './routes/keys';
import { tokenRoutes } from './routes/tokens';
import { syncRoutes } from './routes/sync';
import { vncRoutes } from './routes/vnc';
import { registerVncWebSocket } from './vnc/websocket';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.register(hostRoutes, { prefix: '/api/hosts' });
  app.register(groupRoutes, { prefix: '/api/groups' });
  app.register(snippetRoutes, { prefix: '/api/snippets' });
  app.register(themeRoutes, { prefix: '/api/themes' });
  app.register(auditRoutes, { prefix: '/api/audit' });
  app.register(settingsRoutes, { prefix: '/api/settings' });
  app.register(forwardRoutes, { prefix: '/api/forwards' });
  app.register(knownHostRoutes, { prefix: '/api/known-hosts' });
  app.register(keyRoutes, { prefix: '/api/keys' });
  app.register(tokenRoutes, { prefix: '/api/tokens' });
  app.register(syncRoutes, { prefix: '/api/sync' });
  app.register(vncRoutes, { prefix: '/api/vnc' });

  installApiAuth(app);

  registerTerminalRoutes(app);
  registerSftpRoutes(app);
  registerVncWebSocket(app);

  if (process.env.NODE_ENV === 'production') {
    const dist = path.resolve(__dirname, '../dist');
    await app.register(fastifyStatic, { root: dist, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '';
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  getDb();
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '127.0.0.1';
  void buildApp()
    .then((app) => app.listen({ port, host }))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
