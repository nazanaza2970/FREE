export interface KeyCombo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export function parseCombo(combo: string): KeyCombo {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const result: KeyCombo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts) {
    if (p === 'ctrl') result.ctrl = true;
    else if (p === 'shift') result.shift = true;
    else if (p === 'alt') result.alt = true;
    else if (p === 'meta' || p === 'cmd' || p === 'super') result.meta = true;
    else result.key = p;
  }
  if (!result.key) throw new Error(`combo "${combo}" needs a key`);
  return result;
}

export function comboMatches(combo: string, e: KeyboardEvent): boolean {
  let c: KeyCombo;
  try {
    c = parseCombo(combo);
  } catch {
    return false;
  }
  return c.ctrl === e.ctrlKey && c.shift === e.shiftKey && c.alt === e.altKey && c.meta === e.metaKey && c.key === e.key.toLowerCase();
}

export interface ClipboardEntry {
  text: string;
  at: number;
}

export function pushClipboardHistory(list: ClipboardEntry[], text: string, max = 20): ClipboardEntry[] {
  const t = text.trim();
  if (!t) return list;
  const rest = list.filter((x) => x.text !== t);
  return [{ text: t, at: Date.now() }, ...rest].slice(0, max);
}
