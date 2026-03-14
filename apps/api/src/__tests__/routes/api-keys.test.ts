import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { apiKeyRoutes } from '../../routes/api-keys.js';

async function buildApp(role: string = 'admin') {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role,
    } as any;
  });
  app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.ready();
  return app;
}

describe('API Key Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/api-keys?teamId=team-1 returns keys array', async () => {
    const keys = [
      { id: 'key-1', name: 'Test Key', keyPrefix: 'sd_abc', scopes: ['read'], lastUsedAt: null, expiresAt: null, revoked: false, createdAt: new Date().toISOString() },
    ];

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(keys),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/api-keys?teamId=team-1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Test Key');
  });

  it('POST /api/api-keys creates key and returns fullKey', async () => {
    const created = {
      id: 'key-1',
      name: 'test-key',
      scopes: ['read', 'write'],
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };

    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      payload: { teamId: 'team-1', name: 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('test-key');
    expect(body.key).toBeDefined();
  });

  it('DELETE /api/api-keys/:keyId returns revoked true', async () => {
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'key-1', revoked: true }]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/api-keys/key-1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.revoked).toBe(true);
  });

  it('DELETE /api/api-keys/:keyId returns 404 when key not found', async () => {
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/api-keys/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /api/api-keys returns 403 for viewer role', async () => {
    const app = await buildApp('viewer');
    const res = await app.inject({
      method: 'GET',
      url: '/api/api-keys?teamId=team-1',
    });

    expect(res.statusCode).toBe(403);
  });
});
