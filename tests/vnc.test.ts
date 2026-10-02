import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createHost, initDb, setDb } from '../server/db';
import type Database from '../server/sqlite';
import { isRfbGreeting, probeVnc } from '../server/vnc/probe';
import { connectNet, openVncStream, type VncStream } from '../server/vnc/transport';
import { resolveVncConfig } from '../server/vnc/config';
import { parseDiagnostics } from '../server/vnc/diagnostics';
import {
  desktopInstallCommands,
  getVncRequirements,
  resolveImplementation,
  vncInstallCommands,
  x11vncInstallCommands,
} from '../server/vnc/requirements';
import { enterSession, ensureSession, getSession, leaveSession, stopSession } from '../server/vnc/sessions';
import { buildApp } from '../server/index';
import { startSshServer } from './helpers/ssh-server';
import type { Host, VncDiagnostics } from '../shared/types';

function tempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-vnc-test-'));
  const db = initDb(path.join(dir, 'test.db'));
  setDb(db);
  return { db, cleanup: () => { setDb(null); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

interface FakeVnc {
  port: number;
  connections: number;
  close: () => Promise<void>;
}

function startFakeVnc(port = 0, greeting = 'RFB 003.008\n'): Promise<FakeVnc> {
  return new Promise((resolve, reject) => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.write(greeting);
      socket.on('error', () => {
        /* client went away */
      });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        get port() {
          return (server.address() as { port: number }).port;
        },
        get connections() {
          return connections;
        },
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

function directStream(port: number): Promise<VncStream> {
  return connectNet('127.0.0.1', port).then((socket) => ({ socket, close: () => socket.destroy() }));
}

const DIAG_UBUNTU = [
  '==os==',
  'Ubuntu 22.04.4 LTS',
  '==arch==',
  'x86_64',
  '==bins==',
  '/usr/bin/vncserver',
  '==version==',
  'TigerVNC 1.13.1',
  '==listen==',
  '',
  '==processes==',
  '',
  '==xsessions==',
  'xfce4.desktop',
  '==sessiontype==',
  'Type=x11',
  '==uid==',
  '0',
].join('\n');

type DiagOver = Omit<Partial<VncDiagnostics['vnc']>, 'display'> &
  Omit<Partial<VncDiagnostics['desktop']>, 'display'> & { display?: string | number };

function makeDiagnostics(over: DiagOver = {}): VncDiagnostics {
  const base: VncDiagnostics = {
    os: 'Ubuntu 22.04.4 LTS',
    distribution: 'Ubuntu 22.04.4 LTS',
    architecture: 'x86_64',
    vnc: { installed: true, running: false, implementation: 'tigervnc', hasX11vnc: false, port: 5900, display: undefined },
    desktop: { installed: true, environment: 'xfce', displayServer: 'x11' },
    permissions: { canStartVnc: true, canAccessDisplay: true },
    requirements: [],
  };
  return {
    ...base,
    vnc: { ...base.vnc, ...over, display: over.display as VncDiagnostics['vnc']['display'] },
    desktop: { ...base.desktop, ...over, display: over.display as VncDiagnostics['desktop']['display'] },
  };
}

const DIAG_X11VNC = [
  '==os==',
  'Ubuntu 22.04.4 LTS',
  '==arch==',
  'x86_64',
  '==bins==',
  '/usr/bin/x11vnc',
  '==version==',
  'x11vnc V6.0.5',
  '==listen==',
  '',
  '==processes==',
  '',
  '==xsessions==',
  'xfce4.desktop',
  '==sessiontype==',
  'Type=x11',
  '==display==',
  ':0',
  '==xdisplays==',
  '0',
  '1',
  '==uid==',
  '1000',
].join('\n');

test('isRfbGreeting detects the RFB header', () => {
  assert.equal(isRfbGreeting(Buffer.from('RFB 003.008\n')), true);
  assert.equal(isRfbGreeting(Buffer.from('SSH-2.0-OpenSSH_8.9')), false);
  assert.equal(isRfbGreeting(Buffer.from('RFB')), false);
});

test('probeVnc detects a running VNC server', async () => {
  const fake = await startFakeVnc();
  try {
    const result = await probeVnc(() => directStream(fake.port), 2000);
    assert.equal(result.running, true);
    assert.equal(result.version, '003.008');
    assert.equal(result.reason, null);
  } finally {
    await fake.close();
  }
});

test('probeVnc reports a connection that closes before the greeting', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const result = await probeVnc(() => directStream(port), 2000);
  assert.equal(result.running, false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('probeVnc times out when the server stays silent', async () => {
  const server = net.createServer((socket) => socket.on('error', () => undefined));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const startedAt = Date.now();
  const result = await probeVnc(() => directStream(port), 250);
  assert.equal(result.running, false);
  assert.match(result.reason ?? '', /timed out/);
  assert.ok(Date.now() - startedAt < 2000);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('parseDiagnostics parses a full diagnostic script output', () => {
  const parsed = parseDiagnostics(DIAG_UBUNTU, 5900);
  assert.equal(parsed.distribution, 'Ubuntu 22.04.4 LTS');
  assert.equal(parsed.vnc.installed, true);
  assert.equal(parsed.vnc.running, false);
  assert.equal(parsed.vnc.implementation, 'tigervnc');
  assert.equal(parsed.desktop.installed, true);
  assert.equal(parsed.desktop.environment, 'xfce');
  assert.equal(parsed.desktop.displayServer, 'x11');
  assert.equal(parsed.permissions.canStartVnc, true);
});

test('parseDiagnostics detects x11vnc and the live X display', () => {
  const parsed = parseDiagnostics(DIAG_X11VNC, 5900);
  assert.equal(parsed.vnc.hasX11vnc, true);
  assert.equal(parsed.vnc.implementation, 'x11vnc');
  assert.equal(parsed.desktop.display, ':0');
  assert.deepEqual(parsed.desktop.displays, [0, 1]);
  assert.equal(parsed.permissions.canAccessDisplay, true);
});

test('parseDiagnostics flags an inaccessible display for unprivileged users', () => {
  const output = DIAG_X11VNC.replace('==display==\n:0', '==display==\n:7');
  const parsed = parseDiagnostics(output, 5900);
  assert.equal(parsed.permissions.canAccessDisplay, false);
});

test('parseDiagnostics detects a running VNC from listening ports', () => {
  const output = DIAG_UBUNTU.replace('==listen==\n\n', '==listen==\n5900\n');
  const parsed = parseDiagnostics(output, 5900);
  assert.equal(parsed.vnc.running, true);
  assert.equal(parsed.vnc.port, 5900);
});

test('vncInstallCommands are distro-specific', () => {
  assert.deepEqual(vncInstallCommands('Ubuntu 22.04.4 LTS'), ['apt-get update', 'apt-get install -y tigervnc-standalone-server']);
  assert.deepEqual(vncInstallCommands('Fedora Linux 39'), ['dnf install -y tigervnc-server']);
  assert.deepEqual(vncInstallCommands('Alpine Linux v3.19'), ['apk add tigervnc']);
  assert.deepEqual(desktopInstallCommands('Arch Linux'), ['pacman -S --noconfirm xfce4 xfce4-goodies']);
  assert.deepEqual(vncInstallCommands('FreeBSD 14'), []);
});

test('x11vncInstallCommands are distro-specific', () => {
  assert.deepEqual(x11vncInstallCommands('Ubuntu 22.04.4 LTS'), ['apt-get update', 'apt-get install -y x11vnc']);
  assert.deepEqual(x11vncInstallCommands('Fedora Linux 39'), ['dnf install -y x11vnc']);
  assert.deepEqual(x11vncInstallCommands('Arch Linux'), ['pacman -S --noconfirm x11vnc']);
  assert.deepEqual(x11vncInstallCommands('Alpine Linux v3.19'), ['apk add x11vnc']);
  assert.deepEqual(x11vncInstallCommands('FreeBSD 14'), []);
});

test('getVncRequirements is empty when VNC is already running', () => {
  const requirements = getVncRequirements(makeDiagnostics({ running: true }));
  assert.deepEqual(requirements, []);
});

test('getVncRequirements lists missing pieces with install commands', () => {
  const requirements = getVncRequirements(makeDiagnostics({ installed: false, port: undefined, display: undefined }));
  const types = requirements.map((r) => r.type);
  assert.ok(types.includes('vnc_server_missing'));
  assert.ok(types.includes('desktop_missing'));
  const vncMissing = requirements.find((r) => r.type === 'vnc_server_missing');
  const vncCmds = vncMissing && 'installCommands' in vncMissing ? vncMissing.installCommands : undefined;
  assert.ok(vncCmds && vncCmds.length > 0);
  const desktopMissing = requirements.find((r) => r.type === 'desktop_missing');
  const desktopCmds = desktopMissing && 'installCommands' in desktopMissing ? desktopMissing.installCommands : undefined;
  assert.ok(desktopCmds && desktopCmds.length > 0);
});

test('getVncRequirements flags wayland sessions', () => {
  const requirements = getVncRequirements(makeDiagnostics({ displayServer: 'wayland' }));
  assert.ok(requirements.some((r) => r.type === 'display_unavailable'));
});

test('resolveImplementation honours explicit configuration', () => {
  const host = { vnc_implementation: 'x11vnc', vnc_desktop_mode: 'auto' } as const;
  assert.equal(resolveImplementation(null, host), 'x11vnc');
  assert.equal(resolveImplementation(makeDiagnostics(), host), 'x11vnc');
  const tiger = { vnc_implementation: 'tigervnc', vnc_desktop_mode: 'auto' } as const;
  assert.equal(resolveImplementation(makeDiagnostics({ hasX11vnc: true, display: ':0', displays: [0] }), tiger), 'tigervnc');
});

test('resolveImplementation picks x11vnc only for accessible X11 sessions with x11vnc installed', () => {
  const auto = { vnc_implementation: 'auto', vnc_desktop_mode: 'auto' } as const;
  const x11 = makeDiagnostics({ hasX11vnc: true, display: ':0', displays: [0, 1] });
  assert.equal(resolveImplementation(x11, auto), 'x11vnc');
  assert.equal(resolveImplementation(makeDiagnostics({ hasX11vnc: true, displayServer: 'wayland' }), auto), 'tigervnc');
  assert.equal(resolveImplementation(makeDiagnostics({ display: ':0', displays: [0, 1] }), auto), 'tigervnc');
  const virtual = { vnc_implementation: 'auto', vnc_desktop_mode: 'virtual' } as const;
  assert.equal(resolveImplementation(x11, virtual), 'tigervnc');
  assert.equal(resolveImplementation(null, auto), 'tigervnc');
});

test('getVncRequirements x11vnc reports a missing x11vnc binary', () => {
  const requirements = getVncRequirements(makeDiagnostics({ hasX11vnc: false }), 'x11vnc');
  const missing = requirements.find((r) => r.type === 'x11vnc_missing');
  assert.ok(missing);
  const cmds = missing && 'installCommands' in missing ? missing.installCommands : undefined;
  assert.deepEqual(cmds, ['apt-get update', 'apt-get install -y x11vnc']);
});

test('getVncRequirements x11vnc reports an unavailable display', () => {
  const wayland = getVncRequirements(makeDiagnostics({ hasX11vnc: true, displayServer: 'wayland' }), 'x11vnc');
  assert.ok(wayland.some((r) => r.type === 'display_unavailable'));
  const noDisplays = getVncRequirements(makeDiagnostics({ hasX11vnc: true, displays: [] }), 'x11vnc');
  assert.ok(noDisplays.some((r) => r.type === 'display_unavailable'));
});

test('getVncRequirements x11vnc is empty when the desktop is ready', () => {
  const requirements = getVncRequirements(makeDiagnostics({ hasX11vnc: true, display: ':0', displays: [0, 1] }), 'x11vnc');
  assert.deepEqual(requirements, []);
});

test('getVncRequirements reports unsupported environment without diagnostics', () => {
  const requirements = getVncRequirements(null);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].type, 'unsupported_environment');
});

test('resolveVncConfig honours transport and reference host', () => {
  const { db, cleanup } = tempDb();
  try {
    const ssh = createHost(db, { name: 'ssh-ref', host: '10.0.0.1', port: 2222, username: 'deploy', password: 'pw' });
    const direct = createHost(db, {
      name: 'direct',
      host: '10.0.0.9',
      port: 5901,
      connection_type: 'vnc',
      vnc_transport: 'direct',
    });
    const viaRef = createHost(db, {
      name: 'via-ref',
      host: 'ignored',
      port: 22,
      connection_type: 'vnc',
      vnc_transport: 'ssh',
      vnc_ssh_host_id: ssh.id,
      vnc_port: 5902,
    });
    const directCfg = resolveVncConfig(db, direct);
    assert.equal(directCfg.transport, 'direct');
    assert.equal(directCfg.vncHost, '10.0.0.9');
    assert.equal(directCfg.vncPort, 5901);
    assert.equal(directCfg.ssh, null);

    const refCfg = resolveVncConfig(db, viaRef);
    assert.equal(refCfg.transport, 'ssh');
    assert.equal(refCfg.ssh?.host, '10.0.0.1');
    assert.equal(refCfg.ssh?.port, 2222);
    assert.equal(refCfg.ssh?.username, 'deploy');
    assert.equal(refCfg.vncPort, 5902);
    assert.equal(refCfg.vncHost, '127.0.0.1');
  } finally {
    cleanup();
  }
});

test('openVncStream direct transport connects to the VNC port', async () => {
  const fake = await startFakeVnc();
  const { db, cleanup } = tempDb();
  try {
    const host = createHost(db, {
      name: 'direct',
      host: '127.0.0.1',
      port: fake.port,
      connection_type: 'vnc',
      vnc_transport: 'direct',
    });
    const stream = await openVncStream(db, host);
    const greeting = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no data')), 2000);
      stream.socket.once('data', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
    });
    assert.equal(greeting, 'RFB 003.008\n');
    stream.close();
  } finally {
    cleanup();
    await fake.close();
  }
});

test('openVncStream ssh transport forwards through direct-tcpip', async () => {
  const fake = await startFakeVnc();
  const ssh = await startSshServer({
    onTcpip: (_host, port, stream) => {
      const upstream = net.connect({ host: '127.0.0.1', port });
      upstream.on('error', () => {
        try {
          stream.destroy();
        } catch {
          /* already closed */
        }
      });
      stream.on('close', () => upstream.destroy());
      upstream.on('close', () => {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      });
      upstream.pipe(stream);
      stream.pipe(upstream);
    },
  });
  const { db, cleanup } = tempDb();
  try {
    const host = createHost(db, {
      name: 'via-ssh',
      host: '127.0.0.1',
      port: ssh.port,
      username: 'testuser',
      password: 'testpass',
      connection_type: 'vnc',
      vnc_transport: 'ssh',
      vnc_port: fake.port,
    });
    const stream = await openVncStream(db, host);
    const greeting = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no data')), 3000);
      stream.socket.once('data', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
    });
    assert.equal(greeting, 'RFB 003.008\n');
    stream.close();
  } finally {
    cleanup();
    await fake.close();
    await ssh.close();
  }
});

test('ensureSession starts a virtual desktop and tracks enter/leave/stop', async () => {
  const { db, cleanup } = tempDb();
  const fakes: FakeVnc[] = [];
  const startCommands: string[] = [];
  const killCommands: string[] = [];
  const fakePort = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  const ssh = await startSshServer({
    onExec: (command, stream) => {
      if (command.includes('nohup vncserver')) {
        startCommands.push(command);
        stream.write('4242\n');
        stream.end();
        void startFakeVnc(fakePort).then((s) => {
          fakes.push(s);
        });
        return;
      }
      if (command.includes('-kill')) {
        killCommands.push(command);
        stream.end();
        return;
      }
      stream.write(DIAG_UBUNTU);
      stream.end();
    },
    onTcpip: (_host, port, stream) => {
      const upstream = net.connect({ host: '127.0.0.1', port });
      upstream.on('error', () => {
        try {
          stream.destroy();
        } catch {
          /* already closed */
        }
      });
      stream.on('close', () => upstream.destroy());
      upstream.on('close', () => {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      });
      upstream.pipe(stream);
      stream.pipe(upstream);
    },
  });
  try {
    const host = createHost(db, {
      name: 'managed',
      host: '127.0.0.1',
      port: ssh.port,
      username: 'testuser',
      password: 'testpass',
      connection_type: 'vnc',
      vnc_transport: 'ssh',
      vnc_port: fakePort,
    });
    const result = await ensureSession(host.id, { start: true });
    assert.ok(result.session, 'expected a session to be created');
    assert.equal(result.session.managed, true);
    assert.equal(result.session.display, 1);
    assert.equal(result.session.pid, 4242);
    assert.equal(result.session.port, fakePort);
    assert.equal(result.requirements.length, 0);
    assert.equal(startCommands.length, 1);

    assert.equal(getSession(host.id)?.active, 0);
    enterSession(host.id);
    assert.equal(getSession(host.id)?.active, 1);
    assert.equal(leaveSession(host.id), true);

    await stopSession(host.id);
    assert.equal(getSession(host.id), undefined);
    assert.equal(killCommands.length, 1);
    assert.match(killCommands[0], /vncserver -kill :1/);
  } finally {
    for (const f of fakes) await f.close();
    cleanup();
    await ssh.close();
  }
});

test('ensureSession starts x11vnc on the existing X11 desktop and stops it by pid', async () => {
  const { db, cleanup } = tempDb();
  const fakes: FakeVnc[] = [];
  const startCommands: string[] = [];
  const killCommands: string[] = [];
  const fakePort = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  const ssh = await startSshServer({
    onExec: (command, stream) => {
      if (command.includes('nohup x11vnc')) {
        startCommands.push(command);
        stream.write('7777\n');
        stream.end();
        void startFakeVnc(fakePort).then((s) => {
          fakes.push(s);
        });
        return;
      }
      if (command.startsWith('kill ')) {
        killCommands.push(command);
        stream.end();
        return;
      }
      stream.write(DIAG_X11VNC);
      stream.end();
    },
    onTcpip: (_host, port, stream) => {
      const upstream = net.connect({ host: '127.0.0.1', port });
      upstream.on('error', () => {
        try {
          stream.destroy();
        } catch {
          /* already closed */
        }
      });
      stream.on('close', () => upstream.destroy());
      upstream.on('close', () => {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      });
      upstream.pipe(stream);
      stream.pipe(upstream);
    },
  });
  try {
    const host = createHost(db, {
      name: 'x11vnc',
      host: '127.0.0.1',
      port: ssh.port,
      username: 'testuser',
      password: 'testpass',
      connection_type: 'vnc',
      vnc_transport: 'ssh',
      vnc_port: fakePort,
      vnc_implementation: 'x11vnc',
    });
    const result = await ensureSession(host.id, { start: true });
    assert.ok(result.session, 'expected a session to be created');
    assert.equal(result.session.managed, true);
    assert.equal(result.session.implementation, 'x11vnc');
    assert.equal(result.session.display, 0);
    assert.equal(result.session.pid, 7777);
    assert.equal(result.requirements.length, 0);
    assert.equal(startCommands.length, 1);
    assert.match(startCommands[0], /x11vnc -display :0 -rfbport \d+ -localhost/);

    await stopSession(host.id);
    assert.equal(getSession(host.id), undefined);
    assert.equal(killCommands.length, 1);
    assert.match(killCommands[0], /kill 7777/);
  } finally {
    for (const f of fakes) await f.close();
    cleanup();
    await ssh.close();
  }
});

test('ensureSession returns requirements without starting when auto_start is off', async () => {
  const { db, cleanup } = tempDb();
  try {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (server.address() as { port: number }).port;
    const host = createHost(db, {
      name: 'no-auto',
      host: '127.0.0.1',
      port: deadPort,
      connection_type: 'vnc',
      vnc_transport: 'direct',
      vnc_auto_start: false,
    });
    const result = await ensureSession(host.id);
    assert.equal(result.session, null);
    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0].type, 'unsupported_environment');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    cleanup();
  }
});

async function listenPort(app: import('fastify').FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as { port: number }).port;
}

test('websocket relays the RFB greeting for a running VNC host', async () => {
  const fake = await startFakeVnc();
  const { db, cleanup } = tempDb();
  const app = await buildApp({ logger: false });
  const port = await listenPort(app);
  const host = createHost(db, {
    name: 'ws-direct',
    host: '127.0.0.1',
    port: fake.port,
    connection_type: 'vnc',
    vnc_transport: 'direct',
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?host_id=${host.id}`);
    const greeting = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for greeting')), 5000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(data as Buffer);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.equal(greeting.toString(), 'RFB 003.008\n');
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    assert.equal(getSession(host.id)?.active, 0);
  } finally {
    await stopSession(host.id);
    cleanup();
    await fake.close();
    await app.close();
  }
});

test('websocket closes with 1008 for a non-VNC host', async () => {
  const { db, cleanup } = tempDb();
  const app = await buildApp({ logger: false });
  const port = await listenPort(app);
  try {
    const host = createHost(db, { name: 'plain-ssh', host: '10.0.0.1', port: 22 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?host_id=${host.id}`);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 5000);
      ws.once('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.equal(code, 1008);
  } finally {
    cleanup();
    await app.close();
  }
});

test('websocket closes with 1013 when the VNC server is not running', async () => {
  const { db, cleanup } = tempDb();
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const deadPort = (server.address() as { port: number }).port;
  const app = await buildApp({ logger: false });
  const port = await listenPort(app);
  try {
    const host = createHost(db, {
      name: 'ws-dead',
      host: '127.0.0.1',
      port: deadPort,
      connection_type: 'vnc',
      vnc_transport: 'direct',
      vnc_auto_start: false,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vnc?host_id=${host.id}`);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 5000);
      ws.once('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assert.equal(code, 1013);
  } finally {
    cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  }
});

test('vnc host round-trips through createHost with sensible defaults', () => {
  const { db, cleanup } = tempDb();
  try {
    const host: Host = createHost(db, { name: 'v', host: '127.0.0.1', connection_type: 'vnc' });
    assert.equal(host.vnc_transport, 'ssh');
    assert.equal(host.vnc_port, 5900);
    assert.equal(host.vnc_auto_start, true);
    assert.equal(host.vnc_auto_stop, false);
    assert.equal(host.vnc_desktop_mode, 'auto');
    assert.equal(host.vnc_implementation, 'auto');
  } finally {
    cleanup();
  }
});
