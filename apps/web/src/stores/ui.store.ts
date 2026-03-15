import { create } from 'zustand';

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

function loadTheme(): Theme {
  return (localStorage.getItem('nyx:theme') as Theme) ?? 'system';
}

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

// Apply theme immediately on module load (before first render)
const initialTheme = loadTheme();
applyTheme(initialTheme);

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  theme: initialTheme,
  setTheme: (theme) => {
    localStorage.setItem('nyx:theme', theme);
    applyTheme(theme);
    set({ theme });
  },
}));

// Re-apply when system preference changes (only matters when theme === 'system')
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { theme } = useUIStore.getState();
  if (theme === 'system') {
    applyTheme('system');
  }
});
