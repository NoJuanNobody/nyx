import { useState, useCallback, useEffect, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTeams, fetchApiKeys, createApiKey, revokeApiKey, type ApiKey,
  fetchTeamMembers, updateTeamMemberRole, removeTeamMember, inviteTeamMember,
  fetchTeamInvitations, cancelInvitation, type TeamInvitation,
  fetchIntegrations, deleteIntegration, testIntegration,
  updateProfile, deleteAccount,
  fetchPlans, fetchCurrentSubscription, createCheckoutSession, createPortalSession,
  type SubscriptionPlan, type Subscription,
  fetchTeamAiKeyStatus, addTeamAiKey, rotateTeamAiKey, removeTeamAiKey,
  fetchTeamAiUsage, type TeamAiKeyStatus, type AiUsageSummary,
  fetchModels, setTeamModel, type ModelInfo,
  startIntegrationOAuth,
} from '../lib/api';
import { useAuthStore } from '../stores/auth.store';
import { Portal } from '../components/Portal';
import { SlackIntegration } from '../components/SlackIntegration';
import { AtlassianIntegration } from '../components/AtlassianIntegration';
import { NotificationPreferences } from '../components/NotificationPreferences';

// ── Types ────────────────────────────────────────────────────────────

type SettingsTab = 'team' | 'integrations' | 'api-keys' | 'ai-config' | 'notifications' | 'billing' | 'account';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
  avatarUrl?: string;
  joinedAt: string;
}

interface Integration {
  id: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'jira' | 'confluence';
  label: string;
  description: string;
  connected: boolean;
  account?: string;
  connectedAt?: string;
}

const ROLES: TeamMember['role'][] = ['owner', 'admin', 'developer', 'editor', 'viewer'];

const ROLE_COLORS: Record<TeamMember['role'], string> = {
  owner: 'bg-amber-50 text-amber-700 ring-amber-200',
  admin: 'bg-violet-50 text-violet-700 ring-violet-200',
  developer: 'bg-blue-50 text-blue-700 ring-blue-200',
  editor: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  viewer: 'bg-slate-50 text-slate-500 ring-slate-200',
};

// ── Tab Navigation ───────────────────────────────────────────────────

const TABS: { key: SettingsTab; label: string; icon: ReactElement }[] = [
  {
    key: 'team',
    label: 'Team',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
      </svg>
    ),
  },
  {
    key: 'integrations',
    label: 'Integrations',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
      </svg>
    ),
  },
  {
    key: 'api-keys',
    label: 'API Keys',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
      </svg>
    ),
  },
  {
    key: 'ai-config',
    label: 'AI Configuration',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
      </svg>
    ),
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
      </svg>
    ),
  },
  {
    key: 'billing',
    label: 'Billing',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
      </svg>
    ),
  },
  {
    key: 'account',
    label: 'Account',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
  },
];

// ── Provider Icons ───────────────────────────────────────────────────

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

function JiraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005Zm5.723-5.756H5.723a5.215 5.215 0 0 0 5.215 5.215h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.005-1.005h.017ZM23.013 0H11.441a5.218 5.218 0 0 0 5.216 5.215h2.129v2.058A5.218 5.218 0 0 0 24 12.488V1.005A1.005 1.005 0 0 0 22.996 0h.017Z" />
    </svg>
  );
}

function ConfluenceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.498-.868.763-1.353 1.657-3.06 3.35-2.694 6.39-1.168l4.79 2.4a.764.764 0 0 0 1.023-.383l2.367-5.28a.764.764 0 0 0-.382-1.005c-1.263-.595-3.47-1.642-4.79-2.298-5.372-2.667-9.725-2.53-15.676 3.808ZM23.131 5.743c.248-.382.53-.875.763-1.245a.764.764 0 0 0-.255-1.04L18.674.404a.764.764 0 0 0-1.058.26c-.2.332-.499.868-.764 1.353-1.657 3.06-3.35 2.694-6.39 1.168L5.672.785a.764.764 0 0 0-1.023.383L2.282 6.449a.764.764 0 0 0 .382 1.005c1.263.595 3.47 1.642 4.79 2.298 5.372 2.667 9.725 2.53 15.677-3.809Z" />
    </svg>
  );
}

function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="m23.6 9.593-1.248-3.856-2.478-7.643a.455.455 0 0 0-.862 0l-2.478 7.643H7.466L4.988-1.906a.454.454 0 0 0-.862 0L1.648 5.737.4 9.593a.906.906 0 0 0 .328 1.013L12 18.9l11.272-8.294a.906.906 0 0 0 .328-1.013" />
    </svg>
  );
}

function BitbucketIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.892L.778 1.213zM14.52 15.53H9.522L8.17 8.466h7.561l-1.21 7.064z" />
    </svg>
  );
}

const PROVIDER_ICON: Record<string, (props: { className?: string }) => ReactElement> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  bitbucket: BitbucketIcon,
  jira: JiraIcon,
  confluence: ConfluenceIcon,
};

const PROVIDER_COLORS: Record<string, { bg: string; text: string; ring: string; btn: string }> = {
  github: { bg: 'bg-slate-900', text: 'text-white', ring: 'ring-slate-300', btn: 'bg-slate-900 hover:bg-slate-800 text-white' },
  gitlab: { bg: 'bg-orange-600', text: 'text-white', ring: 'ring-orange-200', btn: 'bg-orange-600 hover:bg-orange-700 text-white' },
  bitbucket: { bg: 'bg-blue-700', text: 'text-white', ring: 'ring-blue-200', btn: 'bg-blue-700 hover:bg-blue-800 text-white' },
  jira: { bg: 'bg-blue-600', text: 'text-white', ring: 'ring-blue-200', btn: 'bg-blue-600 hover:bg-blue-700 text-white' },
  confluence: { bg: 'bg-blue-500', text: 'text-white', ring: 'ring-blue-200', btn: 'bg-blue-500 hover:bg-blue-600 text-white' },
};

