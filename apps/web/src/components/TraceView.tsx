import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchDocumentTrace, type TraceNode } from '../lib/api';

/* ── Event visual config ─────────────────────────────── */

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

const EVENT_COLORS: Record<string, { bg: string; border: string; text: string; ring: string; dot: string }> = {
  doc_edit:          { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-700',   ring: 'ring-blue-200',   dot: 'bg-blue-400' },
  ticket_created:    { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-700',  ring: 'ring-amber-200',  dot: 'bg-amber-400' },
  ticket_updated:    { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-700',  ring: 'ring-amber-200',  dot: 'bg-amber-400' },
  pr_opened:         { bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', ring: 'ring-purple-200', dot: 'bg-purple-400' },
  code_commit:       { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  ring: 'ring-green-200',  dot: 'bg-green-400' },
  commit_pushed:     { bg: 'bg-green-50',  border: 'border-green-200',  text: 'text-green-700',  ring: 'ring-green-200',  dot: 'bg-green-400' },
  proposal_created:  { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', ring: 'ring-indigo-200', dot: 'bg-indigo-400' },
  proposal_approved: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', ring: 'ring-indigo-200', dot: 'bg-indigo-400' },
  proposal_pushed:   { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', ring: 'ring-indigo-200', dot: 'bg-indigo-400' },
  snapshot_created:  { bg: 'bg-teal-50',   border: 'border-teal-200',   text: 'text-teal-700',   ring: 'ring-teal-200',   dot: 'bg-teal-400' },
  agent_workflow:    { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700', ring: 'ring-violet-200', dot: 'bg-violet-400' },
};

const DEFAULT_COLORS = { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', ring: 'ring-slate-200', dot: 'bg-slate-400' };

/* ── Helpers ──────────────────────────────────────────── */

function formatEventType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDateGroup(timestamp: string): string {
  const d = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function groupByDate(nodes: TraceNode[]): Map<string, TraceNode[]> {
  const groups = new Map<string, TraceNode[]>();
  for (const node of nodes) {
    const key = new Date(node.timestamp).toDateString();
    const existing = groups.get(key);
    if (existing) {
      existing.push(node);
    } else {
      groups.set(key, [node]);
    }
  }
  return groups;
}

function getMetadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [
      k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
      typeof v === 'object' ? JSON.stringify(v) : String(v),
    ]);
}

/* ── Timeline node on the rail ───────────────────────── */

function TimelineNode({
  node,
  index,
  isLast,
}: {
  node: TraceNode;
  index: number;
  isLast: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const colors = EVENT_COLORS[node.type] ?? DEFAULT_COLORS;
  const icon = EVENT_ICONS[node.type] ?? '\u{1F4CC}';
  const metaEntries = getMetadataEntries(node.metadata);

  return (
    <div
      className="trace-node group relative flex gap-4"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* ── Rail segment ─────────────────────── */}
      <div className="relative flex flex-col items-center">
        {/* Dot */}
        <div
          className={`relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full
            border-2 ${colors.border} ${colors.bg} ring-4 ${colors.ring}/30
            shadow-sm transition-all duration-200
            group-hover:scale-110 group-hover:shadow-md`}
        >
          <span className="text-sm leading-none" role="img" aria-label={node.type}>{icon}</span>
        </div>
        {/* Connecting line */}
        {!isLast && (
          <div className={`w-0.5 flex-1 ${colors.dot}/20`} />
        )}
      </div>

      {/* ── Event card ───────────────────────── */}
      <div className="min-w-0 flex-1 pb-8">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={`w-full text-left rounded-xl border ${colors.border} ${colors.bg}
            px-4 py-3 shadow-sm transition-all duration-200
            hover:shadow-md hover:border-opacity-80
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${colors.ring}`}
          data-testid="trace-card"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <span className={`text-[13px] font-semibold tracking-tight ${colors.text}`}>
                {formatEventType(node.type)}
              </span>
              <p className="mt-0.5 text-sm leading-snug text-slate-600 line-clamp-2">
                {node.label}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[11px] tabular-nums text-slate-400">
                {formatTime(node.timestamp)}
              </span>
              {(metaEntries.length > 0) && (
                <svg
                  className={`h-3.5 w-3.5 text-slate-300 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              )}
            </div>
          </div>

          {node.actorName && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
              <span className="text-[11px] text-slate-500">{node.actorName}</span>
            </div>
          )}
        </button>

        {/* Expanded metadata */}
        {expanded && metaEntries.length > 0 && (
          <div
            className={`mt-1.5 ml-1 rounded-lg border ${colors.border}/60 bg-white/60 backdrop-blur-sm
              px-4 py-3 text-xs trace-expand`}
          >
            <dl className="space-y-1.5">
              {metaEntries.map(([key, value]) => (
                <div key={key} className="flex gap-3">
                  <dt className="shrink-0 w-28 font-medium text-slate-500">{key}</dt>
                  <dd className="min-w-0 flex-1 break-all text-slate-700 font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Sticky date header ──────────────────────────────── */

function DateHeader({ label }: { label: string }) {
  return (
    <div className="trace-date-header sticky top-0 z-20 -mx-1 mb-3 mt-1">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-slate-200/80 to-transparent" />
        <span className="shrink-0 rounded-full bg-slate-100 border border-slate-200 px-3 py-0.5
          text-[10px] font-semibold uppercase tracking-widest text-slate-400 shadow-sm">
          {label}
        </span>
        <div className="h-px flex-1 bg-gradient-to-l from-slate-200/80 to-transparent" />
      </div>
    </div>
  );
}

/* ── Frosted summary footer ──────────────────────────── */

function TraceSummary({ summary }: { summary: string }) {
  return (
    <div
      data-testid="trace-summary"
      className="trace-summary sticky bottom-0 z-20 -mx-1 mt-4"
    >
      <div className="rounded-xl border border-slate-200/80 bg-white/70 backdrop-blur-xl
        p-4 shadow-lg shadow-slate-200/40">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md
            bg-gradient-to-br from-slate-100 to-slate-200 text-[11px]">
            <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
              Trace Summary
            </h3>
            <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-slate-600">
              {summary}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Loading skeleton ────────────────────────────────── */

function TraceLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4 animate-pulse" style={{ animationDelay: `${i * 150}ms` }}>
          <div className="flex flex-col items-center">
            <div className="h-9 w-9 rounded-full bg-slate-200" />
            {i < 2 && <div className="mt-1 w-0.5 flex-1 bg-slate-100" />}
          </div>
          <div className="flex-1 pb-6">
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="h-3 w-24 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-48 rounded bg-slate-100" />
              <div className="mt-2 h-2 w-16 rounded bg-slate-100" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main component ──────────────────────────────────── */

interface TraceViewProps {
  documentId: string;
}

export function TraceView({ documentId }: TraceViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [nodeCount, setNodeCount] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ['trace', documentId],
    queryFn: () => fetchDocumentTrace(documentId),
    enabled: !!documentId,
  });

  // Track node count for the counter badge
  useEffect(() => {
    if (data?.nodes) setNodeCount(data.nodes.length);
  }, [data?.nodes]);

  if (isLoading) {
    return <TraceLoadingSkeleton />;
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
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl
          bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200 shadow-sm">
          <svg
            className="h-7 w-7 text-slate-300"
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
        </div>
        <p className="text-sm font-medium text-slate-500">No trace events yet</p>
        <p className="mt-1 max-w-[240px] text-xs text-slate-400">
          Events will appear here as the document moves through its lifecycle.
        </p>
      </div>
    );
  }

  const sorted = [...data.nodes].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const dateGroups = groupByDate(sorted);

  let globalIndex = 0;

  return (
    <div data-testid="trace-view" className="relative flex flex-col">
      {/* Event counter */}
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 border border-slate-200
          px-2.5 py-0.5 text-[11px] font-semibold text-slate-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400 animate-pulse" />
          {nodeCount} event{nodeCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto scroll-smooth"
      >
        {Array.from(dateGroups.entries()).map(([dateKey, nodes]) => (
          <div key={dateKey}>
            <DateHeader label={formatDateGroup(nodes[0].timestamp)} />
            <div className="relative pl-1">
              {nodes.map((node, i) => {
                const idx = globalIndex++;
                const isLastInGroup = i === nodes.length - 1;
                const isLastOverall = idx === sorted.length - 1;
                return (
                  <TimelineNode
                    key={node.id}
                    node={node}
                    index={idx}
                    isLast={isLastOverall}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Frosted AI summary */}
      {data.summary && <TraceSummary summary={data.summary} />}

      {/* Inline CSS for animations */}
      <style>{`
        .trace-node {
          animation: traceSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes traceSlideIn {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .trace-expand {
          animation: traceExpand 0.25s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes traceExpand {
          from {
            opacity: 0;
            transform: translateY(-4px) scaleY(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scaleY(1);
          }
        }
        .trace-date-header {
          animation: traceFadeIn 0.3s ease both;
        }
        @keyframes traceFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .trace-summary {
          animation: traceSummaryIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both;
        }
        @keyframes traceSummaryIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
