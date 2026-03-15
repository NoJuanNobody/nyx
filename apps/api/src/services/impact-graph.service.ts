import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditTrail, users } from '../db/schema.js';

export interface ImpactNode {
  id: string;
  eventType: string;
  actorName: string | null;
  intent: string;
  driftFlag: boolean;
  commitSha: string | null;
  ticketId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ImpactEdge {
  source: string;
  target: string;
}

export interface ImpactGraph {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

function inferIntent(
  eventType: string,
  metadata: Record<string, unknown>,
  commitSha: string | null,
): string {
  switch (eventType) {
    case 'doc_edit':
      return metadata.fields
        ? `Edited fields: ${(metadata.fields as string[]).join(', ')}`
        : 'Document edited';
    case 'ticket_created':
      return metadata.title ? `Created ticket: ${metadata.title}` : 'Ticket created';
    case 'ticket_updated':
      return metadata.title ? `Updated ticket: ${metadata.title}` : 'Ticket updated';
    case 'code_commit':
      return metadata.message
        ? String(metadata.message)
        : commitSha
          ? `Commit ${commitSha.slice(0, 7)}`
          : 'Code committed';
    case 'proposal_created':
      return metadata.title ? `Proposed: ${metadata.title}` : 'Change proposed';
    case 'proposal_approved':
      return metadata.title ? `Approved: ${metadata.title}` : 'Proposal approved';
    case 'proposal_pushed':
      return metadata.title ? `Pushed: ${metadata.title}` : 'Proposal pushed to code';
    case 'snapshot_created':
      return metadata.name ? `Snapshot: ${metadata.name}` : 'Snapshot created';
    case 'agent_workflow':
      return metadata.prompt
        ? String(metadata.prompt).slice(0, 80)
        : 'Agent workflow run';
    default:
      return eventType.replace(/_/g, ' ');
  }
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const impactGraphService = {
  async buildImpactGraph(documentId: string): Promise<ImpactGraph> {
    const events = await db
      .select({
        id: auditTrail.id,
        eventType: auditTrail.eventType,
        actorName: users.name,
        ticketId: auditTrail.ticketId,
        commitSha: auditTrail.commitSha,
        parentEventId: auditTrail.parentEventId,
        metadata: auditTrail.metadata,
        createdAt: auditTrail.createdAt,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.actorId, users.id))
      .where(eq(auditTrail.documentId, documentId))
      .orderBy(auditTrail.createdAt);

    if (events.length === 0) return { nodes: [], edges: [] };

    const eventMap = new Map(events.map((e) => [e.id, e]));

    // Build children map for downstream traversal
    const childrenOf = new Map<string, string[]>();
    for (const e of events) {
      if (e.parentEventId) {
        const children = childrenOf.get(e.parentEventId) ?? [];
        children.push(e.id);
        childrenOf.set(e.parentEventId, children);
      }
    }

    function hasDownstreamCommit(eventId: string, visited = new Set<string>()): boolean {
      if (visited.has(eventId)) return false;
      visited.add(eventId);
      const children = childrenOf.get(eventId) ?? [];
      for (const childId of children) {
        const child = eventMap.get(childId);
        if (!child) continue;
        if (child.eventType === 'code_commit') return true;
        if (hasDownstreamCommit(childId, visited)) return true;
      }
      return false;
    }

    const nodes: ImpactNode[] = events.map((e) => {
      const createdAt =
        e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt);
      const ageMs = Date.now() - new Date(createdAt).getTime();
      const driftFlag =
        e.eventType !== 'code_commit' &&
        ageMs > FOURTEEN_DAYS_MS &&
        !hasDownstreamCommit(e.id);

      return {
        id: e.id,
        eventType: e.eventType,
        actorName: e.actorName ?? null,
        intent: inferIntent(
          e.eventType,
          (e.metadata ?? {}) as Record<string, unknown>,
          e.commitSha,
        ),
        driftFlag,
        commitSha: e.commitSha,
        ticketId: e.ticketId,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        createdAt,
      };
    });

    const edges: ImpactEdge[] = events
      .filter((e) => e.parentEventId && eventMap.has(e.parentEventId))
      .map((e) => ({ source: e.parentEventId!, target: e.id }));

    return { nodes, edges };
  },
};
