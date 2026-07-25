import { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth.store';
import {
  fetchTeamTicketSuggestions,
  fetchTickets,
  syncAllTickets,
  updateTicketStatus,
  bulkApproveSuggestions,
  updateTicketSuggestion,
  dismissTicketSuggestion,
  fetchIntegrations,
  fetchJobStatus,
  markOnboardingStep,
  type Ticket,
  type TeamTicketSuggestion,
  type TicketDestination,
  type BulkApproveResult,
} from '../lib/api';
import { ClaudeInsightCard } from '../components/ClaudeInsightCard';

type ColumnStatus = 'open' | 'in_progress' | 'closed';

const PROVIDER_BADGE: Record<string, { label: string; className: string }> = {
  github: { label: 'GitHub', className: 'bg-slate-900 text-white' },
  gitlab: { label: 'GitLab', className: 'bg-orange-600 text-white' },
  bitbucket: { label: 'Bitbucket', className: 'bg-blue-700 text-white' },
  jira: { label: 'Jira', className: 'bg-blue-600 text-white' },
};

const STATUS_LABELS: Record<ColumnStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  closed: 'Closed',
};

const STATUS_BADGE: Record<ColumnStatus, string> = {
  open: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-amber-50 text-amber-700',
  closed: 'bg-green-50 text-green-700',
};

interface DestinationOption {
  value: string;
  label: string;
  destination: TicketDestination;
  providerGroup: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
};

// ── Generated tab ──────────────────────────────────────────────────────────

