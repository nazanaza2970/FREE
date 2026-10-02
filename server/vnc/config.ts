import type Database from '../sqlite';
import { getHost } from '../db';
import type { Host, VncDesktopMode, VncImplementation, VncTransport } from '../../shared/types';

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  hostRow: Host;
}

export interface ResolvedVncConfig {
  transport: VncTransport;
  ssh: SshEndpoint | null;
  vncHost: string;
  vncPort: number;
  vncPassword: string | null;
  autoStart: boolean;
  autoStop: boolean;
  desktopMode: VncDesktopMode;
  implementation: VncImplementation;
  display: number | null;
}

export function resolveVncConfig(database: Database.Database, host: Host): ResolvedVncConfig {
  const transport: VncTransport = host.vnc_transport === 'direct' ? 'direct' : 'ssh';
  let ssh: SshEndpoint | null = null;
  if (transport === 'ssh') {
    let sshRow: Host = host;
    if (host.vnc_ssh_host_id) {
      const ref = getHost(database, host.vnc_ssh_host_id);
      if (ref) sshRow = ref;
    }
    ssh = {
      host: sshRow.host,
      port: sshRow.port,
      username: sshRow.username,
      hostRow: sshRow,
    };
  }
  const vncPort = transport === 'ssh' ? host.vnc_port ?? 5900 : host.port;
  return {
    transport,
    ssh,
    vncHost: transport === 'ssh' ? '127.0.0.1' : host.host,
    vncPort,
    vncPassword: host.vnc_password,
    autoStart: host.vnc_auto_start,
    autoStop: host.vnc_auto_stop,
    desktopMode: host.vnc_desktop_mode ?? 'auto',
    implementation: host.vnc_implementation ?? 'auto',
    display: host.vnc_display,
  };
}
