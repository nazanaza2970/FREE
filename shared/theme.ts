import type { ITheme } from '@xterm/xterm';

export const XTERM_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export const DEFAULT_COLORS: Record<string, string> = {
  background: '#0d1117',
  foreground: '#f0f6fc',
  cursor: '#00e5a0',
  cursorAccent: '#0d1117',
  selectionBackground: '#123a2f',
  black: '#1a1d24',
  red: '#f07178',
  green: '#c3e88d',
  yellow: '#ffcb6b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#cdd3e0',
  brightBlack: '#5a6072',
  brightRed: '#ff5370',
  brightGreen: '#cbdc3f',
  brightYellow: '#ffcc00',
  brightBlue: '#3d8bfd',
  brightMagenta: '#ea5fff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff',
  accent: '#00e5a0',
};

export type ThemeColors = Record<string, string>;

export function toXtermTheme(colors: ThemeColors): ITheme {
  const t: Record<string, string> = {};
  for (const key of XTERM_COLOR_KEYS) {
    if (typeof colors[key] === 'string' && colors[key].length > 0) t[key] = colors[key];
  }
  return t as ITheme;
}

export function mergeColors(colors: ThemeColors): ThemeColors {
  return { ...DEFAULT_COLORS, ...colors };
}

export interface ThemeExport {
  name: string;
  colors: ThemeColors;
}

export function exportThemesJson(themes: ThemeExport[]): string {
  return JSON.stringify(themes, null, 2);
}

export function parseThemesImport(text: string): ThemeExport[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) throw new Error('no themes found');
  return arr.map((t) => {
    const theme = t as Partial<ThemeExport>;
    if (!theme || typeof theme.name !== 'string' || !theme.name) {
      throw new Error('each theme requires a "name"');
    }
    if (typeof theme.colors !== 'object' || theme.colors === null) {
      throw new Error(`theme "${theme.name}" requires a "colors" object`);
    }
    return { name: theme.name, colors: mergeColors(theme.colors as ThemeColors) };
  });
}
