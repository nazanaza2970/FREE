import net from 'node:net';
import ssh2 from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { addAudit, getDb, getHost, listForwards } from './db';
import { buildAuthConfig } from './ssh/auth';
import type { PortForward } from '../shared/types';

const { Client } = ssh2;

type SshClient = InstanceType<typeof Client>;

interface LocalActive {
  id: number;
  kind: 'local' | 'socks';
  server: net.Server;
}

interface RemoteActive {
  id: number;
  kind: 'remote';
  bindAddr: string;
  bindPort: number;
  realPort: number;
}

type Active = LocalActive | RemoteActive;

interface HostTunnel {
  conn: SshClient;
  connecting: Promise<void>;
  active: Map<number, Active>;
}

const tunnels = new Map<number, HostTunnel>();

function connectHost(hostId: number): Promise<HostTunnel> {
  const existing = tunnels.get(hostId);
  if (existing) return Promise.resolve(existing);

  const host = getHost(getDb(), hostId);
  if (!host) throw new Error(`host ${hostId} not found`);
  const auth = buildAuthConfig(host);
  if (!auth.ok) throw new Error(auth.error);

  const conn = new Client();
  const tunnel: HostTunnel = {
    conn,
    connecting: new Promise<void>((resolve, reject) => {
      conn.once('ready', () => resolve());
      conn.once('error', (err) => reject(err));
    }),
    active: new Map(),
  };

  conn.on('tcp connection', (info, accept, reject) => {
    const match = [...tunnel.active.values()].find(
      (a) => a.kind === 'remote' && a.bindAddr === info.destIP && a.bindPort === (info.destPort || a.bindPort),
    ) as RemoteActive | undefined;
    if (!match) {
      reject();
      return;
    }
    const fwd = listForwards(getDb(), hostId).find((f) => f.id === match.id);
    if (!fwd) {
      reject();
      return;
    }
    const upstream = accept();
    const dest = net.connect({ host: fwd.remote_host, port: fwd.remote_port });
    dest.on('error', () => upstream.end());
    upstream.on('error', () => dest.end());
    upstream.pipe(dest).pipe(upstream);
  });
  conn.on('error', (err) => {
    addAudit(getDb(), 'forward.error', hostId, `connection: ${err.message}`);
  });
  conn.on('close', () => {
    for (const a of tunnel.active.values()) {
      if (a.kind !== 'remote') a.server.close();
    }
    tunnel.active.clear();
    tunnels.delete(hostId);
  });

  conn.connect({
    host: host.host,
    port: host.port,
    username: host.username,
    keepaliveInterval: host.keepalive > 0 ? host.keepalive * 1000 : undefined,
    ...auth.config,
  });

  tunnels.set(hostId, tunnel);
  tunnel.connecting.catch(() => {
    tunnels.delete(hostId);
    try {
      conn.end();
    } catch {
      /* already closed */
    }
  });
  return Promise.resolve(tunnel);
}

function pipeBoth(a: net.Socket | ClientChannel, b: net.Socket | ClientChannel): void {
  (a as net.Socket).pipe(b as net.Socket);
  (b as net.Socket).pipe(a as net.Socket);
  a.on('error', () => (b as net.Socket).end());
  b.on('error', () => (a as net.Socket).end());
}

