import type { ClientMessage, ServerMessage } from '@shared/protocol';
import { getApiToken } from './api';

export interface TerminalSocket {
  send: (msg: ClientMessage) => void;
  close: () => void;
  readyState: number;
}

export function connectTerminal(
  onMessage: (msg: ServerMessage) => void,
  onOpen: () => void,
  onClose: () => void,
): TerminalSocket {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getApiToken();
  const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal${token ? `?token=${encodeURIComponent(token)}` : ''}`);

  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(String(event.data)) as ServerMessage);
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onopen = onOpen;
  ws.onclose = onClose;
  ws.onerror = () => {
    /* onclose follows */
  };

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
