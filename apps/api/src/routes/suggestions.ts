import type { FastifyPluginAsync } from 'fastify';
import { suggestionService } from '../services/suggestion.service.js';
import { requireRole } from '../middleware/permissions.js';

export const suggestionRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/documents/:documentId/suggest-tickets — generate ticket suggestions
  app.post('/documents/:documentId/suggest-tickets', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    const suggestion = await suggestionService.generateSuggestions(documentId);
    return suggestion;
  });

  // GET /api/documents/:documentId/ticket-suggestions — list suggestions
  app.get('/documents/:documentId/ticket-suggestions', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    return suggestionService.listByDocument(documentId);
  });

  // POST /api/ticket-suggestions/:id/approve — approve a suggestion and create a ticket
  app.post('/ticket-suggestions/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { provider } = request.body as { provider: 'github' | 'jira' };
    const userId = request.user.id;

    try {
      const result = await suggestionService.approve(id, userId, provider);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });

  // POST /api/ticket-suggestions/:id/dismiss — dismiss a suggestion
  app.post('/ticket-suggestions/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;

    try {
      const result = await suggestionService.dismiss(id, userId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });
};
