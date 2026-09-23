import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface MoshLink {
  child: ChildProcess;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: (code: number | null) => void): void;
  write(data: string): void;
  close(): void;
}

function which(bin: string): string | null {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]);
    if (res.status === 0 && res.stdout.length > 0) {
      return res.stdout.toString().trim().split('\n')[0] ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function hasMosh(): boolean {
  return which('mosh-client') !== null && which('mosh-server') !== null;
}

export function startMosh(host: string, port: number, shell?: string): Promise<MoshLink> {
  return new Promise((resolve, reject) => {
    const args = [host, String(port)];
    if (shell) args.push('--', shell);
    const child = spawn('mosh-client', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    let settled = false;
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('spawn', () => {
      settled = true;
      const link: MoshLink = {
        child,
        onData: (cb) => {
          child.stdout?.on('data', cb);
        },
        onClose: (cb) => {
          child.on('close', (code) => cb(code));
          child.on('error', () => cb(null));
        },
        write: (data) => {
          child.stdin?.write(data);
        },
        close: () => {
          try {
            child.kill();
          } catch {
            /* already dead */
          }
        },
      };
      resolve(link);
    });
  });
}
