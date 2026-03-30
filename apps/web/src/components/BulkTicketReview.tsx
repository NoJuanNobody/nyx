import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  fetchTicketSuggestions,
  generateBulkSuggestions,
  generateFolderTicketSuggestions,
  bulkApproveSuggestions,
  updateTicketSuggestion,
  dismissTicketSuggestion,
  fetchIntegrations,
  fetchJobStatus,
} from '../lib/api';
import type { TicketSuggestion, BulkApproveResult } from '../lib/api';

interface RepoOption { owner: string; name: string; fullName: string; }
import { TicketSuggestionDetail } from './TicketSuggestionDetail';

interface BulkTicketReviewProps {
  documentId: string;
  teamId: string;
  open: boolean;
  onClose: () => void;
  /** When provided, generates suggestions for all documents in this folder instead of a single document */
  folderPath?: string;
}

export function BulkTicketReview({ documentId, teamId, open, onClose, folderPath }: BulkTicketReviewProps) {
  const queryClient = useQueryClient();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [provider, setProvider] = useState<'github' | 'jira'>('github');
  const [results, setResults] = useState<BulkApproveResult[] | null>(null);
  const [detailSuggestionId, setDetailSuggestionId] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<RepoOption | null>(null);

  const [folderSuggestions, setFolderSuggestions] = useState<TicketSuggestion[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);

  const { data: docSuggestions = [], isLoading } = useQuery({
    queryKey: ['ticket-suggestions', documentId],
    queryFn: () => fetchTicketSuggestions(documentId),
    enabled: open && !folderPath,
  });

  const suggestions = folderPath ? folderSuggestions : docSuggestions;

  const { data: integrations } = useQuery({
    queryKey: ['integrations', teamId],
    queryFn: () => fetchIntegrations(teamId),
    enabled: open,
  });

  const githubIntegration = (integrations ?? []).find((i: { type: string }) => i.type === 'github');
  const availableRepos: RepoOption[] = githubIntegration
    ? ((githubIntegration.config as { selectedRepos?: RepoOption[] }).selectedRepos ?? [])
    : [];

  useEffect(() => {
    if (availableRepos.length > 0 && selectedRepo === null) {
      setSelectedRepo(availableRepos[0]);
    }
  }, [availableRepos, selectedRepo]);

  const generateMutation = useMutation({
    mutationFn: () =>
      folderPath
        ? generateFolderTicketSuggestions(teamId, folderPath)
        : generateBulkSuggestions(documentId),
    onSuccess: (data) => {
      if (folderPath && data && 'jobId' in data) {
        setJobId(data.jobId);
      } else {
        queryClient.invalidateQueries({ queryKey: ['ticket-suggestions', documentId] });
      }
    },
  });

  const { data: jobStatus } = useQuery({
    queryKey: ['job-status', jobId],
    queryFn: () => fetchJobStatus<TicketSuggestion[]>(jobId!),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'completed' || status === 'failed') return false;
      return 2000;
    },
  });

  useEffect(() => {
    if (!jobStatus || !jobId) return;
    if (jobStatus.status === 'completed' && jobStatus.result) {
      setFolderSuggestions(jobStatus.result);
      setJobId(null);
    } else if (jobStatus.status === 'failed') {
      setJobId(null);
    }
  }, [jobStatus, jobId]);

  const [approveJobId, setApproveJobId] = useState<string | null>(null);

  const bulkApproveMutation = useMutation({
    mutationFn: () => bulkApproveSuggestions([...selectedIds], provider, selectedRepo ? { owner: selectedRepo.owner, name: selectedRepo.name } : undefined),
    onSuccess: (data) => {
      setApproveJobId(data.jobId);
      // Poll until completed
      const poll = setInterval(async () => {
        try {
          const job = await fetchJobStatus<BulkApproveResult[]>(data.jobId);
          if (job.status === 'completed' && job.result) {
            clearInterval(poll);
            setResults(job.result);
            // Update folder suggestions to reflect approved status
            const approvedIds = new Set(job.result.filter(r => r.success).map(r => r.suggestionId));
            setFolderSuggestions(prev => prev.map(s =>
              approvedIds.has(s.id) ? { ...s, status: 'approved' as const } : s
            ));
            setSelectedIds(new Set());
            setApproveJobId(null);
            queryClient.invalidateQueries({ queryKey: ['ticket-suggestions', documentId] });
          } else if (job.status === 'failed') {
            clearInterval(poll);
            setApproveJobId(null);
          }
        } catch {
          // keep polling on network errors
        }
      }, 2000);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: { title?: string; description?: string } }) =>
      updateTicketSuggestion(id, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ticket-suggestions', documentId] }),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => dismissTicketSuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ticket-suggestions', documentId] });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(dismissMutation.variables!);
        return next;
      });
    },
  });

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const pendingSuggestions = suggestions.filter((s) => s.status === 'pending');

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(pendingSuggestions.map((s) => s.id)));
  }, [pendingSuggestions]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const detailSuggestion = suggestions.find((s) => s.id === detailSuggestionId) ?? null;

  const handleDetailSave = useCallback(
    (id: string, updates: { title?: string; description?: string }) => {
      updateMutation.mutate({ id, updates });
    },
    [updateMutation],
  );

  const handleDetailDismiss = useCallback(
    (id: string) => {
      dismissMutation.mutate(id);
      setDetailSuggestionId(null);
    },
    [dismissMutation],
  );

  const handleDetailApprove = useCallback(
    (id: string) => {
      setSelectedIds(new Set([id]));
      bulkApproveMutation.mutate();
      setDetailSuggestionId(null);
    },
    [bulkApproveMutation],
  );

  const successCount = results?.filter((r) => r.success).length ?? 0;
  const failCount = results?.filter((r) => !r.success).length ?? 0;

  if (!open) return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Modal content */}
      <div className="fixed inset-4 z-50 flex rounded-2xl bg-white shadow-2xl overflow-hidden">
        {/* Main panel (list) */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Header */}
          <div className="flex flex-shrink-0 items-center gap-4 border-b border-slate-200 px-6 py-4">
            <h2 className="text-lg font-semibold text-slate-900">Bulk Ticket Generation</h2>

            <div className="ml-auto flex items-center gap-3">
              {/* Repo selector — shown only for GitHub when multiple repos are configured */}
              {provider === 'github' && availableRepos.length > 0 && (
                <select
                  value={selectedRepo?.fullName ?? ''}
                  onChange={(e) => {
                    const repo = availableRepos.find((r) => r.fullName === e.target.value) ?? null;
                    setSelectedRepo(repo);
                  }}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  data-testid="bulk-repo-selector"
                >
                  {availableRepos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              )}

              {/* Provider selector */}
              <div className="flex rounded-lg border border-slate-200 p-0.5">
                <button
                  type="button"
                  onClick={() => setProvider('github')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    provider === 'github'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  GitHub
                </button>
                <button
                  type="button"
                  onClick={() => setProvider('jira')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    provider === 'jira'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  Jira
                </button>
              </div>

              {/* Generate button */}
              <button
                type="button"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending || !!jobId}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {(generateMutation.isPending || !!jobId) && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
                {generateMutation.isPending ? 'Generating...' : jobId ? 'Processing...' : 'Generate Suggestions'}
              </button>

              {/* Close button */}
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            {jobId && (!jobStatus || jobStatus.status === 'pending' || jobStatus.status === 'running') ? (
              /* Job progress state */
              <div className="flex flex-col items-center justify-center py-20">
                <svg className="h-8 w-8 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <p className="mt-3 text-sm font-medium text-slate-700">
                  {jobStatus?.progressMessage ?? 'Generating suggestions...'}
                </p>
              </div>
            ) : isLoading ? (
              /* Loading state */
              <div className="flex flex-col items-center justify-center py-20">
                <svg className="h-8 w-8 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <p className="mt-3 text-sm text-slate-400">Loading suggestions...</p>
              </div>
            ) : suggestions.length === 0 ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center py-20">
                <div className="mb-4 rounded-full bg-blue-50 p-4">
                  <svg className="h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
                    />
                  </svg>
                </div>
                <h3 className="text-base font-medium text-slate-900">No ticket suggestions yet</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Generate suggestions from this document using AI
                </p>
                <button
                  type="button"
                  onClick={() => generateMutation.mutate()}
                  disabled={generateMutation.isPending}
                  className="mt-4 flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {generateMutation.isPending && (
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  )}
                  {generateMutation.isPending ? 'Generating...' : 'Generate Suggestions'}
                </button>
              </div>
            ) : (
              /* Suggestion list */
              <div className="space-y-3">
                {suggestions.map((suggestion) => {
                  const isPending = suggestion.status === 'pending';
                  const isApproved = suggestion.status === 'approved';
                  const isDismissed = suggestion.status === 'dismissed';
                  const isDetailOpen = detailSuggestionId === suggestion.id;

                  return (
                    <div
                      key={suggestion.id}
                      className={`rounded-lg border bg-white transition-all cursor-pointer ${
                        isDismissed || isApproved ? 'opacity-60' : ''
                      } ${
                        isDetailOpen
                          ? 'border-blue-400 ring-2 ring-blue-100'
                          : selectedIds.has(suggestion.id)
                            ? 'border-blue-300 ring-2 ring-blue-100'
                            : 'border-slate-200 hover:border-slate-300'
                      }`}
                      onClick={() => setDetailSuggestionId(isDetailOpen ? null : suggestion.id)}
                    >
                      <div className="flex items-start gap-3 p-4">
                        {/* Checkbox */}
                        <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(suggestion.id)}
                            disabled={!isPending}
                            onChange={() => toggleSelect(suggestion.id)}
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                          />
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {/* Title */}
                          <span className="text-left text-sm font-medium text-slate-900">
                            {suggestion.title}
                          </span>

                          {/* Description preview */}
                          <p className="mt-1 text-xs text-slate-500">
                            {suggestion.description.length > 120
                              ? `${suggestion.description.slice(0, 120)}...`
                              : suggestion.description}
                          </p>

                          {/* Labels */}
                          {suggestion.labels.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {suggestion.labels.map((label) => (
                                <span
                                  key={label}
                                  className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                                >
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Status badge + actions */}
                        <div className="flex flex-shrink-0 items-center gap-2">
                          {/* Status badge */}
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              isPending
                                ? 'bg-yellow-50 text-yellow-700'
                                : isApproved
                                  ? 'bg-green-50 text-green-700'
                                  : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {suggestion.status}
                          </span>

                          {/* External link for approved */}
                          {isApproved && (
                            <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                              />
                            </svg>
                          )}

                          {/* Chevron indicator */}
                          <svg
                            className={`h-4 w-4 text-slate-400 transition-transform ${isDetailOpen ? 'rotate-180' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Results summary */}
            {results && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm">
                    {successCount > 0 && (
                      <span className="font-medium text-green-700">{successCount} ticket{successCount !== 1 ? 's' : ''} created</span>
                    )}
                    {successCount > 0 && failCount > 0 && <span className="text-slate-400"> / </span>}
                    {failCount > 0 && (
                      <span className="font-medium text-red-600">{failCount} failed</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setResults(null)}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    Dismiss
                  </button>
                </div>
                {/* Show individual errors */}
                {results.filter((r) => !r.success).map((r) => (
                  <p key={r.suggestionId} className="mt-1 text-xs text-red-500">
                    {r.error ?? 'Unknown error'}
                  </p>
                ))}
              </div>
            )}

            {/* Generation error */}
            {generateMutation.isError && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                Failed to generate suggestions. Please try again.
              </div>
            )}

            {/* Job failure error */}
            {jobStatus?.status === 'failed' && (
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {jobStatus.error ?? 'Background job failed. Please try again.'}
              </div>
            )}
          </div>

          {/* Footer toolbar */}
          {suggestions.length > 0 && (
            <div className="flex flex-shrink-0 items-center justify-between border-t border-slate-200 px-6 py-3 bg-slate-50">
              {/* Left side */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={selectedIds.size === pendingSuggestions.length && pendingSuggestions.length > 0 ? deselectAll : selectAll}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  {selectedIds.size === pendingSuggestions.length && pendingSuggestions.length > 0
                    ? 'Deselect All'
                    : 'Select All'}
                </button>
                <span className="text-sm text-slate-500">
                  {selectedIds.size} selected
                </span>
              </div>

              {/* Right side */}
              <button
                type="button"
                onClick={() => bulkApproveMutation.mutate()}
                disabled={selectedIds.size === 0 || bulkApproveMutation.isPending || !!approveJobId}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {(bulkApproveMutation.isPending || approveJobId) && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
                {bulkApproveMutation.isPending || approveJobId
                  ? `Creating tickets...`
                  : `Create ${selectedIds.size} Ticket${selectedIds.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}
        </div>

        {/* Detail drawer (slides in from right, inside the modal) */}
        <TicketSuggestionDetail
          suggestion={detailSuggestion}
          onClose={() => setDetailSuggestionId(null)}
          onSave={handleDetailSave}
          onDismiss={handleDetailDismiss}
          onApprove={handleDetailApprove}
          isSaving={updateMutation.isPending}
        />
      </div>
    </>,
    document.body,
  );
}
