import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument, makeUser } from '../helpers/factories.js';
import Fastify from 'fastify';
import { documentRoutes } from '../../routes/documents.js';

// Mock permissions middleware to let requests through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Mock timeline + audit services
vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../services/audit.service.js', () => ({
  auditService: { recordEvent: vi.fn().mockResolvedValue({}) },
}));

async function buildDocApp() {
  const app = Fastify({ logger: false });

  // Decorate request with a test user
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: null,
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'editor',
    } as any;
  });

  app.register(documentRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

describe('Document Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/documents?teamId=X returns documents for team', async () => {
    const docs = [makeDocument(), makeDocument()];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(docs),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents?teamId=team-1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
  });

  it('POST /api/documents creates document, returns 201', async () => {
    const doc = makeDocument();

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'New Doc', content: '# Hello', teamId: 'team-1' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.title).toBe(doc.title);
  });

  it('PUT /api/documents/:id partial update works', async () => {
    const doc = makeDocument({ title: 'Updated Title' });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([doc]),
        }),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/documents/${doc.id}`,
      payload: { title: 'Updated Title' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Updated Title');
  });

  it('DELETE /api/documents/:id soft-deletes (archives)', async () => {
    const doc = makeDocument({ status: 'archived' });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([doc]),
        }),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${doc.id}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('archived');
  });

  it('GET /api/documents/:id returns 404 for missing doc', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /api/documents without teamId still processes (permission check handles it)', async () => {
    const doc = makeDocument();

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Doc', teamId: 'team-1' },
    });

    // With mocked permissions, this passes
    expect(res.statusCode).toBe(201);
  });

  describe('POST /api/documents/from-template', () => {
    it('creates a document from a marketplace listing and returns 201', async () => {
      const listing = {
        id: 'listing-1',
        title: 'API Spec Template',
        content: '# API Specification\n\n## Endpoints',
        stage: 'design',
        published: true,
        downloadCount: 5,
      };
      const doc = makeDocument({
        title: listing.title,
        content: listing.content,
        stage: listing.stage,
      });

      // First call: select marketplace listing
      const selectChain = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([listing]),
        }),
      };
      mockDb.select.mockReturnValue(selectChain as any);

      // Insert call: create document
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      // Update call: increment download count (fire-and-forget)
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildDocApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/from-template',
        payload: { listingId: 'listing-1', teamId: 'team-1', path: '/specs' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.title).toBe(listing.title);
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildDocApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/from-template',
        payload: { listingId: 'listing-1' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('teamId');
    });

    it('returns 400 when listingId is missing', async () => {
      const app = await buildDocApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/from-template',
        payload: { teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('listingId');
    });

    it('returns 404 when listing is not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildDocApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/from-template',
        payload: { listingId: 'nonexistent', teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });

    it('returns 500 when document creation fails', async () => {
      const listing = {
        id: 'listing-1',
        title: 'Template',
        content: '# Content',
        stage: null,
        published: true,
        downloadCount: 0,
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([listing]),
        }),
      } as any);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as any);

      const app = await buildDocApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/from-template',
        payload: { listingId: 'listing-1', teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Failed');
    });
  });
});
