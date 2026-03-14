import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchImpactGraph, type ImpactNode, type ImpactEdge } from '../lib/api';

interface ImpactMapProps {
  documentId: string;
}

const EVENT_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  doc_edit: { icon: '✏️', color: 'bg-blue-100 text-blue-700', label: 'Doc edit' },
  snapshot_created: { icon: '📸', color: 'bg-purple-100 text-purple-700', label: 'Snapshot' },
  ticket_created: { icon: '🎫', color: 'bg-amber-100 text-amber-700', label: 'Ticket created' },
  ticket_updated: { icon: '🔄', color: 'bg-amber-50 text-amber-600', label: 'Ticket updated' },
  code_commit: { icon: '💻', color: 'bg-green-100 text-green-700', label: 'Code commit' },
  proposal_created: { icon: '📝', color: 'bg-indigo-100 text-indigo-700', label: 'Proposal' },
  proposal_approved: { icon: '✅', color: 'bg-emerald-100 text-emerald-700', label: 'Approved' },
  proposal_pushed: { icon: '🚀', color: 'bg-cyan-100 text-cyan-700', label: 'Pushed' },
  agent_workflow: { icon: '🤖', color: 'bg-violet-100 text-violet-700', label: 'Agent' },
};

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

// ── Card chain view ──────────────────────────────────────────────────

