import type { FastifyPluginAsync } from 'fastify';
import { impactGraphService } from '../services/impact-graph.service.js';
import { requireRole } from '../middleware/permissions.js';

export const impactGraphRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/:documentId/impact-graph
  app.get(
    '/documents/:documentId/impact-graph',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request) => {
      const { documentId } = request.params as { documentId: string };
      const graph = await impactGraphService.buildImpactGraph(documentId);
      return { documentId, ...graph };
    },
  );
};
