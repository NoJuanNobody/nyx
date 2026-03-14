import { useQuery } from '@tanstack/react-query';
import { fetchDocumentTrace, type TraceNode } from '../lib/api';

const EVENT_ICONS: Record<string, string> = {
  doc_edit: '\u{1F4DD}',
  ticket_created: '\u{1F3AB}',
  ticket_updated: '\u{1F3AB}',
  pr_opened: '\u{1F500}',
  code_commit: '\u{2705}',
  commit_pushed: '\u{2705}',
  proposal_created: '\u{1F4CB}',
  proposal_approved: '\u{1F4CB}',
  proposal_pushed: '\u{1F4CB}',
  snapshot_created: '\u{1F4F8}',
  agent_workflow: '\u{1F916}',
};

const EVENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  doc_edit: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  ticket_created: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
  ticket_updated: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
  pr_opened: { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700' },
  code_commit: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
  commit_pushed: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
  proposal_created: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  proposal_approved: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  proposal_pushed: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  snapshot_created: { bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-700' },
  agent_workflow: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
};

const DEFAULT_COLORS = { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700' };

function TraceCard({ node }: { node: TraceNode }) {
  const icon = EVENT_ICONS[node.type] ?? '\u{1F4CC}';
  const colors = EVENT_COLORS[node.type] ?? DEFAULT_COLORS;
  const date = new Date(node.timestamp);
  const formattedDate = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const formattedTime = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      data-testid="trace-card"
      className={`rounded-lg border ${colors.border} ${colors.bg} p-4 shadow-sm`}
    >
      <div className="flex items-start gap-3">
        <span className="text-xl" role="img" aria-label={node.type}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${colors.text}`}>
              {node.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-slate-700">{node.label}</p>
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
            <span>{node.actorName}</span>
            <span>
              {formattedDate} at {formattedTime}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TraceArrow() {
  return (
    <div className="flex justify-center py-1" data-testid="trace-arrow">
      <svg className="h-6 w-6 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0l6.75-6.75M12 19.5l-6.75-6.75" />
      </svg>
    </div>
  );
}

interface TraceViewProps {
  documentId: string;
}

export function TraceView({ documentId }: TraceViewProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['trace', documentId],
    queryFn: () => fetchDocumentTrace(documentId),
    enabled: !!documentId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-400">
        Loading trace...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-red-500">
        Failed to load trace.
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div
        data-testid="trace-empty"
        className="flex flex-col items-center justify-center py-16 text-center"
      >
        <svg
          className="mb-3 h-12 w-12 text-slate-300"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
          />
        </svg>
        <p className="text-sm font-medium text-slate-500">No trace events yet for this document</p>
        <p className="mt-1 text-xs text-slate-400">
          Events will appear here as the document moves through its lifecycle.
        </p>
      </div>
    );
  }

  // Sort chronologically (oldest first, so the chain reads top-to-bottom)
  const sorted = [...data.nodes].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return (
    <div data-testid="trace-view" className="flex flex-col">
      <div className="space-y-0">
        {sorted.map((node, i) => (
          <div key={node.id}>
            <TraceCard node={node} />
            {i < sorted.length - 1 && <TraceArrow />}
          </div>
        ))}
      </div>

      {/* AI Summary */}
      {data.summary && (
        <div
          data-testid="trace-summary"
          className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4"
        >
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Trace Summary
          </h3>
          <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">
            {data.summary}
          </p>
        </div>
      )}
    </div>
  );
}
