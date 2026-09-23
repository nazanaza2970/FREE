import { useEffect, useMemo, useState } from 'react';
import type { HostGroup, Snippet } from '@shared/types';
import { extractVariables, renderSnippet } from '@shared/snippets';
import { api } from '../api';

interface Props {
  open: boolean;
  groups: HostGroup[];
  onInsert: (text: string) => void;
  onClose: () => void;
}

export default function SnippetPicker({ open, groups, onInsert, onClose }: Props) {
  const [items, setItems] = useState<Snippet[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedId(null);
    setRevealed(null);
    setVars({});
    api
      .listSnippets()
      .then(setItems)
      .catch(() => setItems([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) => s.name.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q));
  }, [items, query]);

  const selected = items.find((s) => s.id === selectedId) ?? null;

  const pick = async (s: Snippet) => {
    setSelectedId(s.id);
    setRevealed(null);
    setVars({});
    if (s.protected) {
      setBusy(true);
      try {
        const r = await api.revealSnippet(s.id);
        setRevealed(r.content);
      } catch {
        setRevealed(null);
      } finally {
        setBusy(false);
      }
    }
  };

  if (!open) return null;

  const content = selected ? (selected.protected ? (revealed ?? '') : selected.content) : '';
  const varNames = selected && revealed !== null ? extractVariables(content) : [];
  const ready = selected !== null && (revealed !== null || !selected.protected) && varNames.every((v) => (vars[v] ?? '') !== '');

  const insert = () => {
    if (!ready || !selected) return;
    onInsert(renderSnippet(content, vars) + '\n');
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ width: 640 }} onMouseDown={(e) => e.stopPropagation()}>
        <h3>Insert snippet</h3>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search snippets…"
          style={{ marginBottom: 8 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 12, flex: 1, minHeight: 240 }}>
          <div style={{ overflowY: 'auto', maxHeight: 320, border: '1px solid var(--border)', borderRadius: 6 }}>
            {filtered.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>
                No snippets.
              </div>
            ) : (
              filtered.map((s) => (
                <div
                  key={s.id}
                  onClick={() => void pick(s)}
                  style={{
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                    background: selectedId === s.id ? 'var(--accent-soft, rgba(0,229,160,0.15))' : undefined,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div>
                    {s.favorite ? '★ ' : ''}
                    {s.protected ? '🔒 ' : ''}
                    {s.name}
                  </div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {s.group_id ? (groups.find((g) => g.id === s.group_id)?.name ?? `group ${s.group_id}`) : 'global'}
                    {s.tags ? ` · ${s.tags}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selected ? (
              <>
                <div className="dim" style={{ fontSize: 11 }}>
                  {selected.protected ? 'Protected — content decrypted for this insert.' : 'Content'}
                </div>
                <pre className="snippet-pre" style={{ flex: 1, overflow: 'auto' }}>
                  {busy ? 'decrypting…' : content || '(empty)'}
                </pre>
                {varNames.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                    {varNames.map((v) => (
                      <label key={v} style={{ fontSize: 11 }}>
                        <span className="dim">{`{{${v}}}`}</span>
                        <input
                          value={vars[v] ?? ''}
                          onChange={(e) => setVars((prev) => ({ ...prev, [v]: e.target.value }))}
                          placeholder={v}
                          style={{ width: '100%' }}
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="modal-actions">
                  <button onClick={onClose}>Cancel</button>
                  <button className="primary" disabled={!ready} onClick={insert}>
                    Insert
                  </button>
                </div>
              </>
            ) : (
              <div className="empty" style={{ margin: 'auto' }}>
                Select a snippet to preview and insert.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
