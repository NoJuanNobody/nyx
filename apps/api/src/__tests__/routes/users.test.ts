import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { userRoutes } from '../../routes/users.js';

vi.mock('../../db/schema.js', () => ({
  users: { id: 'id' },
  teamMembers: { userId: 'userId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
}));

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
  app.register(userRoutes, { prefix: '/api/users' });
  await app.ready();
  return app;
}

describe('PATCH /api/users/me', () => {
  it('returns updated user on success', async () => {
    const updatedUser = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'New Name',
      avatarUrl: null,
      role: 'admin',
    };

    const returningMock = vi.fn().mockResolvedValue([updatedUser]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(updatedUser);
  });

  it('returns 404 when user not found', async () => {
    const returningMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'User not found' });
  });
});

describe('DELETE /api/users/me', () => {
  it('returns 204 on success', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/me',
    });

    expect(res.statusCode).toBe(204);
  });
});
