import type { FastifyPluginAsync } from 'fastify';
import { timelineService } from '../services/timeline.service.js';

/**
 * Document-scoped timeline routes — registered at /api/documents
 * Adds sub-routes under /api/documents/:documentId/timeline
 */
export const timelineRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:documentId/timeline', async (request) => {
    const { documentId } = request.params as { documentId: string };
    const events = await timelineService.getByDocument(documentId);
    return { documentId, events };
  });
};
