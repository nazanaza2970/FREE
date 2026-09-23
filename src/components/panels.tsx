import { useEffect, useRef, useState } from 'react';
import type { AuditLog, HostGroup, PortForward, Snippet, SyncConfig, SyncMergeResult, Theme } from '@shared/types';
import { extractVariables } from '@shared/snippets';
import { DEFAULT_COLORS, exportThemesJson, parseThemesImport } from '@shared/theme';
import type { ClipboardEntry } from '@shared/shortcuts';
import { parseCombo } from '@shared/shortcuts';
import { api } from '../api';
import type { KeyMapping, TermSettings } from '../termSettings';
import {
  loadClipboardHistory,
  loadKeymap,
  saveClipboardHistory,
  saveKeymap,
  saveTermSettings,
} from '../termSettings';

export function SnippetsPanel({ groups = [] }: { groups?: HostGroup[] }) {
  const [items, setItems] = useState<Snippet[]>([]);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [groupId, setGroupId] = useState<number | ''>('');
  const [protectedFlag, setProtectedFlag] = useState(false);
  const [revealed, setRevealed] = useState<Record<number, string>>({});

  const load = () => api.listSnippets().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!name || !content) return;
    await api.createSnippet({
      name,
      content,
      tags,
      group_id: groupId === '' ? null : groupId,
      protected: protectedFlag,
    });
    setName('');
    setContent('');
    setTags('');
    setGroupId('');
    setProtectedFlag(false);
    setRevealed({});
    load();
  };

  const reveal = async (s: Snippet) => {
    try {
      const r = await api.revealSnippet(s.id);
      setRevealed((prev) => ({ ...prev, [s.id]: r.content }));
    } catch {
      /* keep masked */
    }
  };

  const vars = extractVariables(content);

  return (
    <div className="panel">
      <h3>Snippets</h3>
      <p className="hint">
        Reusable commands and text blocks. Use <span className="mono">{'{{var}}'}</span> placeholders — you will be
        prompted for values when inserting. Protected snippets are encrypted with AES-256-GCM at rest.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Snippet name" />
        <select value={groupId} onChange={(e) => setGroupId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">Global (no group)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <textarea
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={'Command or text, e.g. echo {{user}} logged in'}
          style={{ gridColumn: '1 / -1' }}
        />
        {vars.length > 0 ? (
          <div className="dim" style={{ fontSize: 11, gridColumn: '1 / -1' }}>
            variables: {vars.map((v) => `{{${v}}}`).join('  ')}
          </div>
        ) : null}
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags (comma separated)" />
        <label style={{ fontSize: 12, alignSelf: 'center' }}>
          <input type="checkbox" checked={protectedFlag} onChange={(e) => setProtectedFlag(e.target.checked)} />{' '}
          protected (AES-GCM)
        </label>
        <div>
          <button className="primary" onClick={add}>
            Add snippet
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty">No snippets yet.</div>
      ) : (
        items.map((s) => (
          <div className="list-row" key={s.id}>
            <div className="info">
              <div className="title">
                {s.favorite ? '★ ' : ''}
                {s.protected ? '🔒 ' : ''}
                {s.name}
              </div>
              <div className="dim" style={{ fontSize: 11 }}>
                {s.group_id ? (groups.find((g) => g.id === s.group_id)?.name ?? `group ${s.group_id}`) : 'global'}
                {s.tags ? ` · ${s.tags}` : ''}
              </div>
              <pre className="snippet-pre">{s.protected ? (revealed[s.id] ?? '•••••• (protected)') : s.content}</pre>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {s.protected ? (
                <button className="ghost" title="Reveal content" onClick={() => void reveal(s)}>
                  👁
                </button>
              ) : null}
              <button className="ghost" onClick={() => api.deleteSnippet(s.id).then(load)}>
                ✕
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function ThemesPanel({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<Theme[]>([]);
  const [editing, setEditing] = useState<Theme | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColors, setDraftColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.listThemes().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
  }, []);

  const download = (filename: string, text: string) => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAll = () => download('themes.json', exportThemesJson(items.map((t) => ({ name: t.name, colors: t.colors }))));

  const importFile = async (file: File) => {
    const text = await file.text();
    try {
      const themes = parseThemesImport(text);
      for (const t of themes) {
        await api.createTheme({ name: t.name, colors: t.colors });
      }
      setError(null);
      load();
    } catch (e) {
      setError(`import failed: ${(e as Error).message}`);
    }
  };

  const startEdit = (t: Theme) => {
    setEditing(t);
    setDraftName(t.name);
    setDraftColors({ ...DEFAULT_COLORS, ...t.colors });
  };

  const startNew = () => {
    const t: Theme = { id: 0, name: 'New theme', colors: { ...DEFAULT_COLORS }, is_default: false, created_at: '', updated_at: '' };
    startEdit(t);
  };

  const save = async () => {
    if (!editing || !draftName) return;
    if (editing.id === 0) {
      const created = await api.createTheme({ name: draftName, colors: draftColors });
      setEditing(created);
      setDraftName(created.name);
    } else {
      const updated = await api.updateTheme(editing.id, { name: draftName, colors: draftColors });
      setEditing(updated);
      setDraftName(updated.name);
      setDraftColors({ ...DEFAULT_COLORS, ...updated.colors });
    }
    load();
    onChanged?.();
  };

  const setDefault = async (t: Theme) => {
    if (!t.is_default) await api.updateTheme(t.id, { is_default: true });
    load();
    onChanged?.();
  };

  const remove = async (t: Theme) => {
    await api.deleteTheme(t.id);
    if (editing?.id === t.id) setEditing(null);
    load();
  };

  return (
    <div className="panel">
      <h3>Themes</h3>
      <p className="hint">Terminal colors map to xterm.js. The accent color themes the app UI. Import/export uses JSON.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="primary" onClick={startNew}>
          New theme
        </button>
        <button onClick={() => fileRef.current?.click()}>Import JSON</button>
        <button onClick={exportAll}>Export all</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
        {error ? <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>{error}</span> : null}
      </div>

      {items.length === 0 ? (
        <div className="empty">No themes yet.</div>
      ) : (
        items.map((t) => (
          <div className="list-row" key={t.id}>
            <div className="info">
              <div className="title">
                {t.name} {t.is_default ? <span className="badge">default</span> : null}
              </div>
              <div className="sub" style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                {(['background', 'foreground', 'cursor', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const).map((k) => (
                  <span
                    key={k}
                    title={k}
                    style={{ width: 16, height: 16, borderRadius: 4, background: t.colors[k], display: 'inline-block', border: '1px solid var(--border)' }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {!t.is_default ? (
                <button className="ghost" title="Set as default" onClick={() => void setDefault(t)}>
                  ★
                </button>
              ) : null}
              <button className="ghost" title="Edit" onClick={() => startEdit(t)}>
                ✎
              </button>
              <button
                className="ghost"
                title="Export"
                onClick={() => download(`${t.name}.json`, exportThemesJson([{ name: t.name, colors: t.colors }]))}
              >
                ⇩
              </button>
              <button className="ghost" onClick={() => void remove(t)}>
                ✕
              </button>
            </div>
          </div>
        ))
      )}

      {editing ? (
        <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <h3>Theme editor</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Theme name" />
            <button className="primary" style={{ justifyContent: 'center' }} onClick={() => void save()}>
              Save
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 6,
              marginBottom: 12,
            }}
          >
            {['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'accent'].map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="color"
                  value={draftColors[k] ?? '#000000'}
                  onChange={(e) => setDraftColors((prev) => ({ ...prev, [k]: e.target.value }))}
                />
                <span className="dim">{k}</span>
              </label>
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 6,
              marginBottom: 12,
            }}
          >
            {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen',
              'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="color"
                  value={draftColors[k] ?? '#000000'}
                  onChange={(e) => setDraftColors((prev) => ({ ...prev, [k]: e.target.value }))}
                />
                <span className="dim">{k}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
            <button className="ghost" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AuditPanel() {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [live, setLive] = useState(false);

  const load = () => api.listAudit(100).then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
    const es = new EventSource('/api/audit/stream');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (event) => {
      try {
        const record = JSON.parse(String(event.data)) as AuditLog;
        setItems((prev) => [record, ...prev].slice(0, 100));
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, []);

  const exportJsonl = () => {
    const a = document.createElement('a');
    a.href = '/api/audit/export?limit=1000';
    a.download = 'free-audit.log';
    a.click();
  };

  return (
    <div className="panel">
      <h3>
        Audit log{' '}
        <span style={{ fontSize: 11, color: live ? 'var(--ok, #3fb950)' : 'var(--text-dim)' }}>
          {live ? '● live' : '○ offline'}
        </span>
      </h3>
      <p className="hint">Recent sessions and events, streamed in real time.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="ghost" onClick={load}>
          Refresh
        </button>
        <button className="ghost" onClick={exportJsonl}>
          Export JSONL
        </button>
      </div>
      <div>
        {items.length === 0 ? (
          <div className="empty">No events recorded yet.</div>
        ) : (
          items.map((a) => (
            <div className="list-row" key={a.id}>
              <div className="info">
                <div className="title">
                  {a.action}
                  {a.host_id ? <span className="badge">host #{a.host_id}</span> : null}
                </div>
                <div className="sub">
                  {a.detail} · {a.created_at}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function PortForwardingPanel({ hostId }: { hostId: number | null }) {
  const [items, setItems] = useState<PortForward[]>([]);
  const [status, setStatus] = useState<Record<number, { active: boolean; realPort?: number; kind?: string }>>({});
  const [localPort, setLocalPort] = useState(8080);
  const [remoteHost, setRemoteHost] = useState('127.0.0.1');
  const [remotePort, setRemotePort] = useState(80);
  const [protocol, setProtocol] = useState('local');
  const [autoStart, setAutoStart] = useState(false);

  const load = () => {
    api.listForwards(hostId ?? undefined).then(setItems).catch(() => setItems([]));
    api.forwardStatus().then(setStatus).catch(() => setStatus({}));
  };
  useEffect(() => {
    load();
  }, [hostId]);

  const add = async () => {
    if (!hostId) return;
    await api.createForward({
      host_id: hostId,
      local_port: localPort,
      remote_host: remoteHost,
      remote_port: remotePort,
      protocol,
      auto_start: autoStart,
    });
    load();
  };

  const toggle = async (f: PortForward) => {
    if (status[f.id]?.active) await api.stopForward(f.id);
    else await api.startForward(f.id);
    load();
  };

  return (
    <div className="panel">
      <h3>Port forwarding</h3>
      <p className="hint">
        {hostId ? `Local / remote / SOCKS5 tunnels for host #${hostId}.` : 'Select a host to manage forwards.'}
      </p>
      {hostId ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option value="local">local</option>
            <option value="remote">remote</option>
            <option value="socks">socks5</option>
          </select>
          <input type="number" value={localPort} onChange={(e) => setLocalPort(Number(e.target.value))} placeholder="Bind port" />
          <span>→</span>
          <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="Dest host" style={{ width: 110 }} />
          <input type="number" value={remotePort} onChange={(e) => setRemotePort(Number(e.target.value))} placeholder="Dest port" />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} /> auto
          </label>
          <button className="primary" onClick={add}>
            Add
          </button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="empty">No port forwards.</div>
      ) : (
        items.map((f) => {
          const st = status[f.id];
          const label =
            f.protocol === 'remote'
              ? `remote :${st?.realPort ?? f.local_port} → ${f.remote_host}:${f.remote_port}`
              : f.protocol === 'socks'
                ? `socks5 :${f.local_port} → any`
                : `localhost:${f.local_port} → ${f.remote_host}:${f.remote_port}`;
          return (
            <div className="list-row" key={f.id}>
              <div className="info">
                <div className="title">
                  {label}
                </div>
                <div className="sub">
                  {f.protocol} · {st?.active ? 'active' : 'stopped'} · {f.auto_start ? 'auto-start' : 'manual'}
                </div>
              </div>
              <button className="ghost" onClick={() => toggle(f)}>
                {st?.active ? 'Stop' : 'Start'}
              </button>
              <button className="ghost" onClick={() => api.deleteForward(f.id).then(load)}>
                ✕
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

export { default as SftpPanel } from './SftpBrowser';

export function SettingsPanel({
  termSettings,
  onTermSettingsChange,
}: {
  termSettings: TermSettings;
  onTermSettingsChange: (s: TermSettings) => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [keymap, setKeymap] = useState<KeyMapping[]>([]);
  const [combo, setCombo] = useState('');
  const [payload, setPayload] = useState('');
  const [label, setLabel] = useState('');
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);

  const load = () => {
    setKeymap(loadKeymap());
    setClipboard(loadClipboardHistory());
  };
  useEffect(() => {
    load();
  }, []);

  const addSetting = async () => {
    if (!key) return;
    await api.setSetting(key, value);
    setKey('');
    setValue('');
  };

  const changeTerm = (patch: Partial<TermSettings>) => {
    const next = { ...termSettings, ...patch };
    saveTermSettings(next);
    onTermSettingsChange(next);
  };

  const addMapping = () => {
    if (!combo) return;
    try {
      parseCombo(combo);
    } catch (e) {
      alert((e as Error).message);
      return;
    }
    const next = [
      ...keymap,
      {
        id: String(Date.now()),
        combo,
        label: label || combo,
        payload: payload === '' ? combo : payload,
      },
    ];
    setKeymap(next);
    saveKeymap(next);
    setCombo('');
    setPayload('');
    setLabel('');
  };

  const removeMapping = (id: string) => {
    const next = keymap.filter((m) => m.id !== id);
    setKeymap(next);
    saveKeymap(next);
  };

  const copyEntry = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  const clearClipboard = () => {
    saveClipboardHistory([]);
    setClipboard([]);
  };

  return (
    <div className="panel">
      <h3>Settings</h3>

      <h3 style={{ marginTop: 8 }}>Terminal</h3>
      <p className="hint">Fonts, cursor and scrollback. Applied live to open terminals.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
        <input
          value={termSettings.fontFamily}
          onChange={(e) => changeTerm({ fontFamily: e.target.value })}
          placeholder="Font family"
        />
        <input
          type="number"
          min={8}
          max={32}
          value={termSettings.fontSize}
          onChange={(e) => changeTerm({ fontSize: Number(e.target.value) || 13 })}
          title="Font size"
        />
        <select
          value={termSettings.cursorStyle}
          onChange={(e) => changeTerm({ cursorStyle: e.target.value as TermSettings['cursorStyle'] })}
          title="Cursor style"
        >
          <option value="block">block cursor</option>
          <option value="underline">underline cursor</option>
          <option value="bar">bar cursor</option>
        </select>
        <input
          type="number"
          min={100}
          max={50000}
          step={100}
          value={termSettings.scrollback}
          onChange={(e) => changeTerm({ scrollback: Number(e.target.value) || 5000 })}
          title="Scrollback lines"
        />
      </div>
      <label style={{ fontSize: 12, marginBottom: 16, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={termSettings.cursorBlink}
          onChange={(e) => changeTerm({ cursorBlink: e.target.checked })}
        />
        blinking cursor
      </label>

      <h3>Key mappings</h3>
      <p className="hint">
        Send raw payloads to the active terminal. Payloads support escapes: <span className="mono">{'\\n \\t \\e \\c-a'}</span>{' '}
        (e.g. <span className="mono">{'\\c-c'}</span> for Ctrl+C).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr auto', gap: 8, marginBottom: 12 }}>
        <input value={combo} onChange={(e) => setCombo(e.target.value)} placeholder="ctrl+shift+x" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional)" />
        <input value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="payload (defaults to combo)" />
        <button className="primary" onClick={addMapping}>
          Add
        </button>
      </div>
      {keymap.length === 0 ? (
        <div className="empty">No key mappings. Example: combo "ctrl+shift+l", payload "\ec" sends Ctrl+C.</div>
      ) : (
        keymap.map((m) => (
          <div className="list-row" key={m.id}>
            <div className="info">
              <div className="title">{m.label}</div>
              <div className="sub">
                <span className="mono">{m.combo}</span> → <span className="mono">{JSON.stringify(m.payload)}</span>
              </div>
            </div>
            <button className="ghost" onClick={() => removeMapping(m.id)}>
              ✕
            </button>
          </div>
        ))
      )}

      <h3 style={{ marginTop: 16 }}>Clipboard history</h3>
      <p className="hint">The last 20 copies made in this browser.</p>
      {clipboard.length === 0 ? (
        <div className="empty">Nothing copied yet.</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            <button className="ghost" onClick={clearClipboard}>
              Clear history
            </button>
          </div>
          {clipboard.map((c, i) => (
            <div className="list-row" key={`${c.at}-${i}`}>
              <div className="info">
                <pre className="snippet-pre" style={{ whiteSpace: 'pre-wrap' }}>
                  {c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text}
                </pre>
              </div>
              <button className="ghost" title="Copy again" onClick={() => copyEntry(c.text)}>
                ⧉
              </button>
            </div>
          ))}
        </>
      )}

      <h3 style={{ marginTop: 16 }}>Custom settings</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key" />
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" style={{ flex: 1 }} />
        <button className="primary" onClick={() => void addSetting()}>
          Set
        </button>
      </div>
    </div>
  );
}

export function SyncPanel() {
  const [cfg, setCfg] = useState<SyncConfig | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncMergeResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = () =>
    api
      .getSyncConfig()
      .then((c) => {
        setCfg(c);
        setServerUrl(c.server_url);
        setDeviceName(c.device_name);
        setToken(c.token);
        setEnabled(c.enabled);
      })
      .catch((e) => setFormError(String(e instanceof Error ? e.message : e)));

  useEffect(() => {
    load();
  }, []);

  const saveConfig = async () => {
    setFormError(null);
    try {
      const saved = await api.putSyncConfig({ server_url: serverUrl, device_name: deviceName, token, enabled });
      setCfg(saved);
    } catch (e) {
      setFormError(String(e instanceof Error ? e.message : e));
    }
  };

  const merge = async () => {
    setBusy(true);
    setResult(null);
    setFormError(null);
    try {
      const r = await api.mergeSync();
      setResult(r);
      load();
    } catch (e) {
      setFormError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return (
      <div className="panel">
        <h3>Sync</h3>
        <div className="empty">{formError ? `Failed to load sync config: ${formError}` : 'Loading…'}</div>
      </div>
    );
  }

  const statusOk = result ? result.ok : cfg.last_error === null || cfg.last_error === '';

  return (
    <div className="panel">
      <h3>Cross-device sync</h3>
      <p className="hint">
        Connects this device to a self-hosted sync server. Hosts, groups, snippets, themes and settings are merged with
        last-write-wins; changes made while offline are queued and pushed on the next merge.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
        <label>
          <span className="hint">Sync server URL</span>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://127.0.0.1:3901" />
        </label>
        <label>
          <span className="hint">Device name</span>
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="laptop" />
        </label>
        <label>
          <span className="hint">App password (scope "sync", created on the sync server)</span>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="tfp_…" />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="hint">Enable sync</span>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={() => void saveConfig()}>
            Save config
          </button>
          <button className="primary" disabled={busy} onClick={() => void merge()}>
            {busy ? 'Merging…' : 'Merge now'}
          </button>
          <button className="ghost" onClick={load}>
            Refresh status
          </button>
        </div>
      </div>

      {formError ? (
        <p style={{ color: 'var(--danger)' }}>{formError}</p>
      ) : null}

      <h3 style={{ marginTop: 16 }}>Status</h3>
      <div className="list-row">
        <div className="info">
          <div className="title">
            {statusOk ? <span style={{ color: 'var(--ok, #3fb950)' }}>● online</span> : <span style={{ color: 'var(--danger)' }}>○ offline</span>}
            {cfg.pending > 0 ? <span className="badge">{cfg.pending} queued</span> : null}
          </div>
          <div className="sub">
            device {cfg.device_id.slice(0, 8)} · last sync {cfg.last_sync_at ?? 'never'}
            {cfg.last_error ? ` · ${cfg.last_error}` : ''}
          </div>
        </div>
      </div>
      {result ? (
        <p className="hint">
          Last merge: pushed {result.pushed}, pulled {result.pulled}, pending {result.pending}
          {result.serverTime ? ` · server time ${result.serverTime}` : ''}
          {result.error ? ` · ${result.error}` : ''}
        </p>
      ) : null}
      {cfg.last_stats ? (
        <p className="hint">
          Previous: pushed {cfg.last_stats.pushed}, pulled {cfg.last_stats.pulled} at {cfg.last_sync_at}
        </p>
      ) : null}
    </div>
  );
}
