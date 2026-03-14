import { useState, useEffect } from 'react';
import { fetchImpactGraph, type ImpactNode, type ImpactEdge } from '../lib/api';

const EVENT_COLORS: Record<string, string> = {
  doc_edit: 'bg-blue-50 border-blue-200 text-blue-800',
  snapshot_created: 'bg-purple-50 border-purple-200 text-purple-800',
  ticket_created: 'bg-amber-50 border-amber-200 text-amber-800',
  ticket_updated: 'bg-amber-50 border-amber-200 text-amber-800',
  code_commit: 'bg-green-50 border-green-200 text-green-800',
  proposal_created: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  proposal_approved: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  proposal_pushed: 'bg-cyan-50 border-cyan-200 text-cyan-800',
  agent_workflow: 'bg-slate-50 border-slate-200 text-slate-800',
};

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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface NodeCardProps {
  node: ImpactNode;
}

function NodeCard({ node }: NodeCardProps) {
  const colorClass = EVENT_COLORS[node.type] ?? 'bg-slate-50 border-slate-200 text-slate-800';
  const icon = EVENT_ICONS[node.type] ?? '●';

  return (
    <div className={`rounded-lg border p-3 ${colorClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{icon}</span>
          <span className="text-xs font-medium">{node.label}</span>
        </div>
        {node.driftFlag && (
          <span
            title="No downstream code commit within 14 days"
            className="flex-shrink-0 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700"
          >
            ⚠ drift
          </span>
        )}
      </div>
      {node.intent && (
        <p className="mt-1 text-[11px] italic text-current opacity-70">{node.intent}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-60">
        <span>{node.actorName}</span>
        <span>·</span>
        <span>{formatTime(node.timestamp)}</span>
      </div>
    </div>
  );
}

interface ChainViewProps {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

function ChainView({ nodes, edges }: ChainViewProps) {
  // Build child map for rendering branches
  const childMap = new Map<string, string[]>();
  const rootIds = new Set(nodes.map((n) => n.id));

  for (const edge of edges) {
    const arr = childMap.get(edge.from) ?? [];
    arr.push(edge.to);
    childMap.set(edge.from, arr);
    rootIds.delete(edge.to);
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  function renderSubtree(nodeId: string, depth = 0): React.ReactNode {
    const node = nodeMap.get(nodeId);
    if (!node) return null;
    const children = childMap.get(nodeId) ?? [];

    return (
      <div key={nodeId} className={depth > 0 ? 'ml-4 border-l border-slate-200 pl-3' : ''}>
        <NodeCard node={node} />
        {children.length > 0 && (
          <div className="mt-1 space-y-1">
            {children.map((childId) => renderSubtree(childId, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-slate-400">
        No impact events yet for this document.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {Array.from(rootIds).map((rootId) => renderSubtree(rootId))}
    </div>
  );
}

interface GraphViewProps {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

function GraphView({ nodes, edges }: GraphViewProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-400">
        No events to display.
      </div>
    );
  }

  // Simple SVG DAG — nodes arranged in rows by topological order
  const WIDTH = 280;
  const NODE_W = 220;
  const NODE_H = 48;
  const ROW_H = 70;
  const X_OFFSET = (WIDTH - NODE_W) / 2;

  // Assign rows via BFS
  const levels = new Map<string, number>();
  const childMap = new Map<string, string[]>();
  const parentCount = new Map<string, number>();

  for (const node of nodes) {
    parentCount.set(node.id, 0);
  }
  for (const edge of edges) {
    const arr = childMap.get(edge.from) ?? [];
    arr.push(edge.to);
    childMap.set(edge.from, arr);
    parentCount.set(edge.to, (parentCount.get(edge.to) ?? 0) + 1);
  }

  const roots = nodes.filter((n) => (parentCount.get(n.id) ?? 0) === 0);
  const queue = roots.map((n) => n.id);
  roots.forEach((n) => levels.set(n.id, 0));

  while (queue.length > 0) {
    const id = queue.shift()!;
    const level = levels.get(id) ?? 0;
    for (const childId of childMap.get(id) ?? []) {
      if (!levels.has(childId) || (levels.get(childId) ?? 0) < level + 1) {
        levels.set(childId, level + 1);
        queue.push(childId);
      }
    }
  }

  const maxLevel = Math.max(0, ...Array.from(levels.values()));
  const svgHeight = (maxLevel + 1) * ROW_H + 20;

  const nodePositions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node) => {
    const level = levels.get(node.id) ?? 0;
    nodePositions.set(node.id, { x: X_OFFSET, y: level * ROW_H + 10 });
  });

  return (
    <div className="overflow-auto">
      <svg width={WIDTH} height={svgHeight} className="block">
        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodePositions.get(edge.from);
          const to = nodePositions.get(edge.to);
          if (!from || !to) return null;
          const x1 = from.x + NODE_W / 2;
          const y1 = from.y + NODE_H;
          const x2 = to.x + NODE_W / 2;
          const y2 = to.y;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#94a3b8"
              strokeWidth={1.5}
              strokeDasharray="4 2"
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const pos = nodePositions.get(node.id);
          if (!pos) return null;
          const icon = EVENT_ICONS[node.type] ?? '●';
          return (
            <g key={node.id}>
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={node.driftFlag ? '#fff7ed' : '#f8fafc'}
                stroke={node.driftFlag ? '#fdba74' : '#e2e8f0'}
                strokeWidth={1.5}
              />
              <text x={pos.x + 10} y={pos.y + 18} fontSize={12} fill="#374151">
                {icon} {node.type}
              </text>
              <text x={pos.x + 10} y={pos.y + 34} fontSize={10} fill="#6b7280">
                {node.actorName} · {new Date(node.timestamp).toLocaleDateString()}
              </text>
              {node.driftFlag && (
                <text x={pos.x + NODE_W - 8} y={pos.y + 14} fontSize={9} fill="#c2410c" textAnchor="end">
                  ⚠ drift
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface ImpactMapProps {
  documentId: string;
}

type ViewMode = 'chain' | 'graph';

export function ImpactMap({ documentId }: ImpactMapProps) {
  const [nodes, setNodes] = useState<ImpactNode[]>([]);
  const [edges, setEdges] = useState<ImpactEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('chain');

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchImpactGraph(documentId)
      .then((result) => {
        setNodes(result.nodes);
        setEdges(result.edges);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load impact graph');
      })
      .finally(() => setLoading(false));
  }, [documentId]);

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-400">
        Loading impact map…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-6 text-center text-sm text-red-500">{error}</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* View mode toggle */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setViewMode('chain')}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
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
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
            viewMode === 'graph'
              ? 'bg-slate-900 text-white'
              : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          Graph
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {viewMode === 'chain' ? (
          <ChainView nodes={nodes} edges={edges} />
        ) : (
          <GraphView nodes={nodes} edges={edges} />
        )}
      </div>
    </div>
  );
}
