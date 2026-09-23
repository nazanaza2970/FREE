import { execSync, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// sshd (UsePAM no) requires the login user to exist in /etc/passwd
const OS_USER = os.userInfo().username;

export interface SftpServer {
  port: number;
  user: string;
  home: string;
  privateKey: () => string;
  stop: () => Promise<void>;
  /** Replace the host key and restart sshd (to trigger host key mismatch). */
  rotateHostKey: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.end();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`sshd did not start listening on ${port}`));
        else setTimeout(tick, 50);
      });
    };
    tick();
  });
}

function writeConfig(dir: string, port: number, hostKey: string, home: string): string {
  const cfgPath = path.join(dir, 'sshd_config');
  fs.writeFileSync(
    cfgPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${path.join(dir, 'run', 'sshd.pid')}`,
      'UsePAM no',
      'PasswordAuthentication no',
      'PubkeyAuthentication yes',
      `AuthorizedKeysFile ${path.join(home, '.ssh', 'authorized_keys')}`,
      'StrictModes no',
      'Subsystem sftp /usr/lib/openssh/sftp-server',
      'LogLevel ERROR',
      '',
    ].join('\n'),
  );
  return cfgPath;
}

function spawnSshd(cfgPath: string): ChildProcess {
  const proc = spawn('/usr/sbin/sshd', ['-f', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  proc.unref();
  return proc;
}

// sshd's direct child exits right away; the listener re-setsid()s itself, so the
// spawned pid / process group can't be used. Kill via PidFile + unique config path.
async function killSshd(dir: string, cfgPath: string, port: number): Promise<void> {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'run', 'sshd.pid'), 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
  } catch {
    /* no pidfile / already gone */
  }
  try {
    execSync(`pkill -f 'sshd -f ${cfgPath}'`, { stdio: 'ignore' });
  } catch {
    /* nothing matched */
  }
  // wait for the port to be released
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve(false);
      });
      s.once('error', () => resolve(true));
    });
    if (free) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function startSftpServer(): Promise<SftpServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-sftp-'));
  const etc = path.join(dir, 'etc');
  const run = path.join(dir, 'run');
  const authHome = path.join(dir, 'home', 'user');
  fs.mkdirSync(etc);
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(authHome, '.ssh'), { recursive: true });

  const hostKey = path.join(etc, 'host_ed25519');
  execSync(`ssh-keygen -t ed25519 -N '' -q -f ${hostKey}`);
  const userKey = path.join(dir, 'user_key');
  execSync(`ssh-keygen -t ed25519 -N '' -q -f ${userKey}`);
  fs.copyFileSync(`${userKey}.pub`, path.join(authHome, '.ssh', 'authorized_keys'));

  const port = await freePort();
  const cfgPath = writeConfig(dir, port, hostKey, authHome);

  const proc = spawnSshd(cfgPath);
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });

  try {
    await waitForPort(port, 5000);
  } catch (e) {
    await killSshd(dir, cfgPath, port);
    throw new Error(`sshd failed to start: ${stderr}\n${String(e)}`);
  }

  return {
    port,
    user: OS_USER,
    // sshd chdirs to the real home of the passwd user (UsePAM no), not our temp dir
    home: os.homedir(),
    privateKey: () => fs.readFileSync(userKey, 'utf8'),
    stop: async () => {
      await killSshd(dir, cfgPath, port);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    rotateHostKey: async () => {
      await killSshd(dir, cfgPath, port);
      const newKey = path.join(etc, 'host_ed25519_rotated');
      execSync(`ssh-keygen -t ed25519 -N '' -q -f ${newKey}`);
      const cfg2 = writeConfig(dir, port, newKey, authHome);
      const proc2 = spawnSshd(cfg2);
      proc2.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      await waitForPort(port, 5000);
    },
  };
}
