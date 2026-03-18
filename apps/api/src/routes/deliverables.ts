import type { FastifyPluginAsync } from 'fastify';
import { deliverableService } from '../services/deliverable.service.js';
import type { DeliverableType } from '../services/deliverable.service.js';

export const deliverableRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/documents/:id/deliverables — generate a deliverable
  app.post('/:id/deliverables', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { stage, type } = request.body as { stage: string; type: DeliverableType };

    if (!stage || !type) {
      reply.code(400);
      return { error: 'stage and type are required' };
    }

    const validTypes: DeliverableType[] = ['pdf', 'markdown', 'report'];
    if (!validTypes.includes(type)) {
      reply.code(400);
      return { error: `type must be one of: ${validTypes.join(', ')}` };
    }

    const deliverable = await deliverableService.generateDeliverable({
      documentId: id,
      stage,
      type,
    });

    if (!deliverable) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    reply.code(201);
    return deliverable;
  });

  // GET /api/documents/:id/deliverables — list deliverables for a document
  app.get('/:id/deliverables', async (request) => {
    const { id } = request.params as { id: string };
    const deliverables = await deliverableService.listDeliverables(id);
    return { deliverables };
  });
};

export const deliverableSingleRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/deliverables/:id — get single deliverable
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deliverable = await deliverableService.getDeliverable(id);

    if (!deliverable) {
      reply.code(404);
      return { error: 'Deliverable not found' };
    }

    return deliverable;
  });
};
