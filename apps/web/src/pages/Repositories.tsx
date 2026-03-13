import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchIntegrations, fetchSyncedRepos, disconnectRepo, type SyncedRepo } from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

function StatusBadge({ status }: { status: SyncedRepo['syncStatus'] }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Disconnected
    </span>
  );
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function Repositories() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);

  const { data: rawIntegrations, isLoading: integrationsLoading } = useQuery({
    queryKey: ['integrations', currentTeamId],
    queryFn: () => fetchIntegrations(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const githubIntegration = rawIntegrations?.find((ri) => ri.type === 'github');

  const { data: syncedData, isLoading: reposLoading } = useQuery({
    queryKey: ['synced-repos', githubIntegration?.id],
    queryFn: () => fetchSyncedRepos(githubIntegration!.id),
    enabled: !!githubIntegration?.id,
  });

  const disconnectMutation = useMutation({
    mutationFn: (repoFullName: string) => disconnectRepo(githubIntegration!.id, repoFullName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['synced-repos'] });
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      setConfirmDisconnect(null);
    },
  });

  const repos = syncedData?.repos ?? [];
  const isLoading = integrationsLoading || reposLoading;

  const handleDisconnect = useCallback((fullName: string) => {
    if (confirmDisconnect === fullName) {
      disconnectMutation.mutate(fullName);
    } else {
      setConfirmDisconnect(fullName);
    }
  }, [confirmDisconnect, disconnectMutation]);

  // Empty state — no GitHub integration connected
  if (!isLoading && !githubIntegration) {
    return (
      <>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Repositories</h1>
          <p className="mt-1 text-sm text-slate-500">
            View and manage your synced GitHub repositories.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-12 text-center">
          <svg className="mx-auto h-12 w-12 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
          </svg>
          <h3 className="mt-3 text-sm font-semibold text-slate-800">No GitHub integration</h3>
          <p className="mt-1 text-xs text-slate-500">
            Connect your GitHub account to start syncing repositories.
          </p>
          <Link
            to="/settings"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            Go to Integrations
          </Link>
        </div>
      </>
    );
  }

  // Empty state — GitHub connected but no repos selected
  if (!isLoading && repos.length === 0) {
    return (
      <>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Repositories</h1>
          <p className="mt-1 text-sm text-slate-500">
            View and manage your synced GitHub repositories.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-12 text-center">
          <svg className="mx-auto h-12 w-12 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
          </svg>
          <h3 className="mt-3 text-sm font-semibold text-slate-800">No repositories synced</h3>
          <p className="mt-1 text-xs text-slate-500">
            Select repositories to monitor from Settings.
          </p>
          <Link
            to="/settings"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            Manage Repos
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Repositories</h1>
        <p className="mt-1 text-sm text-slate-500">
          View and manage your synced GitHub repositories.
        </p>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-slate-200 bg-white p-12 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
          <p className="mt-3 text-xs text-slate-400">Loading repositories...</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_120px_80px_100px] gap-4 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Repository</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Status</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Last Push</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Docs</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 text-right">Actions</span>
          </div>

          {/* Repo rows */}
          <ul className="divide-y divide-slate-100">
            {repos.map((repo) => (
              <li
                key={repo.fullName}
                className="grid grid-cols-[1fr_100px_120px_80px_100px] gap-4 items-center px-4 py-3 hover:bg-slate-50/50 transition-colors"
              >
                {/* Repo name */}
                <div className="min-w-0">
                  <a
                    href={`https://github.com/${repo.fullName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline truncate block"
                  >
                    {repo.fullName}
                  </a>
                </div>

                {/* Status */}
                <div>
                  <StatusBadge status={repo.syncStatus} />
                </div>

                {/* Last push */}
                <div className="text-xs text-slate-500">
                  {repo.lastPushAt ? timeAgo(repo.lastPushAt) : (
                    <span className="text-slate-300">No pushes</span>
                  )}
                </div>

                {/* Linked docs */}
                <div className="text-xs text-slate-600 font-medium">
                  {repo.linkedDocCount > 0 ? (
                    <span>{repo.linkedDocCount} doc{repo.linkedDocCount !== 1 ? 's' : ''}</span>
                  ) : (
                    <span className="text-slate-300">0</span>
                  )}
                </div>

                {/* Actions */}
                <div className="text-right">
                  {confirmDisconnect === repo.fullName ? (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleDisconnect(repo.fullName)}
                        disabled={disconnectMutation.isPending}
                        className="rounded px-2 py-1 text-[10px] font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                      >
                        {disconnectMutation.isPending ? '...' : 'Yes'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDisconnect(null)}
                        className="rounded px-2 py-1 text-[10px] font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleDisconnect(repo.fullName)}
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-medium text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
