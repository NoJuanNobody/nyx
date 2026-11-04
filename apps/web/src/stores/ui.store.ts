import { create } from 'zustand';
import {
  applyAccent,
  applyTheme,
  loadAccent,
  loadTheme,
  saveAccent,
  saveTheme,
  type Theme,
} from '../lib/theme';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: string;
  setAccent: (id: string) => void;
  seeding: boolean;
  setSeeding: (seeding: boolean) => void;
  activeLifecycleSlug: string;
  setActiveLifecycleSlug: (slug: string) => void;
}

// Apply theme immediately on module load (before first render)
const initialTheme = loadTheme();
applyTheme(initialTheme);
const initialAccent = loadAccent();
applyAccent(initialAccent);

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  sidebarCollapsed: false,
  toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  theme: initialTheme,
  setTheme: (theme) => {
    saveTheme(theme);
    applyTheme(theme);
    set({ theme });
  },
  accent: initialAccent,
  setAccent: (id) => {
    saveAccent(id);
    applyAccent(id);
    set({ accent: id });
  },
  seeding: false,
  setSeeding: (seeding) => set({ seeding }),
  activeLifecycleSlug: safeGet('nyx:activeLifecycle') ?? 'software_development',
  setActiveLifecycleSlug: (slug) => {
    try {
      localStorage.setItem('nyx:activeLifecycle', slug);
    } catch {
      // storage unavailable
    }
    set({ activeLifecycleSlug: slug });
  },
}));
