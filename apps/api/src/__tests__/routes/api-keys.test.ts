import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { apiKeyRoutes } from '../../routes/api-keys.js';

async function buildApiKeyApp(role = 'admin') {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', role, teamId: 'team-1' } as any;
  });
  app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  await app.ready();
  return app;
}

function makeApiKey(overrides?: Record<string, unknown>) {
  return {
    id: 'key-1',
    teamId: 'team-1',
    userId: 'user-1',
    name: 'CI Key',
    keyPrefix: 'sd_testte',
    scopes: ['read', 'write'],
    lastUsedAt: null,
    expiresAt: null,
    revoked: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('API Key Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/api-keys/?teamId=X', () => {
    it('returns API keys for team (admin)', async () => {
      const keys = [makeApiKey(), makeApiKey({ id: 'key-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(keys),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'GET',
        url: '/api/api-keys/?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toHaveLength(2);
    });

    it('returns API keys for team (owner)', async () => {
      const keys = [makeApiKey()];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(keys),
        }),
      } as any);

      const app = await buildApiKeyApp('owner');
      const res = await app.inject({
        method: 'GET',
        url: '/api/api-keys/?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 403 for non-admin/owner roles', async () => {
      for (const role of ['viewer', 'editor', 'developer']) {
        const app = await buildApiKeyApp(role);
        const res = await app.inject({
          method: 'GET',
          url: '/api/api-keys/?teamId=team-1',
        });

        expect(res.statusCode).toBe(403);
      }
    });

    it('does not include keyHash in response', async () => {
      const keyWithHash = { ...makeApiKey(), keyHash: 'secret-hash' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([keyWithHash]),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'GET',
        url: '/api/api-keys/?teamId=team-1',
      });

      // Response should not include keyHash (it's excluded in the select)
      const body = JSON.parse(res.body);
      // The route uses a specific select that excludes keyHash
      expect(res.statusCode).toBe(200);
      expect(body[0]).not.toHaveProperty('keyHash');
    });
  });

  describe('POST /api/api-keys/', () => {
    it('creates API key and returns full key once', async () => {
      const key = makeApiKey();

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([key]),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/',
        payload: { teamId: 'team-1', name: 'CI Key' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.key).toBeDefined();
      expect(body.key).toMatch(/^sd_/);
    });

    it('generated key has sd_ prefix', async () => {
      const key = makeApiKey();

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([key]),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/',
        payload: { teamId: 'team-1', name: 'Test Key' },
      });

      const body = JSON.parse(res.body);
      expect(body.key).toMatch(/^sd_[A-Za-z0-9_-]+$/);
    });

    it('sets expiresAt when expiresInDays provided', async () => {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const key = makeApiKey({ expiresAt });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([key]),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/',
        payload: { teamId: 'team-1', name: 'Expiring Key', expiresInDays: 30 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.expiresAt).toBeDefined();
    });

    it('expiresAt is null when expiresInDays not provided', async () => {
      const key = makeApiKey({ expiresAt: null });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([key]),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/',
        payload: { teamId: 'team-1', name: 'No Expiry Key' },
      });

      const body = JSON.parse(res.body);
      expect(body.expiresAt).toBeNull();
    });

    it('returns 403 for non-admin/owner', async () => {
      const app = await buildApiKeyApp('developer');
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/',
        payload: { teamId: 'team-1', name: 'Key' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /api/api-keys/:keyId', () => {
    it('revokes API key', async () => {
      const revokedKey = makeApiKey({ revoked: true });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([revokedKey]),
          }),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/api-keys/key-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).revoked).toBe(true);
    });

    it('returns 404 when key not found', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const app = await buildApiKeyApp('admin');
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/api-keys/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for non-admin/owner', async () => {
      const app = await buildApiKeyApp('viewer');
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/api-keys/key-1',
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
