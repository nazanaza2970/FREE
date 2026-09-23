export type AuthMethod = 'password' | 'key';

export type ConnectionType = 'ssh' | 'telnet' | 'mosh' | 'vnc';

export type VncTransport = 'ssh' | 'direct';
export type VncDesktopMode = 'auto' | 'virtual';
export type VncImplementation = 'auto' | 'tigervnc';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface HostGroup {
  id: number;
  name: string;
  parent_id: number | null;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Host {
  id: number;
  group_id: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  connection_type: ConnectionType;
  agent_forward: boolean;
  auth_method: AuthMethod;
  password: string | null;
  private_key: string | null;
  pass_phrase: string | null;
  remote_command: string | null;
  keepalive: number;
  color: string;
  favorite: boolean;
  notes: string;
  /** VNC transport: 'ssh' (tunneled) or 'direct'. Null for non-VNC hosts. */
  vnc_transport: VncTransport | null;
  /** Remote VNC port (default 5900). Null for non-VNC hosts; ignored for direct transport. */
  vnc_port: number | null;
  /** VNC auth password (plaintext over the API; encrypted at rest). */
  vnc_password: string | null;
  /** Saved SSH connection used as the VNC tunnel, when not entering inline creds. */
  vnc_ssh_host_id: number | null;
  /** Remote display number; null = auto. */
  vnc_display: number | null;
  vnc_desktop_mode: VncDesktopMode | null;
  vnc_auto_start: boolean;
  vnc_auto_stop: boolean;
  vnc_implementation: VncImplementation | null;
  created_at: string;
  updated_at: string;
}

export interface Snippet {
  id: number;
  name: string;
  content: string;
  tags: string;
  favorite: boolean;
  group_id: number | null;
  protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface Theme {
  id: number;
  name: string;
  colors: Record<string, string>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnownHost {
  id: number;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  action: string;
  host_id: number | null;
  detail: string;
  created_at: string;
}

export interface PortForward {
  id: number;
  host_id: number;
  local_port: number;
  remote_host: string;
  remote_port: number;
  protocol: string;
  auto_start: boolean;
  created_at: string;
  updated_at: string;
}

export type TokenScope = string;

export interface AppPassword {
  id: number;
  name: string;
  scope: TokenScope;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface AppPasswordInput {
  name: string;
  scope?: TokenScope;
}

export interface AppPasswordCreated extends AppPassword {
  token: string;
}

export interface HostInput {
  name: string;
  host: string;
  port?: number;
  username?: string;
  connection_type?: ConnectionType;
  agent_forward?: boolean;
  auth_method?: AuthMethod;
  password?: string | null;
  private_key?: string | null;
  pass_phrase?: string | null;
  remote_command?: string | null;
  keepalive?: number;
  color?: string;
  favorite?: boolean;
  notes?: string;
  group_id?: number | null;
  vnc_transport?: VncTransport;
  vnc_port?: number | null;
  vnc_password?: string | null;
  vnc_ssh_host_id?: number | null;
  vnc_display?: number | null;
  vnc_desktop_mode?: VncDesktopMode;
  vnc_auto_start?: boolean;
  vnc_auto_stop?: boolean;
  vnc_implementation?: VncImplementation;
}

export interface GroupInput {
  name: string;
  parent_id?: number | null;
  color?: string;
}

export interface SnippetInput {
  name: string;
  content: string;
  tags?: string;
  favorite?: boolean;
  group_id?: number | null;
  protected?: boolean;
}

export interface ThemeInput {
  name: string;
  colors?: Record<string, string>;
  is_default?: boolean;
}

export interface PortForwardInput {
  host_id: number;
  local_port: number;
  remote_host?: string;
  remote_port: number;
  protocol?: string;
  auto_start?: boolean;
}

export interface AppSettings {
  [key: string]: string;
}

// ---- sync ----

export type SyncEntityType = 'host' | 'group' | 'snippet' | 'theme' | 'setting';

export interface SyncEntity {
  type: SyncEntityType;
  id: number | string;
  /** Full entity payload, or null when deleted (tombstone). */
  payload: unknown;
  /** UTC epoch millis of the last local write (LWW ordering key). */
  updated_at_ms: number;
  deleted: boolean;
  /** Server-side version; present on state snapshots, incremented per accepted write. */
  rev?: number;
}

export interface SyncState {
  entities: SyncEntity[];
  server_time: string;
}

export interface SyncDevice {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export interface SyncMergeStats {
  pushed: number;
  pulled: number;
  deviceId: string;
  serverTime: string;
}

export interface SyncMergeResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  pending: number;
  deviceId: string;
  serverTime?: string;
  error?: string;
}

// ---- vnc ----

export type VncRequirement =
  | { type: 'vnc_server_missing'; severity: 'blocking'; message: string; installCommands?: string[] }
  | { type: 'desktop_missing'; severity: 'blocking'; message: string; installCommands?: string[] }
  | { type: 'display_unavailable'; severity: 'blocking'; message: string }
  | { type: 'permission_denied'; severity: 'blocking'; message: string }
  | { type: 'unsupported_environment'; severity: 'blocking'; message: string };

export interface VncDiagnostics {
  os: string;
  distribution?: string;
  architecture?: string;
  vnc: {
    installed: boolean;
    running: boolean;
    implementation?: 'tigervnc' | 'x11vnc' | 'unknown';
    port?: number;
    display?: number;
  };
  desktop: {
    installed: boolean;
    environment?: 'xfce' | 'gnome' | 'kde' | 'mate' | 'other';
    displayServer?: 'x11' | 'wayland' | 'unknown';
  };
  permissions: {
    canStartVnc: boolean;
    canAccessDisplay: boolean;
  };
  requirements: VncRequirement[];
}

export interface VncStatus {
  host_id: number;
  transport: VncTransport;
  port: number;
  running: boolean;
  started: boolean;
  implementation: VncImplementation | null;
  display: number | null;
  managed: boolean;
  requirements: VncRequirement[];
}

export interface SyncConfigInput {
  enabled?: boolean;
  server_url?: string;
  device_name?: string;
  token?: string;
}

export interface SyncConfig extends SyncConfigInput {
  enabled: boolean;
  server_url: string;
  device_name: string;
  device_id: string;
  token: string;
  last_sync_at: string | null;
  last_error: string | null;
  last_stats: SyncMergeStats | null;
  pending: number;
}
