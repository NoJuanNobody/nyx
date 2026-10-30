import { useEffect, type ReactNode } from 'react';
import { useUIStore } from '../stores/ui.store';
import { ACCENT_KEY, THEME_KEY, applyAccent, applyTheme, isTheme, loadAccent } from '../lib/theme';

/**
 * Keeps the DOM in sync with the theme store: follows the OS while
 * theme === 'system', and picks up changes made in another window
 * (storage event). Initial paint is handled by public/theme-init.js and
 * the store's module-load apply, so this renders no UI of its own.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && isTheme(e.newValue)) {
        useUIStore.setState({ theme: e.newValue });
      } else if (e.key === ACCENT_KEY) {
        useUIStore.setState({ accent: loadAccent() });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return <>{children}</>;
}
