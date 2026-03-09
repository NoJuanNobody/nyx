import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth.store';
import { fetchTickets, syncAllTickets, type Ticket } from '../lib/api';

type ColumnStatus = 'open' | 'in_progress' | 'closed';

const COLUMNS: { key: ColumnStatus; label: string; color: string; bg: string }[] = [
  { key: 'open', label: 'Open', color: 'text-blue-700', bg: 'bg-blue-50' },
  { key: 'in_progress', label: 'In Progress', color: 'text-amber-700', bg: 'bg-amber-50' },
  { key: 'closed', label: 'Closed', color: 'text-green-700', bg: 'bg-green-50' },
];

const PROVIDER_BADGE: Record<string, { label: string; className: string }> = {
  github: { label: 'GitHub', className: 'bg-slate-900 text-white' },
  jira: { label: 'Jira', className: 'bg-blue-600 text-white' },
};

function TicketCard({ ticket }: { ticket: Ticket }) {
  const badge = PROVIDER_BADGE[ticket.provider] ?? { label: ticket.provider, className: 'bg-slate-200 text-slate-700' };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:shadow transition-shadow">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 leading-snug">{ticket.title}</p>
          {ticket.documentTitle && (
            <a
              href={`/documents/${ticket.documentId}`}
              className="mt-1 block text-xs text-blue-500 hover:text-blue-700 truncate"
            >
              {ticket.documentTitle}
            </a>
          )}
        </div>
        <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.className}`}>
          {badge.label}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-slate-400">
          #{ticket.externalId}
        </span>
        <a
          href={ticket.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-slate-400 hover:text-blue-500 transition-colors"
        >
          Open externally &rarr;
        </a>
      </div>
    </div>
  );
}

export function Board() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [providerFilter, setProviderFilter] = useState<string>('');

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['tickets', currentTeamId, providerFilter],
    queryFn: () => fetchTickets(currentTeamId!, { provider: providerFilter || undefined }),
    enabled: !!currentTeamId,
  });

  const syncMutation = useMutation({
    mutationFn: () => syncAllTickets(currentTeamId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tickets', currentTeamId] }),
  });

  const grouped: Record<ColumnStatus, Ticket[]> = {
    open: [],
    in_progress: [],
    closed: [],
  };

  for (const ticket of tickets) {
    const status = ticket.status as ColumnStatus;
    if (grouped[status]) {
      grouped[status].push(ticket);
    } else {
      grouped.open.push(ticket);
    }
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Board</h1>
          <p className="mt-1 text-sm text-slate-500">
            Track tickets across your team's integrations.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-600 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          >
            <option value="">All providers</option>
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>
          <button
            type="button"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {syncMutation.isPending ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Syncing...
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                </svg>
                Sync All
              </>
            )}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4" style={{ minHeight: 400 }}>
          {COLUMNS.map((col) => (
            <div key={col.key} className="flex flex-col rounded-lg border border-slate-200 bg-slate-50/50">
              <div className={`flex items-center justify-between rounded-t-lg px-4 py-2.5 ${col.bg}`}>
                <span className={`text-xs font-semibold uppercase tracking-wider ${col.color}`}>
                  {col.label}
                </span>
                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                  {grouped[col.key].length}
                </span>
              </div>
              <div className="flex-1 space-y-2 p-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
                {grouped[col.key].length === 0 ? (
                  <p className="py-8 text-center text-xs text-slate-400">No tickets</p>
                ) : (
                  grouped[col.key].map((ticket) => (
                    <TicketCard key={ticket.id} ticket={ticket} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