function CardChain({ nodes, edges }: { nodes: ImpactNode[]; edges: ImpactEdge[] }) {
  if (nodes.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400">No impact events yet.</p>;
  }

  // Build children map to detect branches
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    const children = childrenOf.get(edge.source) ?? [];
    children.push(edge.target);
    childrenOf.set(edge.source, children);
    parentOf.set(edge.target, edge.source);
  }

  // Root nodes (no parent in edge set)
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => !parentOf.has(n.id));

  function renderNode(node: ImpactNode, depth: number = 0): React.ReactNode {
    const cfg = EVENT_CONFIG[node.eventType] ?? {
      icon: '🔵',
      color: 'bg-slate-100 text-slate-700',
      label: node.eventType,
    };
    const children = (childrenOf.get(node.id) ?? [])
      .map((id) => nodeMap.get(id))
      .filter(Boolean) as ImpactNode[];

    return (
      <div key={node.id} className={depth > 0 ? 'ml-4 border-l-2 border-slate-200 pl-3' : ''}>
        <div className="py-2">
          <div className="flex items-start gap-2">
            <span
              className={`mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs ${cfg.color}`}
            >
              {cfg.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium text-slate-700">{cfg.label}</span>
                {node.driftFlag && (
                  <span
                    title="No code commit linked within 14 days"
                    className="inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600"
                  >
                    ⚠ drift
                  </span>
                )}
                <span className="text-[10px] text-slate-400">{relativeTime(node.createdAt)}</span>
              </div>
              {node.actorName && (
                <p className="text-[10px] text-slate-400">{node.actorName}</p>
              )}
              <p className="mt-0.5 text-[11px] italic text-slate-500">{node.intent}</p>
            </div>
          </div>
        </div>
        {children.length > 0 && (
          <div>
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-100 px-4 py-2">
      {roots.map((r) => renderNode(r, 0))}
    </div>
  );
}

// ── SVG graph view ───────────────────────────────────────────────────

const NODE_W = 140;
const NODE_H = 52;
const H_GAP = 180;
const V_GAP = 80;

function SvgGraph({ nodes, edges }: { nodes: ImpactNode[]; edges: ImpactEdge[] }) {
  if (nodes.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-slate-400">No impact events yet.</p>;
  }

  // Simple layered layout: assign each node a column based on longest path from root
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    parentOf.set(edge.target, edge.source);
    const ch = childrenOf.get(edge.source) ?? [];
    ch.push(edge.target);
    childrenOf.set(edge.source, ch);
  }

  function depth(id: string, visited = new Set<string>()): number {
    if (visited.has(id)) return 0;
    visited.add(id);
    const parent = parentOf.get(id);
    if (!parent) return 0;
    return 1 + depth(parent, visited);
  }

  // Group nodes by column (depth)
  const colMap = new Map<number, ImpactNode[]>();
  for (const n of nodes) {
    const col = depth(n.id);
    const col_nodes = colMap.get(col) ?? [];
    col_nodes.push(n);
    colMap.set(col, col_nodes);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, col_nodes] of colMap) {
    col_nodes.forEach((n, row) => {
      positions.set(n.id, {
        x: col * H_GAP + 10,
        y: row * V_GAP + 10,
      });
    });
  }

  const maxX = Math.max(...Array.from(positions.values()).map((p) => p.x)) + NODE_W + 10;
  const maxY = Math.max(...Array.from(positions.values()).map((p) => p.y)) + NODE_H + 10;

  return (
    <div className="overflow-auto px-2 py-2">
      <svg width={maxX} height={maxY} className="overflow-visible">
        {/* Edges */}
        {edges.map((edge) => {
          const src = positions.get(edge.source);
          const tgt = positions.get(edge.target);
          if (!src || !tgt) return null;
          const x1 = src.x + NODE_W;
          const y1 = src.y + NODE_H / 2;
          const x2 = tgt.x;
          const y2 = tgt.y + NODE_H / 2;
          return (
            <line
              key={`${edge.source}-${edge.target}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#cbd5e1"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* Arrow marker */}
        <defs>
          <marker
            id="arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L6,3 z" fill="#cbd5e1" />
          </marker>
        </defs>

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const cfg = EVENT_CONFIG[node.eventType] ?? {
            icon: '🔵',
            color: 'bg-slate-100 text-slate-700',
            label: node.eventType,
          };
          return (
            <g key={node.id} transform={`translate(${pos.x},${pos.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={node.driftFlag ? '#fef2f2' : '#f8fafc'}
                stroke={node.driftFlag ? '#fca5a5' : '#e2e8f0'}
                strokeWidth={1.5}
              />
              <text x={8} y={18} fontSize={13} dominantBaseline="middle">
                {cfg.icon}
              </text>
              <text x={26} y={17} fontSize={10} fontWeight={600} fill="#374151">
                {cfg.label}
              </text>
              {node.driftFlag && (
                <text x={26} y={29} fontSize={9} fill="#dc2626">
                  ⚠ drift
                </text>
              )}
              <text x={8} y={42} fontSize={9} fill="#6b7280" fontStyle="italic">
                {node.intent.length > 22 ? node.intent.slice(0, 22) + '…' : node.intent}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

type ViewMode = 'chain' | 'graph';

export function ImpactMap({ documentId }: ImpactMapProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('chain');

  const { data, isLoading, error } = useQuery({
    queryKey: ['impact-graph', documentId],
    queryFn: () => fetchImpactGraph(documentId),
  });

  const nodes: ImpactNode[] = data?.nodes ?? [];
  const edges: ImpactEdge[] = data?.edges ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* View mode toggle */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-200/80 px-4 py-2">
        <button
          type="button"
          onClick={() => setViewMode('chain')}
          className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
            viewMode === 'chain'
              ? 'bg-slate-900 text-white'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          Chain
        </button>
        <button
          type="button"
          onClick={() => setViewMode('graph')}
          className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
            viewMode === 'graph'
              ? 'bg-slate-900 text-white'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          Graph
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <p className="px-4 py-6 text-center text-sm text-slate-400">Loading impact map…</p>
        )}
        {error && (
          <p className="px-4 py-6 text-center text-sm text-red-500">Failed to load impact map.</p>
        )}
        {!isLoading && !error && viewMode === 'chain' && (
          <CardChain nodes={nodes} edges={edges} />
        )}
        {!isLoading && !error && viewMode === 'graph' && (
          <SvgGraph nodes={nodes} edges={edges} />
        )}
      </div>
    </div>
  );
}
