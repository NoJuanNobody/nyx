import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../../stores/ui.store.js';

describe('UI Store', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false, theme: 'system' });
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('setTheme("dark") adds dark class to documentElement, persists to localStorage', () => {
    useUIStore.getState().setTheme('dark');

    expect(useUIStore.getState().theme).toBe('dark');
    expect(localStorage.setItem).toHaveBeenCalledWith('syncdocs:theme', 'dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('setTheme("system") follows matchMedia preference', () => {
    // matchMedia mock returns matches: false (light mode)
    useUIStore.getState().setTheme('system');

    expect(useUIStore.getState().theme).toBe('system');
    expect(localStorage.setItem).toHaveBeenCalledWith('syncdocs:theme', 'system');
  });

  it('toggleSidebar inverts sidebarOpen state', () => {
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });
});
