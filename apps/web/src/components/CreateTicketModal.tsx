import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from './Modal';
import { GitHubReconnectBanner } from './GitHubReconnectBanner';
import { fetchIntegrations, createTicket, renderMockupJsx, GitHubTokenExpiredError } from '../lib/api';
import type { Ticket } from '../lib/api';

interface RepoOption {
  owner: string;
  name: string;
  fullName: string;
}

interface CreateTicketModalProps {
  open: boolean;
  onClose: () => void;
  documentId: string;
  teamId: string;
  documentTitle: string;
  documentContent: string;
  mockupJsx?: string | null;
}

export function CreateTicketModal({
  open,
  onClose,
  documentId,
  teamId,
  documentTitle,
  documentContent,
  mockupJsx,
}: CreateTicketModalProps) {
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(documentTitle);
  const [body, setBody] = useState('');
  const [provider, setProvider] = useState<'github' | 'jira'>('github');
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);
  const [createdTicket, setCreatedTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);

  // Pre-fill fields when modal opens
  useEffect(() => {
    if (open) {
      setTitle(documentTitle);
      let initialBody = documentContent.length > 500
        ? documentContent.slice(0, 500) + '...'
        : documentContent;
      if (mockupJsx) {
        initialBody += '\n\n---\n_A UI mockup will be attached as an image after ticket creation._';
      }
      setBody(initialBody);
      setSelectedRepo(null);
      setCreatedTicket(null);
      setError(null);
      setTokenExpired(false);
    }
  }, [open, documentTitle, documentContent, mockupJsx]);

  const { data: integrations, isLoading: integrationsLoading } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => fetchIntegrations(teamId),
    enabled: open,
  });

  const availableProviders = (integrations ?? [])
    .map((i) => i.type)
    .filter((t): t is 'github' | 'jira' => t === 'github' || t === 'jira');

  // Derive available GitHub repos from the GitHub integration config
  const githubIntegration = (integrations ?? []).find((i) => i.type === 'github');
  const availableRepos: RepoOption[] = githubIntegration
    ? ((githubIntegration.config as { selectedRepos?: RepoOption[] }).selectedRepos ?? [])
    : [];

  // Set initial provider when integrations load
  useEffect(() => {
    if (availableProviders.length > 0 && !availableProviders.includes(provider)) {
      setProvider(availableProviders[0]);
    }
  }, [availableProviders, provider]);

  // Set default repo when GitHub repos load
  useEffect(() => {
    if (availableRepos.length > 0 && selectedRepo === null) {
      setSelectedRepo(availableRepos[0]);
    }
  }, [availableRepos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const mutation = useMutation({
    mutationFn: () =>
      createTicket(documentId, {
        provider,
        title,
        body,
        repo: provider === 'github' && selectedRepo ? selectedRepo : undefined,
      }),
    onSuccess: async (ticket) => {
      queryClient.invalidateQueries({ queryKey: ['tickets', documentId] });
      setCreatedTicket(ticket);
      setError(null);

      // Render and attach mockup image if available (fire-and-forget)
      if (mockupJsx) {
        try {
          const { screenshot } = await renderMockupJsx(mockupJsx);
          // Attach as image comment via mockups/attach endpoint
          await fetch('/api/mockups/attach-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              screenshot,
              provider,
              issueId: ticket.externalId,
              teamId,
            }),
          });
        } catch {
          // Non-critical — ticket was already created
        }
      }

      // Auto-close after showing success
      setTimeout(() => {
        setCreatedTicket(null);
        onClose();
      }, 2500);
    },
    onError: (err: Error) => {
      if (err instanceof GitHubTokenExpiredError) {
        setTokenExpired(true);
        setError(null);
      } else {
        setError(err.message || 'Failed to create ticket');
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  };

  const hasIntegrations = availableProviders.length > 0;

  return (
    <Modal open={open} onClose={onClose} title="Create Ticket">
      {integrationsLoading ? (
        <p className="text-sm text-slate-500">Loading integrations...</p>
      ) : !hasIntegrations ? (
        <div className="text-center py-6">
          <p className="text-sm text-slate-600 mb-2">
            No integrations configured.
          </p>
          <p className="text-xs text-slate-400">
            Go to <span className="font-medium text-slate-600">Settings</span> to
            connect GitHub or Jira.
          </p>
        </div>
      ) : createdTicket ? (
        <div className="text-center py-6">
          <div className="mb-2 text-green-600">
            <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900 mb-1">Ticket created!</p>
          <a
            href={createdTicket.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:text-blue-700 underline"
          >
            View on {createdTicket.provider === 'github' ? 'GitHub' : 'Jira'}
          </a>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Provider selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Provider
            </label>
            <div className="flex gap-4">
              {availableProviders.map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={provider === p}
                    onChange={() => setProvider(p)}
                    className="accent-blue-600"
                  />
                  {p === 'github' ? 'GitHub' : 'Jira'}
                </label>
              ))}
            </div>
          </div>

          {/* Repo selector — shown only for GitHub when multiple repos are configured */}
          {provider === 'github' && availableRepos.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Repository
              </label>
              <select
                value={selectedRepo?.fullName ?? ''}
                onChange={(e) => {
                  const repo = availableRepos.find((r) => r.fullName === e.target.value) ?? null;
                  setSelectedRepo(repo);
                }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                data-testid="repo-selector"
              >
                {availableRepos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Description
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
          </div>

          {/* GitHub token expired */}
          {tokenExpired && (
            <GitHubReconnectBanner />
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !title.trim()}
              className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Ticket'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
