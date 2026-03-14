import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeTemplate } from '../helpers/factories.js';
import Fastify from 'fastify';
import { templateRoutes } from '../../routes/templates.js';

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
  app.register(templateRoutes, { prefix: '/api/templates' });
  await app.ready();
  return app;
}

describe('Custom Template CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── POST /api/templates ─────────────────────────────────────────────

  describe('POST /api/templates', () => {
    it('creates a custom template and returns 201', async () => {
      const created = makeTemplate({
        id: 'tmpl-new',
        name: 'My Custom Template',
        stage: 'definition',
        teamId: 'team-1',
        content: '# Custom\n\nBody here',
        description: 'A custom template',
      });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          name: 'My Custom Template',
          stage: 'definition',
          teamId: 'team-1',
          content: '# Custom\n\nBody here',
          description: 'A custom template',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('tmpl-new');
      expect(body.name).toBe('My Custom Template');
      expect(body.teamId).toBe('team-1');
    });

    it('returns 400 when required fields are missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/templates',
        payload: {
          // missing name, stage, content
          description: 'incomplete',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  // ── PUT /api/templates/:id ──────────────────────────────────────────

  describe('PUT /api/templates/:id', () => {
    it('updates a custom template', async () => {
      const existing = makeTemplate({
        id: 'tmpl-custom',
        name: 'Old Name',
        teamId: 'team-1',
      });

      const updated = { ...existing, name: 'Updated Name' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([existing]),
        }),
      } as any);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/tmpl-custom',
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('Updated Name');
    });

    it('returns 403 when trying to update a built-in template', async () => {
      const builtIn = makeTemplate({
        id: 'tmpl-builtin',
        name: 'Built-in Template',
        teamId: null,
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([builtIn]),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/tmpl-builtin',
        payload: { name: 'Hacked Name' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('returns 404 when template does not exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/templates/nonexistent',
        payload: { name: 'Whatever' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ── DELETE /api/templates/:id ───────────────────────────────────────

  describe('DELETE /api/templates/:id', () => {
    it('deletes a custom template', async () => {
      const existing = makeTemplate({
        id: 'tmpl-delete-me',
        name: 'Deletable',
        teamId: 'team-1',
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([existing]),
        }),
      } as any);

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/tmpl-delete-me',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
    });

    it('returns 403 when trying to delete a built-in template', async () => {
      const builtIn = makeTemplate({
        id: 'tmpl-builtin',
        name: 'Built-in Template',
        teamId: null,
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([builtIn]),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/tmpl-builtin',
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('returns 404 when template does not exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/templates/nonexistent',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not found/i);
    });
  });

  // ── GET /api/templates?teamId=X ─────────────────────────────────────

  describe('GET /api/templates?teamId=X', () => {
    it('returns both global and team-scoped templates', async () => {
      const templates = [
        makeTemplate({ id: 'global-1', name: 'Global', teamId: null, sortOrder: 0 }),
        makeTemplate({ id: 'team-1', name: 'Team Custom', teamId: 'team-abc', sortOrder: 1 }),
      ];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(templates),
          }),
        }),
      } as any);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/templates?teamId=team-abc',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBeGreaterThanOrEqual(2);
      const ids = body.map((t: any) => t.id);
      expect(ids).toContain('global-1');
      expect(ids).toContain('team-1');
    });
  });
});
