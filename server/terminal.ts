import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { Client, type ConnectConfig, type ShellOptions } from 'ssh2';
import { addAudit, getDb, getHost, getKnownHost, upsertKnownHost } from './db';
import { buildAuthConfig } from './ssh/auth';
import { InAppAgent } from './ssh/agent';
import { hostKeyAlg, hostKeyFingerprint } from './ssh/known_hosts';
import { startAutoForwards } from './forwards';
import { connectTelnet } from './telnet';
import { hasMosh, startMosh } from './mosh';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { encodeBase64 } from '../shared/protocol';

interface TerminalLink {
  write(data: string): void;
  resize(rows: number, cols: number): void;
  close(): void;
}

interface Session {
  id: string;
  hostId: number;
  ws: WebSocket;
  link: TerminalLink;
  closed: boolean;
}

const sessions = new Map<string, Session>();
const recentCloses = new Map<number, number>();

/** Hard cap on concurrent terminal sessions (env MAX_SESSIONS, default 32). */
function maxSessions(): number {
  const n = Number(process.env.MAX_SESSIONS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32;
}

/** Per-host delay before a new connection is allowed after a close (env RECONNECT_COOLDOWN_MS, default 2000). */
function reconnectCooldownMs(): number {
  const n = Number(process.env.RECONNECT_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function closeSession(s: Session): void {
  if (s.closed) return;
  s.closed = true;
  sessions.delete(s.id);
  recentCloses.set(s.hostId, Date.now());
  if (recentCloses.size > 128) {
    for (const [hostId, at] of recentCloses) {
      if (Date.now() - at > 60_000) recentCloses.delete(hostId);
    }
  }
  try {
    s.link.close();
  } catch {
    /* already closed */
  }
}

function openSession(ws: WebSocket, sessionId: string, hostId: number, trust = false, onDead: () => void = () => {}): void {
  const database = getDb();
  const host = getHost(database, hostId);
  if (!host) {
    send(ws, { type: 'error', sessionId, message: 'host not found' });
    onDead();
    return;
  }

  const cooldown = reconnectCooldownMs();
  if (cooldown > 0) {
    const lastClose = recentCloses.get(hostId);
    const activeOnHost = [...sessions.values()].some((s) => s.hostId === hostId && !s.closed);
    if (lastClose && !activeOnHost && Date.now() - lastClose < cooldown) {
      const wait = Math.ceil((cooldown - (Date.now() - lastClose)) / 1000);
      send(ws, { type: 'status', sessionId, state: 'error', detail: `reconnect cooldown: retry in ${wait}s` });
      onDead();
      return;
    }
  }

  switch (host.connection_type) {
    case 'telnet':
      openTelnet(ws, sessionId, hostId, host.host, host.port, onDead);
      return;
    case 'mosh':
      openMosh(ws, sessionId, hostId, host.host, host.port, onDead);
      return;
    case 'ssh':
    default:
      openSsh(ws, sessionId, hostId, trust, onDead);
  }
}

function openSsh(ws: WebSocket, sessionId: string, hostId: number, trust: boolean, onDead: () => void): void {
  const database = getDb();
  const host = getHost(database, hostId);
  if (!host) {
    send(ws, { type: 'error', sessionId, message: 'host not found' });
    onDead();
    return;
  }

  const auth = buildAuthConfig(host);
  if (!auth.ok) {
    send(ws, { type: 'error', sessionId, message: auth.error });
    addAudit(database, 'session.error', host.id, auth.error);
    onDead();
    return;
  }

  let rawKey: Buffer | null = null;
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 15000,
    keepaliveInterval: Math.max(5, host.keepalive || 30) * 1000,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      rawKey = key;
      verify(true);
    },
  };
  Object.assign(config, auth.config);
  if (host.agent_forward) {
    config.agent = new InAppAgent(database);
  }

  const conn = new Client();
  send(ws, { type: 'status', sessionId, state: 'connecting' });

  conn.on('ready', () => {
    const fingerprint = hostKeyFingerprint(rawKey);
    if (fingerprint) {
      const known = getKnownHost(database, host.host, host.port);
      if (trust) {
        upsertKnownHost(database, host.host, host.port, hostKeyAlg(rawKey ?? null), fingerprint);
        addAudit(database, 'hostkey.trusted', host.id, `${host.host}:${host.port} ${fingerprint}`);
        send(ws, { type: 'hostkey', sessionId, state: 'new', fingerprint });
      } else if (known && known.fingerprint !== fingerprint) {
        send(ws, { type: 'hostkey', sessionId, state: 'mismatch', fingerprint, expected: known.fingerprint });
        send(ws, { type: 'status', sessionId, state: 'error', detail: 'host key mismatch' });
        addAudit(
          database,
          'hostkey.mismatch',
          host.id,
          `${host.host}:${host.port} expected ${known.fingerprint} got ${fingerprint}`,
        );
        conn.end();
        onDead();
        return;
      } else if (!known) {
        upsertKnownHost(database, host.host, host.port, hostKeyAlg(rawKey ?? null), fingerprint);
        addAudit(database, 'hostkey.trusted', host.id, `${host.host}:${host.port} ${fingerprint}`);
        send(ws, { type: 'hostkey', sessionId, state: 'new', fingerprint });
      } else {
        send(ws, { type: 'hostkey', sessionId, state: 'verified', fingerprint });
      }
    }
    conn.shell(
      { term: 'xterm-256color', cols: 80, rows: 24 },
      host.agent_forward ? ({ agentForward: true } as ShellOptions) : {},
      (err, shell) => {
        if (err) {
          send(ws, { type: 'error', sessionId, message: `shell: ${String(err.message || err)}` });
          conn.end();
          onDead();
          return;
        }
        const session: Session = {
          id: sessionId,
          hostId: host.id,
          ws,
          closed: false,
          link: {
            write: (data) => shell.write(data),
            resize: (rows, cols) => {
              try {
                shell.setWindow(rows, cols, 0, 0);
              } catch {
                /* ignore */
              }
            },
            close: () => {
              try {
                shell.end();
              } catch {
                /* ignore */
              }
              conn.end();
            },
          },
        };
        sessions.set(session.id, session);
        addAudit(database, 'session.start', host.id, `${host.name} (${host.host}:${host.port})${host.agent_forward ? ' agent-fwd' : ''}`);
        send(ws, { type: 'status', sessionId, state: 'connected' });
        void startAutoForwards(host.id);

        shell.on('data', (data: Buffer) => {
          send(ws, { type: 'output', sessionId, data: encodeBase64(data) });
        });
        shell.on('exit', (code: number) => {
          send(ws, { type: 'exit', sessionId, code: code ?? null });
          addAudit(database, 'session.end', host.id, `${host.name} exit=${code ?? 'null'}`);
          closeSession(session);
        });
        shell.on('close', () => closeSession(session));
      },
    );
  });

  conn.on('error', (err: Error) => {
    const message = String(err.message || err);
    send(ws, { type: 'status', sessionId, state: 'error', detail: message });
    addAudit(database, 'session.error', host.id, message);
    const session = sessions.get(sessionId);
    if (session) closeSession(session);
    onDead();
  });

  conn.on('close', () => {
    const session = sessions.get(sessionId);
    if (session) closeSession(session);
    onDead();
  });

  conn.connect(config);
}

function openTelnet(
  ws: WebSocket,
  sessionId: string,
  hostId: number,
  host: string,
  port: number,
  onDead: () => void,
): void {
  const database = getDb();
  send(ws, { type: 'status', sessionId, state: 'connecting' });
  connectTelnet(host, port)
    .then((link) => {
      const session: Session = {
        id: sessionId,
        hostId,
        ws,
        closed: false,
        link: {
          write: (data) => link.write(data),
          resize: () => {
            /* no resize over telnet */
          },
          close: () => link.close(),
        },
      };
      sessions.set(session.id, session);
      link.onData((data: Buffer) => {
        if (!session.closed) send(ws, { type: 'output', sessionId, data: encodeBase64(data) });
      });
      link.onClose(() => {
        send(ws, { type: 'exit', sessionId, code: null });
        closeSession(session);
        onDead();
      });
      addAudit(database, 'session.start', hostId, `telnet ${host}:${port}`);
      send(ws, { type: 'status', sessionId, state: 'connected' });
    })
    .catch((err: Error) => {
      const message = String(err.message || err);
      send(ws, { type: 'status', sessionId, state: 'error', detail: message });
      addAudit(database, 'session.error', hostId, `telnet ${host}:${port}: ${message}`);
      onDead();
    });
}

function openMosh(
  ws: WebSocket,
  sessionId: string,
  hostId: number,
  host: string,
  port: number,
  onDead: () => void,
): void {
  const database = getDb();
  send(ws, { type: 'status', sessionId, state: 'connecting' });
  if (!hasMosh()) {
    const detail = 'mosh-client/mosh-server binaries not found on the server host';
    send(ws, { type: 'status', sessionId, state: 'error', detail });
    addAudit(database, 'session.error', hostId, `mosh ${host}:${port}: ${detail}`);
    onDead();
    return;
  }
  startMosh(host, port)
    .then((link) => {
      const session: Session = {
        id: sessionId,
        hostId,
        ws,
        closed: false,
        link: {
          write: (data) => link.write(data),
          resize: () => {
            /* mosh handles resize internally */
          },
          close: () => link.close(),
        },
      };
      sessions.set(session.id, session);
      link.onData((data: Buffer) => {
        if (!session.closed) send(ws, { type: 'output', sessionId, data: encodeBase64(data) });
      });
      link.onClose((code: number | null) => {
        send(ws, { type: 'exit', sessionId, code });
        closeSession(session);
        onDead();
      });
      addAudit(database, 'session.start', hostId, `mosh ${host}:${port}`);
      send(ws, { type: 'status', sessionId, state: 'connected' });
    })
    .catch((err: Error) => {
      const message = String(err.message || err);
      send(ws, { type: 'status', sessionId, state: 'error', detail: message });
      addAudit(database, 'session.error', hostId, `mosh ${host}:${port}: ${message}`);
      onDead();
    });
}

export function registerTerminalRoutes(app: FastifyInstance): void {
  app.get('/ws/terminal', { websocket: true }, (connection, _req: FastifyRequest) => {
    const socket: WebSocket = connection.socket;
    let activeSessionId: string | null = null;

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'connect': {
          if (activeSessionId) {
            send(socket, { type: 'error', sessionId: msg.sessionId, message: 'session already active on this socket' });
            return;
          }
          const limit = maxSessions();
          if (sessions.size >= limit) {
            send(socket, { type: 'error', sessionId: msg.sessionId, message: `too many concurrent sessions (max ${limit})` });
            return;
          }
          activeSessionId = msg.sessionId;
          openSession(socket, msg.sessionId, msg.hostId, msg.trust === true, () => {
            if (activeSessionId === msg.sessionId) activeSessionId = null;
          });
          break;
        }
        case 'input': {
          const session = sessions.get(msg.sessionId);
          if (session && !session.closed) session.link.write(msg.data);
          break;
        }
        case 'resize': {
          const session = sessions.get(msg.sessionId);
          if (session && !session.closed) session.link.resize(msg.rows, msg.cols);
          break;
        }
        case 'disconnect': {
          const session = sessions.get(msg.sessionId);
          if (session) closeSession(session);
          activeSessionId = null;
          break;
        }
      }
    });

    socket.on('close', () => {
      if (activeSessionId) {
        const session = sessions.get(activeSessionId);
        if (session) {
          addAudit(getDb(), 'session.closed', session.hostId, 'socket closed');
          closeSession(session);
        }
        activeSessionId = null;
      }
    });

    socket.on('error', () => {
      if (activeSessionId) {
        const session = sessions.get(activeSessionId);
        if (session) closeSession(session);
        activeSessionId = null;
      }
    });
  });
}
