import type Database from 'better-sqlite3';
import type { Host } from '../../shared/types';
import { resolveVncConfig } from './config';
import { execRemote } from './ssh';
import { openVncStream } from './transport';
import { probeVnc } from './probe';

export interface ManagedVnc {
  display: number;
  pid: number | null;
  port: number;
}

export async function startVirtualDesktop(
  database: Database.Database,
  host: Host,
  opts: { port: number; display: number },
): Promise<ManagedVnc> {
  const cfg = resolveVncConfig(database, host);
  if (!cfg.ssh) throw new Error('virtual desktop startup requires an SSH transport');
  const { display, port } = opts;
  const command = [
    `vncserver -kill :${display} 2>/dev/null || true`,
    `nohup vncserver :${display} -rfbport ${port} -localhost -SecurityTypes None -Geometry 1280x800 -Depth 24 >/tmp/termius-free-vnc-${display}.log 2>&1 & echo $!`,
  ].join('; ');
  const { code, stdout, stderr } = await execRemote(cfg.ssh, command, 30000);
  if (code !== 0) {
    throw new Error(stderr.trim() || `vncserver exited with code ${code}`);
  }
  const pidLine = stdout.trim().split('\n').pop() ?? '';
  const pid = Number(pidLine);

  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = await probeVnc(() => openVncStream(database, host, port), 1500);
    if (probe.running) {
      return { display, pid: Number.isInteger(pid) && pid > 0 ? pid : null, port };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vncserver started on display :${display} but port ${port} never began listening`);
}

export async function stopVirtualDesktop(
  database: Database.Database,
  host: Host,
  display: number,
): Promise<void> {
  const cfg = resolveVncConfig(database, host);
  if (!cfg.ssh) return;
  await execRemote(cfg.ssh, `vncserver -kill :${display} 2>/dev/null || true`, 15000);
}
