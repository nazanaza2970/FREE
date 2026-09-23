import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { addAudit, getDb, getHost } from '../db';
import { enterSession, ensureSession, leaveSession, stopSession } from './sessions';
import { openVncStream, type VncStream } from './transport';

export function registerVncWebSocket(app: FastifyInstance): void {
  app.get('/ws/vnc', { websocket: true }, (connection, req: FastifyRequest) => {
    const socket: WebSocket = connection.socket;
    const query = req.query as Record<string, string | undefined>;
    const hostId = Number(query.host_id);

    let stream: VncStream | null = null;
    let finished = false;
    let entered = false;

    const finish = (code?: number, reason?: string) => {
      if (finished) return;
      finished = true;
      if (stream) {
        try {
          stream.close();
        } catch {
          /* already closed */
        }
      }
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        try {
          socket.close(code ?? 1000, reason);
        } catch {
          /* already closing */
        }
      }
      if (entered && leaveSession(hostId)) {
        const host = getHost(getDb(), hostId);
        if (host?.vnc_auto_stop) {
          void stopSession(hostId).catch(() => undefined);
        }
      }
    };

    void (async () => {
      const database = getDb();
      const host = getHost(database, hostId);
      if (!host || host.connection_type !== 'vnc') {
        finish(1008, 'not a VNC host');
        return;
      }
      const result = await ensureSession(hostId);
      if (!result.session) {
        finish(1013, 'VNC server is not running');
        return;
      }
      enterSession(hostId);
      entered = true;
      const opened = await openVncStream(database, host, result.session.port);
      if (finished) {
        opened.close();
        return;
      }
      stream = opened;
      socket.binaryType = 'nodebuffer';
      socket.on('message', (data: Buffer) => {
        try {
          opened.socket.write(data);
        } catch {
          finish(1011, 'VNC stream write failed');
        }
      });
      opened.socket.on('data', (data: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      });
      opened.socket.on('error', () => finish(1011, 'VNC stream error'));
      opened.socket.on('close', () => finish(1006, 'VNC stream closed'));
      addAudit(database, 'vnc.connect', host.id, `port ${result.session.port}`);
    })().catch((err: Error) => {
      finish(1011, String(err.message || err));
    });

    socket.on('close', () => finish());
    socket.on('error', () => finish());
  });
}
