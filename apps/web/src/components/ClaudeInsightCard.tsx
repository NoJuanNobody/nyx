import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refreshTicketInsight, type ClaudeInsight } from '../lib/api';

interface ClaudeInsightCardProps {
  ticketId: string;
  insight: ClaudeInsight | null | undefined;
}

export function ClaudeInsightCard({ ticketId, insight }: ClaudeInsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const refreshMutation = useMutation({
    mutationFn: () => refreshTicketInsight(ticketId),
    onSuccess: (data) => {
      // Update the ticket in the board cache
      queryClient.setQueriesData<Array<Record<string, unknown>>>(
        { queryKey: ['tickets'] },
        (old) =>
          old?.map((t) =>
            t.id === ticketId ? { ...t, claudeInsights: data } : t,
          ),
      );
    },
  });

  if (!insight && !refreshMutation.data) {
    return (
      <div className="mt-2 flex items-center justify-between rounded border border-dashed border-slate-200 px-2 py-1.5">
        <span className="text-[10px] text-slate-400">No Claude insight</span>
        <button
          type="button"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-500 hover:text-blue-700 disabled:opacity-50 transition-colors"
        >
          {refreshMutation.isPending ? 'Fetching…' : 'Fetch'}
        </button>
      </div>
    );
  }

  const displayed = refreshMutation.data ?? insight!;

  return (
    <div className="mt-2 rounded border border-purple-100 bg-purple-50/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-2 py-1.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Claude logo mark */}
          <svg
            className="h-3 w-3 flex-shrink-0 text-purple-600"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
          </svg>
          <span className="truncate text-[10px] font-semibold text-purple-700">
            {displayed.title}
          </span>
        </div>
        <svg
          className={`h-3 w-3 flex-shrink-0 text-purple-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-purple-100 px-2 pb-2 pt-1.5">
          {displayed.summary.length > 0 && (
            <ul className="mb-1.5 space-y-0.5">
              {displayed.summary.map((point, i) => (
                <li key={i} className="flex gap-1 text-[10px] text-slate-600">
                  <span className="mt-px flex-shrink-0 text-purple-400">•</span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          )}

          {displayed.filesChanged.length > 0 && (
            <div className="mb-1.5">
              <p className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                Files
              </p>
              <ul className="space-y-0.5">
                {displayed.filesChanged.slice(0, 5).map((file, i) => (
                  <li key={i} className="truncate rounded bg-white/70 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
                    {file}
                  </li>
                ))}
                {displayed.filesChanged.length > 5 && (
                  <li className="text-[9px] text-slate-400">
                    +{displayed.filesChanged.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between">
            <a
              href={displayed.commentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[9px] text-purple-500 hover:text-purple-700 transition-colors"
            >
              View comment →
            </a>
            <button
              type="button"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              className="text-[9px] text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors"
            >
              {refreshMutation.isPending ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
