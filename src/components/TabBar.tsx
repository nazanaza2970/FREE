import type { Host, SessionState } from '@shared/types';

export interface Tab {
  host: Host;
  sessionId: string;
  status: SessionState;
  detail?: string;
  fingerprint?: string | null;
}

interface Props {
  tabs: Tab[];
  activeId: number | null;
  onSelect: (hostId: number) => void;
  onClose: (hostId: number) => void;
}

export default function TabBar({ tabs, activeId, onSelect, onClose }: Props) {
  if (tabs.length === 0) return null;
  return (
    <div className="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.host.id}
          className={`tab ${tab.host.id === activeId ? 'active' : ''}`}
          onClick={() => onSelect(tab.host.id)}
        >
          <span className="dot" style={{ background: tab.host.color }} />
          <span>
            {tab.host.connection_type === 'vnc' ? '🖥 ' : ''}
            {tab.host.name}
          </span>
          <button
            className="close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.host.id);
            }}
            title="Close tab"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
