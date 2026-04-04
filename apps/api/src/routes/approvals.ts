import type { FastifyPluginAsync } from 'fastify';
import { approvalService } from '../services/approval.service.js';
import { requireRole } from '../middleware/permissions.js';

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/teams/:teamId/approvals — list approvals for a team
  app.get(
    '/teams/:teamId/approvals',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'team' })] },
    async (request) => {
      const { teamId } = request.params as { teamId: string };
      const { status } = request.query as { status?: string };
      const items = await approvalService.listByTeam(teamId, status);
      return { approvals: items };
    },
  );

  // GET /api/approvals/:id — get a single approval
  app.get(
    '/approvals/:id',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const approval = await approvalService.getById(id);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }
      return { approval };
    },
  );

  // POST /api/approvals/:id/approve — approve a pending approval
  app.post(
    '/approvals/:id/approve',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { reason?: string };
      const userId = request.user?.id;

      if (!userId) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const approval = await approvalService.approve(id, userId, body.reason);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }

      return { approval };
    },
  );

  // POST /api/approvals/:id/reject — reject a pending approval
  app.post(
    '/approvals/:id/reject',
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { reason?: string };
      const userId = request.user?.id;

      if (!userId) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const approval = await approvalService.reject(id, userId, body.reason);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }

      return { approval };
    },
  );
};
