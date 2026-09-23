import type { SessionState } from './types';

export const TERMINAL_PATH = '/ws/terminal';

export type ClientMessage =
  | { type: 'connect'; sessionId: string; hostId: number; trust?: boolean }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'disconnect'; sessionId: string };

export type ServerMessage =
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'status'; sessionId: string; state: SessionState; detail?: string }
  | { type: 'hostkey'; sessionId: string; state: 'new' | 'verified' | 'mismatch'; fingerprint: string; expected?: string }
  | { type: 'exit'; sessionId: string; code: number | null }
  | { type: 'error'; sessionId: string; message: string };

export function encodeBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
