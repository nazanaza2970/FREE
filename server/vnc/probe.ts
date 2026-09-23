import type { Duplex } from 'node:stream';
import type { VncStream } from './transport';

export interface ProbeResult {
  running: boolean;
  version: string | null;
  reason: string | null;
}

const GREETING = 'RFB ';

export function isRfbGreeting(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === GREETING;
}

export async function probeVnc(
  openStream: () => Promise<VncStream>,
  timeoutMs = 4000,
): Promise<ProbeResult> {
  let stream: VncStream | null = null;
  try {
    stream = await openStream();
    const socket: Duplex = stream.socket;
    const chunks: Buffer[] = [];
    return await new Promise<ProbeResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = (err: Error) => finish({ running: false, version: null, reason: err.message });
      const finish = (result: ProbeResult) => {
        if (timer) clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        resolve(result);
      };
      const onData = (data: Buffer) => {
        chunks.push(data);
        const head = Buffer.concat(chunks);
        if (isRfbGreeting(head)) {
          finish({ running: true, version: head.subarray(4, 12).toString('ascii').trim(), reason: null });
        } else if (head.length > 64) {
          finish({ running: false, version: null, reason: `unexpected data: ${head.subarray(0, 16).toString('base64')}` });
        }
      };
      const onClose = () => {
        finish({ running: false, version: null, reason: 'connection closed before RFB greeting' });
      };
      timer = setTimeout(() => fail(new Error('timed out waiting for RFB greeting')), timeoutMs);
      socket.on('data', onData);
      socket.once('close', onClose);
    });
  } catch (err) {
    return { running: false, version: null, reason: String((err as Error).message || err) };
  } finally {
    try {
      stream?.close();
    } catch {
      /* already closed */
    }
  }
}
