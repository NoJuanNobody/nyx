import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchImpactGraph, type ImpactNode, type ImpactEdge } from '../lib/api';

interface ImpactMapProps {
  documentId: string;
}

type ViewMode = 'chain' | 'graph';

const EVENT_ICONS: Record<string, string> = {
  doc_edit: '✏️',
  snapshot_created: '📸',
  ticket_created: '🎫',
  ticket_updated: '🔄',
  code_commit: '💻',
  proposal_created: '📝',
  proposal_approved: '✅',
  proposal_pushed: '🚀',
  agent_workflow: '🤖',
};

const EVENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  doc_edit: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  snapshot_created: { bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-700' },
  ticket_created: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
  ticket_updated: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-600' },
  code_commit: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
  proposal_created: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  proposal_approved: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
  proposal_pushed: { bg: 'bg-cyan-50', border: 'border-cyan-200', text: 'text-cyan-700' },
  agent_workflow: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
};

const DEFAULT_COLORS = { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700' };

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function ImpactNodeCard({ node }: { node: ImpactNode }) {
  const icon = EVENT_ICONS[node.type] ?? '📌';
  const colors = EVENT_COLORS[node.type] ?? DEFAULT_COLORS;
  const typeName = node.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div
      data-testid="impact-node-card"
      className={`rounded-lg border ${colors.border} ${colors.bg} p-3 shadow-sm`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-base" role="img" aria-label={node.type}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-semibold ${colors.text}`}>{typeName}</span>
            {node.driftFlag && (
              <span
                data-testid="drift-flag"
                title="No downstream commit within 14 days"
                className="flex-shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600"
              >
                ⚠ drift
              </span>
            )}
          </div>

          <p className="mt-0.5 text-xs text-slate-700">{node.label}</p>

          {node.intent && (
            <p
              data-testid="node-intent"
              className="mt-1 text-[10px] italic text-slate-500"
            >
              Intent: {node.intent}
            </p>
          )}

          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">
            <span>{node.actorName}</span>
            <span>·</span>
            <span>{relativeTime(node.timestamp)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChainArrow() {
  return (
    <div className="flex justify-center py-0.5" data-testid="chain-arrow">
      <svg className="h-5 w-5 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m0 0l6.75-6.75M12 19.5l-6.75-6.75" />
      </svg>
    </div>
  );
}

/** Simple SVG graph layout for the optional graph view. */
function GraphView({ nodes, edges }: { nodes: ImpactNode[]; edges: ImpactEdge[] }) {
  const CARD_WIDTH = 200;
  const CARD_HEIGHT = 60;
  const GAP_Y = 40;
  const OFFSET_X = 16;
  const OFFSET_Y = 16;

  const posMap = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    posMap.set(n.id, { x: OFFSET_X, y: OFFSET_Y + i * (CARD_HEIGHT + GAP_Y) });
  });

  const totalHeight = OFFSET_Y + nodes.length * (CARD_HEIGHT + GAP_Y);

  return (
    <div data-testid="impact-graph-view" className="overflow-auto">
      <svg
        width={CARD_WIDTH + OFFSET_X * 2}
        height={totalHeight}
        className="text-slate-400"
      >
        {/* Edges */}
        {edges.map((edge, i) => {
          const from = posMap.get(edge.from);
          const to = posMap.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + CARD_WIDTH / 2;
          const y1 = from.y + CARD_HEIGHT;
          const x2 = to.x + CARD_WIDTH / 2;
          const y2 = to.y;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="4 2"
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = posMap.get(node.id);
          if (!pos) return null;
          const colors = EVENT_COLORS[node.type] ?? DEFAULT_COLORS;
          const icon = EVENT_ICONS[node.type] ?? '📌';
          const typeName = node.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

          return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <rect
                width={CARD_WIDTH}
                height={CARD_HEIGHT}
                rx={8}
                className={`${colors.border} ${colors.bg}`}
                fill="white"
                stroke="#e2e8f0"
              />
              <text x={12} y={22} fontSize={14}>{icon}</text>
              <text x={32} y={22} fontSize={10} fontWeight="600" fill="#334155">
                {typeName.length > 22 ? `${typeName.slice(0, 22)}…` : typeName}
              </text>
              {node.driftFlag && (
                <text x={CARD_WIDTH - 8} y={22} fontSize={9} fill="#dc2626" textAnchor="end">
                  ⚠ drift
                </text>
              )}
              <text x={12} y={40} fontSize={9} fill="#64748b">
                {node.actorName} · {relativeTime(node.timestamp)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ImpactMap({ documentId }: ImpactMapProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chain');

  const { data, isLoading, error } = useQuery({
    queryKey: ['impact-graph', documentId],
    queryFn: () => fetchImpactGraph(documentId),
    enabled: !!documentId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-400">
        Building impact map…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-red-500">
        Failed to load impact map.
      </div>
    );
  }

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  if (nodes.length === 0) {
    return (
      <div
        data-testid="impact-map-empty"
        className="flex flex-col items-center justify-center py-16 text-center"
      >
        <svg
          className="mb-3 h-10 w-10 text-slate-300"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
          />
        </svg>
        <p className="text-sm font-medium text-slate-500">No impact events yet</p>
        <p className="mt-1 text-xs text-slate-400">
          Events will appear here as the document moves through its lifecycle.
        </p>
      </div>
    );
  }

  const driftCount = nodes.filter((n) => n.driftFlag).length;

  return (
    <div data-testid="impact-map" className="flex h-full flex-col bg-white">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setViewMode('chain')}
            data-testid="view-chain-btn"
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
              viewMode === 'chain'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Chain
          </button>
          <button
            type="button"
            onClick={() => setViewMode('graph')}
            data-testid="view-graph-btn"
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
              viewMode === 'graph'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Graph
          </button>
        </div>

        {driftCount > 0 && (
          <span className="text-[10px] text-red-500">
            {driftCount} drift{driftCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {viewMode === 'chain' ? (
          <div data-testid="impact-chain-view" className="space-y-0">
            {nodes.map((node, i) => (
              <div key={node.id}>
                <ImpactNodeCard node={node} />
                {i < nodes.length - 1 && <ChainArrow />}
              </div>
            ))}
          </div>
        ) : (
          <GraphView nodes={nodes} edges={edges} />
        )}
      </div>
    </div>
  );
}
