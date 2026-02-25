import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async () => {
    // TODO: implement auth — return mock user for now
    return {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'dev@syncdocs.io',
      name: 'Dev User',
      role: 'owner',
    };
  });
};
