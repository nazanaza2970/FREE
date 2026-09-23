import ssh2 from 'ssh2';
import type { Channel, Connection, Session } from 'ssh2';

const { Server, utils } = ssh2;

export interface TestSshServer {
  port: number;
  hostKey: string;
  close: () => Promise<void>;
}

export interface TestSshServerOptions {
  user?: string;
  password?: string;
  banner?: string;
  echoPrefix?: string;
  port?: number;
  /** Private or public key (PEM) to accept for publickey auth. */
  publicKey?: string;
  onAuthAgent?: (channel: Channel) => void;
  onAuthAgentError?: (err: Error) => void;
  /** Handler for `exec` requests. Default: close the stream immediately. */
  onExec?: (command: string, stream: Channel) => void;
  /** Handler for direct-tcpip forwarding requests. Default: close the stream. */
  onTcpip?: (destinationHost: string, destinationPort: number, stream: Channel) => void;
}

// ssh2 has no public API for the server to open an `auth-agent@openssh.com`
// channel back at the client, so reach into the connection internals.
function openAuthAgentChannel(
  client: Connection,
  onOpen: (err: Error | null, stream?: Channel) => void,
): void {
  const internal = client as unknown as {
    _chanMgr: { add(cb: (err: Error | null, stream?: Channel) => void): number };
    _protocol: { openssh_authAgent(chan: number, window: number, packetSize: number): void };
  };
  const onChannelOpen: (err: Error | null, stream?: Channel) => void = (err, stream) => {
    onOpen(err, stream);
  };
  (onChannelOpen as { type?: string }).type = 'auth-agent@openssh.com';
  const chan = internal._chanMgr.add(onChannelOpen);
  if (chan !== -1) internal._protocol.openssh_authAgent(chan, 2 * 1024 * 1024, 32 * 1024);
  else onOpen(new Error('no free channel ids on test server'));
}

export async function startSshServer(opts: TestSshServerOptions = {}): Promise<TestSshServer> {
  const user = opts.user ?? 'testuser';
  const password = opts.password ?? 'testpass';
  const banner = opts.banner ?? 'WELCOME-TEST\r\n';
  const echoPrefix = opts.echoPrefix ?? 'ECHO:';
  const keyPair = utils.generateKeyPairSync('ed25519');

  const expectedKey = opts.publicKey ? utils.parseKey(opts.publicKey) : null;

  const server = new Server({ hostKeys: [keyPair.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && expectedKey && !(expectedKey instanceof Error) && ctx.key) {
        const keyMatches = expectedKey.getPublicSSH().equals(ctx.key.data);
        if (!keyMatches) {
          ctx.reject();
          return;
        }
        if (!ctx.blob || !ctx.signature) {
          // key "query" (no signature) — say the key is usable
          ctx.accept();
          return;
        }
        const ok = expectedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
        ok ? ctx.accept() : ctx.reject();
        return;
      }
      if (ctx.method === 'password' && ctx.username === user && String(ctx.password) === password) {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept() as Session;
        session.on('pty', (acceptPty) => {
          acceptPty();
        });
        session.on('shell', (acceptShell) => {
          const shell = acceptShell();
          shell.write(banner);
          shell.on('data', (data: Buffer) => {
            shell.write(`${echoPrefix}${data.toString('utf8')}`);
          });
          shell.on('close', () => {
            try {
              shell.end();
            } catch {
              /* already closed */
            }
          });
        });
        session.on('auth-agent', (accept) => {
          accept();
          openAuthAgentChannel(client, (err, stream) => {
            if (err || !stream) {
              opts.onAuthAgentError?.(err ?? new Error('auth-agent channel not opened'));
              return;
            }
            opts.onAuthAgent?.(stream);
          });
        });
        session.on('exec', (acceptExec, _reject, info) => {
          const execStream = acceptExec();
          const command = typeof info.command === 'string' ? info.command : Buffer.from(info.command).toString('utf8');
          if (opts.onExec) {
            opts.onExec(command, execStream);
          } else {
            try {
              execStream.end();
            } catch {
              /* already closed */
            }
          }
        });
        session.on('close', () => {
          try {
            session.end();
          } catch {
            /* already closed */
          }
        });
      });
      client.on('tcpip', (acceptTcpip, _reject, info) => {
        const stream = acceptTcpip();
        if (opts.onTcpip) {
          opts.onTcpip(String(info.destIP), Number(info.destPort), stream);
        } else {
          try {
            stream.close();
          } catch {
            /* already closed */
          }
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    hostKey: keyPair.private,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
