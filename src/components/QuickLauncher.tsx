import { useEffect, useMemo, useRef, useState } from 'react';
import type { Host } from '@shared/types';

interface Props {
  open: boolean;
  hosts: Host[];
  onOpen: (host: Host) => void;
  onClose: () => void;
}

export default function QuickLauncher({ open, hosts, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
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
    if (!q) return hosts;
    return hosts.filter(
      (h) => h.name.toLowerCase().includes(q) || h.host.toLowerCase().includes(q) || h.username.toLowerCase().includes(q),
    );
  }, [hosts, query]);

  if (!open) return null;

  const pick = (h: Host) => {
    onOpen(h);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ width: 480 }} onMouseDown={(e) => e.stopPropagation()}>
        <h3>Quick launcher</h3>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered.length > 0) pick(filtered[0]);
          }}
          placeholder="Search hosts…"
          style={{ marginBottom: 10 }}
        />
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>
              No matching hosts.
            </div>
          ) : (
            filtered.map((h, i) => (
              <div
                key={h.id}
                onClick={() => pick(h)}
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                  background: i === 0 ? 'var(--accent-soft, rgba(0,229,160,0.15))' : undefined,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div className="title">{h.name}</div>
                <div className="dim" style={{ fontSize: 11 }}>
                  {h.username}@{h.host}:{h.port}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
          Enter opens the first result · Esc closes
        </div>
      </div>
    </div>
  );
}
