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

  // POST /api/documents/:documentId/bulk-suggest-tickets — generate bulk ticket suggestions
  app.post('/documents/:documentId/bulk-suggest-tickets', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    const suggestions = await suggestionService.generateBulkSuggestions(documentId);
    return suggestions;
  });

  // POST /api/ticket-suggestions/bulk-approve — approve multiple suggestions at once
  app.post('/ticket-suggestions/bulk-approve', async (request, reply) => {
    const { suggestionIds, provider } = request.body as { suggestionIds: string[]; provider: 'github' | 'jira' };
    const userId = request.user.id;
    if (!suggestionIds?.length) { reply.code(400); return { error: 'No suggestions selected' }; }
    if (!['github', 'jira'].includes(provider)) { reply.code(400); return { error: 'Invalid provider' }; }
    const results = await suggestionService.bulkApprove(suggestionIds, userId, provider);
    return results;
  });

  // POST /api/folders/suggest-tickets — generate ticket suggestions from all docs in a folder
  app.post('/folders/suggest-tickets', async (request, reply) => {
    const { teamId, folderPath } = request.body as { teamId: string; folderPath: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }
    if (!folderPath) {
      reply.code(400);
      return { error: 'folderPath is required' };
    }

    try {
      const suggestions = await suggestionService.generateFolderSuggestions(teamId, folderPath);
      return suggestions;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });

  // PATCH /api/ticket-suggestions/:id — edit a pending suggestion
  app.patch('/ticket-suggestions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as { title?: string; description?: string; labels?: string[] };
    try {
      const updated = await suggestionService.updateSuggestion(id, updates);
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });
};
