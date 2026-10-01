import { addAudit, getDb, getHost } from '../db';
import type { VncRequirement } from '../../shared/types';
import { resolveVncConfig } from './config';
import { openVncStream } from './transport';
import { probeVnc } from './probe';
import { diagnoseVncEnvironment } from './diagnostics';
import { getVncRequirements, resolveImplementation } from './requirements';
import { startExistingDesktop, startVirtualDesktop, stopExistingDesktop, stopVirtualDesktop } from './lifecycle';

export interface ManagedSession {
  hostId: number;
  port: number;
  display: number | null;
  pid: number | null;
  managed: boolean;
  implementation: 'tigervnc' | 'x11vnc';
  active: number;
}

export interface EnsureResult {
  session: ManagedSession | null;
  requirements: VncRequirement[];
}

const sessions = new Map<number, ManagedSession>();
const starting = new Map<number, Promise<EnsureResult>>();

export function getSession(hostId: number): ManagedSession | undefined {
  return sessions.get(hostId);
}

export function enterSession(hostId: number): void {
  const session = sessions.get(hostId);
  if (session) session.active += 1;
}

export function leaveSession(hostId: number): boolean {
  const session = sessions.get(hostId);
  if (!session) return false;
  session.active = Math.max(0, session.active - 1);
  return session.active === 0;
}

function findFreeDisplay(hostId: number): number {
  const taken = new Set([...sessions.values()].map((s) => s.display));
  void hostId;
  for (let display = 1; display <= 20; display++) {
    if (!taken.has(display)) return display;
  }
  throw new Error('no free VNC display available (tried :1-:20)');
}

export async function ensureSession(hostId: number, opts: { start?: boolean } = {}): Promise<EnsureResult> {
  const existing = sessions.get(hostId);
  if (existing) return { session: existing, requirements: [] };
  const pending = starting.get(hostId);
  if (pending) return pending;

  const task = (async (): Promise<EnsureResult> => {
    const database = getDb();
    const host = getHost(database, hostId);
    if (!host) throw new Error('host not found');
    const cfg = resolveVncConfig(database, host);

    const probe = await probeVnc(() => openVncStream(database, host), 4000);
    if (probe.running) {
      const session: ManagedSession = {
        hostId,
        port: cfg.vncPort,
        display: null,
        pid: null,
        managed: false,
        implementation: 'tigervnc',
        active: 0,
      };
      sessions.set(hostId, session);
      return { session, requirements: [] };
    }

    const diagnostics = cfg.ssh ? await diagnoseVncEnvironment(database, host).catch(() => null) : null;
    const implementation = resolveImplementation(diagnostics, host);
    const requirements = getVncRequirements(diagnostics, implementation);
    if (!host.vnc_auto_start && opts.start !== true) {
      return { session: null, requirements };
    }
    if (requirements.length > 0) {
      return { session: null, requirements };
    }

    let started;
    let display: number;
    if (implementation === 'x11vnc') {
      const detected = diagnostics?.desktop.display?.replace(/^:/, '');
      const candidate = detected !== undefined && /^\d+$/.test(detected) ? Number(detected) : (diagnostics?.desktop.displays?.[0] ?? 0);
      display = candidate;
      started = await startExistingDesktop(database, host, { port: cfg.vncPort, display });
    } else {
      display = host.vnc_display ?? findFreeDisplay(hostId);
      started = await startVirtualDesktop(database, host, { port: cfg.vncPort, display });
    }
    const session: ManagedSession = {
      hostId,
      port: cfg.vncPort,
      display: started.display,
      pid: started.pid,
      managed: true,
      implementation,
      active: 0,
    };
    sessions.set(hostId, session);
    addAudit(
      database,
      implementation === 'x11vnc' ? 'vnc.x11vnc.started' : 'vnc.started',
      hostId,
      `display :${started.display} pid=${started.pid ?? 'unknown'} port=${started.port}`,
    );
    return { session, requirements: [] };
  })();

  starting.set(hostId, task);
  try {
    return await task;
  } finally {
    starting.delete(hostId);
  }
}

export async function stopSession(hostId: number): Promise<void> {
  const session = sessions.get(hostId);
  if (!session) return;
  if (session.managed) {
    const database = getDb();
    const host = getHost(database, hostId);
    if (host) {
      const stop =
        session.implementation === 'x11vnc'
          ? stopExistingDesktop(database, host, session.pid)
          : stopVirtualDesktop(database, host, session.display ?? 0);
      await stop.catch(() => undefined);
    }
    addAudit(database, 'vnc.stopped', hostId, `display :${session.display ?? 'unknown'}`);
  }
  sessions.delete(hostId);
}
