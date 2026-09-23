import { useMemo, useState } from 'react';
import type { Host, HostGroup } from '@shared/types';

interface Props {
  hosts: Host[];
  groups: HostGroup[];
  activeHostId: number | null;
  onSelect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onNew: () => void;
  onNewHostInGroup: (groupId: number | null) => void;
  onNewGroup: (parentId: number | null) => void;
  onRenameGroup: (group: HostGroup) => void;
  onDeleteGroup: (group: HostGroup) => void;
}

export default function HostList({
  hosts,
  groups,
  activeHostId,
  onSelect,
  onEdit,
  onDelete,
  onNew,
  onNewHostInGroup,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const byParent = useMemo(() => {
    const map = new Map<number | null, HostGroup[]>();
    for (const g of groups) {
      const key = g.parent_id ?? null;
      const list = map.get(key) ?? [];
      list.push(g);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [groups]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderGroup = (group: HostGroup, depth: number): React.ReactNode => {
    const groupHosts = hosts.filter((h) => h.group_id === group.id);
    const children = byParent.get(group.id) ?? [];
    const isCollapsed = collapsed.has(group.id);
    const expandable = groupHosts.length > 0 || children.length > 0;

    return (
      <div key={group.id}>
        <div
          className="group-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (expandable) toggle(group.id);
          }}
        >
          <span className="chev">{expandable ? (isCollapsed ? '▸' : '▾') : ''}</span>
          <span className="dot" style={{ background: group.color }} />
          <span className="gname">{group.name}</span>
          <span className="gcount">{groupHosts.length}</span>
          <span className="actions" onClick={(e) => e.stopPropagation()}>
            <button className="ghost" title="New host in group" onClick={() => onNewHostInGroup(group.id)}>
              +
            </button>
            <button className="ghost" title="New subgroup" onClick={() => onNewGroup(group.id)}>
              ☰
            </button>
            <button className="ghost" title="Rename" onClick={() => onRenameGroup(group)}>
              ✎
            </button>
            <button className="ghost" title="Delete" onClick={() => onDeleteGroup(group)}>
              ✕
            </button>
          </span>
        </div>
        {!isCollapsed && (
          <div>
            {groupHosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                active={host.id === activeHostId}
                indent={depth + 1}
                onSelect={onSelect}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
            {children.map((child) => renderGroup(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const ungrouped = hosts.filter((h) => h.group_id === null);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '0 4px 8px' }}>
        <button className="ghost" title="New group" onClick={() => onNewGroup(null)}>
          ☰
        </button>
        <button className="primary" onClick={onNew}>
          + New host
        </button>
      </div>

      {(byParent.get(null) ?? []).map((g) => renderGroup(g, 0))}

      {ungrouped.length > 0 && (
        <div>
          <div className="host-group-title">
            <span>Ungrouped</span>
            <span>{ungrouped.length}</span>
          </div>
          {ungrouped.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              active={host.id === activeHostId}
              onSelect={onSelect}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {hosts.length === 0 && groups.length === 0 && (
        <div className="empty">No hosts yet. Add one to get started.</div>
      )}
    </div>
  );
}

function HostRow({
  host,
  active,
  indent = 0,
  onSelect,
  onEdit,
  onDelete,
}: {
  host: Host;
  active: boolean;
  indent?: number;
  onSelect: (h: Host) => void;
  onEdit: (h: Host) => void;
  onDelete: (h: Host) => void;
}) {
  return (
    <div
      className={`host-item ${active ? 'active' : ''}`}
      style={indent > 0 ? { paddingLeft: 8 + indent * 14 } : undefined}
      onClick={() => onSelect(host)}
    >
      <span className="dot" style={{ background: host.color }} />
      <div className="meta">
        <div className="name">
          {host.favorite ? '★ ' : ''}
          {host.name}
          {host.connection_type !== 'ssh' ? (
            <span className="badge type-badge">{host.connection_type.toUpperCase()}</span>
          ) : null}
        </div>
        <div className="addr">
          {host.username}@{host.host}:{host.port}
        </div>
      </div>
      <div className="actions">
        <button className="ghost" title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(host); }}>
          ✎
        </button>
        <button className="ghost" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(host); }}>
          ✕
        </button>
      </div>
    </div>
  );
}
