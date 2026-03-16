import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { permissionRoutes } from '../../routes/permissions.js';

async function buildApp(userId: string = 'user-1') {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: userId,
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(permissionRoutes, { prefix: '/api/permissions' });
  await app.ready();
  return app;
}

function mockUserRole(role: string | null) {
  if (role === null) {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);
  } else {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ role }]),
      }),
    } as any);
  }
}

describe('Permission Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/permissions/check', () => {
    it('returns allowed=true when user role meets requirement', async () => {
      mockUserRole('admin');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=edit',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(true);
      expect(body.role).toBe('admin');
      expect(body.requiredRole).toBe('editor');
    });

    it('returns allowed=false when user role is insufficient', async () => {
      mockUserRole('viewer');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=delete',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(false);
      expect(body.role).toBe('viewer');
      expect(body.requiredRole).toBe('admin');
      expect(body.reason).toContain("requires at least 'admin'");
    });

    it('returns allowed=false when user is not a team member', async () => {
      mockUserRole(null);
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=read',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(false);
      expect(body.role).toBeNull();
      expect(body.reason).toContain('not a member');
    });

    it('returns 400 for missing teamId', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?action=read',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for unknown action', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=fly',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Unknown action');
    });

    it('maps deploy action to developer role', async () => {
      mockUserRole('developer');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=deploy',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(true);
      expect(body.requiredRole).toBe('developer');
    });

    it('maps transfer action to owner role', async () => {
      mockUserRole('admin');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/check?teamId=team-1&action=transfer',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(false);
      expect(body.requiredRole).toBe('owner');
    });
  });

  describe('GET /api/permissions/roles', () => {
    it('returns role and hierarchy for team member', async () => {
      mockUserRole('editor');
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/roles?teamId=team-1',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.role).toBe('editor');
      expect(body.hierarchy).toEqual(['viewer', 'editor', 'developer', 'admin', 'owner']);
      expect(body.allowedActions).toContain('read');
      expect(body.allowedActions).toContain('edit');
      expect(body.allowedActions).not.toContain('delete');
    });

    it('returns 403 for non-member', async () => {
      mockUserRole(null);
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/roles?teamId=team-1',
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 for missing teamId', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/permissions/roles',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
