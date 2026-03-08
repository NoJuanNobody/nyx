import { create } from 'zustand';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  imageUrl?: string;
}

export interface AuthTeam {
  id: string;
  name: string;
  role: string;
}

interface AuthState {
  user: AuthUser | null;
  currentTeamId: string | null;
  teams: AuthTeam[];
  isLoading: boolean;
  setUser: (user: AuthUser | null) => void;
  setCurrentTeamId: (id: string) => void;
  setTeams: (teams: AuthTeam[]) => void;
  clear: () => void;
}

function loadTeamId(): string | null {
  return localStorage.getItem('syncdocs:currentTeamId');
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  currentTeamId: loadTeamId(),
  teams: [],
  isLoading: true,
  setUser: (user) => set({ user }),
  setCurrentTeamId: (id) => {
    localStorage.setItem('syncdocs:currentTeamId', id);
    set({ currentTeamId: id });
  },
  setTeams: (teams) => set({ teams }),
  clear: () => {
    localStorage.removeItem('syncdocs:currentTeamId');
    set({ user: null, currentTeamId: null, teams: [], isLoading: false });
  },
}));
