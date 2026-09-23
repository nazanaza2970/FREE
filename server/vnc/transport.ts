import net from 'node:net';
import type { Duplex } from 'node:stream';
import type Database from 'better-sqlite3';
import type { Client } from 'ssh2';
import type { Host } from '../../shared/types';
import { resolveVncConfig } from './config';
import { connectSsh } from './ssh';

export interface VncStream {
  socket: Duplex;
  close(): void;
}

export function connectNet(host: string, port: number, timeoutMs = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect to ${host}:${port} timed out`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface OpenVncStreamOpts {
  connectNetImpl?: (host: string, port: number, timeoutMs?: number) => Promise<net.Socket>;
  connectSshImpl?: (endpoint: Parameters<typeof connectSsh>[0]) => Promise<Client>;
}

export async function openVncStream(
  database: Database.Database,
  host: Host,
  portOverride?: number,
  opts: OpenVncStreamOpts = {},
): Promise<VncStream> {
  const cfg = resolveVncConfig(database, host);
  const port = portOverride ?? cfg.vncPort;
  const netImpl = opts.connectNetImpl ?? connectNet;
  const sshImpl = opts.connectSshImpl ?? connectSsh;

  if (cfg.transport === 'direct') {
    const socket = await netImpl(cfg.vncHost, port);
    return { socket, close: () => socket.destroy() };
  }

  const ssh = await sshImpl(cfg.ssh!);
  return new Promise<VncStream>((resolve, reject) => {
    ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, socket) => {
      if (err) {
        ssh.end();
        reject(err);
        return;
      }
      socket.once('close', () => ssh.end());
      resolve({
        socket,
        close: () => {
          try {
            socket.destroy();
          } catch {
            /* already closed */
          }
          ssh.end();
        },
      });
    });
  });
}
