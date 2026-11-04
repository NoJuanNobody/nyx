import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { aiKeyRoutes } from '../../routes/ai-keys.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/encryption.service.js', () => ({
  encrypt: vi.fn(() => ({ ciphertext: 'encrypted-base64', iv: 'iv-base64' })),
  decrypt: vi.fn(() => 'sk-ant-decrypted-key'),
}));

vi.mock('../../services/ai.service.js', () => ({
  invalidateTeamClient: vi.fn(),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: null,
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(aiKeyRoutes, { prefix: '/api/teams' });
  await app.ready();
  return app;
}

describe('AI Key Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/teams/:id/ai-key returns 409 if key already exists', async () => {
    // Existing key found
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'key-1' }]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/teams/team-1/ai-key',
      payload: { provider: 'anthropic', apiKey: 'sk-ant-test-1234' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('POST /api/teams/:id/ai-key creates key', async () => {
    // No existing key
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    // Insert returns row
    const now = new Date().toISOString();
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          provider: 'anthropic',
          keySuffix: '1234',
          isActive: true,
          createdAt: now,
        }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/teams/team-1/ai-key',
      payload: { provider: 'anthropic', apiKey: 'sk-ant-test-1234' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.provider).toBe('anthropic');
    expect(body.keySuffix).toBe('1234');
    expect(body.isActive).toBe(true);
  });

  it('GET /api/teams/:id/ai-key returns configured: false when no key', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/ai-key',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      configured: false,
      defaultModel: null,
      fastModel: null,
    });
  });

  it('GET /api/teams/:id/ai-key returns key status when configured', async () => {
    const now = new Date().toISOString();
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            provider: 'anthropic',
            keySuffix: 'xK7f',
            isActive: true,
            createdAt: now,
            rotatedAt: null,
          }]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/ai-key',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.configured).toBe(true);
    expect(body.provider).toBe('anthropic');
    expect(body.keySuffix).toBe('xK7f');
  });

  it('PUT /api/teams/:id/ai-key rotates key', async () => {
    // Find existing key
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 'key-1', provider: 'anthropic' }]),
        }),
      }),
    } as any);

    const now = new Date().toISOString();
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            provider: 'anthropic',
            keySuffix: '5678',
            isActive: true,
            rotatedAt: now,
          }]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/teams/team-1/ai-key',
      payload: { apiKey: 'sk-ant-new-key-5678' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.keySuffix).toBe('5678');
  });

  it('DELETE /api/teams/:id/ai-key removes key', async () => {
    mockDb.delete.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'key-1' }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/teams/team-1/ai-key',
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE /api/teams/:id/ai-key returns 404 when no key', async () => {
    mockDb.delete.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/teams/team-1/ai-key',
    });

    expect(res.statusCode).toBe(404);
  });
});
