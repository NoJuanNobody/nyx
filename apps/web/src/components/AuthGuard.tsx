import { useEffect } from 'react';
import { useNavigate, Outlet } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useAuthStore } from '../stores/auth.store';
import { setAuthToken, fetchTeams } from '../lib/api';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/** Fetches /api/auth/me for dev bypass mode */
async function fetchDevUser() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) throw new Error('Failed to fetch dev user');
  return res.json();
}

function ClerkAuthGuard() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user: clerkUser } = useUser();
  const navigate = useNavigate();
  const { setUser, setTeams, setCurrentTeamId, currentTeamId } = useAuthStore();

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      navigate('/sign-in', { replace: true });
      return;
    }

    // Set up auth token for API requests
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (cancelled) return;
      setAuthToken(token);

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
        setTeams(teams.map((t) => ({ id: t.id, name: t.name, role: (t as Record<string, string>).role ?? 'viewer' })));
        if (!currentTeamId && teams.length > 0) {
          setCurrentTeamId(teams[0].id);
        }
      } catch {
        // teams fetch can fail in early setup
      }

      useAuthStore.setState({ isLoading: false });
    })();

    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, clerkUser]);

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return <Outlet />;
}

function DevAuthGuard() {
  const navigate = useNavigate();
  const { setUser, setTeams, setCurrentTeamId, currentTeamId, user } = useAuthStore();

  useEffect(() => {
    if (user) return;

    let cancelled = false;
    (async () => {
      try {
        const devUser = await fetchDevUser();
        if (cancelled) return;
        setUser({
          id: devUser.id,
          name: devUser.name,
          email: devUser.email,
          role: devUser.role,
          imageUrl: devUser.avatarUrl ?? undefined,
        });

        const teams = await fetchTeams();
        if (cancelled) return;
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