// ── Team Panel ───────────────────────────────────────────────────────

function TeamPanel() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const setCurrentTeamId = useAuthStore((s) => s.setCurrentTeamId);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamMember['role']>('editor');
  const [inviteSent, setInviteSent] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);

  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: ['team-members', currentTeamId],
    queryFn: () => fetchTeamMembers(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const { data: invitationsData } = useQuery({
    queryKey: ['team-invitations', currentTeamId],
    queryFn: () => fetchTeamInvitations(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const pendingInvitations = invitationsData?.invitations ?? [];

  const cancelInviteMutation = useMutation({
    mutationFn: (invId: string) => cancelInvitation(currentTeamId!, invId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team-invitations', currentTeamId] }),
  });

  const members: TeamMember[] = (membersData?.members ?? []).map((m) => ({
    id: m.userId,
    name: m.userName,
    email: m.userEmail,
    role: m.role as TeamMember['role'],
    joinedAt: m.joinedAt,
  }));

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      updateTeamMemberRole(currentTeamId!, userId, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team-members', currentTeamId] }),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeTeamMember(currentTeamId!, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team-members', currentTeamId] }),
  });

  const [inviteResultMsg, setInviteResultMsg] = useState('');

  const inviteMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: string }) =>
      inviteTeamMember(currentTeamId!, email, role),
    onSuccess: (data: { type?: string }) => {
      setInviteSent(true);
      setInviteResultMsg(data.type === 'added' ? 'Added to team!' : 'Invitation created!');
      setTimeout(() => { setInviteSent(false); setInviteResultMsg(''); }, 2500);
      setInviteEmail('');
      queryClient.invalidateQueries({ queryKey: ['team-members', currentTeamId] });
      queryClient.invalidateQueries({ queryKey: ['team-invitations', currentTeamId] });
    },
  });

  const handleInvite = useCallback(async () => {
    if (!inviteEmail.trim()) return;
    
    // If no team exists, create one first
    if (!currentTeamId) {
      setCreatingTeam(true);
      try {
        // Trigger team creation by fetching teams (backend auto-creates)
        const teams = await fetchTeams();
        if (teams.length > 0) {
          setCurrentTeamId(teams[0].id);
          // Wait a bit for state to update
          setTimeout(() => {
            inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole });
            setCreatingTeam(false);
          }, 100);
        } else {
          alert('Failed to create team. Please refresh the page and try again.');
          setCreatingTeam(false);
        }
      } catch (error) {
        console.error('Failed to create team:', error);
        alert('Error creating team. Please try again.');
        setCreatingTeam(false);
      }
      return;
    }
    
    inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole });
  }, [inviteEmail, inviteRole, currentTeamId, inviteMutation, setCurrentTeamId]);

  const handleRoleChange = useCallback((memberId: string, newRole: TeamMember['role']) => {
    roleMutation.mutate({ userId: memberId, role: newRole });
  }, [roleMutation]);

  const handleRemove = useCallback((memberId: string) => {
    removeMutation.mutate(memberId);
  }, [removeMutation]);

  return (
    <div className="space-y-6">
      {/* Invite form */}
      <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4">
        <h3 className="text-sm font-semibold text-slate-800">Invite a team member</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          They'll receive an email invitation to join your workspace.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as TeamMember['role'])}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          >
            {ROLES.filter((r) => r !== 'owner').map((role) => (
              <option key={role} value={role}>
                {role.charAt(0).toUpperCase() + role.slice(1)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleInvite}
            disabled={!inviteEmail.trim() || creatingTeam}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {creatingTeam ? 'Creating workspace...' : 'Invite'}
          </button>
        </div>
        {inviteSent && (
          <p className="mt-2 text-xs font-medium text-green-600">
            {inviteResultMsg || 'Done!'}
          </p>
        )}
      </div>

      {/* Pending invitations */}
      {pendingInvitations.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/30 overflow-hidden">
          <div className="border-b border-amber-100 bg-amber-50/70 px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-500">
              {pendingInvitations.length} pending invitation{pendingInvitations.length !== 1 && 's'}
            </span>
          </div>
          <ul className="divide-y divide-amber-100">
            {pendingInvitations.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-600">
                  {inv.email.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">{inv.email}</span>
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                      Pending
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${ROLE_COLORS[inv.role as TeamMember['role']] ?? ROLE_COLORS.viewer}`}>
                      {inv.role}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Invited {new Date(inv.createdAt).toLocaleDateString()} &middot; Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => cancelInviteMutation.mutate(inv.id)}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                  title="Cancel invitation"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Member list */}
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {members.length} member{members.length !== 1 && 's'}
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50/50"
            >
              {/* Avatar */}
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-600">
                {member.name.charAt(0).toUpperCase()}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 truncate">{member.name}</span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${ROLE_COLORS[member.role]}`}>
                    {member.role}
                  </span>
                </div>
                <p className="text-xs text-slate-400 truncate">{member.email}</p>
              </div>

              {/* Actions */}
              {member.role !== 'owner' && (
                <div className="flex items-center gap-2">
                  <select
                    value={member.role}
                    onChange={(e) => handleRoleChange(member.id, e.target.value as TeamMember['role'])}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  >
                    {ROLES.filter((r) => r !== 'owner').map((role) => (
                      <option key={role} value={role}>
                        {role.charAt(0).toUpperCase() + role.slice(1)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleRemove(member.id)}
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    title="Remove member"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
                    </svg>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Integrations Panel ───────────────────────────────────────────────

function IntegrationsPanel() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const teams = useAuthStore((s) => s.teams);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  // Debug: Log team state on mount and when it changes
  useEffect(() => {
    console.log('[IntegrationsPanel] currentTeamId:', currentTeamId);
    console.log('[IntegrationsPanel] teams:', teams);
  }, [currentTeamId, teams]);

  const { data: rawIntegrations } = useQuery({
    queryKey: ['integrations', currentTeamId],
    queryFn: () => fetchIntegrations(currentTeamId!),
    enabled: !!currentTeamId,
  });

  // Map API integrations to display format, merged with static provider info
  const STATIC_PROVIDERS: Integration[] = [
    { id: '', provider: 'github', label: 'GitHub', description: 'Sync repositories, detect code drift, and push tickets as issues.', connected: false },
    { id: '', provider: 'gitlab', label: 'GitLab', description: 'Connect GitLab repos (cloud or self-hosted), create issues, and receive push webhooks.', connected: false },
    { id: '', provider: 'bitbucket', label: 'Bitbucket', description: 'Connect Bitbucket Cloud repos, create issues, and receive push webhooks.', connected: false },
    { id: '', provider: 'jira', label: 'Jira', description: 'Push change proposal tickets directly to your Jira project boards.', connected: false },
    { id: '', provider: 'confluence', label: 'Confluence', description: 'Import existing documentation and keep Confluence pages in sync.', connected: false },
  ];

  const integrations: Integration[] = STATIC_PROVIDERS.map((sp) => {
    const found = rawIntegrations?.find((ri) => ri.type === sp.provider);
    if (found) {
      const cfg = found.config as Record<string, string>;
      const account = cfg.githubUsername ?? cfg.gitlabUsername ?? cfg.bitbucketUsername ?? cfg.account;
      return { ...sp, id: found.id, connected: true, account, connectedAt: found.createdAt };
    }
    return sp;
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => deleteIntegration(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['integrations', currentTeamId] }),
  });

  const handleConnect = useCallback(async (provider: string) => {
    setConnectError(null);

    if (!currentTeamId) {
      console.error(`[${provider} Connect] currentTeamId is missing:`, currentTeamId);
      setConnectError('No team selected. Please refresh the page and try again.');
      return;
    }

    const paths: Record<string, string> = {
      github: `/integrations/github/connect?teamId=${currentTeamId}`,
      gitlab: `/integrations/gitlab/connect?teamId=${currentTeamId}`,
      bitbucket: `/integrations/bitbucket/connect?teamId=${currentTeamId}`,
      jira: `/integrations/atlassian/auth?teamId=${currentTeamId}`,
      confluence: `/integrations/atlassian/auth?teamId=${currentTeamId}`,
    };

    const path = paths[provider];
    if (path) {
      setConnecting(provider);
      try {
        const url = await startIntegrationOAuth(path);
        window.location.href = url;
      } catch (err) {
        setConnecting(null);
        setConnectError(err instanceof Error ? err.message : 'Failed to start OAuth flow');
      }
      return;
    }
    setConnecting(provider);
    setTimeout(() => setConnecting(null), 1500);
  }, [currentTeamId]);

  const handleDisconnect = useCallback((integrationId: string) => {
    disconnectMutation.mutate(integrationId);
  }, [disconnectMutation]);

  return (
    <div className="space-y-4">
      {/* Debug panel - only show if no team is loaded */}
      {!currentTeamId && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 flex-shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800">No Team Found</h3>
              <p className="mt-1 text-sm text-red-700">
                {teams.length === 0
                  ? 'You need a team to use integrations. Click below to create your workspace.'
                  : 'Team information is loading. Please wait or refresh the page.'}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
                >
                  Refresh Page
                </button>
                <button
                  type="button"
                  onClick={() => setShowDebug(!showDebug)}
                  className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
                >
                  {showDebug ? 'Hide' : 'Show'} Debug Info
                </button>
              </div>
              {showDebug && (
                <div className="mt-3 rounded bg-red-100 p-3 font-mono text-xs text-red-900 overflow-auto max-h-60">
                  <div><strong>currentTeamId:</strong> {currentTeamId || 'null'}</div>
                  <div className="mt-1"><strong>teams.length:</strong> {teams.length}</div>
                  {teams.length > 0 && (
                    <div className="mt-1"><strong>teams:</strong> {JSON.stringify(teams, null, 2)}</div>
                  )}
                  <div className="mt-2 pt-2 border-t border-red-200">
                    <strong>What to do:</strong>
                    <ol className="mt-1 list-decimal list-inside space-y-1 text-[11px]">
                      <li>Open browser console (F12) and look for errors</li>
                      <li>Check Network tab for failed /api/teams request</li>
                      <li>Try logging out and logging back in</li>
                      <li>Contact support if issue persists</li>
                    </ol>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {connectError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 flex-shrink-0 text-red-500 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800">Connection Error</h3>
              <p className="mt-1 text-sm text-red-700">{connectError}</p>
            </div>
            <button
              type="button"
              onClick={() => setConnectError(null)}
              className="text-red-400 hover:text-red-600 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {integrations.map((integration) => {
        const Icon = PROVIDER_ICON[integration.provider];
        const colors = PROVIDER_COLORS[integration.provider];
        const isConnecting = connecting === integration.provider;

        return (
          <div
            key={integration.provider}
            className={`rounded-lg border overflow-hidden transition-all ${
              integration.connected
                ? 'border-green-200 bg-green-50/30'
                : 'border-slate-200 bg-white'
            }`}
          >
            <div className="flex items-start gap-4 p-4">
              {/* Provider icon */}
              <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${colors.bg} ${colors.text}`}>
                <Icon className="h-5 w-5" />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{integration.label}</span>
                  {integration.connected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      Connected
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{integration.description}</p>
                {integration.connected && integration.account && (
                  <p className="mt-1.5 text-xs text-slate-400">
                    Account: <span className="font-mono text-slate-600">{integration.account}</span>
                    {integration.connectedAt && (
                      <> &middot; Connected {new Date(integration.connectedAt).toLocaleDateString()}</>
                    )}
                  </p>
                )}
              </div>

              {/* Action */}
              <div className="flex flex-shrink-0 items-center gap-2">
                {integration.connected && (['github', 'gitlab', 'bitbucket'] as const).includes(integration.provider as 'github' | 'gitlab' | 'bitbucket') && (
                  <Link
                    to="/app/repositories"
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                  >
                    Select repositories →
                  </Link>
                )}
                {integration.connected ? (
                  <button
                    type="button"
                    onClick={() => handleDisconnect(integration.id)}
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-colors"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleConnect(integration.provider)}
                    disabled={isConnecting || !currentTeamId}
                    title={!currentTeamId ? 'Please wait for team to load or refresh the page' : undefined}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${colors.btn}`}
                  >
                    {isConnecting ? (
                      <span className="flex items-center gap-1.5">
                        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Connecting...
                      </span>
                    ) : !currentTeamId ? (
                      'Loading...'
                    ) : (
                      'Connect'
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Atlassian integration (Jira + Confluence) */}
      <AtlassianIntegration />

      {/* Slack integration */}
      <SlackIntegration />

    </div>
  );
}

// ── Account Panel ────────────────────────────────────────────────────

const CLERK_ACTIVE = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function AccountPanel() {
  const authUser = useAuthStore((s) => s.user);
  const [name, setName] = useState(authUser?.name ?? '');
  const [email, setEmail] = useState(authUser?.email ?? '');
  const [saved, setSaved] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const profileMutation = useMutation({
    mutationFn: () => updateProfile({ name, email }),
    onSuccess: (data) => {
      useAuthStore.getState().setUser({ ...authUser!, name: data.name, email: data.email });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAccount(),
    onSuccess: () => {
      useAuthStore.getState().clear();
      window.location.href = '/sign-in';
    },
  });

  const handleSaveProfile = useCallback(() => {
    profileMutation.mutate();
  }, [profileMutation]);

  const handleChangePassword = useCallback(async () => {
    setPasswordError('');
    if (!currentPassword) {
      setPasswordError('Current password is required.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }

    if (CLERK_ACTIVE) {
      try {
        // Use Clerk's password update — imported dynamically to avoid issues in dev mode
        const { useUser } = await import('@clerk/clerk-react');
        // Note: in a real component this would be a hook, but since we're in a callback
        // we call the Clerk API directly via the global clerk instance
        const clerkUser = (window as unknown as { Clerk?: { user?: { updatePassword: (p: { currentPassword: string; newPassword: string }) => Promise<void> } } }).Clerk?.user;
        if (clerkUser) {
          await clerkUser.updatePassword({ currentPassword, newPassword });
        }
      } catch (err) {
        setPasswordError(err instanceof Error ? err.message : 'Failed to update password.');
        return;
      }
    }

    setPasswordSaved(true);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setTimeout(() => setPasswordSaved(false), 2500);
  }, [currentPassword, newPassword, confirmPassword]);

  return (
    <div className="space-y-6">
      {/* Profile */}
      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-800">Profile</h3>
        <p className="mt-0.5 text-xs text-slate-500">Your public display name and contact email.</p>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Display name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSaveProfile}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 transition-colors"
          >
            Save changes
          </button>
          {saved && (
            <span className="text-xs font-medium text-green-600">Profile updated.</span>
          )}
        </div>
      </div>

      {/* Password — only shown when Clerk is active */}
      {CLERK_ACTIVE && (
      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-800">Change password</h3>
        <p className="mt-0.5 text-xs text-slate-500">Update your password. You'll need your current password to confirm.</p>
        <div className="mt-4 space-y-3 max-w-sm">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
        </div>
        {passwordError && (
          <p className="mt-2 text-xs font-medium text-red-500">{passwordError}</p>
        )}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleChangePassword}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            Update password
          </button>
          {passwordSaved && (
            <span className="text-xs font-medium text-green-600">Password changed.</span>
          )}
        </div>
      </div>
      )}

      {/* Danger zone */}
      <div className="rounded-lg border border-red-200 bg-red-50/30 p-4">
        <h3 className="text-sm font-semibold text-red-700">Danger zone</h3>
        <p className="mt-0.5 text-xs text-red-500/80">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        {!deleteConfirm ? (
          <button
            type="button"
            onClick={() => setDeleteConfirm(true)}
            className="mt-3 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
          >
            Delete account
          </button>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Confirm delete'}
            </button>
            <button
              type="button"
              onClick={() => setDeleteConfirm(false)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── API Keys Panel ──────────────────────────────────────────────────

function ApiKeysPanel() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // The MCP server prepends this to `/api/...` paths, so NYX_API_URL is the API
  // origin (no `/api`) — same value the web client derives API_BASE from.
  const apiOrigin = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
  const mcpConfig = createdKey
    ? JSON.stringify(
        {
          mcpServers: {
            nyx: {
              command: 'node',
              args: ['/absolute/path/to/nyx/packages/mcp-server/dist/index.js'],
              env: { NYX_API_KEY: createdKey, NYX_API_URL: apiOrigin },
            },
          },
        },
        null,
        2,
      )
    : '';

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });
  const teamId = teams?.[0]?.id;

  const { data: keys, isLoading } = useQuery({
    queryKey: ['api-keys', teamId],
    queryFn: () => fetchApiKeys(teamId!),
    enabled: !!teamId,
  });

  const createMutation = useMutation({
    mutationFn: (keyName: string) => createApiKey({ teamId: teamId!, name: keyName }),
    onSuccess: (data) => {
      setCreatedKey(data.key);
      setName('');
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => revokeApiKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const handleCopy = useCallback(() => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [createdKey]);

  const handleCopyConfig = useCallback(() => {
    if (mcpConfig) {
      navigator.clipboard.writeText(mcpConfig);
      setCopiedConfig(true);
      setTimeout(() => setCopiedConfig(false), 2000);
    }
  }, [mcpConfig]);

  const handleCreate = useCallback(() => {
    if (!name.trim()) return;
    setCreatedKey(null);
    createMutation.mutate(name.trim());
  }, [name, createMutation]);

  const activeKeys = keys?.filter((k) => !k.revoked) ?? [];
  const revokedKeys = keys?.filter((k) => k.revoked) ?? [];

  return (
    <div className="space-y-6">
      {/* Info */}
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4">
        <h3 className="text-sm font-semibold text-blue-800">API Keys for MCP Server</h3>
        <p className="mt-1 text-xs text-blue-600 leading-relaxed">
          API keys let external tools like Claude Code, Cursor, and Copilot access your Nyx
          workspace via the MCP server. Keys use the <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-[11px]">sd_</code> prefix.
        </p>
      </div>

      {/* Create form */}
      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-sm font-semibold text-slate-800">Create a new key</h3>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. Claude Code)"
            className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || createMutation.isPending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {createMutation.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>

        {/* Show newly created key */}
        {createdKey && (
          <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3">
            <p className="text-xs font-medium text-green-800 mb-1.5">
              Key created! Copy it now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-white px-3 py-1.5 font-mono text-xs text-slate-800 border border-green-200 select-all">
                {createdKey}
              </code>
              <button
                type="button"
                data-testid="copy-api-key"
                onClick={handleCopy}
                className="rounded-md border border-green-300 bg-white px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50 transition-colors"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            {/* Ready-to-paste MCP config — same `mcpServers` shape works for
                Claude Code (.mcp.json), Cursor, and Claude Desktop. */}
            <div className="mt-3 border-t border-green-200 pt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium text-green-800">
                  MCP config — paste into your client
                </p>
                <button
                  type="button"
                  data-testid="copy-mcp-config"
                  onClick={handleCopyConfig}
                  className="rounded-md border border-green-300 bg-white px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-50 transition-colors"
                >
                  {copiedConfig ? 'Copied!' : 'Copy config'}
                </button>
              </div>
              <pre className="overflow-x-auto rounded bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700 border border-green-200">
                {mcpConfig}
              </pre>
              <p className="mt-1.5 text-[11px] leading-relaxed text-green-700">
                Build the server first with{' '}
                <code className="rounded bg-green-100 px-1 py-0.5 font-mono">pnpm --filter @nyx/mcp-server build</code>,
                then set <code className="rounded bg-green-100 px-1 py-0.5 font-mono">args</code> to the absolute path of
                its <code className="rounded bg-green-100 px-1 py-0.5 font-mono">dist/index.js</code>. Add the block to
                your client config — Claude Code: <code className="rounded bg-green-100 px-1 py-0.5 font-mono">.mcp.json</code>;
                Cursor: Settings → MCP; Claude Desktop: <code className="rounded bg-green-100 px-1 py-0.5 font-mono">claude_desktop_config.json</code>.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Key list */}
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {isLoading ? 'Loading...' : `${activeKeys.length} active key${activeKeys.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {activeKeys.length === 0 && !isLoading ? (
          <div className="px-4 py-6 text-center text-xs text-slate-400">
            No API keys yet. Create one above to connect external tools.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {activeKeys.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{key.name}</span>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                      {key.keyPrefix}...
                    </code>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt && <> &middot; Last used {new Date(key.lastUsedAt).toLocaleDateString()}</>}
                    {key.expiresAt && <> &middot; Expires {new Date(key.expiresAt).toLocaleDateString()}</>}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revokeMutation.mutate(key.id)}
                  disabled={revokeMutation.isPending}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-40"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        {revokedKeys.length > 0 && (
          <>
            <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                {revokedKeys.length} revoked
              </span>
            </div>
            <ul className="divide-y divide-slate-100 opacity-50">
              {revokedKeys.map((key) => (
                <li key={key.id} className="flex items-center gap-3 px-4 py-2">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-slate-400 line-through">{key.name}</span>
                    <code className="ml-2 font-mono text-[10px] text-slate-300">{key.keyPrefix}...</code>
                  </div>
                  <span className="text-[10px] text-slate-300">revoked</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ── Billing Panel ────────────────────────────────────────────────────

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: 'bg-slate-100 text-slate-600',
  pro: 'bg-blue-100 text-blue-700',
  team: 'bg-violet-100 text-violet-700',
  enterprise: 'bg-amber-100 text-amber-700',
};

// ── AI Configuration Panel (BYOK) ─────────────────────────────────────

function AiConfigPanel() {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: fetchTeams });
  const teamId = teamsQuery.data?.[0]?.id;
  const userRole = teamsQuery.data?.[0]?.role;
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const keyStatusQuery = useQuery({
    queryKey: ['ai-key-status', teamId],
    queryFn: () => fetchTeamAiKeyStatus(teamId!),
    enabled: !!teamId,
  });

  const usageQuery = useQuery({
    queryKey: ['ai-usage', teamId],
    queryFn: () => fetchTeamAiUsage(teamId!),
    enabled: !!teamId,
  });

  const [showModal, setShowModal] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [modalProvider, setModalProvider] = useState('anthropic');
  const [modalApiKey, setModalApiKey] = useState('');
  const [modalError, setModalError] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  // Model picker state
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [fastModel, setFastModel] = useState<string | null>(null);
  const [modelDirty, setModelDirty] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [modelError, setModelError] = useState('');

  const handleAddOrRotate = useCallback(async () => {
    if (!teamId || !modalApiKey.trim()) return;
    setModalLoading(true);
    setModalError('');
    try {
      if (isRotating) {
        await rotateTeamAiKey(teamId, { apiKey: modalApiKey.trim() });
      } else {
        await addTeamAiKey(teamId, { provider: modalProvider, apiKey: modalApiKey.trim() });
      }
      queryClient.invalidateQueries({ queryKey: ['ai-key-status', teamId] });
      setShowModal(false);
      setModalApiKey('');
      setIsRotating(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save key';
      setModalError(message);
    } finally {
      setModalLoading(false);
    }
  }, [teamId, modalApiKey, modalProvider, isRotating, queryClient]);

  const handleRemove = useCallback(async () => {
    if (!teamId) return;
    try {
      await removeTeamAiKey(teamId);
      queryClient.invalidateQueries({ queryKey: ['ai-key-status', teamId] });
      setShowRemoveConfirm(false);
    } catch {
      // Ignore errors for now
    }
  }, [teamId, queryClient]);

  const keyStatus = keyStatusQuery.data;
  const usage = usageQuery.data;

  // Sync local model selection from server state (only while pristine)
  useEffect(() => {
    if (keyStatus && !modelDirty) {
      setDefaultModel(keyStatus.defaultModel ?? null);
      setFastModel(keyStatus.fastModel ?? null);
    }
  }, [keyStatus, modelDirty]);

  const handleSaveModel = useCallback(async () => {
    if (!teamId) return;
    setModelSaving(true);
    setModelError('');
    setModelSaved(false);
    try {
      await setTeamModel(teamId, { defaultModel, fastModel });
      queryClient.invalidateQueries({ queryKey: ['ai-key-status', teamId] });
      setModelDirty(false);
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 2500);
    } catch (err: unknown) {
      setModelError(err instanceof Error ? err.message : 'Failed to save model');
    } finally {
      setModelSaving(false);
    }
  }, [teamId, defaultModel, fastModel, queryClient]);

  const formatNumber = (n: number) => n.toLocaleString();

  const formatContext = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
  };

  const models = modelsQuery.data;

  return (
    <div data-testid="ai-config-panel" className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">AI Configuration</h2>
        <p className="mt-1 text-sm text-slate-500">
          Manage your team's AI provider key and monitor usage.
        </p>
      </div>

      {/* Key Status Card */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-medium text-slate-700 mb-3">API Key Status</h3>
        {keyStatus?.configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                Custom key active
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-500">Provider:</span>{' '}
                <span className="font-medium text-slate-900 capitalize">{keyStatus.provider}</span>
              </div>
              <div>
                <span className="text-slate-500">Key:</span>{' '}
                <span className="font-mono text-slate-900">****...{keyStatus.keySuffix}</span>
              </div>
              <div>
                <span className="text-slate-500">Added:</span>{' '}
                <span className="text-slate-900">
                  {keyStatus.createdAt ? new Date(keyStatus.createdAt).toLocaleDateString() : '-'}
                </span>
              </div>
              {keyStatus.rotatedAt && (
                <div>
                  <span className="text-slate-500">Last rotated:</span>{' '}
                  <span className="text-slate-900">
                    {new Date(keyStatus.rotatedAt).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
            {isAdmin && (
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => { setIsRotating(true); setShowModal(true); setModalApiKey(''); setModalError(''); }}
                  className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                  data-testid="rotate-key-btn"
                >
                  Rotate Key
                </button>
                <button
                  type="button"
                  onClick={() => setShowRemoveConfirm(true)}
                  className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50"
                  data-testid="remove-key-btn"
                >
                  Remove Key
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Using SyncDocs-managed AI. Your team's AI requests use the platform's shared key.
              Usage counts against your plan's AI quota.
            </p>
            {isAdmin && (
              <button
                type="button"
                onClick={() => { setIsRotating(false); setShowModal(true); setModalApiKey(''); setModalError(''); }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                data-testid="add-key-btn"
              >
                Add Your Own API Key
              </button>
            )}
            {!isAdmin && (
              <p className="text-xs text-slate-400 italic">
                Only admins can manage AI keys.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Usage Summary */}
      {usage && (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-medium text-slate-700 mb-3">Usage This Period (last 30 days)</h3>
          <div className="grid grid-cols-3 gap-4 text-sm mb-4">
            <div>
              <p className="text-slate-500">Input tokens</p>
              <p className="text-lg font-semibold text-slate-900">{formatNumber(usage.totalInputTokens)}</p>
            </div>
            <div>
              <p className="text-slate-500">Output tokens</p>
              <p className="text-lg font-semibold text-slate-900">{formatNumber(usage.totalOutputTokens)}</p>
            </div>
            <div>
              <p className="text-slate-500">Key source</p>
              <p className="text-lg font-semibold text-slate-900 uppercase">{usage.keySource ?? 'syncdocs'}</p>
            </div>
          </div>
          {usage.byOperation.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-slate-500 uppercase mb-2">Operation Breakdown</h4>
              <div className="divide-y divide-slate-100">
                {usage.byOperation.map((op) => (
                  <div key={op.operation} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-slate-700">{op.operation.replace(/_/g, ' ')}</span>
                    <span className="font-mono text-slate-500">
                      {formatNumber(op.inputTokens + op.outputTokens)} tokens
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Model Picker */}
      <div className="rounded-lg border border-slate-200 bg-white p-5" data-testid="model-picker">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-medium text-slate-700">Model</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Choose which model your team uses. The default model handles standard work; the fast
              model is used for lightweight, latency-sensitive tasks.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {modelSaved && (
              <span className="text-xs font-medium text-emerald-600" data-testid="model-saved">
                Saved
              </span>
            )}
            <button
              type="button"
              onClick={handleSaveModel}
              disabled={!isAdmin || !modelDirty || modelSaving}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="save-model-btn"
            >
              {modelSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {modelError && <p className="mb-3 text-sm text-red-600">{modelError}</p>}

        {modelsQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading models…</p>
        ) : modelsQuery.isError ? (
          <p className="text-sm text-red-600">Failed to load models.</p>
        ) : !models || models.length === 0 ? (
          <p className="text-sm text-slate-500">No models available.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 rounded-md border border-slate-200">
            {models.map((model: ModelInfo) => {
              const isDefault = defaultModel === model.id;
              const isFast = fastModel === model.id;
              return (
                <div
                  key={model.id}
                  data-testid="model-option"
                  className={`flex items-center justify-between gap-4 px-4 py-3 ${
                    isDefault ? 'bg-blue-50/60' : ''
                  }`}
                >
                  <button
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => {
                      setDefaultModel(model.id);
                      setModelDirty(true);
                      setModelSaved(false);
                    }}
                    className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{model.name}</span>
                      {isDefault && (
                        <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                          Default
                        </span>
                      )}
                      {isFast && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                          Fast
                        </span>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-slate-400">{model.id}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      <span>{formatContext(model.contextLength)} ctx</span>
                      <span>
                        ${model.promptPricePerM.toFixed(2)} / ${model.completionPricePerM.toFixed(2)} per 1M (in/out)
                      </span>
                      {model.paramsB != null && <span>{model.paramsB}B params</span>}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={!isAdmin}
                      onClick={() => {
                        setFastModel(isFast ? null : model.id);
                        setModelDirty(true);
                        setModelSaved(false);
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset disabled:cursor-not-allowed disabled:opacity-50 ${
                        isFast
                          ? 'bg-violet-600 text-white ring-violet-600'
                          : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50'
                      }`}
                      data-testid="model-fast-toggle"
                    >
                      {isFast ? 'Fast ✓' : 'Set fast'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!isAdmin && (
          <p className="mt-3 text-xs italic text-slate-400">Only admins can change the model.</p>
        )}
      </div>

      {/* Add/Rotate Key Modal */}
      {showModal && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" data-testid="ai-key-modal">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">
                {isRotating ? 'Rotate API Key' : 'Add API Key'}
              </h3>
              <button type="button" onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {!isRotating && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-700 mb-1">Provider</label>
                <select
                  value={modalProvider}
                  onChange={(e) => setModalProvider(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  data-testid="provider-select"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
            )}
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
              <input
                type="password"
                value={modalApiKey}
                onChange={(e) => setModalApiKey(e.target.value)}
                placeholder="Paste your full API key"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
                data-testid="api-key-input"
              />
              <p className="mt-1 text-xs text-slate-400">
                It will be encrypted and never shown again.
              </p>
            </div>
            {modalError && (
              <p className="mb-3 text-sm text-red-600" data-testid="modal-error">{modalError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddOrRotate}
                disabled={modalLoading || !modalApiKey.trim()}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="validate-save-btn"
              >
                {modalLoading ? 'Saving...' : 'Validate & Save'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Remove Confirmation Dialog */}
      {showRemoveConfirm && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl" data-testid="remove-confirm-dialog">
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Remove API Key</h3>
            <p className="text-sm text-slate-500 mb-4">
              Are you sure? Your team will fall back to SyncDocs-managed AI.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRemoveConfirm(false)}
                className="rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRemove}
                className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
                data-testid="confirm-remove-btn"
              >
                Remove Key
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
}

function BillingPanel() {
  const { user } = useAuthStore();
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: fetchTeams });
  const teamId = teamsQuery.data?.[0]?.id;

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: fetchPlans });
  const subQuery = useQuery({
    queryKey: ['subscription', teamId],
    queryFn: () => fetchCurrentSubscription(teamId!),
    enabled: !!teamId,
  });

  const checkoutMutation = useMutation({
    mutationFn: createCheckoutSession,
    onSuccess: (data) => {
      if (data.url && typeof data.url === 'string' && data.url.startsWith('https://') && data.url.includes('stripe.com')) {
        window.location.href = data.url;
      } else if (data.url) {
        console.warn('Blocked redirect to untrusted URL:', data.url);
      }
    },
  });

  const portalMutation = useMutation({
    mutationFn: createPortalSession,
    onSuccess: (data) => {
      if (data.url && typeof data.url === 'string' && data.url.startsWith('https://') && data.url.includes('stripe.com')) {
        window.location.href = data.url;
      } else if (data.url) {
        console.warn('Blocked redirect to untrusted URL:', data.url);
      }
    },
  });

  const currentPlan = subQuery.data?.plan ?? 'free';
  const plans = plansQuery.data ?? [];

  const handleUpgrade = (planId: string) => {
    if (!teamId) return;
    checkoutMutation.mutate({
      plan: planId,
      teamId,
      successUrl: `${window.location.origin}/app/settings?tab=billing&success=true`,
      cancelUrl: `${window.location.origin}/app/settings?tab=billing`,
    });
  };

  const handleManageBilling = () => {
    if (!teamId) return;
    portalMutation.mutate({
      teamId,
      returnUrl: `${window.location.origin}/app/settings?tab=billing`,
    });
  };

  if (plansQuery.isLoading || subQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current plan banner */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Current Plan</h3>
            <div className="mt-1 flex items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${PLAN_BADGE_COLORS[currentPlan] ?? PLAN_BADGE_COLORS.free}`}>
                {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
              </span>
              {subQuery.data?.status && subQuery.data.status !== 'active' && (
                <span className="text-xs text-amber-600">({subQuery.data.status})</span>
              )}
            </div>
            {subQuery.data?.currentPeriodEnd && (
              <p className="mt-1 text-xs text-slate-400">
                {subQuery.data.cancelAtPeriodEnd
                  ? `Cancels on ${new Date(subQuery.data.currentPeriodEnd).toLocaleDateString()}`
                  : `Renews on ${new Date(subQuery.data.currentPeriodEnd).toLocaleDateString()}`}
              </p>
            )}
          </div>
          {currentPlan !== 'free' && (
            <button
              type="button"
              onClick={handleManageBilling}
              disabled={portalMutation.isPending}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
            >
              {portalMutation.isPending ? 'Loading...' : 'Manage Billing'}
            </button>
          )}
        </div>
      </div>

      {/* Plan comparison cards */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Available Plans</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlan;
            const isEnterprise = plan.id === 'enterprise';

            return (
              <div
                key={plan.id}
                className={`relative rounded-lg border p-4 transition-shadow ${
                  isCurrent
                    ? 'border-blue-300 bg-blue-50/30 shadow-sm'
                    : 'border-slate-200 bg-white hover:shadow-sm'
                }`}
              >
                {isCurrent && (
                  <span className="absolute -top-2.5 left-3 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    Current
                  </span>
                )}

                <h4 className="text-sm font-semibold text-slate-800">{plan.name}</h4>

                <div className="mt-2">
                  {plan.price !== null ? (
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-slate-900">${plan.price}</span>
                      {plan.interval && (
                        <span className="text-xs text-slate-400">/{plan.interval}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-lg font-semibold text-slate-600">Contact us</span>
                  )}
                </div>

                <ul className="mt-3 space-y-1.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-1.5 text-xs text-slate-600">
                      <svg
                        className="mt-0.5 h-3 w-3 flex-shrink-0 text-green-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2.5}
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>

                <div className="mt-4">
                  {isCurrent ? (
                    <span className="block rounded-md bg-slate-100 px-3 py-1.5 text-center text-xs font-medium text-slate-400">
                      Current plan
                    </span>
                  ) : isEnterprise ? (
                    <a
                      href="mailto:sales@nyx.io"
                      className="block rounded-md border border-slate-200 bg-white px-3 py-1.5 text-center text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      Contact Sales
                    </a>
                  ) : plan.price === 0 ? (
                    <span className="block rounded-md bg-slate-50 px-3 py-1.5 text-center text-xs font-medium text-slate-400">
                      Free forever
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={checkoutMutation.isPending}
                      className="block w-full rounded-md bg-blue-600 px-3 py-1.5 text-center text-xs font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                    >
                      {checkoutMutation.isPending ? 'Redirecting...' : 'Upgrade'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Error display */}
      {(checkoutMutation.error || portalMutation.error) && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          {(checkoutMutation.error ?? portalMutation.error)?.message ?? 'Something went wrong'}
        </div>
      )}
    </div>
  );
}

// ── Settings Page ────────────────────────────────────────────────────

export function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('team');

  return (
    <>
      <div className="mb-6 flex-shrink-0">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage your team, integrations, and account preferences.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 gap-8">
        {/* Side nav */}
        <nav className="flex w-44 flex-shrink-0 flex-col gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors text-left ${
                activeTab === tab.key
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Panel */}
        <div className="flex-1 min-w-0 overflow-y-auto pr-1">
          {activeTab === 'team' && <TeamPanel />}
          {activeTab === 'integrations' && <IntegrationsPanel />}
          {activeTab === 'api-keys' && <ApiKeysPanel />}
          {activeTab === 'ai-config' && <AiConfigPanel />}
          {activeTab === 'notifications' && <NotificationPreferences />}
          {activeTab === 'billing' && <BillingPanel />}
          {activeTab === 'account' && <AccountPanel />}
        </div>
      </div>
    </>
  );
}
