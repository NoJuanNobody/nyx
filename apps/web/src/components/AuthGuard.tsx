import { useEffect } from 'react';
import { useNavigate, Navigate, Outlet } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAuthStore } from '../stores/auth.store';
import { API_BASE, setAuthTokenGetter, fetchTeams } from '../lib/api';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/** Fetches /api/auth/me for dev bypass mode */
async function fetchDevUser() {
  // Use API_BASE — a relative '/api/...' resolves against the frontend origin
  // (Vercel) now that the proxy rewrite is gone, and 404s.
  const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch dev user');
  return res.json();
}

function ClerkAuthGuard() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user: clerkUser } = useUser();
  const navigate = useNavigate();
  const { setUser, setTeams, setCurrentTeamId, currentTeamId, isLoading, user } = useAuthStore();

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;

    if (!isSignedIn) {
      if (import.meta.env.DEV) {
        (async () => {
          try {
            const [devUser, teams] = await Promise.all([fetchDevUser(), fetchTeams()]);
            if (cancelled) return;
            setUser({
              id: devUser.id,
              name: devUser.name,
              email: devUser.email,
              role: devUser.role,
              imageUrl: devUser.avatarUrl ?? undefined,
            });
            setTeams(teams.map((t) => ({ id: t.id, name: t.name, role: (t as Record<string, string>).role ?? 'viewer' })));
            if (!currentTeamId && teams.length > 0) {
              setCurrentTeamId(teams[0].id);
            }
            useAuthStore.setState({ isLoading: false });
            return;
          } catch {
            if (!cancelled) navigate('/sign-in', { replace: true });
          }
        })();
        return () => { cancelled = true; };
      }
      navigate('/sign-in', { replace: true });
      return;
    }

    // Set up auth token for API requests
    // Register the token getter so every API request gets a fresh token
    setAuthTokenGetter(() => getToken());
    (async () => {
      if (cancelled) return;

      if (clerkUser) {
        setUser({
          id: clerkUser.id,
          name: clerkUser.fullName ?? clerkUser.primaryEmailAddress?.emailAddress ?? '',
          email: clerkUser.primaryEmailAddress?.emailAddress ?? '',
          role: 'owner',
          imageUrl: clerkUser.imageUrl,
        });
      }

      try {
        const teams = await fetchTeams();
        if (cancelled) return;
        const mappedTeams = teams.map((t) => ({ id: t.id, name: t.name, role: (t as Record<string, string>).role ?? 'viewer' }));
        setTeams(mappedTeams);
        const hasValidCurrent = currentTeamId && mappedTeams.some((t) => t.id === currentTeamId);
        if (!hasValidCurrent && mappedTeams.length > 0) {
          // Prefer a team the user was invited to over an auto-created personal workspace
          const invitedTeam = mappedTeams.find((t) => !(t.name === 'My Workspace' && t.role === 'owner')) ?? mappedTeams[0];
          setCurrentTeamId(invitedTeam.id);
        }
      } catch {
        // teams fetch can fail in early setup
      }

      useAuthStore.setState({ isLoading: false });
    })();

    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, clerkUser]);

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (!isSignedIn && !user) {
    if (import.meta.env.DEV && isLoading) {
      return (
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      );
    }
    return <Navigate to="/sign-in" replace />;
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return <Outlet />;
}

function DevAuthGuard() {
  const { setUser, setTeams, setCurrentTeamId, currentTeamId, user } = useAuthStore();

  useEffect(() => {
    if (user) return;

    let cancelled = false;
    (async () => {
      try {
        // Fetch user and teams in parallel to avoid race condition where
        // setUser triggers re-render and cancels the teams fetch
        const [devUser, teams] = await Promise.all([fetchDevUser(), fetchTeams()]);
        if (cancelled) return;
        setUser({
          id: devUser.id,
          name: devUser.name,
          email: devUser.email,
          role: devUser.role,
          imageUrl: devUser.avatarUrl ?? undefined,
        });
        setTeams(teams.map((t) => ({ id: t.id, name: t.name, role: (t as Record<string, string>).role ?? 'viewer' })));
        if (!currentTeamId && teams.length > 0) {
          setCurrentTeamId(teams[0].id);
        }
      } catch {
        // In dev mode, just continue
      }

      useAuthStore.setState({ isLoading: false });
    })();

    return () => { cancelled = true; };
  }, [user]);

  return <Outlet />;
}

export function AuthGuard() {
  return CLERK_ENABLED ? <ClerkAuthGuard /> : <DevAuthGuard />;
}
