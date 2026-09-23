import type { SessionState } from '@shared/types';

interface Props {
  hostName: string | null;
  state: SessionState;
  detail?: string;
  fingerprint: string | null;
  hostCount: number;
}

export default function StatusBar({ hostName, state, detail, fingerprint, hostCount }: Props) {
  return (
    <div className="statusbar">
      <div className={`state ${state}`}>
        <span className="dot" />
        <span>{hostName ? `${hostName} · ${state}` : state}</span>
        {detail ? <span title={detail}>· {detail}</span> : null}
      </div>
      {fingerprint ? (
        <span className="mono" title="Verified host key fingerprint" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {fingerprint}
        </span>
      ) : null}
      <div className="spacer" />
      <span>{hostCount} host(s)</span>
      <span>FREE</span>
    </div>
  );
}
