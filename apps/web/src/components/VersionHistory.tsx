import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DocumentVersion } from '@syncdocs/shared';
import { fetchVersions, fetchBranches, type DocumentBranch } from '../lib/api';

interface VersionHistoryProps {
  documentId: string;
  onCompare?: (versionA: DocumentVersion, versionB: DocumentVersion) => void;
  onExitCompare?: () => void;
  onSelectVersion?: (version: DocumentVersion | null) => void;
  activeVersionId?: string | null;
}

/* ── Graph node types ─────────────────────────────────────────────── */

type GraphNode =
  | { kind: 'commit'; version: DocumentVersion; lane: number; isHead: boolean; isBranchBase: boolean }
  | { kind: 'branch-out'; branch: DocumentBranch; fromLane: number; toLane: number; baseVersion: number }
  | { kind: 'branch-tip'; branch: DocumentBranch; lane: number }
  | { kind: 'merge'; branch: DocumentBranch; fromLane: number; toLane: number; mergedVersion: number };

/* ── Colors for branch lanes ──────────────────────────────────────── */

const LANE_COLORS = [
  '#10b981', // emerald-500
  '#3b82f6', // blue-500
  '#ef4444', // red-500
  '#f59e0b', // amber-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/* ── Time formatting ──────────────────────────────────────────────── */

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shortHash(id: string): string {
  return id.slice(0, 7);
}

/* ── Build the graph ──────────────────────────────────────────────── */

function buildGraph(versions: DocumentVersion[], branches: DocumentBranch[]): { nodes: GraphNode[]; laneCount: number } {
  if (versions.length === 0) return { nodes: [], laneCount: 1 };

  // Sort versions descending (newest first)
  const sorted = [...versions].sort((a, b) => b.version - a.version);

  // Map branches to their base version
  const branchByBaseVersionId = new Map<string, DocumentBranch[]>();
  for (const b of branches) {
    const existing = branchByBaseVersionId.get(b.baseVersionId) ?? [];
    existing.push(b);
    branchByBaseVersionId.set(b.baseVersionId, existing);
  }

  // Find merged branches (mergedAt is set) and which version they merged at
  // For simplicity, merged branches merge back at the version after their base
  const mergedBranches = branches.filter((b) => b.mergedAt);

  // Assign lanes to branches
  const branchLaneMap = new Map<string, number>();
  let nextLane = 1; // lane 0 is main
  for (const b of branches) {
    branchLaneMap.set(b.id, nextLane);
    nextLane++;
  }

  const laneCount = Math.max(1, nextLane);
  const nodes: GraphNode[] = [];

  // Track active branch lanes at each point
  const activeBranches = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const isHead = i === 0;

    // Check if any branches fork from this version
    const forkedBranches = branchByBaseVersionId.get(v.id) ?? [];
    const isBranchBase = forkedBranches.length > 0;

    // Check if any merged branches merge at this version (the version after the base)
    // We'll show merge on the version right before the branch base (i.e., the next newer version)

    // Add branch-out nodes for branches forking from this version
    for (const b of forkedBranches) {
      const bLane = branchLaneMap.get(b.id) ?? 1;
      activeBranches.add(b.id);

      // Branch tip (the branch head)
      nodes.push({
        kind: 'branch-tip',
        branch: b,
        lane: bLane,
      });

      // If merged, show merge line going back to main
      if (b.mergedAt) {
        nodes.push({
          kind: 'merge',
          branch: b,
          fromLane: bLane,
          toLane: 0,
          mergedVersion: v.version,
        });
      }

      // Branch-out line
      nodes.push({
        kind: 'branch-out',
        branch: b,
        fromLane: 0,
        toLane: bLane,
        baseVersion: v.version,
      });
    }

    // Add the commit node
    nodes.push({
      kind: 'commit',
      version: v,
      lane: 0,
      isHead,
      isBranchBase,
    });
  }

  return { nodes, laneCount };
}

/* ── SVG Graph Column ─────────────────────────────────────────────── */

const ROW_HEIGHT = 56;
const LANE_WIDTH = 16;
const NODE_RADIUS = 5;
const GRAPH_LEFT = 12;

