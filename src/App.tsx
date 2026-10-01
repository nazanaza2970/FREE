import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Host, HostGroup, HostInput, SessionState, Theme } from '@shared/types';
import { DEFAULT_COLORS, toXtermTheme } from '@shared/theme';
import { comboMatches, pushClipboardHistory } from '@shared/shortcuts';
import { api, ensureApiToken, setApiToken } from './api';
import { escapePayload, loadClipboardHistory, loadKeymap, loadTermSettings, saveClipboardHistory } from './termSettings';
import HostList from './components/HostList';
import HostForm from './components/HostForm';
import TabBar, { type Tab } from './components/TabBar';
import Terminal from './components/Terminal';
import VncView from './components/VncView';
import SnippetPicker from './components/SnippetPicker';
import QuickLauncher from './components/QuickLauncher';
import StatusBar from './components/StatusBar';
import {
  AuditPanel,
  PortForwardingPanel,
  SftpPanel,
  SettingsPanel,
  SnippetsPanel,
  SyncPanel,
  ThemesPanel,
  TokensPanel,
} from './components/panels';

type PanelKey = 'terminal' | 'files' | 'snippets' | 'themes' | 'audit' | 'forwards' | 'settings' | 'sync' | 'tokens';

const PANELS: { key: PanelKey; label: string }[] = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'files', label: 'Files' },
  { key: 'snippets', label: 'Snippets' },
  { key: 'themes', label: 'Themes' },
  { key: 'forwards', label: 'Forwards' },
  { key: 'audit', label: 'Audit' },
  { key: 'sync', label: 'Sync' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'settings', label: 'Settings' },
];

