import type { FastifyPluginAsync } from 'fastify';

export const authRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/auth/me — return the authenticated user
  app.get('/me', async (request) => {
    return {
      id: request.user.id,
      clerkId: request.user.clerkId,
      email: request.user.email,
      name: request.user.name,
      avatarUrl: request.user.avatarUrl,
      role: request.user.role,
    };
  });
};