function GraphSvg({ nodes, laneCount }: { nodes: GraphNode[]; laneCount: number }) {
  const width = GRAPH_LEFT + laneCount * LANE_WIDTH + 4;
  const height = nodes.length * ROW_HEIGHT;

  function laneX(lane: number): number {
    return GRAPH_LEFT + lane * LANE_WIDTH;
  }

  // Track y positions
  let y = 0;
  const elements: JSX.Element[] = [];

  // Draw the main branch line
  const commitNodes = nodes.filter((n) => n.kind === 'commit');
  if (commitNodes.length > 1) {
    const firstY = nodes.indexOf(commitNodes[0]) * ROW_HEIGHT + ROW_HEIGHT / 2;
    const lastY = nodes.indexOf(commitNodes[commitNodes.length - 1]) * ROW_HEIGHT + ROW_HEIGHT / 2;
    elements.push(
      <line
        key="main-line"
        x1={laneX(0)}
        y1={firstY}
        x2={laneX(0)}
        y2={lastY}
        stroke={laneColor(0)}
        strokeWidth={2}
        opacity={0.5}
      />,
    );
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;

    if (node.kind === 'commit') {
      const cx = laneX(node.lane);
      // Commit dot
      elements.push(
        <circle
          key={`commit-${node.version.id}`}
          cx={cx}
          cy={cy}
          r={node.isHead ? NODE_RADIUS + 1.5 : NODE_RADIUS}
          fill={node.isHead ? laneColor(0) : 'white'}
          stroke={laneColor(0)}
          strokeWidth={node.isHead ? 2.5 : 2}
        />,
      );
      // Head indicator: extra ring
      if (node.isHead) {
        elements.push(
          <circle
            key={`head-ring-${node.version.id}`}
            cx={cx}
            cy={cy}
            r={NODE_RADIUS + 5}
            fill="none"
            stroke={laneColor(0)}
            strokeWidth={1}
            opacity={0.25}
          />,
        );
      }
    } else if (node.kind === 'branch-out') {
      const fromX = laneX(node.fromLane);
      const toX = laneX(node.toLane);
      // Find the commit row below this
      const nextCommitIdx = nodes.findIndex((n, idx) => idx > i && n.kind === 'commit');
      const fromY = nextCommitIdx >= 0 ? nextCommitIdx * ROW_HEIGHT + ROW_HEIGHT / 2 : cy;
      // Curved branch line going up and out
      elements.push(
        <path
          key={`branch-out-${node.branch.id}`}
          d={`M ${fromX} ${fromY} C ${fromX} ${cy}, ${toX} ${fromY}, ${toX} ${cy}`}
          fill="none"
          stroke={laneColor(node.toLane)}
          strokeWidth={2}
          opacity={0.6}
        />,
      );
      // Vertical branch line up to tip
      const tipIdx = nodes.findIndex((n) => n.kind === 'branch-tip' && n.branch.id === node.branch.id);
      if (tipIdx >= 0) {
        const tipY = tipIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
        elements.push(
          <line
            key={`branch-line-${node.branch.id}`}
            x1={toX}
            y1={tipY}
            x2={toX}
            y2={cy}
            stroke={laneColor(node.toLane)}
            strokeWidth={2}
            opacity={0.5}
          />,
        );
      }
    } else if (node.kind === 'branch-tip') {
      const cx = laneX(node.lane);
      // Branch tip diamond
      const s = 4;
      elements.push(
        <polygon
          key={`tip-${node.branch.id}`}
          points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
          fill={laneColor(node.lane)}
          stroke={laneColor(node.lane)}
          strokeWidth={1}
        />,
      );
    } else if (node.kind === 'merge') {
      const fromX = laneX(node.fromLane);
      const toX = laneX(node.toLane);
      // Find the commit above this for merge target
      const prevCommitIdx = nodes.findIndex((n, idx) => idx > i && n.kind === 'commit');
      const toY = prevCommitIdx >= 0 ? prevCommitIdx * ROW_HEIGHT + ROW_HEIGHT / 2 : cy;
      elements.push(
        <path
          key={`merge-${node.branch.id}`}
          d={`M ${fromX} ${cy} C ${fromX} ${toY}, ${toX} ${cy}, ${toX} ${toY}`}
          fill="none"
          stroke={laneColor(node.fromLane)}
          strokeWidth={2}
          opacity={0.4}
          strokeDasharray="4 3"
        />,
      );
    }
  }

  return (
    <svg
      width={width}
      height={height}
      className="flex-shrink-0"
      style={{ minHeight: height }}
    >
      {elements}
    </svg>
  );
}

/* ── Row label for each graph node ────────────────────────────────── */

function NodeLabel({
  node,
  isSelected,
  compareMode,
  onClick,
}: {
  node: GraphNode;
  isSelected: boolean;
  compareMode: boolean;
  onClick: () => void;
}) {
  if (node.kind === 'commit') {
    const v = node.version;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-start gap-2 py-1 text-left transition-colors rounded-md px-2 -ml-1 ${
          isSelected
            ? 'bg-emerald-50'
            : 'hover:bg-slate-50'
        }`}
        style={{ height: ROW_HEIGHT, boxSizing: 'border-box' }}
      >
        <div className="flex flex-col justify-center h-full min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {node.isHead && (
              <span className="inline-flex items-center rounded-sm bg-emerald-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-emerald-700 border border-emerald-200">
                HEAD
              </span>
            )}
            <code className="text-[11px] font-mono text-slate-400 select-all">
              {shortHash(v.id)}
            </code>
            <span className="text-[10px] text-slate-400">{relativeTime(v.createdAt)}</span>
          </div>
          <p className="mt-0.5 truncate text-[12px] leading-snug text-slate-700">
            {v.message || `Version ${v.version}`}
          </p>
          {compareMode && (
            <div className="mt-0.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${isSelected ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 bg-transparent'}`} />
            </div>
          )}
        </div>
      </button>
    );
  }

  if (node.kind === 'branch-tip') {
    const b = node.branch;
    const isMerged = !!b.mergedAt;
    const statusColor = isMerged
      ? 'text-purple-700 bg-purple-50 border-purple-200'
      : b.status === 'approved'
        ? 'text-sky-700 bg-sky-50 border-sky-200'
        : 'text-amber-700 bg-amber-50 border-amber-200';

    return (
      <div className="flex items-center gap-2 px-2 -ml-1" style={{ height: ROW_HEIGHT }}>
        <span className={`inline-flex items-center rounded-sm px-1.5 py-px text-[9px] font-bold uppercase tracking-wider border ${statusColor}`}>
          {b.name}
        </span>
        <span className="text-[10px] text-slate-400">
          {isMerged ? 'merged' : b.status}
        </span>
      </div>
    );
  }

  if (node.kind === 'branch-out') {
    return <div style={{ height: ROW_HEIGHT }} />;
  }

  if (node.kind === 'merge') {
    return <div style={{ height: ROW_HEIGHT }} />;
  }

  return null;
}

