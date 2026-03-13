import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth.store';

// ── Types ─────────────────────────────────────────────────────────────

type SyncStatus = 'active' | 'stale' | 'disconnected';

interface SyncedRepo {
  id: string;
  fullName: string;
  htmlUrl: string;
  syncStatus: SyncStatus;
  lastPushAt: string | null;
  webhookLastEventAt: string | null;
  linkedDocumentCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<SyncStatus, { label: string; className: string; description: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    description: 'webhook receiving events',
  },
  stale: {
    label: 'Stale',
    className: 'bg-amber-50 text-amber-700 ring-amber-200',
    description: 'no events in 7 days',
  },
  disconnected: {
    label: 'Disconnected',
    className: 'bg-red-50 text-red-600 ring-red-200',
    description: 'webhook unreachable',
  },
};

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SyncStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

function WebhookDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
        healthy ? 'bg-emerald-400' : 'bg-slate-300'
      }`}
      title={healthy ? 'Webhook active' : 'Webhook inactive'}
    />
  );
}

// ── Empty state ───────────────────────────────────────────────────────

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
      <svg
        className="mx-auto h-12 w-12 text-slate-300"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.25 9.75 16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25Z"
        />
      </svg>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">No repositories connected</h3>
      <p className="mt-1 text-sm text-slate-500">
        Connect GitHub to start detecting drift between your docs and code.
      </p>
      <button
        type="button"
        onClick={onConnect}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Connect GitHub
      </button>
    </div>
  );
}

// ── Repo row ──────────────────────────────────────────────────────────

function RepoRow({
  repo,
  onRemove,
  removing,
}: {
  repo: SyncedRepo;
  onRemove: (id: string) => void;
  removing: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const webhookHealthy = repo.syncStatus === 'active';

  return (
    <li
      className={`flex flex-wrap items-center gap-3 px-5 py-4 transition-colors hover:bg-slate-50 ${
        removing ? 'opacity-50' : ''
      }`}
    >
      {/* Repo name + metadata */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a
            href={repo.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-sm font-medium text-slate-900 hover:text-blue-600 hover:underline"
          >
            {repo.fullName}
          </a>
          <svg
            className="h-3 w-3 flex-shrink-0 text-slate-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
            />
          </svg>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <WebhookDot healthy={webhookHealthy} />
            Webhook {relativeTime(repo.webhookLastEventAt)}
          </span>
          <span>·</span>
          <span>Last push {relativeTime(repo.lastPushAt)}</span>
        </div>
      </div>

      {/* Status badge */}
      <StatusBadge status={repo.syncStatus} />

      {/* Linked docs */}
      <Link
        to={`/dashboard?repo=${encodeURIComponent(repo.fullName)}`}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        title="View linked documents"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
          />
        </svg>
        {repo.linkedDocumentCount} {repo.linkedDocumentCount === 1 ? 'doc' : 'docs'}
      </Link>

      {/* Remove action */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {confirmRemove ? (
          <>
            <span className="text-xs text-slate-500">Disconnect?</span>
            <button
              type="button"
              onClick={() => onRemove(repo.id)}
              disabled={removing}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors"
            title="Disconnect repository"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
              />
            </svg>
          </button>
        )}
      </div>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

export function Repositories() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { teams } = useAuthStore();
  const teamId = teams?.[0]?.id;

  const { data: repos, isLoading } = useQuery<SyncedRepo[]>({
    queryKey: ['github-repos', teamId],
    queryFn: async () => {
      // Will be replaced with real endpoint: GET /api/integrations/:id/github/repos/status
      const res = await fetch(`/api/teams/${teamId}/github/repos/status`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to load repositories');
      return res.json();
    },
    enabled: !!teamId,
  });

  const removeMutation = useMutation({
    mutationFn: async (repoId: string) => {
      const res = await fetch(`/api/teams/${teamId}/github/repos/${repoId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to disconnect repository');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['github-repos', teamId] });
    },
  });

  const handleConnect = () => navigate('/settings?tab=integrations');

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Repositories</h1>
          <p className="mt-1 text-sm text-slate-500">
            GitHub repositories synced for drift detection. Webhook events keep your docs in sync
            as code evolves.
          </p>
        </div>
        {repos && repos.length > 0 && (
          <button
            type="button"
            onClick={handleConnect}
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add repo
          </button>
        )}
      </div>

      {/* Summary bar — only when repos exist */}
      {repos && repos.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 px-4 py-2.5">
          {(['active', 'stale', 'disconnected'] as SyncStatus[]).map((status) => {
            const count = repos.filter((r) => r.syncStatus === status).length;
            if (count === 0) return null;
            const cfg = STATUS_CONFIG[status];
            return (
              <div key={status} className="flex items-center gap-1.5 text-xs">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${cfg.className}`}
                >
                  {cfg.label}
                </span>
                <span className="text-slate-500">
                  {count} {count === 1 ? 'repo' : 'repos'} — {cfg.description}
                </span>
              </div>
            );
          })}
          <span className="ml-auto text-xs text-slate-400">{repos.length} total</span>
        </div>
      )}

      {/* Main content */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading repositories…</div>
      ) : !repos || repos.length === 0 ? (
        <EmptyState onConnect={handleConnect} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                onRemove={(id) => removeMutation.mutate(id)}
                removing={removeMutation.isPending && removeMutation.variables === repo.id}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Help text */}
      {repos && repos.length > 0 && (
        <p className="mt-4 text-xs text-slate-400">
          Removing a repository disconnects the webhook and unlinks it from all documents.{' '}
          <button
            type="button"
            onClick={handleConnect}
            className="text-blue-500 hover:underline"
          >
            Manage GitHub connection
          </button>
        </p>
      )}
    </div>
  );
}