function GeneratedTab({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedDestination, setSelectedDestination] = useState<TicketDestination | null>(null);
  const [results, setResults] = useState<BulkApproveResult[] | null>(null);
  const [approveJobId, setApproveJobId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const { data: suggestions = [], isLoading } = useQuery({
    queryKey: ['team-ticket-suggestions', teamId],
    queryFn: () => fetchTeamTicketSuggestions(teamId),
    enabled: !!teamId,
  });

  const { data: integrations } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => fetchIntegrations(teamId),
    enabled: !!teamId,
  });

  const destinations: DestinationOption[] = (integrations ?? []).flatMap((integration: { type: string; config: Record<string, unknown> }) => {
    const type = integration.type as 'github' | 'gitlab' | 'bitbucket' | 'jira';
    if (type === 'jira') {
      const projectKey = (integration.config.projectKey as string) ?? '';
      if (!projectKey) return [];
      return [{
        value: `jira:${projectKey}`,
        label: projectKey,
        destination: { provider: 'jira' as const, identifier: projectKey },
        providerGroup: 'Jira',
      }];
    }
    if (type === 'github' || type === 'gitlab' || type === 'bitbucket') {
      const repos = (integration.config.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
      return repos.map((repo) => ({
        value: `${type}:${repo.fullName}`,
        label: repo.fullName,
        destination: { provider: type, identifier: repo.fullName },
        providerGroup: PROVIDER_LABELS[type] ?? type,
      }));
    }
    return [];
  });

  useEffect(() => {
    if (destinations.length > 0 && selectedDestination === null) {
      setSelectedDestination(destinations[0].destination);
    }
  }, [destinations.length, selectedDestination]);

  const pending = suggestions.filter((s) => s.status === 'pending');

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => setSelectedIds(new Set(pending.map((s) => s.id))), [pending]);
  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: { title?: string; description?: string } }) =>
      updateTicketSuggestion(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-ticket-suggestions', teamId] });
      setEditingId(null);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => dismissTicketSuggestion(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['team-ticket-suggestions', teamId] });
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    },
  });

  const bulkApproveMutation = useMutation({
    mutationFn: () => {
      if (!selectedDestination) return Promise.reject(new Error('No destination selected'));
      return bulkApproveSuggestions([...selectedIds], selectedDestination);
    },
    onSuccess: (data) => {
      setApproveJobId(data.jobId);
      const poll = setInterval(async () => {
        try {
          const job = await fetchJobStatus<BulkApproveResult[]>(data.jobId);
          if (job.status === 'completed' && job.result) {
            clearInterval(poll);
            setResults(job.result);
            setSelectedIds(new Set());
            setApproveJobId(null);
            queryClient.invalidateQueries({ queryKey: ['team-ticket-suggestions', teamId] });
            queryClient.invalidateQueries({ queryKey: ['tickets', teamId] });
          } else if (job.status === 'failed') {
            clearInterval(poll);
            setApproveJobId(null);
          }
        } catch {
          // keep polling
        }
      }, 2000);
    },
  });

  const startEdit = (s: TeamTicketSuggestion) => {
    setEditingId(s.id);
    setEditTitle(s.title);
    setEditDescription(s.description);
  };

  const saveEdit = (id: string) => {
    updateMutation.mutate({ id, updates: { title: editTitle, description: editDescription } });
  };

  const successCount = results?.filter((r) => r.success).length ?? 0;
  const failCount = results?.filter((r) => !r.success).length ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="tickets-generated-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="tickets-generated-tab">
      {/* Destination + bulk actions toolbar */}
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        {destinations.length === 0 ? (
          <span className="text-sm text-slate-400">No destinations connected — connect a repo or Jira project in Settings → Integrations.</span>
        ) : (
          <>
            <label className="text-sm font-medium text-slate-600 shrink-0">Post to:</label>
            <select
              data-testid="tickets-destination-selector"
              value={selectedDestination ? `${selectedDestination.provider}:${selectedDestination.identifier}` : ''}
              onChange={(e) => {
                const opt = destinations.find((d) => d.value === e.target.value);
                setSelectedDestination(opt?.destination ?? null);
              }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {Object.entries(
                destinations.reduce<Record<string, DestinationOption[]>>((acc, d) => {
                  (acc[d.providerGroup] ??= []).push(d);
                  return acc;
                }, {}),
              ).map(([group, opts]) => (
                <optgroup key={group} label={group}>
                  {opts.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={selectedIds.size === pending.length && pending.length > 0 ? deselectAll : selectAll}
            className="text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            {selectedIds.size === pending.length && pending.length > 0 ? 'Deselect All' : 'Select All'}
          </button>
          <span className="text-sm text-slate-400">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => bulkApproveMutation.mutate()}
            disabled={selectedIds.size === 0 || !selectedDestination || bulkApproveMutation.isPending || !!approveJobId || destinations.length === 0}
            data-testid="tickets-post-button"
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {(bulkApproveMutation.isPending || approveJobId) ? 'Posting...' : `Post ${selectedIds.size > 0 ? selectedIds.size : ''}`}
          </button>
        </div>
      </div>

      {/* Results banner */}
      {results && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center justify-between">
          <span className="text-sm">
            {successCount > 0 && <span className="font-medium text-green-700">{successCount} ticket{successCount !== 1 ? 's' : ''} created</span>}
            {successCount > 0 && failCount > 0 && <span className="text-slate-400"> / </span>}
            {failCount > 0 && <span className="font-medium text-red-600">{failCount} failed</span>}
          </span>
          <button type="button" onClick={() => setResults(null)} className="text-xs text-slate-500 hover:text-slate-700">Dismiss</button>
        </div>
      )}

      {/* Suggestion list */}
      {suggestions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 rounded-full bg-blue-50 p-4">
            <svg className="h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-700">No generated tickets yet</p>
          <p className="mt-1 text-xs text-slate-400">Open a document and generate tickets from its content.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {suggestions.map((s) => {
            const isPending = s.status === 'pending';
            const isApproved = s.status === 'approved';
            const isEditing = editingId === s.id;

            return (
              <div
                key={s.id}
                data-testid={`ticket-suggestion-${s.id}`}
                className={`rounded-lg border bg-white p-4 transition-all ${
                  isApproved ? 'opacity-60' : ''
                } ${
                  selectedIds.has(s.id) ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'
                }`}
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full rounded border border-slate-200 px-2 py-1 text-sm font-medium text-slate-900 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                      data-testid="ticket-edit-title"
                    />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      rows={3}
                      className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
                      data-testid="ticket-edit-description"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => saveEdit(s.id)}
                        disabled={updateMutation.isPending}
                        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {updateMutation.isPending ? 'Saving...' : 'Save'}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      disabled={!isPending}
                      onChange={() => toggleSelect(s.id)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-slate-900">{s.title}</p>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          isPending ? 'bg-yellow-50 text-yellow-700' : isApproved ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {s.status}
                        </span>
                      </div>
                      {s.documentTitle && (
                        <p className="mt-0.5 text-[11px] text-slate-400">{s.documentTitle}</p>
                      )}
                      <p className="mt-1 text-xs text-slate-500">
                        {s.description.length > 140 ? `${s.description.slice(0, 140)}…` : s.description}
                      </p>
                      {s.labels.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {s.labels.map((label) => (
                            <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{label}</span>
                          ))}
                        </div>
                      )}
                      {isPending && (
                        <div className="mt-2 flex gap-2">
                          <button type="button" onClick={() => startEdit(s)} className="text-[11px] font-medium text-blue-500 hover:text-blue-700" data-testid="ticket-edit-btn">Edit</button>
                          <button type="button" onClick={() => dismissMutation.mutate(s.id)} disabled={dismissMutation.isPending} className="text-[11px] font-medium text-red-400 hover:text-red-600 disabled:opacity-50" data-testid="ticket-dismiss-btn">Dismiss</button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Posted tab ────────────────────────────────────────────────────────────

function PostedTab({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const [providerFilter, setProviderFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['tickets', teamId, providerFilter, statusFilter],
    queryFn: () => fetchTickets(teamId, {
      provider: providerFilter || undefined,
      status: statusFilter || undefined,
    }),
    enabled: !!teamId,
  });

  const syncMutation = useMutation({
    mutationFn: () => syncAllTickets(teamId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tickets', teamId] }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ ticketId, status }: { ticketId: string; status: ColumnStatus }) =>
      updateTicketStatus(ticketId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tickets', teamId] }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="tickets-posted-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div data-testid="tickets-posted-tab">
      {/* Filter + sync toolbar */}
      <div className="mb-4 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          data-testid="tickets-status-filter"
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="closed">Closed</option>
        </select>
        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          data-testid="tickets-provider-filter"
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          <option value="">All providers</option>
          <option value="github">GitHub</option>
          <option value="jira">Jira</option>
        </select>
        {(providerFilter || statusFilter) && (
          <button type="button" onClick={() => { setProviderFilter(''); setStatusFilter(''); }} className="text-xs text-slate-400 hover:text-slate-600">
            Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-slate-400">{tickets.length} ticket{tickets.length !== 1 ? 's' : ''}</span>
        <button
          type="button"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="tickets-sync-button"
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {syncMutation.isPending ? 'Syncing...' : 'Sync All'}
        </button>
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 rounded-full bg-slate-100 p-4">
            <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-700">No posted tickets yet</p>
          <p className="mt-1 text-xs text-slate-400">Post a generated ticket to see it here.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {tickets.map((ticket: Ticket) => {
            const badge = PROVIDER_BADGE[ticket.provider] ?? { label: ticket.provider, className: 'bg-slate-200 text-slate-700' };
            const status = ticket.status as ColumnStatus;

            return (
              <div key={ticket.id} className="flex items-start gap-4 px-4 py-3 hover:bg-slate-50 transition-colors" data-testid={`posted-ticket-${ticket.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.className}`}>{badge.label}</span>
                    <p className="text-sm font-medium text-slate-800 truncate">{ticket.title}</p>
                  </div>
                  {ticket.documentTitle && (
                    <a href={`/app/documents/${ticket.documentId}`} className="mt-0.5 block text-[11px] text-blue-500 hover:text-blue-700 truncate">
                      {ticket.documentTitle}
                    </a>
                  )}
                  {ticket.repoName && (
                    <p className="mt-0.5 text-[11px] text-slate-400 truncate">{ticket.repoName}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[status] ?? 'bg-slate-100 text-slate-500'}`}>
                    {STATUS_LABELS[status] ?? status}
                  </span>
                  <select
                    value={ticket.status}
                    onChange={(e) => statusMutation.mutate({ ticketId: ticket.id, status: e.target.value as ColumnStatus })}
                    className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600 outline-none focus:border-blue-400"
                    data-testid={`ticket-status-select-${ticket.id}`}
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="closed">Closed</option>
                  </select>
                  <a
                    href={ticket.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-slate-400 hover:text-blue-500 whitespace-nowrap"
                  >
                    #{ticket.externalId} ↗
                  </a>
                </div>
                {ticket.provider === 'github' && (
                  <div className="shrink-0">
                    <ClaudeInsightCard ticketId={ticket.id} insight={ticket.claudeInsights ?? null} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────

type Tab = 'generated' | 'posted';

export function Tickets() {
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [activeTab, setActiveTab] = useState<Tab>('generated');

  useEffect(() => {
    markOnboardingStep('board-visited').catch(() => {});
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto min-h-0">
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="tickets-title">Tickets</h1>
            <p className="mt-1 text-sm text-slate-500">Manage generated and posted tickets across your team.</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex gap-1 border-b border-slate-200">
          <button
            type="button"
            onClick={() => setActiveTab('generated')}
            data-testid="tickets-tab-generated"
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'generated'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            Generated
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('posted')}
            data-testid="tickets-tab-posted"
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === 'posted'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            Posted
          </button>
        </div>

        {currentTeamId && activeTab === 'generated' && <GeneratedTab teamId={currentTeamId} />}
        {currentTeamId && activeTab === 'posted' && <PostedTab teamId={currentTeamId} />}
      </div>
    </div>
  );
}
