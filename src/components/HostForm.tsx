import { useMemo, useState } from 'react';
import type { Host, HostGroup, HostInput } from '@shared/types';
import { api } from '../api';

interface Props {
  initial: Host | null;
  groups: HostGroup[];
  hosts: Host[];
  presetGroupId?: number | null;
  onSave: (input: HostInput) => Promise<void>;
  onClose: () => void;
}

const PALETTE = ['#0ea5e9', '#2ecc71', '#f5a623', '#ff5c5c', '#6c5ce7', '#ec4899', '#14b8a6', '#8b95ab'];

export default function HostForm({ initial, groups, hosts, presetGroupId, onSave, onClose }: Props) {
  const [form, setForm] = useState<HostInput>({
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    username: initial?.username ?? 'root',
    connection_type: initial?.connection_type ?? 'ssh',
    agent_forward: initial?.agent_forward ?? false,
    auth_method: initial?.auth_method ?? 'password',
    password: initial?.password ?? '',
    private_key: initial?.private_key ?? '',
    pass_phrase: initial?.pass_phrase ?? '',
    remote_command: initial?.remote_command ?? '',
    keepalive: initial?.keepalive ?? 30,
    color: initial?.color ?? PALETTE[0],
    favorite: initial?.favorite ?? false,
    notes: initial?.notes ?? '',
    group_id: initial?.group_id ?? presetGroupId ?? null,
    vnc_transport: initial?.vnc_transport ?? 'ssh',
    vnc_port: initial?.vnc_port ?? 5900,
    vnc_password: initial?.vnc_password ?? '',
    vnc_ssh_host_id: initial?.vnc_ssh_host_id ?? null,
    vnc_display: initial?.vnc_display ?? null,
    vnc_desktop_mode: initial?.vnc_desktop_mode ?? 'auto',
    vnc_auto_start: initial?.vnc_auto_start ?? true,
    vnc_auto_stop: initial?.vnc_auto_stop ?? false,
    vnc_implementation: initial?.vnc_implementation ?? 'auto',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyType, setKeyType] = useState<'ed25519' | 'rsa'>('ed25519');
  const [generating, setGenerating] = useState(false);
  const [keyFingerprint, setKeyFingerprint] = useState<string | null>(null);

  const groupOptions = useMemo(() => {
    const byParent = new Map<number | null, HostGroup[]>();
    for (const g of groups) {
      const list = byParent.get(g.parent_id ?? null) ?? [];
      list.push(g);
      byParent.set(g.parent_id ?? null, list);
    }
    const out: { group: HostGroup; depth: number }[] = [];
    const walk = (parentId: number | null, depth: number) => {
      const list = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const g of list) {
        out.push({ group: g, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [groups]);

  const generateKey = async () => {
    setGenerating(true);
    setError(null);
    try {
      const comment = form.name ? `${form.name}@free` : 'free';
      const key = await api.generateKey({ type: keyType, comment });
      set('private_key', key.private);
      setKeyFingerprint(key.fingerprint);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setGenerating(false);
    }
  };

  const set = <K extends keyof HostInput>(key: K, value: HostInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isVnc = form.connection_type === 'vnc';
  const vncTransport = form.vnc_transport ?? 'ssh';
  const vncUsesReference = isVnc && vncTransport === 'ssh' && !!form.vnc_ssh_host_id;
  const needsSshCreds = form.connection_type === 'ssh' || (isVnc && vncTransport === 'ssh' && !vncUsesReference);
  const sshHosts = hosts.filter((h) => h.connection_type === 'ssh' && h.id !== initial?.id);

  const submit = async () => {
    if (!form.name || !form.host) {
      setError('name and host are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? 'Edit host' : 'New host'}</h3>
        <div className="form-grid">
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="prod-web-1" />
          </div>
          <div className="field">
            <label>Group</label>
            <select value={form.group_id ?? ''} onChange={(e) => set('group_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">— none —</option>
              {groupOptions.map(({ group, depth }) => (
                <option key={group.id} value={group.id}>
                  {'  '.repeat(depth)}
                  {depth > 0 ? '└ ' : ''}
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Host</label>
            <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="203.0.113.10" />
          </div>
          <div className="field">
            <label>Port</label>
            <input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value) || 22)} />
          </div>
          <div className="field">
            <label>Connection type</label>
            <select value={form.connection_type} onChange={(e) => set('connection_type', e.target.value as HostInput['connection_type'])}>
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet</option>
              <option value="mosh">Mosh</option>
              <option value="vnc">VNC / Desktop</option>
            </select>
          </div>
          {needsSshCreds ? (
            <div className="field">
              <label>Username</label>
              <input value={form.username} onChange={(e) => set('username', e.target.value)} />
            </div>
          ) : (
            <div className="field" />
          )}
          {needsSshCreds ? (
          <>
          <div className="field">
            <label>Auth method</label>
            <select value={form.auth_method} onChange={(e) => set('auth_method', e.target.value as HostInput['auth_method'])}>
              <option value="password">Password</option>
              <option value="key">Private key</option>
            </select>
          </div>
          {form.auth_method === 'password' ? (
            <div className="field full">
              <label>Password</label>
              <input type="password" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} />
            </div>
          ) : (
            <>
              <div className="field full">
                <label>Private key (PEM)</label>
                <div className="key-gen-row">
                  <select value={keyType} onChange={(e) => setKeyType(e.target.value as 'ed25519' | 'rsa')}>
                    <option value="ed25519">ed25519</option>
                    <option value="rsa">RSA 3072</option>
                  </select>
                  <button disabled={generating} onClick={generateKey}>
                    {generating ? 'Generating…' : '⚡ Generate key'}
                  </button>
                  {keyFingerprint ? <span className="mono dim" title={keyFingerprint}>{keyFingerprint.slice(0, 24)}…</span> : null}
                </div>
                <textarea rows={5} value={form.private_key ?? ''} onChange={(e) => { set('private_key', e.target.value); setKeyFingerprint(null); }} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'} />
              </div>
              <div className="field">
                <label>Passphrase</label>
                <input type="password" value={form.pass_phrase ?? ''} onChange={(e) => set('pass_phrase', e.target.value)} />
              </div>
            </>
          )}
          </>
          ) : null}
          {isVnc ? (
            <>
              <div className="field full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <label style={{ color: 'var(--accent)' }}>VNC settings</label>
              </div>
              <div className="field">
                <label>Transport</label>
                <select value={vncTransport} onChange={(e) => set('vnc_transport', e.target.value as HostInput['vnc_transport'])}>
                  <option value="ssh">SSH tunnel (recommended)</option>
                  <option value="direct">Direct (host/port is VNC)</option>
                </select>
              </div>
              {vncTransport === 'ssh' ? (
                <div className="field">
                  <label>SSH tunnel source</label>
                  <select
                    value={form.vnc_ssh_host_id ?? ''}
                    onChange={(e) => set('vnc_ssh_host_id', e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Use this host's SSH details</option>
                    {sshHosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} ({h.host}:{h.port})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="field">
                  <label>VNC port</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => set('port', Number(e.target.value) || 5900)}
                  />
                </div>
              )}
              {vncTransport === 'ssh' ? (
                <div className="field">
                  <label>Remote VNC port</label>
                  <input
                    type="number"
                    value={form.vnc_port ?? 5900}
                    onChange={(e) => set('vnc_port', Number(e.target.value) || 5900)}
                  />
                </div>
              ) : null}
              <div className="field">
                <label>VNC password</label>
                <input type="password" value={form.vnc_password ?? ''} onChange={(e) => set('vnc_password', e.target.value)} />
              </div>
              <div className="field full">
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>Advanced (desktop, display, lifecycle)</summary>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    <div className="field">
                      <label>Desktop mode</label>
                      <select value={form.vnc_desktop_mode ?? 'auto'} onChange={(e) => set('vnc_desktop_mode', e.target.value as HostInput['vnc_desktop_mode'])}>
                        <option value="auto">Auto-detect</option>
                        <option value="virtual">Always virtual (vncserver)</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Implementation</label>
                      <select value={form.vnc_implementation ?? 'auto'} onChange={(e) => set('vnc_implementation', e.target.value as HostInput['vnc_implementation'])}>
                        <option value="auto">Auto-detect</option>
                        <option value="tigervnc">TigerVNC</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Display number (blank = auto)</label>
                      <input
                        type="number"
                        value={form.vnc_display ?? ''}
                        onChange={(e) => set('vnc_display', e.target.value ? Number(e.target.value) : null)}
                      />
                    </div>
                    <div className="field" />
                    <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={form.vnc_auto_start ?? true} onChange={(e) => set('vnc_auto_start', e.target.checked)} />
                      <span style={{ fontSize: 13 }}>Auto-start on connect</span>
                    </label>
                    <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={form.vnc_auto_stop ?? false} onChange={(e) => set('vnc_auto_stop', e.target.checked)} />
                      <span style={{ fontSize: 13 }}>Auto-stop when last viewer leaves</span>
                    </label>
                  </div>
                </details>
              </div>
            </>
          ) : null}
          <div className="field">
            <label>Keepalive (s)</label>
            <input type="number" value={form.keepalive} onChange={(e) => set('keepalive', Number(e.target.value) || 30)} />
          </div>
          <div className="field">
            <label>Color</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4 }}>
              {PALETTE.map((c) => (
                <span
                  key={c}
                  onClick={() => set('color', c)}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 6,
                    background: c,
                    cursor: 'pointer',
                    outline: form.color === c ? '2px solid white' : 'none',
                  }}
                />
              ))}
            </div>
          </div>
          {form.connection_type === 'ssh' ? (
            <div className="field full">
              <label>Remote command (optional)</label>
              <input value={form.remote_command ?? ''} onChange={(e) => set('remote_command', e.target.value)} />
            </div>
          ) : null}
          <div className="field full">
            <label>Notes</label>
            <textarea rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.favorite} onChange={(e) => set('favorite', e.target.checked)} />
            <span style={{ fontSize: 13 }}>Favorite</span>
          </label>
          {form.connection_type === 'ssh' ? (
            <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.agent_forward} onChange={(e) => set('agent_forward', e.target.checked)} />
              <span style={{ fontSize: 13 }}>SSH agent forwarding (expose in-app agent keys to remote)</span>
            </label>
          ) : null}
        </div>
        {error ? <p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p> : null}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving} onClick={submit}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
