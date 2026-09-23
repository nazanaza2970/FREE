import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_PATH, decodeBase64, encodeBase64 } from '../shared/protocol';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { SessionState } from '../shared/types';

test('TERMINAL_PATH is the expected ws route', () => {
  assert.equal(TERMINAL_PATH, '/ws/terminal');
});

test('SessionState covers all expected values', () => {
  const states: SessionState[] = ['disconnected', 'connecting', 'connected', 'error'];
  assert.deepEqual(new Set(states).size, 4);
});

test('base64 round-trips a buffer', () => {
  const buf = Buffer.from('hello terminal');
  const enc = encodeBase64(buf);
  const dec = Buffer.from(decodeBase64(enc));
  assert.equal(dec.toString('utf8'), 'hello terminal');
});

test('client message shapes are well-formed', () => {
  const messages: ClientMessage[] = [
    { type: 'connect', sessionId: 's1', hostId: 1 },
    { type: 'input', sessionId: 's1', data: 'ls\r' },
    { type: 'resize', sessionId: 's1', cols: 80, rows: 24 },
    { type: 'disconnect', sessionId: 's1' },
  ];
  assert.equal(messages.length, 4);
  assert.equal(messages[0].type, 'connect');
});

test('server message shapes are well-formed', () => {
  const messages: ServerMessage[] = [
    { type: 'output', sessionId: 's1', data: 'aGk=' },
    { type: 'status', sessionId: 's1', state: 'connected' },
    { type: 'exit', sessionId: 's1', code: 0 },
    { type: 'error', sessionId: 's1', message: 'boom' },
  ];
  assert.equal(messages.length, 4);
  assert.equal(messages[1].type, 'status');
});
