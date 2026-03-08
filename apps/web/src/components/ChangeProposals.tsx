import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchChangeProposals,
  generateChangeProposal,
  approveChangeProposal,
  rejectChangeProposal,
  pushChangeProposal,
  type ChangeProposal,
} from '../lib/api';

interface ChangeProposalsProps {
  documentId: string;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'bg-amber-100', text: 'text-amber-700' },
  approved: { bg: 'bg-green-100', text: 'text-green-700' },
  rejected: { bg: 'bg-red-100', text: 'text-red-700' },
  pushed: { bg: 'bg-blue-100', text: 'text-blue-700' },
};

const PRIORITY_STYLES: Record<string, string> = {
  high: 'text-red-600 bg-red-50',
  medium: 'text-amber-600 bg-amber-50',
  low: 'text-slate-600 bg-slate-50',
};

function ProposalCard({
  proposal,
  onApprove,
  onReject,
  onPush,
  isActing,
}: {
  proposal: ChangeProposal;
  onApprove: (filteredTickets?: ChangeProposal['suggestedTickets']) => void;
  onReject: () => void;
  onPush: () => void;
  isActing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [excludedTickets, setExcludedTickets] = useState<Set<number>>(new Set());
  const status = STATUS_STYLES[proposal.status] ?? STATUS_STYLES.pending;

  const toggleTicket = (index: number) => {
    setExcludedTickets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const acceptedCount = proposal.suggestedTickets.length - excludedTickets.size;

  return (
    <div className="border-b border-slate-100">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-900 truncate">{proposal.title}</span>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.bg} ${status.text}`}>
              {proposal.status}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 truncate">{proposal.description}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">
            {proposal.suggestedTickets.length} ticket(s) suggested
          </p>
        </div>
        <svg
          className={`h-4 w-4 flex-shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-3">
          <div className="space-y-2">
            {proposal.suggestedTickets.map((ticket, i) => {
              const excluded = excludedTickets.has(i);
              return (
                <div
                  key={i}
                  className={`rounded-lg border p-3 transition-all ${
                    excluded
                      ? 'border-slate-100 opacity-50'
                      : 'border-green-200 border-l-green-500 border-l-2'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {proposal.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => toggleTicket(i)}
                        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
                          excluded
                            ? 'bg-red-100 text-red-500 hover:bg-red-200'
                            : 'bg-green-100 text-green-600 hover:bg-green-200'
                        }`}
                        title={excluded ? 'Include ticket' : 'Exclude ticket'}
                      >
                        {excluded ? '\u2717' : '\u2713'}
                      </button>
                    )}
                    <span className={`text-xs font-medium text-slate-800 ${excluded ? 'line-through' : ''}`}>{ticket.title}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[ticket.priority] ?? PRIORITY_STYLES.medium}`}>
                      {ticket.priority}
                    </span>
                  </div>
                  <p className={`mt-1 text-[11px] text-slate-500 leading-relaxed ${excluded ? 'line-through' : ''}`}>{ticket.description}</p>
                  {ticket.labels.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {ticket.labels.map((label) => (
                        <span key={label} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {proposal.status === 'pending' && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const filtered = proposal.suggestedTickets.filter((_, i) => !excludedTickets.has(i));
                  onApprove(filtered);
                }}
                disabled={isActing || acceptedCount === 0}
                className="rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {excludedTickets.size > 0
                  ? `Approve ${acceptedCount} of ${proposal.suggestedTickets.length} tickets`
                  : 'Approve'}
              </button>
              <button
                type="button"
                onClick={onReject}
                disabled={isActing}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}

          {proposal.status === 'approved' && (
            <div className="mt-3">
              <button
                type="button"
                onClick={onPush}
                disabled={isActing}
                className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Push as Tickets
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChangeProposals({ documentId }: ChangeProposalsProps) {
  const queryClient = useQueryClient();
  const queryKey = ['change-proposals', documentId];

  const { data: proposals = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => fetchChangeProposals(documentId),
  });

  const generateMutation = useMutation({
    mutationFn: () => generateChangeProposal(documentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const approveMutation = useMutation({
    mutationFn: ({ id, tickets }: { id: string; tickets?: ChangeProposal['suggestedTickets'] }) =>
      approveChangeProposal(id, tickets),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const rejectMutation = useMutation({
    mutationFn: rejectChangeProposal,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const pushMutation = useMutation({
    mutationFn: pushChangeProposal,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const isActing = approveMutation.isPending || rejectMutation.isPending || pushMutation.isPending;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Proposals</span>
        <button
          type="button"
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          className="rounded-md bg-blue-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {generateMutation.isPending ? 'Analyzing...' : 'Generate'}
        </button>
      </div>

      {generateMutation.isError && (
        <p className="px-4 py-2 text-xs text-red-500">
          {generateMutation.error instanceof Error ? generateMutation.error.message : 'Failed to generate proposal'}
        </p>
      )}

      {isLoading && (
        <p className="p-4 text-sm text-slate-400">Loading proposals...</p>
      )}

      {!isLoading && proposals.length === 0 && (
        <p className="p-4 text-sm text-slate-400">
          No proposals yet. Save some versions then click Generate to create ticket suggestions from your changes.
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onApprove={(filtered) => approveMutation.mutate({ id: proposal.id, tickets: filtered })}
            onReject={() => rejectMutation.mutate(proposal.id)}
            onPush={() => pushMutation.mutate(proposal.id)}
            isActing={isActing}
          />
        ))}
      </div>
    </div>
  );
}
