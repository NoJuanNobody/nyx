import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditTrail, users } from '../db/schema.js';

interface TraceNode {
  id: string;
  type: string;
  label: string;
  actorName: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

interface TraceEdge {
  from: string;
  to: string;
}

export interface TraceResult {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

const EVENT_LABELS: Record<string, string> = {
  doc_edit: 'Document edited',
  snapshot_created: 'Snapshot created',
  ticket_created: 'Ticket created',
  ticket_updated: 'Ticket updated',
  code_commit: 'Commit pushed',
  proposal_created: 'Proposal created',
  proposal_approved: 'Proposal approved',
  proposal_pushed: 'Proposal pushed',
  agent_workflow: 'Agent workflow run',
};

function buildLabel(eventType: string, metadata: Record<string, unknown>): string {
  const base = EVENT_LABELS[eventType] ?? eventType;
  const detail = metadata?.message ?? metadata?.title ?? metadata?.commitMessage;
  if (detail && typeof detail === 'string') {
    return `${base}: ${detail}`;
  }
  return base;
}

export const traceService = {
  async buildTrace(documentId: string): Promise<TraceResult> {
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

    const nodes: TraceNode[] = events.map((e) => ({
      id: e.id,
      type: e.eventType,
      label: buildLabel(e.eventType, (e.metadata ?? {}) as Record<string, unknown>),
      actorName: e.actorName ?? 'System',
      timestamp: e.createdAt?.toISOString() ?? new Date().toISOString(),
      metadata: (e.metadata ?? {}) as Record<string, unknown>,
    }));

    const edges: TraceEdge[] = [];
    for (const e of events) {
      if (e.parentEventId) {
        edges.push({ from: e.parentEventId, to: e.id });
      }
    }

    return { nodes, edges };
  },

  async getTraceSummary(documentId: string): Promise<string> {
    const { nodes } = await this.buildTrace(documentId);

    if (nodes.length === 0) {
      return 'No trace events yet for this document.';
    }

    // Build a plain-English summary from the event chain
    const sorted = [...nodes].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const steps = sorted.map((n, i) => {
      const date = new Date(n.timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      return `${i + 1}. ${n.actorName} ${n.label.toLowerCase()} (${date})`;
    });

    return `This document has ${nodes.length} trace event${nodes.length === 1 ? '' : 's'}:\n${steps.join('\n')}`;
  },
};
