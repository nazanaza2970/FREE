import { useCallback, useEffect, useRef, useState } from 'react';
import type { Host, SessionState, VncRequirement } from '@shared/types';
import { api, getApiToken } from '../api';
import VncSetupDisclaimer from './VncSetupDisclaimer';

type RfbCtor = typeof import('@novnc/novnc').default;
type Rfb = InstanceType<RfbCtor>;

let rfbCtorPromise: Promise<RfbCtor> | null = null;
function loadRfb(): Promise<RfbCtor> {
  if (!rfbCtorPromise) {
    rfbCtorPromise = import('@novnc/novnc').then((m) => m.default);
  }
  return rfbCtorPromise;
}

type Phase = 'checking' | 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'setup';

type ScaleMode = 'fit' | 'resize' | 'fixed';

interface Props {
  host: Host;
  sessionId: string;
  active: boolean;
  onStatus: (hostId: number, state: SessionState, detail?: string) => void;
  onReconnect: (hostId: number) => void;
}

function wsUrl(hostId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getApiToken();
  return `${proto}://${window.location.host}/ws/vnc?host_id=${hostId}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
}

export default function VncView({ host, sessionId, active, onStatus, onReconnect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const connectedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<VncRequirement[]>([]);
  const [viewOnly, setViewOnly] = useState(false);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit');
  const [rechecking, setRechecking] = useState(false);
  const [stopping, setStopping] = useState(false);

  const disposeRfb = useCallback(() => {
    if (rfbRef.current) {
      try {
        rfbRef.current.disconnect();
      } catch {
        /* already closed */
      }
      rfbRef.current = null;
    }
    connectedRef.current = false;
  }, []);

  const connect = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    const RfbCtor = await loadRfb();
    if (!containerRef.current) return;
    disposeRfb();
    setDetail(null);
    setPhase('connecting');
    onStatus(host.id, 'connecting', 'connecting to VNC…');

    const rfb = new RfbCtor(container, wsUrl(host.id), {
      password: host.vnc_password || undefined,
      shared: true,
      scaleViewport: scaleMode === 'fit',
      resizeSession: scaleMode === 'resize',
      viewOnly,
      background: '#0a0d13',
    });
    rfbRef.current = rfb;

    rfb.addEventListener('connect', () => {
      connectedRef.current = true;
      setPhase('connected');
      onStatus(host.id, 'connected', `VNC ${host.host}`);
    });

    rfb.addEventListener('credentialsrequired', () => {
      rfb.sendCredentials({ password: host.vnc_password ?? '' });
    });

    rfb.addEventListener('securityresult', (e: Event) => {
      const { result, reason } = (e as CustomEvent).detail as { result: boolean; reason?: string };
      if (!result) {
        const msg = reason ?? 'VNC authentication failed';
        setDetail(msg);
        setPhase('error');
        onStatus(host.id, 'error', msg);
      }
    });

    rfb.addEventListener('disconnect', (e: Event) => {
      const { clean, reason } = (e as CustomEvent).detail as { clean: boolean; reason?: string };
      if (connectedRef.current) {
        setPhase('disconnected');
        onStatus(host.id, 'disconnected', reason || 'session closed');
      } else if (!clean) {
        setDetail(reason ?? 'connection failed');
        setPhase('error');
        onStatus(host.id, 'error', reason ?? 'connection failed');
      }
      connectedRef.current = false;
    });

    rfb.addEventListener('clipboard', (e: Event) => {
      const data = (e as CustomEvent).detail as ArrayBuffer;
      try {
        void navigator.clipboard?.writeText(new TextDecoder().decode(data));
      } catch {
        /* clipboard unavailable */
      }
    });
  }, [host.id, host.host, host.vnc_password, onStatus, scaleMode, viewOnly, disposeRfb]);

  const startDesktop = useCallback(async () => {
    setPhase('starting');
    onStatus(host.id, 'connecting', 'starting VNC desktop…');
    try {
      const status = await api.vncEnsure(host.id, true);
      if (status.running) {
        void connect();
        return;
      }
      setRequirements(status.requirements);
      setPhase('setup');
      onStatus(host.id, 'disconnected', 'VNC is not running');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setDetail(msg);
      setPhase('error');
      onStatus(host.id, 'error', msg);
    }
  }, [host.id, connect, onStatus]);

  const recheck = useCallback(async () => {
    setRechecking(true);
    onStatus(host.id, 'connecting', 'checking VNC service…');
    try {
      const status = await api.vncStatus(host.id);
      if (status.running) {
        void connect();
        return;
      }
      setRequirements(status.requirements);
      setPhase('setup');
      onStatus(host.id, 'disconnected', 'VNC is not running');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setDetail(msg);
      setPhase('error');
      onStatus(host.id, 'error', msg);
    } finally {
      setRechecking(false);
    }
  }, [host.id, connect, onStatus]);

  useEffect(() => {
    let cancelled = false;
    const guard = () => cancelled;

    const run = async () => {
      setPhase('checking');
      onStatus(host.id, 'connecting', 'checking VNC service…');
      try {
        const status = await api.vncStatus(host.id);
        if (guard()) return;
        if (status.running) {
          void connect();
          return;
        }
        setRequirements(status.requirements);
        if (host.vnc_auto_start) {
          setPhase('starting');
          onStatus(host.id, 'connecting', 'starting VNC desktop…');
          const ensured = await api.vncEnsure(host.id, true);
          if (guard()) return;
          if (ensured.running) {
            void connect();
            return;
          }
          setRequirements(ensured.requirements);
          setPhase('setup');
          onStatus(host.id, 'disconnected', 'VNC is not running');
        } else {
          setPhase('setup');
          onStatus(host.id, 'disconnected', 'VNC is not running');
        }
      } catch (e) {
        if (guard()) return;
        const msg = String(e instanceof Error ? e.message : e);
        setDetail(msg);
        setPhase('error');
        onStatus(host.id, 'error', msg);
      }
    };
    void run();

    return () => {
      cancelled = true;
      disposeRfb();
      if (connectedRef.current) onStatus(host.id, 'disconnected', 'tab closed');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id, sessionId]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = scaleMode === 'fit';
    rfb.resizeSession = scaleMode === 'resize';
  }, [viewOnly, scaleMode]);

  const stopDesktop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    onStatus(host.id, 'connecting', 'stopping VNC desktop…');
    try {
      await api.vncStop(host.id);
      disposeRfb();
      setDetail(null);
      setPhase('disconnected');
      onStatus(host.id, 'disconnected', 'desktop stopped');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setDetail(msg);
      setPhase('error');
      onStatus(host.id, 'error', msg);
    } finally {
      setStopping(false);
    }
  }, [host.id, onStatus, stopping, disposeRfb]);

  const toggleFullscreen = () => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const starting = phase === 'starting';
  const showSetup = phase === 'setup';
  const showStatus = phase === 'checking' || starting || phase === 'connecting';
  const showOverlay = !showSetup && (phase === 'disconnected' || phase === 'error');

  return (
    <div className="vnc-wrap" style={{ display: active ? 'block' : 'none' }}>
      <div className="vnc-toolbar">
        <span className="dot" style={{ background: host.color }} />
        <span className="vnc-title">{host.name}</span>
        <span className="vnc-phase">
          {phase === 'connected' ? 'connected' : phase}
          {host.vnc_transport === 'direct' ? ' · direct' : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className={viewOnly ? 'primary' : 'ghost'}
          title="Toggle view-only mode"
          onClick={() => setViewOnly((v) => !v)}
        >
          {viewOnly ? '✋ View-only' : 'View-only'}
        </button>
        <select
          className="ghost"
          value={scaleMode}
          title="Scaling mode"
          onChange={(e) => setScaleMode(e.target.value as ScaleMode)}
        >
          <option value="fit">Fit to window</option>
          <option value="resize">Resize session</option>
          <option value="fixed">Fixed size</option>
        </select>
        <button className="ghost" title="Toggle fullscreen" onClick={toggleFullscreen}>
          ⛶
        </button>
        <button className="ghost" title="Reconnect" onClick={() => onReconnect(host.id)}>
          ↻
        </button>
        <button
          className="ghost"
          title="Disconnect"
          onClick={() => {
            disposeRfb();
            setPhase('disconnected');
            onStatus(host.id, 'disconnected', 'disconnected');
          }}
        >
          ⏻
        </button>
        <button
          className="ghost"
          title="Stop the remote desktop server (releases remote resources)"
          onClick={() => void stopDesktop()}
          disabled={stopping}
        >
          {stopping ? 'Stopping…' : '⏹ Stop desktop'}
        </button>
      </div>
      <div className="vnc-canvas" ref={containerRef} />
      {showStatus ? (
        <div className="overlay">
          <div className="overlay-card" style={{ textAlign: 'center' }}>
            <h4>
              {phase === 'checking'
                ? 'Checking VNC service…'
                : phase === 'starting'
                  ? 'Starting virtual desktop…'
                  : 'Connecting…'}
            </h4>
            <p className="hint">This can take a moment on first run while the desktop is provisioned.</p>
          </div>
        </div>
      ) : null}
      {showSetup ? (
        <div className="overlay">
          <VncSetupDisclaimer
            requirements={requirements}
            detail={detail}
            starting={starting}
            rechecking={rechecking}
            onStart={() => void startDesktop()}
            onRecheck={() => void recheck()}
          />
        </div>
      ) : null}
      {showOverlay ? (
        <div className="overlay">
          <div className="overlay-card">
            <h4>{phase === 'error' ? 'Connection failed' : 'Session closed'}</h4>
            {detail ? (
              <p className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {detail}
              </p>
            ) : null}
            <div className="modal-actions">
              <button className="ghost" onClick={() => void recheck()}>
                Re-check service
              </button>
              <button className="primary" onClick={() => onReconnect(host.id)}>
                Reconnect
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