/* ── Main component ───────────────────────────────────────────────── */

export function VersionHistory({ documentId, onCompare, onExitCompare, onSelectVersion, activeVersionId }: VersionHistoryProps) {
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);

  const { data: versions, isLoading: versionsLoading } = useQuery<DocumentVersion[]>({
    queryKey: ['versions', documentId],
    queryFn: () => fetchVersions(documentId),
  });

  const { data: branches } = useQuery<DocumentBranch[]>({
    queryKey: ['branches', documentId],
    queryFn: () => fetchBranches(documentId),
  });

  const { nodes, laneCount } = useMemo(
    () => buildGraph(versions ?? [], branches ?? []),
    [versions, branches],
  );

  const handleNodeClick = (node: GraphNode) => {
    if (node.kind !== 'commit') return;
    const v = node.version;
    if (compareMode) {
      setCompareSelection((prev) => {
        if (prev.includes(v.id)) return prev.filter((id) => id !== v.id);
        if (prev.length >= 2) return [prev[1], v.id];
        return [...prev, v.id];
      });
    } else {
      const newId = v.id === activeVersionId ? null : v.id;
      const newVersion = newId ? v : null;
      onSelectVersion?.(newVersion);
    }
  };

  const handleCompare = () => {
    if (compareSelection.length === 2 && versions && onCompare) {
      const a = versions.find((v) => v.id === compareSelection[0]);
      const b = versions.find((v) => v.id === compareSelection[1]);
      if (a && b) onCompare(a, b);
    }
  };

  const handleExitCompare = () => {
    setCompareMode(false);
    setCompareSelection([]);
    onExitCompare?.();
  };

  const isNodeSelected = (node: GraphNode): boolean => {
    if (node.kind !== 'commit') return false;
    return compareMode
      ? compareSelection.includes(node.version.id)
      : node.version.id === activeVersionId;
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Compare toolbar */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        {!compareMode ? (
          <button
            type="button"
            onClick={() => setCompareMode(true)}
            className="text-[11px] font-medium text-emerald-600 hover:text-emerald-700 transition-colors"
          >
            Compare versions
          </button>
        ) : (
          <div className="flex w-full items-center gap-2">
            <button
              type="button"
              onClick={handleCompare}
              disabled={compareSelection.length !== 2}
              className="rounded-sm bg-emerald-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-30 transition-opacity"
            >
              Diff ({compareSelection.length}/2)
            </button>
            <button
              type="button"
              onClick={handleExitCompare}
              className="text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-400">
          <span>{versions?.length ?? 0} commits</span>
          {(branches?.length ?? 0) > 0 && (
            <>
              <span className="text-slate-300">/</span>
              <span>{branches!.length} branch{branches!.length !== 1 ? 'es' : ''}</span>
            </>
          )}
        </div>
      </div>

      {/* Graph area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {versionsLoading && (
          <p className="p-4 text-[12px] text-slate-400 font-mono">Loading...</p>
        )}

        {!versionsLoading && nodes.length === 0 && (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <div className="mb-2 h-8 w-8 rounded-full border-2 border-dashed border-slate-300" />
            <p className="text-[12px] text-slate-500">No versions yet</p>
            <p className="mt-1 text-[10px] text-slate-400">Save a version to start tracking history</p>
          </div>
        )}

        {nodes.length > 0 && (
          <div className="flex">
            {/* SVG graph column */}
            <div className="flex-shrink-0 pt-0">
              <GraphSvg nodes={nodes} laneCount={laneCount} />
            </div>

            {/* Labels column */}
            <div className="flex-1 min-w-0">
              {nodes.map((node, i) => (
                <NodeLabel
                  key={node.kind === 'commit' ? node.version.id : node.kind === 'branch-tip' ? `tip-${node.branch.id}` : `${node.kind}-${i}`}
                  node={node}
                  isSelected={isNodeSelected(node)}
                  compareMode={compareMode}
                  onClick={() => handleNodeClick(node)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
