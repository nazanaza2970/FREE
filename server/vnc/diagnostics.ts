import type Database from '../sqlite';
import type { Host, VncDiagnostics } from '../../shared/types';
import { resolveVncConfig } from './config';
import { execRemote } from './ssh';

const SCRIPT = [
  'echo "==os=="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s',
  'echo "==arch=="; uname -m 2>/dev/null',
  'echo "==bins=="; for b in vncserver vncsession xvnc4server Xvnc x11vnc; do command -v "$b" 2>/dev/null; done',
  'echo "==version=="; (vncserver -version 2>&1 || xvnc4server --help 2>&1 | head -1 || x11vnc -version 2>&1 | head -1) | head -2',
  'echo "==listen=="; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk \'NR>1 {split($4, a, ":"); print a[length(a)]}\' | grep -E "^59[0-9][0-9]$\' | sort -u',
  'echo "==processes=="; ps -eo args 2>/dev/null | grep -E "Xvnc|tigervnc" | grep -v grep | head -5',
  'echo "==xsessions=="; ls /usr/share/xsessions 2>/dev/null',
  'echo "==sessiontype=="; loginctl show-session "$(loginctl 2>/dev/null | awk \'NR==2 {print $1}\')" -p Type 2>/dev/null',
  'echo "==display=="; echo "${DISPLAY:-}"',
  'echo "==xdisplays=="; ls /tmp/.X11-unix 2>/dev/null | sed \'s/^X//\'',
  'echo "==uid=="; id -u 2>/dev/null',
].join('\n');

function section(output: string, name: string): string {
  const marker = `==${name}==`;
  const start = output.indexOf(marker);
  if (start === -1) return '';
  const rest = output.slice(start + marker.length);
  const next = rest.search(/\n==[a-z]+==/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function parseDiagnostics(output: string, expectedPort: number): VncDiagnostics {
  const distro = section(output, 'os').split('\n')[0]?.trim() || undefined;
  const architecture = section(output, 'arch').split('\n')[0]?.trim() || undefined;
  const bins = section(output, 'bins')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const versionText = section(output, 'version');
  const listeningPorts = section(output, 'listen')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n >= 5900 && n <= 5999);
  const processes = section(output, 'processes').split('\n').filter(Boolean);
  const xsessions = section(output, 'xsessions')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const sessionType = section(output, 'sessiontype');
  const xdisplay = section(output, 'display').split('\n')[0]?.trim() || undefined;
  const displays = section(output, 'xdisplays')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  const uid = Number(section(output, 'uid').split('\n')[0]);

  const binNames = bins.map((b) => b.split('/').pop() ?? b);
  let implementation: 'tigervnc' | 'x11vnc' | 'unknown' | undefined;
  if (/TigerVNC/i.test(versionText) || (binNames.includes('vncserver') && !binNames.includes('x11vnc'))) {
    implementation = 'tigervnc';
  } else if (/x11vnc/i.test(versionText) || binNames.includes('x11vnc')) {
    implementation = 'x11vnc';
  }

  let display: number | undefined;
  for (const line of processes) {
    const match = line.match(/:\d+/);
    if (match) {
      display = Number(match[0].slice(1));
      break;
    }
  }

  let environment: VncDiagnostics['desktop']['environment'];
  if (xsessions.length > 0) {
    if (xsessions.some((f) => f.startsWith('xfce'))) environment = 'xfce';
    else if (xsessions.some((f) => f.includes('gnome'))) environment = 'gnome';
    else if (xsessions.some((f) => f.includes('plasma'))) environment = 'kde';
    else if (xsessions.some((f) => f.includes('mate'))) environment = 'mate';
    else environment = 'other';
  }

  const displayServer: 'x11' | 'wayland' | 'unknown' = /Type=wayland/i.test(sessionType)
    ? 'wayland'
    : /Type=x11/i.test(sessionType)
      ? 'x11'
      : 'unknown';

  const displayNumber = xdisplay && /^\d+$/.test(xdisplay.replace(/^:/, ''))
    ? Number(xdisplay.replace(/^:/, ''))
    : undefined;
  const canAccessDisplay =
    displays.length > 0 && (uid === 0 || (displayNumber !== undefined && displays.includes(displayNumber)));

  return {
    os: distro ?? 'unknown',
    distribution: distro,
    architecture,
    vnc: {
      installed: bins.length > 0,
      running: listeningPorts.includes(expectedPort) || processes.length > 0,
      implementation,
      hasX11vnc: binNames.includes('x11vnc'),
      port: listeningPorts.includes(expectedPort) ? expectedPort : listeningPorts[0],
      display,
    },
    desktop: {
      installed: xsessions.length > 0,
      environment,
      displayServer,
      display: xdisplay,
      displays,
    },
    permissions: {
      canStartVnc: Number.isInteger(uid) && (uid === 0 || bins.length > 0),
      canAccessDisplay,
    },
    requirements: [],
  };
}

export async function diagnoseVncEnvironment(
  database: Database.Database,
  host: Host,
): Promise<VncDiagnostics | null> {
  const cfg = resolveVncConfig(database, host);
  if (!cfg.ssh) return null;
  const { stdout } = await execRemote(cfg.ssh, SCRIPT, 30000);
  return parseDiagnostics(stdout, cfg.vncPort);
}
