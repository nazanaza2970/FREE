import type { Host, VncDiagnostics, VncRequirement } from '../../shared/types';

function packageManager(distribution: string | undefined): string | null {
  const name = (distribution ?? '').toLowerCase();
  if (name.includes('debian') || name.includes('ubuntu')) return 'apt';
  if (name.includes('fedora') || name.includes('rhel') || name.includes('centos') || name.includes('rocky') || name.includes('alma')) return 'dnf';
  if (name.includes('arch') || name.includes('manjaro')) return 'pacman';
  if (name.includes('alpine')) return 'apk';
  if (name.includes('suse') || name.includes('opensuse')) return 'zypper';
  return null;
}

export function vncInstallCommands(distribution: string | undefined): string[] {
  switch (packageManager(distribution)) {
    case 'apt':
      return ['apt-get update', 'apt-get install -y tigervnc-standalone-server'];
    case 'dnf':
      return ['dnf install -y tigervnc-server'];
    case 'pacman':
      return ['pacman -S --noconfirm tigervnc'];
    case 'apk':
      return ['apk add tigervnc'];
    case 'zypper':
      return ['zypper install -y tigervnc'];
    default:
      return [];
  }
}

export function x11vncInstallCommands(distribution: string | undefined): string[] {
  switch (packageManager(distribution)) {
    case 'apt':
      return ['apt-get update', 'apt-get install -y x11vnc'];
    case 'dnf':
      return ['dnf install -y x11vnc'];
    case 'pacman':
      return ['pacman -S --noconfirm x11vnc'];
    case 'apk':
      return ['apk add x11vnc'];
    case 'zypper':
      return ['zypper install -y x11vnc'];
    default:
      return [];
  }
}

export function desktopInstallCommands(distribution: string | undefined): string[] {
  switch (packageManager(distribution)) {
    case 'apt':
      return ['apt-get update', 'apt-get install -y xfce4 xfce4-goodies'];
    case 'dnf':
      return ['dnf install -y xorg-x11-server-Xorg xfce4'];
    case 'pacman':
      return ['pacman -S --noconfirm xfce4 xfce4-goodies'];
    case 'apk':
      return ['apk add xfce4'];
    case 'zypper':
      return ['zypper install -y xfce4'];
    default:
      return [];
  }
}

export function resolveImplementation(
  diagnostics: VncDiagnostics | null,
  host: Pick<Host, 'vnc_implementation' | 'vnc_desktop_mode'>,
): 'tigervnc' | 'x11vnc' {
  if (host.vnc_implementation === 'tigervnc') return 'tigervnc';
  if (host.vnc_implementation === 'x11vnc') return 'x11vnc';
  if (host.vnc_desktop_mode === 'virtual') return 'tigervnc';
  if (!diagnostics) return 'tigervnc';
  if (diagnostics.desktop.displayServer === 'x11' && diagnostics.permissions.canAccessDisplay && diagnostics.vnc.hasX11vnc) {
    return 'x11vnc';
  }
  return 'tigervnc';
}

export function getVncRequirements(
  diagnostics: VncDiagnostics | null,
  implementation: 'tigervnc' | 'x11vnc' = 'tigervnc',
): VncRequirement[] {
  if (!diagnostics) {
    return [
      {
        type: 'unsupported_environment',
        severity: 'blocking',
        message: 'Remote diagnostics are unavailable for this VNC transport.',
      },
    ];
  }
  if (diagnostics.vnc.running) return [];
  const requirements: VncRequirement[] = [];

  if (implementation === 'x11vnc') {
    if (!diagnostics.vnc.hasX11vnc) {
      requirements.push({
        type: 'x11vnc_missing',
        severity: 'blocking',
        message: `x11vnc is not installed on ${diagnostics.distribution ?? diagnostics.os}.`,
        installCommands: x11vncInstallCommands(diagnostics.distribution),
      });
    }
    if (
      diagnostics.desktop.displayServer === 'wayland' ||
      (diagnostics.desktop.displays ?? []).length === 0 ||
      !diagnostics.permissions.canAccessDisplay
    ) {
      requirements.push({
        type: 'display_unavailable',
        severity: 'blocking',
        message:
          diagnostics.desktop.displayServer === 'wayland'
            ? 'The remote session is Wayland-based; x11vnc requires an X11 display.'
            : 'No accessible X11 display was found on the remote host.',
      });
    }
    return requirements;
  }

  if (!diagnostics.vnc.installed) {
    requirements.push({
      type: 'vnc_server_missing',
      severity: 'blocking',
      message: `No VNC server is installed on ${diagnostics.distribution ?? diagnostics.os}.`,
      installCommands: vncInstallCommands(diagnostics.distribution),
    });
  }
  if (!diagnostics.desktop.installed) {
    requirements.push({
      type: 'desktop_missing',
      severity: 'blocking',
      message: 'No desktop environment is installed on the remote host.',
      installCommands: desktopInstallCommands(diagnostics.distribution),
    });
  }
  if (
    diagnostics.vnc.installed &&
    diagnostics.desktop.installed &&
    diagnostics.desktop.displayServer === 'wayland'
  ) {
    requirements.push({
      type: 'display_unavailable',
      severity: 'blocking',
      message: 'The remote session is Wayland-based; an X server display is required for VNC.',
    });
  }
  if (diagnostics.vnc.installed && !diagnostics.permissions.canStartVnc) {
    requirements.push({
      type: 'permission_denied',
      severity: 'blocking',
      message: 'The connected user does not have permission to start a VNC server.',
    });
  }
  return requirements;
}
