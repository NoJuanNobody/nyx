/**
 * Theme + accent helpers. Pure functions and safe storage only; the zustand
 * store (stores/ui.store.ts) and <ThemeProvider> build on top of this.
 *
 * public/theme-init.js duplicates the tiny read path (storage keys, hue
 * range) to avoid a flash of the wrong theme before the bundle loads.
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'nyx:theme';
export const ACCENT_KEY = 'nyx:accent';

export interface AccentPreset {
  id: string;
  label: string;
  /** OKLCH hue in degrees; drives the whole --color-blue-* scale. */
  hue: number;
}

/** Brand purple first. All presets are checked for WCAG AA in contrast.test.ts. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'purple', label: 'Purple', hue: 287 },
  { id: 'indigo', label: 'Indigo', hue: 265 },
  { id: 'blue', label: 'Blue', hue: 250 },
  { id: 'teal', label: 'Teal', hue: 200 },
  { id: 'green', label: 'Green', hue: 150 },
  { id: 'rose', label: 'Rose', hue: 5 },
  { id: 'orange', label: 'Orange', hue: 50 },
];

export const DEFAULT_ACCENT = ACCENT_PRESETS[0].id;

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function accentById(id: string | null | undefined): AccentPreset {
  return ACCENT_PRESETS.find((a) => a.id === id) ?? ACCENT_PRESETS[0];
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage / quota: theme still applies for this session.
  }
}

export function loadTheme(): Theme {
  const v = readStorage(THEME_KEY);
  return isTheme(v) ? v : 'system';
}

export function saveTheme(theme: Theme): void {
  writeStorage(THEME_KEY, theme);
}

export function loadAccent(): string {
  return accentById(readStorage(ACCENT_KEY)).id;
}

export function saveAccent(id: string): void {
  writeStorage(ACCENT_KEY, accentById(id).id);
}

export function getSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme;
}

export function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  return resolved;
}

export function applyAccent(id: string): AccentPreset {
  const preset = accentById(id);
  document.documentElement.style.setProperty('--accent-hue', String(preset.hue));
  return preset;
}
