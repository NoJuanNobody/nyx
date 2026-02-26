import type { FastifyPluginAsync } from 'fastify';
import { branchService } from '../services/branch.service.js';
import { requireRole } from '../middleware/permissions.js';

export const branchRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/:documentId/branches — list branches
  app.get('/:documentId/branches', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request) => {
    const { documentId } = request.params as { documentId: string };
    return branchService.listByDocument(documentId);
  });

  // POST /api/documents/:documentId/branches — create a branch
  app.post('/:documentId/branches', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const { name, baseVersionId } = request.body as { name: string; baseVersionId: string };
    const userId = request.user.id;

    const branch = await branchService.create({
      documentId,
      name,
      baseVersionId,
      createdById: userId,
    });

    return reply.code(201).send(branch);
  });

  // GET /api/documents/:documentId/branches/:branchId — get branch
  app.get('/:documentId/branches/:branchId', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request, reply) => {
    const { branchId } = request.params as { documentId: string; branchId: string };
    const branch = await branchService.getById(branchId);
    if (!branch) {
      return reply.code(404).send({ error: 'Branch not found' });
    }
    return branch;
  });

  // PUT /api/documents/:documentId/branches/:branchId — update branch content
  app.put('/:documentId/branches/:branchId', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request) => {
    const { branchId } = request.params as { documentId: string; branchId: string };
    const { content } = request.body as { content: string };
    return branchService.updateContent(branchId, content);
  });

  // GET /api/documents/:documentId/branches/:branchId/diff — diff branch against base
  app.get('/:documentId/branches/:branchId/diff', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request) => {
    const { branchId } = request.params as { documentId: string; branchId: string };
    return branchService.diff(branchId);
  });

  // POST /api/documents/:documentId/branches/:branchId/approve — approve branch
  app.post('/:documentId/branches/:branchId/approve', { preHandler: [requireRole({ minimumRole: 'developer', source: 'document' })] }, async (request, reply) => {
    const { branchId } = request.params as { documentId: string; branchId: string };
    const userId = request.user.id;

    try {
      const branch = await branchService.approve(branchId, userId);
      return branch;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });

  // POST /api/documents/:documentId/branches/:branchId/merge — merge branch
  app.post('/:documentId/branches/:branchId/merge', { preHandler: [requireRole({ minimumRole: 'developer', source: 'document' })] }, async (request, reply) => {
    const { branchId } = request.params as { documentId: string; branchId: string };
    const userId = request.user.id;

    try {
      const branch = await branchService.merge(branchId, userId);
      return branch;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });
};