async function startLocal(fwd: PortForward, tunnel: HostTunnel, kind: 'local' | 'socks'): Promise<void> {
  const server = net.createServer((socket) => {
    if (kind === 'local') {
      tunnel.conn.forwardOut(
        '127.0.0.1',
        fwd.local_port,
        fwd.remote_host,
        fwd.remote_port,
        (err, stream) => {
          if (err) {
            socket.end();
            return;
          }
          pipeBoth(socket, stream);
        },
      );
    } else {
      handleSocks5(socket, tunnel, fwd);
    }
  });
  server.on('error', (err) => {
    addAudit(getDb(), 'forward.error', fwd.host_id, `listen ${fwd.local_port}: ${err.message}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(fwd.local_port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  tunnel.active.set(fwd.id, { id: fwd.id, kind, server });
  addAudit(getDb(), 'forward.start', fwd.host_id, `${kind} :${fwd.local_port} → ${fwd.remote_host}:${fwd.remote_port}`);
}

function handleSocks5(socket: net.Socket, tunnel: HostTunnel, fwd: PortForward): void {
  let state: 'greeting' | 'request' | 'done' = 'greeting';
  let buf = Buffer.alloc(0);

  socket.on('data', (data) => {
    if (state === 'done') return; // payload now flows through the pipe
    buf = Buffer.concat([buf, data]);
    while (true) {
      if (state === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) {
          socket.destroy();
          return;
        }
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        socket.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(2 + nmethods);
        state = 'request';
      }
      if (state === 'request') {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05) {
          socket.destroy();
          return;
        }
        const cmd = buf[1];
        const atyp = buf[3];
        let addrLen: number;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x03) addrLen = 1 + buf[4];
        else if (atyp === 0x04) addrLen = 16;
        else {
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }
        if (buf.length < 4 + addrLen + 2) return;
        const port = buf.readUInt16BE(4 + addrLen);
        let host: string;
        if (atyp === 0x01) host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        else if (atyp === 0x03) host = buf.subarray(5, 5 + buf[4]).toString('utf8');
        else host = buf.subarray(4, 20).toString('hex');
        buf = buf.subarray(6 + addrLen);

        if (cmd !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }
        tunnel.conn.forwardOut('127.0.0.1', fwd.local_port, host, port, (err, stream) => {
          if (err) {
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          state = 'done';
          pipeBoth(socket, stream);
        });
        return;
      }
      return;
    }
  });
  socket.on('error', () => undefined);
}

async function startRemote(fwd: PortForward, tunnel: HostTunnel): Promise<void> {
  const bindAddr = '127.0.0.1';
  const realPort = await new Promise<number>((resolve, reject) => {
    tunnel.conn.forwardIn(bindAddr, fwd.local_port, (err, rp) => (err ? reject(err) : resolve(rp ?? fwd.local_port)));
  });
  tunnel.active.set(fwd.id, { id: fwd.id, kind: 'remote', bindAddr, bindPort: realPort, realPort });
  addAudit(getDb(), 'forward.start', fwd.host_id, `remote :${realPort} → ${fwd.remote_host}:${fwd.remote_port}`);
}

export async function startForward(id: number): Promise<void> {
  const fwd = listForwards(getDb()).find((f) => f.id === id);
  if (!fwd) throw new Error(`forward ${id} not found`);
  const tunnel = await connectHost(fwd.host_id);
  await tunnel.connecting;
  if (tunnel.active.has(id)) return;
  if (fwd.protocol === 'remote') await startRemote(fwd, tunnel);
  else if (fwd.protocol === 'socks') await startLocal(fwd, tunnel, 'socks');
  else await startLocal(fwd, tunnel, 'local');
}

export async function stopForward(id: number): Promise<void> {
  const fwd = listForwards(getDb()).find((f) => f.id === id);
  const tunnel = fwd ? tunnels.get(fwd.host_id) : undefined;
  const active = tunnel?.active.get(id);
  if (active) {
    if (active.kind === 'remote') {
      await new Promise<void>((resolve) => {
        tunnel!.conn.unforwardIn(active.bindAddr, active.bindPort, () => resolve());
      });
    } else {
      await new Promise<void>((resolve) => active.server.close(() => resolve()));
    }
    tunnel!.active.delete(id);
  }
  if (fwd) addAudit(getDb(), 'forward.stop', fwd.host_id, `:${fwd.local_port}`);
}

export async function stopHost(hostId: number): Promise<void> {
  const tunnel = tunnels.get(hostId);
  if (!tunnel) return;
  for (const id of [...tunnel.active.keys()]) await stopForward(id);
  tunnel.conn.end();
  tunnels.delete(hostId);
}

export function forwardStates(): Record<number, { active: boolean; realPort?: number; kind?: string }> {
  const out: Record<number, { active: boolean; realPort?: number; kind?: string }> = {};
  for (const fwd of listForwards(getDb())) out[fwd.id] = { active: false };
  for (const tunnel of tunnels.values()) {
    for (const a of tunnel.active.values()) {
      out[a.id] = { active: true, kind: a.kind, realPort: a.kind === 'remote' ? a.realPort : undefined };
    }
  }
  return out;
}

export async function startAutoForwards(hostId: number): Promise<void> {
  for (const fwd of listForwards(getDb(), hostId)) {
    if (fwd.auto_start) {
      try {
        await startForward(fwd.id);
      } catch (e) {
        addAudit(getDb(), 'forward.error', hostId, `auto-start :${fwd.local_port}: ${String(e)}`);
      }
    }
  }
}
