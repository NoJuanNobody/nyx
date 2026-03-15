import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { getInvitation, acceptInvitation, setAuthTokenGetter } from '../lib/api';

const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// ── Shared UI ──────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
    </div>
  );
}

function ErrorCard({ onHome }: { onHome: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
          <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-900">Invitation Not Found</h2>
        <p className="mt-2 text-sm text-slate-500">
          This invitation link is invalid or has been revoked.
        </p>
        <button
          type="button"
          onClick={onHome}
          className="mt-6 inline-flex items-center rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 transition-colors"
        >
          Go to Home
        </button>
      </div>
    </div>
  );
}

interface InvitationData {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  teamName: string;
}

function InvitationCard({
  invitation,
  isSignedIn,
  onAccept,
  isAccepting,
  acceptError,
  onClearError,
  onSignUp,
  onSignIn,
  onDashboard,
}: {
  invitation: InvitationData;
  isSignedIn: boolean;
  onAccept: () => void;
  isAccepting: boolean;
  acceptError: string | null;
  onClearError: () => void;
  onSignUp: () => void;
  onSignIn: () => void;
  onDashboard: () => void;
}) {
  const isExpired = new Date(invitation.expiresAt) < new Date();
  const isAlreadyAccepted = invitation.status === 'accepted';
  const isPending = invitation.status === 'pending';

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        {/* Header */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
            <svg className="h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900">Team Invitation</h1>
          <p className="mt-1 text-sm text-slate-500">
            You have been invited to join a team on Nyx.
          </p>
        </div>

        {/* Invitation Details */}
        <div className="mt-6 rounded-lg border border-slate-100 bg-slate-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Team</span>
            <span className="text-sm font-medium text-slate-900">{invitation.teamName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Role</span>
            <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200 capitalize">
              {invitation.role}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Invited as</span>
            <span className="text-sm text-slate-700">{invitation.email}</span>
          </div>
          {!isExpired && !isAlreadyAccepted && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Expires</span>
              <span className="text-sm text-slate-700">
                {new Date(invitation.expiresAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {/* Status-dependent content */}
        <div className="mt-6">
          {isExpired && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
              <p className="text-sm font-medium text-amber-800">This invitation has expired.</p>
              <p className="mt-1 text-xs text-amber-600">
                Please ask a team admin to send a new invitation.
              </p>
            </div>
          )}

          {isAlreadyAccepted && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center">
              <p className="text-sm font-medium text-green-800">This invitation has already been accepted.</p>
              <button
                type="button"
                onClick={onDashboard}
                className="mt-3 inline-flex items-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors"
              >
                Go to Dashboard
              </button>
            </div>
          )}

          {isPending && !isExpired && !isSignedIn && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={onSignUp}
                className="w-full rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:from-blue-600 hover:to-violet-600 transition-all"
              >
                Sign up to accept
              </button>
              <button
                type="button"
                onClick={onSignIn}
                className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Already have an account? Sign in
              </button>
            </div>
          )}

          {isPending && !isExpired && isSignedIn && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  onClearError();
                  onAccept();
                }}
                disabled={isAccepting}
                className="w-full rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:from-blue-600 hover:to-violet-600 disabled:opacity-50 transition-all"
              >
                {isAccepting ? 'Accepting...' : 'Accept Invitation'}
              </button>

              {acceptError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
                  <p className="text-sm text-red-700">{acceptError}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Clerk-enabled version ──────────────────────────────────────────

function ClerkAcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const { data: invitation, isLoading, error } = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => getInvitation(token!),
    enabled: !!token,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      // Ensure the auth token getter is set so the request helper includes the Bearer token
      setAuthTokenGetter(() => getToken());
      return acceptInvitation(token!);
    },
    onSuccess: () => {
      navigate('/dashboard', { replace: true });
    },
    onError: (err: Error) => {
      setAcceptError(err.message);
    },
  });

  if (!isLoaded || isLoading) return <Spinner />;
  if (error || !invitation) return <ErrorCard onHome={() => navigate('/')} />;

  const redirectUrl = `/invite/${token}`;

  return (
    <InvitationCard
      invitation={invitation}
      isSignedIn={!!isSignedIn}
      onAccept={() => acceptMutation.mutate()}
      isAccepting={acceptMutation.isPending}
      acceptError={acceptError}
      onClearError={() => setAcceptError(null)}
      onSignUp={() => navigate(`/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`)}
      onSignIn={() => navigate(`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`)}
      onDashboard={() => navigate('/dashboard', { replace: true })}
    />
  );
}

// ── Dev (no Clerk) version ─────────────────────────────────────────

function DevAcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const { data: invitation, isLoading, error } = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => getInvitation(token!),
    enabled: !!token,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () => acceptInvitation(token!),
    onSuccess: () => {
      navigate('/dashboard', { replace: true });
    },
    onError: (err: Error) => {
      setAcceptError(err.message);
    },
  });

  if (isLoading) return <Spinner />;
  if (error || !invitation) return <ErrorCard onHome={() => navigate('/')} />;

  return (
    <InvitationCard
      invitation={invitation}
      isSignedIn={true}
      onAccept={() => acceptMutation.mutate()}
      isAccepting={acceptMutation.isPending}
      acceptError={acceptError}
      onClearError={() => setAcceptError(null)}
      onSignUp={() => navigate('/')}
      onSignIn={() => navigate('/')}
      onDashboard={() => navigate('/dashboard', { replace: true })}
    />
  );
}

// ── Export ──────────────────────────────────────────────────────────

export function AcceptInvite() {
  return CLERK_ENABLED ? <ClerkAcceptInvite /> : <DevAcceptInvite />;
}
