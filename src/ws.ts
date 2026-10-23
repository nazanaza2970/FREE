import type { ClientMessage, ServerMessage } from '@shared/protocol';
import { getApiToken, wsBase } from './api';

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
  const token = getApiToken();
  const ws = new WebSocket(`${wsBase()}/ws/terminal${token ? `?token=${encodeURIComponent(token)}` : ''}`);

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
