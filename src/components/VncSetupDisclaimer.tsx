import { useState } from 'react';
import type { VncRequirement } from '@shared/types';

interface Props {
  requirements: VncRequirement[];
  onStart: () => void;
  onRecheck: () => void;
  starting?: boolean;
  rechecking?: boolean;
  detail?: string | null;
}

export default function VncSetupDisclaimer({
  requirements,
  onStart,
  onRecheck,
  starting,
  rechecking,
  detail,
}: Props) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyCommands = async (index: number, commands: string[]) => {
    try {
      await navigator.clipboard.writeText(commands.join('\n'));
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((cur) => (cur === index ? null : cur)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="vnc-setup">
      <div className="vnc-setup-card">
        <h4>🖥 VNC isn't running on this host</h4>
        <p className="hint">
          We checked the remote host and the VNC desktop isn't available yet. Review the
          requirements below, then start the virtual desktop — we'll create it for you over
          the SSH tunnel.
        </p>
        {detail ? <p className="mono" style={{ fontSize: 11, color: 'var(--danger)', wordBreak: 'break-all' }}>{detail}</p> : null}

        {requirements.length > 0 ? (
          <div className="vnc-req-list">
            {requirements.map((req, i) => {
              const commands = 'installCommands' in req ? (req.installCommands ?? []) : [];
              return (
                <div key={i} className="vnc-req">
                  <div className="vnc-req-msg">{req.message}</div>
                  {commands.length > 0 ? (
                    <div className="vnc-req-cmd">
                      <pre className="mono">{commands.join('\n')}</pre>
                      <button className="ghost" onClick={() => void copyCommands(i, commands)}>
                        {copiedIndex === i ? '✓ Copied' : 'Copy commands'}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hint">No specific missing packages detected, but the VNC service is not responding.</p>
        )}

        <div className="modal-actions">
          <button className="ghost" disabled={rechecking} onClick={onRecheck}>
            {rechecking ? 'Checking…' : 'Re-check'}
          </button>
          <button className="primary" disabled={starting || rechecking} onClick={onStart}>
            {starting ? 'Starting…' : 'Start virtual desktop'}
          </button>
        </div>
      </div>
    </div>
  );
}
