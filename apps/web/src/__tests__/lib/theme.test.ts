import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ACCENT_KEY,
  ACCENT_PRESETS,
  THEME_KEY,
  accentById,
  applyAccent,
  applyTheme,
  loadAccent,
  loadTheme,
  saveAccent,
  saveTheme,
} from '../../lib/theme';

describe('theme persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('defaults to system and rejects garbage values', () => {
    expect(loadTheme()).toBe('system');
    localStorage.setItem(THEME_KEY, 'neon');
    expect(loadTheme()).toBe('system');
  });

  it('round-trips theme and accent', () => {
    saveTheme('dark');
    saveAccent('teal');
    expect(loadTheme()).toBe('dark');
    expect(loadAccent()).toBe('teal');
  });

  it('falls back to brand purple for unknown accents', () => {
    localStorage.setItem(ACCENT_KEY, 'chartreuse');
    expect(loadAccent()).toBe('purple');
    expect(accentById('nope').hue).toBe(287);
  });

  it('does not throw when storage is blocked', () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadTheme()).toBe('system');
    expect(loadAccent()).toBe('purple');
    expect(() => saveTheme('light')).not.toThrow();
    expect(() => saveAccent('rose')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('applying theme', () => {
  it('toggles the dark class and color-scheme', () => {
    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('system follows matchMedia', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: true, media: q }) as MediaQueryList,
    );
    expect(applyTheme('system')).toBe('dark');
    spy.mockRestore();
  });

  it('applyAccent sets the hue variable', () => {
    applyAccent('green');
    expect(document.documentElement.style.getPropertyValue('--accent-hue')).toBe('150');
  });

  it('has unique preset ids and hues in range', () => {
    expect(new Set(ACCENT_PRESETS.map((a) => a.id)).size).toBe(ACCENT_PRESETS.length);
    for (const a of ACCENT_PRESETS) expect(a.hue >= 0 && a.hue <= 360).toBe(true);
  });
});
