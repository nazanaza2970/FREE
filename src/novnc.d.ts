declare module '@novnc/novnc' {
  export interface RfbOptions {
    target?: HTMLElement;
    wsProtocols?: string[];
    password?: string;
    shared?: boolean;
    viewOnly?: boolean;
    scaleViewport?: boolean;
    resizeSession?: boolean;
    fullscreen?: boolean;
    showDot?: boolean;
    background?: string;
    repeaterID?: number;
    automatickeymap?: boolean;
  }

  export interface RfbCredentials {
    username?: string;
    password?: string;
    pathname?: string;
  }

  export interface RfbSecurityResult {
    reason?: string;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | WebSocket | RTCDataChannel, options?: RfbOptions);
    disconnect(reason?: string): void;
    sendCredentials(creds: RfbCredentials): void;
    sendPassword(password: string): void;
    sendText(text: string): void;
    setClipboard(mime: string, data: Uint8Array): void;
    get viewOnly(): boolean;
    set viewOnly(value: boolean);
    get scaleViewport(): boolean;
    set scaleViewport(value: boolean);
    get resizeSession(): boolean;
    set resizeSession(value: boolean);
    get fullscreen(): boolean;
    set fullscreen(value: boolean);
  }
}
