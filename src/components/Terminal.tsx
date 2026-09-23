import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ITheme } from '@xterm/xterm';
import type { Host, SessionState } from '@shared/types';
import { decodeBase64 } from '@shared/protocol';
import { connectTerminal, type TerminalSocket } from '../ws';
import type { TermSettings } from '../termSettings';

interface Props {
  host: Host;
  active: boolean;
  sessionId: string;
  status: SessionState;
  detail?: string;
  theme: ITheme;
  termSettings: TermSettings;
  onStatus: (hostId: number, state: SessionState, detail?: string) => void;
  onHostKey: (hostId: number, fingerprint: string | null) => void;
  onReconnect: (hostId: number) => void;
  onWriter?: (hostId: number, write: ((data: string) => void) | null) => void;
}

interface Mismatch {
  fingerprint: string;
  expected: string;
}

export default function Terminal({
  host,
  active,
  sessionId,
  status,
  detail,
  theme,
  termSettings,
  onStatus,
  onHostKey,
  onReconnect,
  onWriter,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: termSettings.cursorBlink,
      fontSize: termSettings.fontSize,
      fontFamily: termSettings.fontFamily,
      cursorStyle: termSettings.cursorStyle,
      theme,
      scrollback: termSettings.scrollback,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    const fitNow = () => {
      try {
        fit.fit();
        socketRef.current?.send({ type: 'resize', sessionId, cols: term.cols, rows: term.rows });
      } catch {
        /* not ready */
      }
    };
    fitNow();

    termRef.current = term;
    fitRef.current = fit;

    const socket = connectTerminal(
      (msg) => {
        if (msg.sessionId !== sessionId) return;
        switch (msg.type) {
          case 'output': {
            const bytes = decodeBase64(msg.data);
            term.write(bytes);
            break;
          }
          case 'status':
            onStatus(host.id, msg.state, msg.detail);
            break;
          case 'hostkey':
            if (msg.state === 'new') {
              term.write(`\r\n\x1b[33m[hostkey] new host key trusted (TOFU): ${msg.fingerprint}\x1b[0m\r\n`);
              onHostKey(host.id, msg.fingerprint);
            } else if (msg.state === 'verified') {
              onHostKey(host.id, msg.fingerprint);
            } else {
              setMismatch({ fingerprint: msg.fingerprint, expected: msg.expected ?? '' });
              onStatus(host.id, 'error', 'host key mismatch');
            }
            break;
          case 'exit':
            setMismatch(null);
            onStatus(host.id, 'disconnected', `exit code ${msg.code ?? 'null'}`);
            break;
          case 'error':
            onStatus(host.id, 'error', msg.message);
            term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
            break;
        }
      },
      () => {
        socket.send({ type: 'connect', sessionId, hostId: host.id });
        onWriter?.(host.id, (data) => socket.send({ type: 'input', sessionId, data }));
      },
      () => {
        if (termRef.current) onStatus(host.id, 'disconnected', 'socket closed');
      },
    );
    socketRef.current = socket;

    const onTermData = (data: string) => {
      socket.send({ type: 'input', sessionId, data });
    };
    term.onData(onTermData);

    const observer = new ResizeObserver(() => {
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(fitNow, 120);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      onWriter?.(host.id, null);
      socket.send({ type: 'disconnect', sessionId });
      socket.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, host.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = theme;
    term.options.cursorStyle = termSettings.cursorStyle;
    term.options.cursorBlink = termSettings.cursorBlink;
    term.options.fontSize = termSettings.fontSize;
    term.options.fontFamily = termSettings.fontFamily;
    term.options.scrollback = termSettings.scrollback;
  }, [theme, termSettings]);

  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit();
        termRef.current?.focus();
      } catch {
        /* not ready */
      }
    }
  }, [active]);

  const trustAndConnect = () => {
    setMismatch(null);
    socketRef.current?.send({ type: 'connect', sessionId, hostId: host.id, trust: true });
  };

  const showOverlay = !mismatch && (status === 'error' || status === 'disconnected');

  return (
    <div className="terminal-wrap" style={{ display: active ? 'block' : 'none' }}>
      <div ref={containerRef} />
      {mismatch ? (
        <div className="overlay">
          <div className="overlay-card">
            <h4>Host key mismatch</h4>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
              The server presented a key different from the one on record. If you don't
              recognize this change, a man-in-the-middle attack is possible.
            </p>
            <p className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              <span className="dim">recorded: </span>
              {mismatch.expected}
              <br />
              <span className="dim">received: </span>
              {mismatch.fingerprint}
            </p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setMismatch(null);
                  onReconnect(host.id);
                }}
              >
                Cancel
              </button>
              <button className="primary" onClick={trustAndConnect}>
                Trust new key
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showOverlay ? (
        <div className="overlay">
          <div className="overlay-card">
            <h4>{status === 'error' ? 'Connection failed' : 'Session closed'}</h4>
            {detail ? (
              <p className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {detail}
              </p>
            ) : null}
            <div className="modal-actions">
              <button onClick={() => onReconnect(host.id)}>Reconnect</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
