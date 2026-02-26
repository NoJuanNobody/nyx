import type { FastifyPluginAsync } from 'fastify';
import { snapshotService } from '../services/snapshot.service.js';

export const snapshotRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request) => {
    const { teamId } = request.query as { teamId?: string };
    const snapshots = await snapshotService.list(teamId);
    return { snapshots };
  });

  app.post('/', async (request, reply) => {
    const { name, documentIds } = request.body as {
      name: string;
      documentIds: string[];
    };

    const snapshots = await snapshotService.create({ name, documentIds });
    return reply.code(201).send({ snapshots });
  });

  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const snapshot = await snapshotService.getById(id);
    if (!snapshot) {
      return reply.code(404).send({ error: 'Snapshot not found' });
    }
    return snapshot;
  });

  // POST /:id/restore — restore a document from a snapshot
  app.post('/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;

    try {
      const result = await snapshotService.restore(id, userId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });
};
