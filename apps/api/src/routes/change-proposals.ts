import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { changeProposalService } from '../services/change-proposal.service.js';
import { auditService } from '../services/audit.service.js';
import { requireRole } from '../middleware/permissions.js';
import { timelineService } from '../services/timeline.service.js';

export const changeProposalRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/documents/:documentId/change-proposals/generate
  app.post(
    '/documents/:documentId/change-proposals/generate',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const userId = request.user.id;

      const [doc] = await db
        .select({ teamId: documents.teamId })
        .from(documents)
        .where(eq(documents.id, documentId));

      if (!doc) {
        reply.code(404);
        return { error: 'Document not found' };
      }

      try {
        const proposal = await changeProposalService.generate(documentId, doc.teamId, userId);

        // Record audit event
        setImmediate(async () => {
          try {
            await auditService.recordEvent({
              teamId: doc.teamId,
              eventType: 'proposal_created',
              actorId: userId,
              documentId,
              metadata: { proposalId: proposal.id, title: proposal.title },
            });
          } catch {}
        });

        reply.code(201);
        return proposal;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate proposal';
        reply.code(400);
        return { error: message };
      }
    },
  );

  // GET /api/documents/:documentId/change-proposals
  app.get(
    '/documents/:documentId/change-proposals',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request) => {
      const { documentId } = request.params as { documentId: string };
      const { status } = request.query as { status?: string };
      return changeProposalService.list(documentId, status);
    },
  );

  // PATCH /api/change-proposals/:id/approve
  app.patch(
    '/change-proposals/:id/approve',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const proposal = await changeProposalService.getById(id);
      if (!proposal) {
        reply.code(404);
        return { error: 'Proposal not found' };
      }

      const { suggestedTickets } = (request.body ?? {}) as { suggestedTickets?: Array<{ title: string; description: string; priority: string; labels: string[] }> };
      const updated = await changeProposalService.approve(id, suggestedTickets);

      setImmediate(async () => {
        try {
          await auditService.recordEvent({
            teamId: proposal.teamId,
            eventType: 'proposal_approved',
            actorId: request.user.id,
            documentId: proposal.documentId,
            metadata: { proposalId: id },
          });
        } catch {}
      });

      return updated;
    },
  );

  // PATCH /api/change-proposals/:id/reject
  app.patch(
    '/change-proposals/:id/reject',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const proposal = await changeProposalService.getById(id);
      if (!proposal) {
        reply.code(404);
        return { error: 'Proposal not found' };
      }

      return changeProposalService.reject(id);
    },
  );

  // POST /api/change-proposals/:id/push
  app.post(
    '/change-proposals/:id/push',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user.id;

      const proposal = await changeProposalService.getById(id);
      if (!proposal) {
        reply.code(404);
        return { error: 'Proposal not found' };
      }

      try {
        const result = await changeProposalService.push(id, userId);

        setImmediate(async () => {
          try {
            await auditService.recordEvent({
              teamId: proposal.teamId,
              eventType: 'proposal_pushed',
              actorId: userId,
              documentId: proposal.documentId,
              metadata: { proposalId: id, ticketCount: result.createdTickets.length },
            });
            await timelineService.create({
              documentId: proposal.documentId,
              type: 'proposal_pushed',
              payload: { proposalId: id, title: proposal.title, ticketCount: result.createdTickets.length },
              actorId: userId,
            });
          } catch {}
        });

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to push proposal';
        reply.code(400);
        return { error: message };
      }
    },
  );
};
