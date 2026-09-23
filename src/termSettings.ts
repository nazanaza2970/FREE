export interface TermSettings {
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
}

export const DEFAULT_TERM_SETTINGS: TermSettings = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
};

const SETTINGS_KEY = 'tf.termSettings';

export function loadTermSettings(): TermSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_TERM_SETTINGS };
    return { ...DEFAULT_TERM_SETTINGS, ...(JSON.parse(raw) as Partial<TermSettings>) };
  } catch {
    return { ...DEFAULT_TERM_SETTINGS };
  }
}

export function saveTermSettings(settings: TermSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export interface KeyMapping {
  id: string;
  combo: string;
  label: string;
  payload: string;
}

const KEYMAP_KEY = 'tf.keymap';

export function loadKeymap(): KeyMapping[] {
  try {
    const raw = localStorage.getItem(KEYMAP_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as KeyMapping[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.combo === 'string' && typeof m.payload === 'string') : [];
  } catch {
    return [];
  }
}

export function saveKeymap(list: KeyMapping[]): void {
  localStorage.setItem(KEYMAP_KEY, JSON.stringify(list));
}

import type { ClipboardEntry } from '../shared/shortcuts';

const CLIPBOARD_KEY = 'tf.clipboard';

export function loadClipboardHistory(): ClipboardEntry[] {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ClipboardEntry[];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.text === 'string') : [];
  } catch {
    return [];
  }
}

export function saveClipboardHistory(list: ClipboardEntry[]): void {
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(list));
}

export function escapePayload(payload: string): string {
  return payload
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\e/g, '\x1b')
    .replace(/\\c-([a-z])/gi, (_, c: string) => String.fromCharCode(c.charCodeAt(0) - 96));
}
