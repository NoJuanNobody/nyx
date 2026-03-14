import type { FastifyPluginAsync } from 'fastify';
import { traceService } from '../services/trace.service.js';
import { requireRole } from '../middleware/permissions.js';

export const traceRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/:documentId/trace
  app.get(
    '/documents/:documentId/trace',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request) => {
      const { documentId } = request.params as { documentId: string };
      const trace = await traceService.buildTrace(documentId);
      const summary = await traceService.getTraceSummary(documentId);
      return { documentId, ...trace, summary };
    },
  );
};
