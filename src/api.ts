import type {
  AppPassword,
  AppPasswordCreated,
  AppSettings,
  AuditLog,
  GroupInput,
  Host,
  HostGroup,
  HostInput,
  KnownHost,
  PortForward,
  PortForwardInput,
  Snippet,
  SnippetInput,
  SyncConfig,
  SyncConfigInput,
  SyncMergeResult,
  Theme,
  ThemeInput,
  VncDiagnostics,
  VncStatus,
} from '@shared/types';

const TOKEN_KEY = 'tfp_api_token';

export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  listHosts: () => request<Host[]>('/api/hosts'),
  createHost: (input: HostInput) => request<Host>('/api/hosts', { method: 'POST', body: json(input) }),
  updateHost: (id: number, input: Partial<HostInput>) =>
    request<Host>(`/api/hosts/${id}`, { method: 'PUT', body: json(input) }),
  deleteHost: (id: number) => request<void>(`/api/hosts/${id}`, { method: 'DELETE' }),

  listGroups: () => request<HostGroup[]>('/api/groups'),
  createGroup: (input: GroupInput) => request<HostGroup>('/api/groups', { method: 'POST', body: json(input) }),
  updateGroup: (id: number, input: Partial<GroupInput>) =>
    request<HostGroup>(`/api/groups/${id}`, { method: 'PUT', body: json(input) }),
  deleteGroup: (id: number) => request<void>(`/api/groups/${id}`, { method: 'DELETE' }),

  generateKey: (opts: { type?: 'ed25519' | 'rsa'; bits?: number; comment?: string } = {}) =>
    request<{ type: string; private: string; public: string; fingerprint: string }>('/api/keys/generate', {
      method: 'POST',
      body: json(opts),
    }),

  listSnippets: (groupId?: number | 'global') =>
    request<Snippet[]>(`/api/snippets${groupId === undefined ? '' : `?group_id=${groupId}`}`),
  createSnippet: (input: SnippetInput) => request<Snippet>('/api/snippets', { method: 'POST', body: json(input) }),
  updateSnippet: (id: number, input: Partial<SnippetInput>) =>
    request<Snippet>(`/api/snippets/${id}`, { method: 'PUT', body: json(input) }),
  deleteSnippet: (id: number) => request<void>(`/api/snippets/${id}`, { method: 'DELETE' }),
  revealSnippet: (id: number) => request<{ id: number; name: string; content: string }>(`/api/snippets/${id}/reveal`),

  listThemes: () => request<Theme[]>('/api/themes'),
  createTheme: (input: ThemeInput) => request<Theme>('/api/themes', { method: 'POST', body: json(input) }),
  updateTheme: (id: number, input: Partial<ThemeInput>) =>
    request<Theme>(`/api/themes/${id}`, { method: 'PUT', body: json(input) }),
  deleteTheme: (id: number) => request<void>(`/api/themes/${id}`, { method: 'DELETE' }),

  listAudit: (limit = 200) => request<AuditLog[]>(`/api/audit?limit=${limit}`),

  listKnownHosts: () => request<KnownHost[]>('/api/known-hosts'),
  deleteKnownHost: (id: number) => request<void>(`/api/known-hosts/${id}`, { method: 'DELETE' }),

  getSettings: () => request<AppSettings>('/api/settings'),
  setSetting: (key: string, value: string) =>
    request<{ key: string; value: string }>(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: json({ value }),
    }),

  listForwards: (hostId?: number) =>
    request<PortForward[]>(`/api/forwards${hostId ? `?hostId=${hostId}` : ''}`),
  createForward: (input: PortForwardInput) =>
    request<PortForward>('/api/forwards', { method: 'POST', body: json(input) }),
  deleteForward: (id: number) => request<void>(`/api/forwards/${id}`, { method: 'DELETE' }),
  startForward: (id: number) => request<{ id: number; active: boolean }>(`/api/forwards/${id}/start`, { method: 'POST' }),
  stopForward: (id: number) => request<{ id: number; active: boolean }>(`/api/forwards/${id}/stop`, { method: 'POST' }),
  forwardStatus: () => request<Record<number, { active: boolean; realPort?: number; kind?: string }>>('/api/forwards/status'),

  getSyncConfig: () => request<SyncConfig>('/api/sync/config'),
  putSyncConfig: (input: SyncConfigInput) =>
    request<SyncConfig>('/api/sync/config', { method: 'PUT', body: json(input) }),
  mergeSync: () => request<SyncMergeResult>('/api/sync/merge', { method: 'POST' }),

  vncStatus: (hostId: number) => request<VncStatus>(`/api/vnc/${hostId}/status`),
  vncDiagnose: (hostId: number) => request<VncDiagnostics>(`/api/vnc/${hostId}/diagnose`, { method: 'POST' }),
  vncEnsure: (hostId: number, start = false) =>
    request<VncStatus>(`/api/vnc/${hostId}/ensure`, { method: 'POST', body: json({ start }) }),
  vncStop: (hostId: number) => request<VncStatus>(`/api/vnc/${hostId}/stop`, { method: 'POST' }),

  listTokens: () => request<AppPassword[]>('/api/tokens'),
  createToken: (input: { name: string; scope?: string }) =>
    request<AppPasswordCreated>('/api/tokens', { method: 'POST', body: json(input) }),
  revokeToken: (id: number) => request<void>(`/api/tokens/${id}`, { method: 'DELETE' }),
  verifyToken: () => request<{ id: number; name: string; scope: string }>('/api/tokens/verify'),
};

/**
 * Ensures a usable API token: verifies the stored one, and on first run
 * creates the bootstrap token (allowed by the server while no token exists).
 */
export async function ensureApiToken(): Promise<boolean> {
  if (getApiToken()) {
    try {
      await api.verifyToken();
      return true;
    } catch {
      setApiToken(null);
    }
  }
  try {
    const created = await api.createToken({ name: 'browser', scope: '*' });
    setApiToken(created.token);
    return true;
  } catch {
    return false;
  }
}
