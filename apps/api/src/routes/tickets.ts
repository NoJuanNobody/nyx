import type { FastifyPluginAsync } from 'fastify';
import { ticketService } from '../services/ticket.service.js';
import { timelineService } from '../services/timeline.service.js';

export const ticketRoutes: FastifyPluginAsync = async (app) => {
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

    reply.code(201);
    return ticket;
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
};
