import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../middleware/permissions.js';
import { deliverableService } from '../services/deliverable.service.js';

export const deliverableRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/:id/deliverables — list all deliverables for a document
  app.get(
    '/:id/deliverables',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const items = await deliverableService.listDeliverables(id);
      return items;
    },
  );

  // POST /api/documents/:id/deliverables/generate — trigger deliverable generation for current stage
  app.post(
    '/:id/deliverables/generate',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const items = await deliverableService.generateDeliverables(id);
        reply.code(201);
        return items;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate deliverables';
        reply.code(500);
        return { error: message };
      }
    },
  );

  // GET /api/documents/:id/deliverables/:deliverableId/download — download deliverable content
  app.get(
    '/:id/deliverables/:deliverableId/download',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request, reply) => {
      const { deliverableId } = request.params as { id: string; deliverableId: string };
      const item = await deliverableService.getDeliverable(deliverableId);

      if (!item) {
        reply.code(404);
        return { error: 'Deliverable not found' };
      }

      if (item.status !== 'ready' || !item.content) {
        reply.code(409);
        return { error: `Deliverable is not ready (status: ${item.status})` };
      }

      reply
        .header('Content-Type', item.mimeType)
        .header('Content-Disposition', `attachment; filename="${item.fileName}"`)
        .send(item.content);
    },
  );

  // DELETE /api/documents/:id/deliverables/:deliverableId — delete a deliverable
  app.delete(
    '/:id/deliverables/:deliverableId',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const { deliverableId } = request.params as { id: string; deliverableId: string };
      const deleted = await deliverableService.deleteDeliverable(deliverableId);
      if (!deleted) {
        reply.code(404);
        return { error: 'Deliverable not found' };
      }
      return { success: true };
    },
  );
};
