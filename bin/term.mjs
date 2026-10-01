#!/usr/bin/env node
/**
 * term — attach to a saved host using the same REST + WS API as the web UI.
 *
 *   term <host-name|id> [--server http://127.0.0.1:3001] [--trust] [-v]
 *
 * Looks the host up over HTTP, then drives the /ws/terminal WebSocket exactly
 * like the browser client: base64-encoded output out, UTF-8 input in.
 */
import WebSocket from 'ws';

function parseArgs(argv) {
  const opts = {
    host: null,
    server: process.env.TERMUS_SERVER || 'http://127.0.0.1:3001',
    token: process.env.TERMUS_TOKEN || null,
    trust: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server' || a === '-s') opts.server = String(argv[++i] ?? '');
    else if (a === '--token' || a === '-T') opts.token = String(argv[++i] ?? '');
    else if (a === '--trust' || a === '-t') opts.trust = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) {
      // ignore unknown flags
    } else if (!opts.host) opts.host = a;
  }
  return opts;
}

function die(message, code = 1) {
  process.stderr.write(`term: ${message}\n`);
  process.exit(code);
}

function help() {
  process.stdout.write(
    [
      'usage: term <host-name|id> [options]',
      '',
      'options:',
      '  -s, --server URL   server base URL (default $TERMUS_SERVER or http://127.0.0.1:3001)',
      '  -T, --token TOKEN  bearer token (default $TERMUS_TOKEN) when the server requires auth',
      '  -t, --trust        auto-trust new/mismatched host keys',
      '  -v, --verbose      log protocol status to stderr',
      '  -h, --help         show this help',
      '',
    ].join('\n'),
  );
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.host) {
  help();
  process.exit(opts.help ? 0 : 1);
}

async function resolveHost(server, selector, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${server.replace(/\/$/, '')}/api/hosts`, { headers });
  if (!res.ok) die(`failed to list hosts (HTTP ${res.status})${token ? '' : ' — is the server running with auth armed? use -T/--token'}`);
  const hosts = await res.json();
  if (Number.isInteger(Number(selector))) {
    return hosts.find((h) => h.id === Number(selector)) ?? null;
  }
  return hosts.find((h) => h.name === selector) ?? null;
}

const host = await resolveHost(opts.server, opts.host, opts.token).catch((e) => die(`server error: ${e.message}`));
if (!host) die(`host '${opts.host}' not found`);

const serverBase = opts.server.replace(/\/$/, '');
const wsUrl =
  (serverBase.startsWith('https') ? 'wss://' : 'ws://') +
  serverBase.replace(/^https?:\/\//, '') +
  '/ws/terminal' +
  (opts.token ? `?token=${encodeURIComponent(opts.token)}` : '');

const log = (m) => {
  if (opts.verbose) process.stderr.write(`term: ${m}\n`);
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

const sessionId = `cli-${process.pid}-${Date.now()}`;
const ws = new WebSocket(wsUrl);
let closed = false;
let connected = false;

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function shutdown(code = 0) {
  if (closed) return;
  closed = true;
  try {
    send({ type: 'disconnect', sessionId });
  } catch {
    /* ignore */
  }
  ws.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(code);
}

ws.on('open', () => {
  log(`connected to ${wsUrl}`);
  send({ type: 'connect', sessionId, hostId: host.id, trust: opts.trust });
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  switch (msg.type) {
    case 'output': {
      const data = Buffer.from(String(msg.data ?? ''), 'base64');
      if (data.length) process.stdout.write(data);
      break;
    }
    case 'status': {
      log(`status: ${msg.state}${msg.detail ? ` (${msg.detail})` : ''}`);
      if (msg.state === 'connected') connected = true;
      if (msg.state === 'error') shutdown(2);
      break;
    }
    case 'hostkey': {
      if (msg.state === 'mismatch') {
        process.stderr.write(`term: host key mismatch (expected ${msg.expected ?? '?'}, got ${msg.fingerprint})\n`);
        if (!opts.trust) shutdown(3);
      } else if (msg.state === 'new') {
        process.stderr.write(`term: trusted new host key ${msg.fingerprint}\n`);
      }
      break;
    }
    case 'exit': {
      log(`remote exited (${msg.code ?? 'null'})`);
      shutdown(0);
      break;
    }
    case 'error': {
      process.stderr.write(`term: ${msg.message}\n`);
      shutdown(2);
      break;
    }
    default:
      break;
  }
});

ws.on('error', (err) => {
  die(err.message);
});

ws.on('close', () => {
  if (!closed) {
    log('disconnected');
    process.exit(connected ? 0 : 4);
  }
});

process.stdin.on('data', (chunk) => {
  send({ type: 'input', sessionId, data: chunk.toString('utf8') });
});
process.stdin.on('end', () => shutdown(0));

function sendResize() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  send({ type: 'resize', sessionId, cols, rows });
}
process.stdout.on('resize', sendResize);
sendResize();

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
