import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { ticketService } from '../services/ticket.service.js';
import { timelineService } from '../services/timeline.service.js';
import { GitHubTokenExpiredError } from '../services/github.service.js';
import { claudeInsightsService } from '../services/claude-insights.service.js';
import { notificationService } from '../services/notification.service.js';
import { NotificationEvents } from '../services/notification-events.js';

export const ticketRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/tickets?teamId=X&status=&provider= — list tickets for a team (Board view)
  app.get('/tickets', async (request, reply) => {
    const { teamId, status, provider } = request.query as { teamId?: string; status?: string; provider?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    return ticketService.listByTeam(teamId, { status, provider });
  });

  // POST /api/tickets/sync-all?teamId=X — sync all ticket statuses for a team
  app.post('/tickets/sync-all', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const synced = await ticketService.syncAllForTeam(teamId);
    return { synced };
  });

  // GET /api/documents/:documentId/tickets — list tickets for a document
  app.get('/documents/:documentId/tickets', async (request) => {
    const { documentId } = request.params as { documentId: string };
    return ticketService.listByDocument(documentId);
  });

  // POST /api/documents/:documentId/tickets — create a ticket from a document
  app.post('/documents/:documentId/tickets', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const { provider, title, body } = request.body as {
      provider: 'github' | 'jira';
      title: string;
      body: string;
    };

    const userId = request.user.id;

    try {
      const ticket = await ticketService.createFromDocument(
        documentId,
        provider,
        title,
        body,
        userId,
      );

      // Fire-and-forget: record timeline event
      setImmediate(async () => {
        try {
          await timelineService.create({
            documentId,
            type: 'ticket_created',
            payload: { ticketId: ticket.id, provider, title, externalUrl: ticket.externalUrl },
            actorId: userId,
          });
        } catch {}
      });

      // Fire-and-forget: notify document owner
      const [doc] = await db
        .select({ teamId: documents.teamId, createdById: documents.createdById })
        .from(documents)
        .where(eq(documents.id, documentId));

      if (doc) {
        notificationService.create({
          userId: doc.createdById,
          teamId: doc.teamId,
          eventType: NotificationEvents.TICKET_CREATED,
          title: `Ticket created: ${title}`,
          body: `A new ${provider} ticket was created from your document.`,
          metadata: { ticketId: ticket.id, provider },
          entityId: ticket.id,
        }).catch(() => {});
      }

      reply.code(201);
      return ticket;
    } catch (err) {
      if (err instanceof GitHubTokenExpiredError) {
        reply.code(401);
        return { error: 'github_token_expired', message: err.message };
      }
      throw err;
    }
  });

  // PATCH /api/tickets/:id/status — manually update ticket status
  app.patch('/tickets/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: string };

    const validStatuses = ['open', 'in_progress', 'closed'];
    if (!status || !validStatuses.includes(status)) {
      reply.code(400);
      return { error: `status must be one of: ${validStatuses.join(', ')}` };
    }

    try {
      const ticket = await ticketService.updateStatus(id, status as 'open' | 'in_progress' | 'closed');
      return ticket;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(404);
      return { error: message };
    }
  });

  // POST /api/tickets/:id/sync — sync ticket status from external provider
  app.post('/tickets/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const ticket = await ticketService.syncStatus(id);
      return ticket;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(404);
      return { error: message };
    }
  });

  // GET /api/tickets/:id/insights — get stored Claude Action insight for a ticket
  app.get('/tickets/:id/insights', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const insight = await claudeInsightsService.getForTicket(id);
      if (!insight) {
        reply.code(404);
        return { error: 'No Claude insight found for this ticket' };
      }
      return insight;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(404);
      return { error: message };
    }
  });

  // POST /api/tickets/:id/insights/refresh — re-fetch Claude Action insight from GitHub
  app.post('/tickets/:id/insights/refresh', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const insight = await claudeInsightsService.refreshForTicket(id);
      if (!insight) {
        reply.code(404);
        return { error: 'No Claude comment found for this ticket' };
      }
      return insight;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(500);
      return { error: message };
    }
  });
};
