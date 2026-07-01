import type { FastifyPluginAsync } from 'fastify';
import { suggestionService } from '../services/suggestion.service.js';
import { jobService } from '../services/job.service.js';
import { requireRole } from '../middleware/permissions.js';
import type { TicketDestination } from '../services/ticket.service.js';

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
    const { provider, repo } = request.body as {
      provider: 'github' | 'jira';
      repo?: { owner: string; name: string };
    };
    const userId = request.user.id;

    try {
      const result = await suggestionService.approve(id, userId, provider, repo);
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

  // POST /api/ticket-suggestions/:id/expand — expand a brief suggestion into full description
  app.post('/ticket-suggestions/:id/expand', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = await suggestionService.expandSuggestion(id);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });

  // POST /api/documents/:documentId/bulk-suggest-tickets — generate bulk ticket suggestions (async job)
  app.post('/documents/:documentId/bulk-suggest-tickets', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    const userId = request.user.id;

    const job = await jobService.create(null, userId, 'bulk-suggest-tickets', { documentId });

    setImmediate(async () => {
      try {
        await jobService.markRunning(job.id);
        const suggestions = await suggestionService.generateBulkSuggestions(documentId);
        await jobService.markCompleted(job.id, suggestions);
      } catch (err) {
        await jobService.markFailed(job.id, err instanceof Error ? err.message : 'Unknown error');
      }
    });

    return { jobId: job.id };
  });

  // POST /api/ticket-suggestions/bulk-approve — approve multiple suggestions at once (async)
  app.post('/ticket-suggestions/bulk-approve', async (request, reply) => {
    const { suggestionIds, destination, teamId } = request.body as {
      suggestionIds: string[];
      destination: TicketDestination;
      teamId?: string;
    };
    const userId = request.user.id;
    if (!suggestionIds?.length) { reply.code(400); return { error: 'No suggestions selected' }; }
    const validProviders = ['github', 'gitlab', 'bitbucket', 'jira'];
    if (!destination?.provider || !validProviders.includes(destination.provider)) {
      reply.code(400); return { error: 'Invalid destination provider' };
    }

    const job = await jobService.create(
      teamId || null,
      userId,
      'bulk-approve-tickets',
      { suggestionIds, destination },
    );

    setImmediate(async () => {
      try {
        await jobService.markRunning(job.id);
        const results = await suggestionService.bulkApprove(suggestionIds, userId, destination);
        await jobService.markCompleted(job.id, results);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await jobService.markFailed(job.id, message);
      }
    });

    reply.code(202);
    return { jobId: job.id };
  });

  // POST /api/folders/suggest-tickets — generate ticket suggestions from all docs in a folder (async)
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

    const userId = request.user.id;
    const job = await jobService.create(teamId, userId, 'folder-suggest-tickets', { teamId, folderPath });

    setImmediate(async () => {
      try {
        await jobService.markRunning(job.id);
        const suggestions = await suggestionService.generateFolderSuggestions(teamId, folderPath);
        await jobService.markCompleted(job.id, suggestions);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await jobService.markFailed(job.id, message);
      }
    });

    reply.code(202);
    return { jobId: job.id };
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
