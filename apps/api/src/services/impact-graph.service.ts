import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditTrail, users } from '../db/schema.js';

export interface ImpactNode {
  id: string;
  type: string;
  label: string;
  actorName: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  intent: string | null;
  driftFlag: boolean;
}

export interface ImpactEdge {
  from: string;
  to: string;
}

export interface ImpactGraph {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

const EVENT_LABELS: Record<string, string> = {
  doc_edit: 'Document edited',
  snapshot_created: 'Snapshot created',
  ticket_created: 'Ticket created',
  ticket_updated: 'Ticket updated',
  code_commit: 'Code commit',
  proposal_created: 'Proposal created',
  proposal_approved: 'Proposal approved',
  proposal_pushed: 'Proposal pushed',
  agent_workflow: 'Agent workflow run',
};

/** Derive a human-readable label from event type + metadata. */
function buildLabel(eventType: string, metadata: Record<string, unknown>): string {
  const base = EVENT_LABELS[eventType] ?? eventType;
  const detail = metadata?.message ?? metadata?.title ?? metadata?.commitMessage;
  if (detail && typeof detail === 'string') return `${base}: ${detail}`;
  return base;
}

/**
 * Infer intent from metadata when no human comment is present.
 * Returns null when no meaningful intent can be derived.
 */
function inferIntent(eventType: string, metadata: Record<string, unknown>): string | null {
  switch (eventType) {
    case 'doc_edit': {
      const fields = metadata?.fields;
      if (Array.isArray(fields) && fields.length > 0) {
        return `Updated ${(fields as string[]).join(', ')} to keep documentation current`;
      }
      return 'Updated document content';
    }
    case 'ticket_created': {
      const title = metadata?.title;
      return title ? `Created ticket to track: ${title}` : 'Created ticket for follow-up';
    }
    case 'code_commit': {
      const msg = metadata?.message ?? metadata?.commitMessage;
      return msg ? `Implemented: ${msg}` : 'Committed code changes';
    }
    case 'proposal_created':
      return 'Proposed a change for team review';
    case 'proposal_approved':
      return 'Approved change proposal for implementation';
    case 'proposal_pushed':
      return 'Pushed approved change to development workflow';
    case 'snapshot_created': {
      const name = metadata?.name;
      return name ? `Captured snapshot: ${name}` : 'Captured document snapshot';
    }
    case 'agent_workflow':
      return 'AI agent performed automated workflow';
    default:
      return null;
  }
}

const DRIFT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Determines if a node has a drift flag:
 * true when the event has no downstream code_commit descendant within 14 days.
 * commit events themselves never drift-flag.
 */
function hasDriftFlag(
  eventId: string,
  eventType: string,
  eventTime: Date,
  childMap: Map<string, string[]>,
  typeById: Map<string, string>,
  timeById: Map<string, Date>,
): boolean {
  // Code commits and read-only types don't drift
  if (eventType === 'code_commit') return false;

  // BFS over descendants
  const queue = [eventId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const childId of childMap.get(current) ?? []) {
      const childType = typeById.get(childId);
      const childTime = timeById.get(childId);
      if (childType === 'code_commit' && childTime) {
        const diff = childTime.getTime() - eventTime.getTime();
        if (diff >= 0 && diff <= DRIFT_WINDOW_MS) return false;
      }
      queue.push(childId);
    }
  }

  return true;
}

export const impactGraphService = {
  async buildImpactGraph(documentId: string): Promise<ImpactGraph> {
    const rows = await db
      .select({
        id: auditTrail.id,
        eventType: auditTrail.eventType,
        actorName: users.name,
        parentEventId: auditTrail.parentEventId,
        metadata: auditTrail.metadata,
        createdAt: auditTrail.createdAt,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.actorId, users.id))
      .where(eq(auditTrail.documentId, documentId));

    // Build lookup maps for drift calculation
    const typeById = new Map<string, string>();
    const timeById = new Map<string, Date>();
    const childMap = new Map<string, string[]>();

    for (const row of rows) {
      typeById.set(row.id, row.eventType);
      timeById.set(row.id, row.createdAt ?? new Date());
      if (row.parentEventId) {
        const siblings = childMap.get(row.parentEventId) ?? [];
        siblings.push(row.id);
        childMap.set(row.parentEventId, siblings);
      }
    }

    const nodes: ImpactNode[] = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const eventTime = row.createdAt ?? new Date();
      return {
        id: row.id,
        type: row.eventType,
        label: buildLabel(row.eventType, meta),
        actorName: row.actorName ?? 'System',
        timestamp: eventTime.toISOString(),
        metadata: meta,
        intent: inferIntent(row.eventType, meta),
        driftFlag: hasDriftFlag(row.id, row.eventType, eventTime, childMap, typeById, timeById),
      };
    });

    // Sort chronologically so the chain reads top-to-bottom
    nodes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const edges: ImpactEdge[] = rows
      .filter((r) => r.parentEventId)
      .map((r) => ({ from: r.parentEventId!, to: r.id }));

    return { nodes, edges };
  },
};
