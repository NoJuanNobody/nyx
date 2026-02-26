import type { FastifyPluginAsync } from 'fastify';
import { versionService } from '../services/version.service.js';
import { requireRole } from '../middleware/permissions.js';
import { timelineService } from '../services/timeline.service.js';

/**
 * Document-scoped version routes — registered at /api/documents
 * These add sub-routes under /api/documents/:documentId/versions
 */
export const documentVersionRoutes: FastifyPluginAsync = async (app) => {
  // viewers+ can list versions
  app.get('/:documentId/versions', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    const versions = await versionService.listByDocument(documentId);
    return versions;
  });

  // editors+ can create versions
  app.post('/:documentId/versions', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const { content, message } = request.body as {
      content: string;
      message?: string;
    };

    const createdById = request.user.id;

    const version = await versionService.create({
      documentId,
      content,
      message,
      createdById,
    });

    // Fire-and-forget: record timeline event
    setImmediate(async () => {
      try {
        await timelineService.create({
          documentId,
          type: 'version_created',
          payload: { versionId: version.id, version: version.version, message: version.message },
          actorId: request.user.id,
        });
      } catch {}
    });

    return reply.code(201).send(version);
  });

  // POST /:documentId/restore-to-version/:versionId — restore document to a specific version
  app.post('/:documentId/restore-to-version/:versionId', { preHandler: [requireRole({ minimumRole: 'developer', source: 'document' })] }, async (request, reply) => {
    const { documentId, versionId } = request.params as { documentId: string; versionId: string };
    const userId = request.user.id;

    try {
      const restored = await versionService.restoreToVersion(documentId, versionId, userId);
      return restored;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });
};

/**
 * Standalone version routes — registered at /api/versions
 */
export const versionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const version = await versionService.getById(id);
    if (!version) {
      return reply.code(404).send({ error: 'Version not found' });
    }
    return version;
  });

  app.get('/:idA/diff/:idB', async (request, reply) => {
    const { idA, idB } = request.params as { idA: string; idB: string };
    const result = await versionService.diff(idA, idB);
    if (!result) {
      return reply.code(404).send({ error: 'One or both versions not found' });
    }
    return result;
  });
};
