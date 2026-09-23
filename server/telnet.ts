import net from 'node:net';

export interface TelnetLink {
  socket: net.Socket;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: () => void): void;
  write(data: string): void;
  close(): void;
}

const IAC = 0xff;
const DONT = 0xfc;
const DO = 0xfd;
const WONT = 0xfe;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;
const IP = 0xf9;
const IA = 0xf1;

/**
 * Minimal Telnet client: performs basic option negotiation (WONT/DONT),
 * discards subnegotiations, and passes payload bytes through unchanged.
 */
export function connectTelnet(host: string, port: number): Promise<TelnetLink> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let pendingIac = false;
    let inSubneg = false;
    let payloadCb: ((data: Buffer) => void) | null = null;

    socket.once('error', (err) => reject(err));
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      socket.on('data', (chunk: Buffer) => {
        const out: number[] = [];
        const reply: number[] = [];
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          if (inSubneg) {
            if (b === SE) inSubneg = false;
            continue;
          }
          if (pendingIac) {
            pendingIac = false;
            switch (b) {
              case DO:
                reply.push(IAC, WONT, chunk[i + 1] ?? 0);
                i++;
                break;
              case WILL:
                reply.push(IAC, DONT, chunk[i + 1] ?? 0);
                i++;
                break;
              case SB:
                inSubneg = true;
                break;
              case IP:
                out.push(IAC, IP);
                break;
              case IA:
                out.push(IAC, IA);
                break;
              default:
                break;
            }
            continue;
          }
          if (b === IAC) {
            pendingIac = true;
            continue;
          }
          out.push(b);
        }
        if (out.length > 0 && payloadCb) payloadCb(Buffer.from(out));
        if (reply.length > 0) socket.write(Buffer.from(reply));
      });

      const link: TelnetLink = {
        socket,
        onData: (cb) => {
          payloadCb = cb;
        },
        onClose: (cb) => {
          socket.on('close', cb);
          socket.on('error', cb);
        },
        write: (data) => {
          socket.write(data);
        },
        close: () => {
          try {
            socket.end();
          } catch {
            /* already closed */
          }
        },
      };
      resolve(link);
    });
  });
}
