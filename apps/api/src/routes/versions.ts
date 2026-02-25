import type { FastifyPluginAsync } from 'fastify';

export const versionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:documentId', async (request) => {
    const { documentId } = request.params as { documentId: string };
    // TODO: list versions for document
    return { documentId, versions: [] };
  });

  app.post('/:documentId', async (request) => {
    const { documentId } = request.params as { documentId: string };
    // TODO: create version
    return { documentId, message: 'not implemented' };
  });
};