function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeHostId, setActiveHostId] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelKey>('terminal');
  const [formHost, setFormHost] = useState<Host | null>(null);
  const [formPresetGroup, setFormPresetGroup] = useState<number | null | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [themes, setThemes] = useState<Theme[]>([]);
  const [termSettings, setTermSettings] = useState(loadTermSettings);
  const writersRef = useRef(new Map<number, (data: string) => void>());

  const refreshThemes = useCallback(() => {
    api
      .listThemes()
      .then(setThemes)
      .catch(() => setThemes([]));
  }, []);

  useEffect(() => {
    refreshThemes();
  }, [refreshThemes]);

  const activeTheme = useMemo(() => themes.find((t) => t.is_default) ?? themes[0] ?? null, [themes]);
  const xtermTheme = useMemo(() => toXtermTheme(activeTheme?.colors ?? DEFAULT_COLORS), [activeTheme]);

  useEffect(() => {
    const accent = activeTheme?.colors?.accent;
    if (accent) document.documentElement.style.setProperty('--accent', accent);
  }, [activeTheme]);

  const registerWriter = useCallback((hostId: number, write: ((data: string) => void) | null) => {
    if (write) writersRef.current.set(hostId, write);
    else writersRef.current.delete(hostId);
  }, []);

  const insertIntoActive = useCallback(
    (text: string) => {
      if (activeHostId === null) return;
      writersRef.current.get(activeHostId)?.(text);
    },
    [activeHostId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault();
        setPickerOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        setLauncherOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // clipboard history: capture copies made anywhere in the app
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      const list = pushClipboardHistory(loadClipboardHistory(), text);
      saveClipboardHistory(list);
    };
    window.addEventListener('copy', onCopy);
    return () => window.removeEventListener('copy', onCopy);
  }, []);

  // key mappings: send payload to the active terminal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (activeHostId === null) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      for (const m of loadKeymap()) {
        if (comboMatches(m.combo, e)) {
          e.preventDefault();
          writersRef.current.get(activeHostId)?.(escapePayload(m.payload));
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeHostId]);

  const refresh = useCallback(async () => {
    try {
      const [h, g] = await Promise.all([api.listHosts(), api.listGroups()]);
      setHosts(h);
      setGroups(g);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void ensureApiToken().then((ok) => {
      setLocked(!ok);
      if (ok) refresh();
    });
  }, [refresh]);

  const tryUnlock = () => {
    const value = tokenDraft.trim();
    if (!value) return;
    setApiToken(value);
    void ensureApiToken().then((ok) => {
      setLocked(!ok);
      if (ok) refresh();
    });
  };

  const openTab = useCallback((host: Host) => {
    setTabs((prev) => {
      if (prev.some((t) => t.host.id === host.id)) return prev;
      return [...prev, { host, sessionId: newSessionId(), status: 'disconnected' }];
    });
    setActiveHostId(host.id);
    setPanel('terminal');
  }, []);

  const closeTab = useCallback((hostId: number) => {
    setTabs((prev) => prev.filter((t) => t.host.id !== hostId));
    setActiveHostId((cur) => (cur === hostId ? null : cur));
  }, []);

  const onStatus = useCallback((hostId: number, state: SessionState, detail?: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.host.id === hostId ? { ...t, status: state, detail } : t)),
    );
  }, []);

  const onHostKey = useCallback((hostId: number, fingerprint: string | null) => {
    setTabs((prev) =>
      prev.map((t) => (t.host.id === hostId ? { ...t, fingerprint } : t)),
    );
  }, []);

  const onReconnect = useCallback((hostId: number) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.host.id === hostId
          ? { ...t, sessionId: newSessionId(), status: 'disconnected', detail: undefined }
          : t,
      ),
    );
  }, []);

  const saveHost = useCallback(
    async (input: HostInput) => {
      if (formHost) {
        const updated = await api.updateHost(formHost.id, input);
        setHosts((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
      } else {
        const created = await api.createHost(input);
        setHosts((prev) => [...prev, created]);
      }
    },
    [formHost],
  );

  const deleteHost = useCallback(
    async (host: Host) => {
      if (!window.confirm(`Delete host "${host.name}"?`)) return;
      await api.deleteHost(host.id);
      setHosts((prev) => prev.filter((h) => h.id !== host.id));
      closeTab(host.id);
    },
    [closeTab],
  );

  const activeTab = useMemo(
    () => tabs.find((t) => t.host.id === activeHostId) ?? null,
    [tabs, activeHostId],
  );

  const openForm = (host: Host | null, presetGroup?: number | null) => {
    setFormHost(host);
    setFormPresetGroup(presetGroup);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setFormHost(null);
    setFormPresetGroup(undefined);
  };

  const runGroupAction = async (fn: () => Promise<unknown>, fallbackError: string) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e) || fallbackError);
    }
  };

  const onNewGroup = (parentId: number | null) => {
    const name = window.prompt('New group name');
    if (!name || !name.trim()) return;
    void runGroupAction(() => api.createGroup({ name: name.trim(), parent_id: parentId }), 'Failed to create group');
  };

  const onRenameGroup = (group: HostGroup) => {
    const name = window.prompt('Rename group', group.name);
    if (!name || !name.trim() || name.trim() === group.name) return;
    void runGroupAction(() => api.updateGroup(group.id, { name: name.trim() }), 'Failed to rename group');
  };

  const onDeleteGroup = (group: HostGroup) => {
    const childCount = groups.filter((g) => g.parent_id === group.id).length;
    const hostCount = hosts.filter((h) => h.group_id === group.id).length;
    const detail = [hostCount > 0 ? `${hostCount} host(s)` : null, childCount > 0 ? `${childCount} subgroup(s) will move up` : null]
      .filter(Boolean)
      .join(', ');
    if (!window.confirm(`Delete group "${group.name}"?${detail ? ` ${detail}.` : ''}`)) return;
    void runGroupAction(() => api.deleteGroup(group.id), 'Failed to delete group');
  };

  if (locked) {
    return (
      <div className="empty" style={{ margin: 'auto', maxWidth: 440, textAlign: 'center' }}>
        <h2>Locked</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          This app instance is protected, but no valid token is stored in this browser. Paste a token to
          unlock.
        </p>
        <input
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') tryUnlock();
          }}
          placeholder="tfp_…"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <button onClick={tryUnlock}>Unlock</button>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          FREE
        </div>
        <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Everything remote. Freely yours.</span>
        {error ? <span style={{ color: 'var(--danger)', fontSize: 12 }} title={error}>⚠ {error}</span> : null}
      </div>

      <div className="body">
        <div className="sidebar">
          <div className="sidebar-header">
            <h2>Hosts</h2>
            <button className="ghost" onClick={refresh} title="Refresh">
              ↻
            </button>
          </div>
          <div className="host-list">
            <HostList
              hosts={hosts}
              groups={groups}
              activeHostId={activeHostId}
              onSelect={openTab}
              onEdit={openForm}
              onDelete={deleteHost}
              onNew={() => openForm(null)}
              onNewHostInGroup={(groupId) => openForm(null, groupId)}
              onNewGroup={onNewGroup}
              onRenameGroup={onRenameGroup}
              onDeleteGroup={onDeleteGroup}
            />
          </div>
        </div>

        <div className="main">
          <TabBar tabs={tabs} activeId={activeHostId} onSelect={setActiveHostId} onClose={closeTab} />
          <div className="panel-bar">
            {PANELS.map((p) => (
                <button key={p.key} className={panel === p.key ? 'active' : ''} onClick={() => setPanel(p.key)}>
                  {p.label}
                </button>
              ))}
              <button
                className="ghost"
                style={{ marginLeft: 'auto' }}
                title="Quick launcher (Ctrl+Shift+L)"
                onClick={() => setLauncherOpen(true)}
              >
                ⌘ Launcher
              </button>
              {activeTab ? (
                <button className="ghost" title="Insert snippet (Ctrl+Shift+K)" onClick={() => setPickerOpen(true)}>
                  ⚡ Insert snippet
                </button>
              ) : null}
          </div>
          <div className="panel-area">
            {tabs.length > 0 ? (
              tabs.map((tab) =>
                tab.host.connection_type === 'vnc' ? (
                  <VncView
                    key={tab.host.id}
                    host={tab.host}
                    sessionId={tab.sessionId}
                    active={tab.host.id === activeHostId && panel === 'terminal'}
                    onStatus={onStatus}
                    onReconnect={onReconnect}
                  />
                ) : (
                  <Terminal
                    key={tab.host.id}
                    host={tab.host}
                    sessionId={tab.sessionId}
                    status={tab.status}
                    detail={tab.detail}
                    active={tab.host.id === activeHostId && panel === 'terminal'}
                    theme={xtermTheme}
                    termSettings={termSettings}
                    onStatus={onStatus}
                    onHostKey={onHostKey}
                    onReconnect={onReconnect}
                    onWriter={registerWriter}
                  />
                ),
              )
            ) : (
              <div className="empty" style={{ margin: 'auto', maxWidth: 420 }}>
                Select a host on the left, or create a new one, to open a terminal.
              </div>
            )}

            {panel === 'files' && activeTab ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <SftpPanel host={activeTab.host} />
              </div>
            ) : null}
            {panel === 'snippets' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <SnippetsPanel groups={groups} />
              </div>
            ) : null}
            {panel === 'themes' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <ThemesPanel onChanged={refreshThemes} />
              </div>
            ) : null}
            {panel === 'forwards' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <PortForwardingPanel hostId={activeTab?.host.id ?? null} />
              </div>
            ) : null}
            {panel === 'audit' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <AuditPanel />
              </div>
            ) : null}
            {panel === 'sync' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <SyncPanel />
              </div>
            ) : null}
            {panel === 'tokens' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <TokensPanel />
              </div>
            ) : null}
            {panel === 'settings' ? (
              <div className="panel" style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }}>
                <SettingsPanel termSettings={termSettings} onTermSettingsChange={setTermSettings} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <StatusBar
        hostName={activeTab?.host.name ?? null}
        state={activeTab?.status ?? 'disconnected'}
        detail={activeTab?.detail}
        fingerprint={activeTab?.fingerprint ?? null}
        hostCount={hosts.length}
      />

      {formOpen ? (
        <HostForm
          initial={formHost}
          groups={groups}
          hosts={hosts}
          presetGroupId={formPresetGroup}
          onSave={saveHost}
          onClose={closeForm}
        />
      ) : null}

      <SnippetPicker open={pickerOpen} groups={groups} onInsert={insertIntoActive} onClose={() => setPickerOpen(false)} />
      <QuickLauncher open={launcherOpen} hosts={hosts} onOpen={openTab} onClose={() => setLauncherOpen(false)} />
    </div>
  );
}
