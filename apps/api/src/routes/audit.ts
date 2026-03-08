import type { FastifyPluginAsync } from 'fastify';
import { auditService } from '../services/audit.service.js';
import { requireRole } from '../middleware/permissions.js';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/:documentId/audit-trail
  app.get(
    '/documents/:documentId/audit-trail',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request) => {
      const { documentId } = request.params as { documentId: string };
      const events = await auditService.getTrailForDocument(documentId);
      return { documentId, events };
    },
  );

  // GET /api/audit-trail/:eventId/trace
  app.get(
    '/audit-trail/:eventId/trace',
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const chain = await auditService.getTraceChain(eventId);
      return { eventId, chain };
    },
  );

  // GET /api/teams/:teamId/activity
  app.get(
    '/teams/:teamId/activity',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'team' })] },
    async (request) => {
      const { teamId } = request.params as { teamId: string };
      const { limit } = request.query as { limit?: string };
      const events = await auditService.getTeamActivity(teamId, limit ? parseInt(limit, 10) : 50);
      return { teamId, events };
    },
  );
};
