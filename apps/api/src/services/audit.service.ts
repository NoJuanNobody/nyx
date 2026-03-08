import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditTrail, users } from '../db/schema.js';

type AuditEventType =
  | 'doc_edit' | 'snapshot_created' | 'ticket_created' | 'ticket_updated'
  | 'code_commit' | 'proposal_created' | 'proposal_approved' | 'proposal_pushed'
  | 'agent_workflow';

export interface RecordEventParams {
  teamId: string;
  eventType: AuditEventType;
  actorId?: string;
  documentId?: string;
  snapshotId?: string;
  ticketId?: string;
  commitSha?: string;
  parentEventId?: string;
  metadata?: Record<string, unknown>;
}

export const auditService = {
  async recordEvent(params: RecordEventParams) {
    const [event] = await db
      .insert(auditTrail)
      .values({
        teamId: params.teamId,
        eventType: params.eventType,
        actorId: params.actorId ?? null,
        documentId: params.documentId ?? null,
        snapshotId: params.snapshotId ?? null,
        ticketId: params.ticketId ?? null,
        commitSha: params.commitSha ?? null,
        parentEventId: params.parentEventId ?? null,
        metadata: params.metadata ?? {},
      })
      .returning();
    return event;
  },

  async getTrailForDocument(documentId: string) {
    const events = await db
      .select({
        id: auditTrail.id,
        teamId: auditTrail.teamId,
        eventType: auditTrail.eventType,
        actorId: auditTrail.actorId,
        actorName: users.name,
        documentId: auditTrail.documentId,
        snapshotId: auditTrail.snapshotId,
        ticketId: auditTrail.ticketId,
        commitSha: auditTrail.commitSha,
        parentEventId: auditTrail.parentEventId,
        metadata: auditTrail.metadata,
        createdAt: auditTrail.createdAt,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.actorId, users.id))
      .where(eq(auditTrail.documentId, documentId))
      .orderBy(desc(auditTrail.createdAt));

    return events;
  },

  async getTraceChain(eventId: string) {
    // Walk up the parentEventId chain
    const chain = [];
    let currentId: string | null = eventId;

    while (currentId) {
      const [event] = await db
        .select({
          id: auditTrail.id,
          teamId: auditTrail.teamId,
          eventType: auditTrail.eventType,
          actorId: auditTrail.actorId,
          actorName: users.name,
          documentId: auditTrail.documentId,
          snapshotId: auditTrail.snapshotId,
          ticketId: auditTrail.ticketId,
          commitSha: auditTrail.commitSha,
          parentEventId: auditTrail.parentEventId,
          metadata: auditTrail.metadata,
          createdAt: auditTrail.createdAt,
        })
        .from(auditTrail)
        .leftJoin(users, eq(auditTrail.actorId, users.id))
        .where(eq(auditTrail.id, currentId));

      if (!event) break;
      chain.push(event);
      currentId = event.parentEventId;

      // Safety: prevent infinite loops
      if (chain.length > 50) break;
    }

    return chain;
  },

  async getTeamActivity(teamId: string, limit = 50) {
    const events = await db
      .select({
        id: auditTrail.id,
        teamId: auditTrail.teamId,
        eventType: auditTrail.eventType,
        actorId: auditTrail.actorId,
        actorName: users.name,
        documentId: auditTrail.documentId,
        snapshotId: auditTrail.snapshotId,
        ticketId: auditTrail.ticketId,
        commitSha: auditTrail.commitSha,
        parentEventId: auditTrail.parentEventId,
        metadata: auditTrail.metadata,
        createdAt: auditTrail.createdAt,
      })
      .from(auditTrail)
      .leftJoin(users, eq(auditTrail.actorId, users.id))
      .where(eq(auditTrail.teamId, teamId))
      .orderBy(desc(auditTrail.createdAt))
      .limit(limit);

    return events;
  },
};
