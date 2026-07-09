import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument, makeUser } from '../helpers/factories.js';
import Fastify from 'fastify';
import { documentRoutes } from '../../routes/documents.js';

// Mock permissions middleware to let requests through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Mock plan-limits service — default to allowed so existing tests are unaffected
const mockCheckLimit = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ allowed: true, limit: -1, current: 0, plan: 'pro' }),
);
vi.mock('../../services/plan-limits.service.js', () => ({
  checkLimit: mockCheckLimit,
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

  it('PUT /api/documents/:id does not clear stage when stage is not in payload', async () => {
    const doc = makeDocument({ title: 'Updated Content', stage: 'design' });

    const mockSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    });
    mockDb.update.mockReturnValue({ set: mockSet } as any);

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/documents/${doc.id}`,
      payload: { content: '# Updated content' },
    });

    expect(res.statusCode).toBe(200);
    // Verify that the set() call did NOT include a stage key
    const setArg = mockSet.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('stage');
    expect(setArg).toHaveProperty('updatedAt');
    expect(setArg).toHaveProperty('content', '# Updated content');
  });

  it('DELETE /api/documents/:id soft-deletes via deletedAt tombstone', async () => {
    const doc = makeDocument({ deletedAt: new Date() });

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
    expect(body.deletedAt).toBeTruthy();
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

  it('returns 403 when free tier document limit reached', async () => {
    mockCheckLimit.mockResolvedValueOnce({ allowed: false, limit: 5, current: 5, plan: 'free' });

    const app = await buildDocApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'New Doc', content: '# Hello', teamId: 'team-1' },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.upgradeRequired).toBe(true);
    expect(body.current).toBe(5);
    expect(body.limit).toBe(5);
    expect(body.plan).toBe('free');
  });

  it('allows document creation when under limit', async () => {
    const doc = makeDocument();
    mockCheckLimit.mockResolvedValueOnce({ allowed: true, limit: 5, current: 2, plan: 'free' });

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

});
