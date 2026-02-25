import type { FastifyPluginAsync } from 'fastify';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    // TODO: list teams for current user
    return [];
  });

  app.post('/', async (request) => {
    // TODO: create team
    return { message: 'not implemented' };
  });

  app.get('/:id/members', async (request) => {
    const { id } = request.params as { id: string };
    // TODO: list team members
    return { teamId: id, members: [] };
  });
};
