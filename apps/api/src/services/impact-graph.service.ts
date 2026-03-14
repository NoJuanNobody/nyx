import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditTrail, users } from '../db/schema.js';

export interface ImpactNode {
  id: string;
  type: string;
  label: string;
  actorName: string;
  timestamp: string;
  intent: string;
  driftFlag: boolean;
  metadata: Record<string, unknown>;
}

export interface ImpactEdge {
  from: string;
  to: string;
}

export interface ImpactGraphResult {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

const EVENT_LABELS: Record<string, string> = {
  doc_edit: 'Document edited',
  snapshot_created: 'Snapshot created',
  ticket_created: 'Ticket created',
  ticket_updated: 'Ticket updated',
  code_commit: 'Code committed',
  proposal_created: 'Proposal created',
  proposal_approved: 'Proposal approved',
  proposal_pushed: 'Proposal pushed',
  agent_workflow: 'Agent workflow run',
};

function inferIntent(eventType: string, metadata: Record<string, unknown>): string {
  const title = metadata.title;
  const message = metadata.commitMessage ?? metadata.message;
  const fields = metadata.fields;
  const name = metadata.name;

  if (typeof title === 'string' && title) return title;
  if (typeof message === 'string' && message) return message;
  if (typeof name === 'string' && name) return name;
  if (Array.isArray(fields) && fields.length > 0) return `Updated ${fields.join(', ')}`;

  const defaults: Record<string, string> = {
    doc_edit: 'Document content updated',
    snapshot_created: 'Codebase snapshot captured',
    ticket_created: 'Ticket opened for implementation',
    ticket_updated: 'Ticket status changed',
    code_commit: 'Code changes pushed',
    proposal_created: 'Change proposal drafted',
    proposal_approved: 'Change proposal approved',
    proposal_pushed: 'Tickets pushed to external tracker',
    agent_workflow: 'Automated workflow executed',
  };

  return defaults[eventType] ?? 'Event recorded';
}

function buildLabel(eventType: string, metadata: Record<string, unknown>): string {
  const base = EVENT_LABELS[eventType] ?? eventType;
  const detail = metadata?.message ?? metadata?.title ?? metadata?.commitMessage;
  if (detail && typeof detail === 'string') {
    return `${base}: ${detail}`;
  }
  return base;
}

/** Returns true if a node has no downstream code_commit within 14 days */
function computeDriftFlag(
  nodeId: string,
  nodeTimestamp: Date,
  nodeType: string,
  allEvents: Array<{ id: string; eventType: string; parentEventId: string | null; createdAt: Date | null }>,
): boolean {
  // code_commit nodes themselves never drift
  if (nodeType === 'code_commit') return false;

  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const nodeTime = nodeTimestamp.getTime();

  // Build a child map: childMap[parentId] = [childId, ...]
  const childMap = new Map<string, string[]>();
  for (const e of allEvents) {
    if (e.parentEventId) {
      const arr = childMap.get(e.parentEventId) ?? [];
      arr.push(e.id);
      childMap.set(e.parentEventId, arr);
    }
  }

  // BFS from nodeId through descendants; look for a code_commit within 14 days
  const visited = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const children = childMap.get(current) ?? [];
    for (const childId of children) {
      const child = allEvents.find((e) => e.id === childId);
      if (!child) continue;
      if (child.eventType === 'code_commit' && child.createdAt) {
        const childTime = child.createdAt.getTime();
        if (childTime - nodeTime <= FOURTEEN_DAYS_MS) {
          return false; // found a downstream commit within 14 days
        }
      }
      queue.push(childId);
    }
  }

  return true; // no downstream commit found
}

export const impactGraphService = {
  async buildImpactGraph(documentId: string): Promise<ImpactGraphResult> {
    const events = await db
      .select({
        id: auditTrail.id,
        eventType: auditTrail.eventType,
        actorId: auditTrail.actorId,
        actorName: users.name,
        parentEventId: auditTrail.parentEventId,
        metadata: auditTrail.metadata,
        createdAt: auditTrail.createdAt,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.actorId, users.id))
      .where(eq(auditTrail.documentId, documentId))
      .orderBy(desc(auditTrail.createdAt));

    // Sort chronologically for consistent graph rendering
    const sorted = [...events].sort(
      (a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );

    const nodes: ImpactNode[] = sorted.map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const createdAt = e.createdAt ?? new Date();
      return {
        id: e.id,
        type: e.eventType,
        label: buildLabel(e.eventType, meta),
        actorName: e.actorName ?? 'System',
        timestamp: createdAt.toISOString(),
        intent: inferIntent(e.eventType, meta),
        driftFlag: computeDriftFlag(e.id, createdAt, e.eventType, sorted.map((s) => ({
          id: s.id,
          eventType: s.eventType,
          parentEventId: s.parentEventId,
          createdAt: s.createdAt ?? new Date(),
        }))),
        metadata: meta,
      };
    });

    const edges: ImpactEdge[] = [];
    for (const e of sorted) {
      if (e.parentEventId) {
        edges.push({ from: e.parentEventId, to: e.id });
      }
    }

    return { nodes, edges };
  },
};
