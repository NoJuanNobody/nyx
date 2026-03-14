import { describe, it, expect } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { authRoutes } from '../../routes/auth.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(authRoutes, { prefix: '/api/auth' });
  await app.ready();
  return app;
}

describe('GET /api/auth/me', () => {
  it('returns the authenticated user object', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    });
  });
});
