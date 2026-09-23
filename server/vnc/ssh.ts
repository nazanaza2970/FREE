import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { buildAuthConfig } from '../ssh/auth';
import type { SshEndpoint } from './config';

export function connectSsh(endpoint: SshEndpoint): Promise<Client> {
  const auth = buildAuthConfig(endpoint.hostRow);
  if (!auth.ok) return Promise.reject(new Error(auth.error));
  const config: ConnectConfig = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    hostVerifier: () => true,
  };
  Object.assign(config, auth.config);
  const conn = new Client();
  return new Promise((resolve, reject) => {
    conn.once('ready', () => resolve(conn));
    conn.once('error', reject);
    conn.connect(config);
  });
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function execRemote(
  endpoint: SshEndpoint,
  command: string,
  timeoutMs = 30000,
): Promise<ExecResult> {
  const conn = await connectSsh(endpoint);
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      conn.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          conn.end();
          resolve({ code: code ?? 0, stdout, stderr });
        });
        stream.on('error', (e: Error) => {
          clearTimeout(timer);
          conn.end();
          reject(e);
        });
      });
    });
  } finally {
    try {
      conn.end();
    } catch {
      /* already closed */
    }
  }
}
