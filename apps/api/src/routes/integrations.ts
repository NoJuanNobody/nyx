import type { FastifyPluginAsync } from 'fastify';

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    // TODO: list integrations for team
    return [];
  });

  app.post('/', async (request) => {
    // TODO: create integration
    return { message: 'not implemented' };
  });

  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    // TODO: remove integration
    return { id, message: 'not implemented' };
  });
};
