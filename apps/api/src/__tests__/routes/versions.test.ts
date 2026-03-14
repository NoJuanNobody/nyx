import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

const { mockVersionService } = vi.hoisted(() => ({
  mockVersionService: {
    listByDocument: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    diff: vi.fn(),
    restoreToVersion: vi.fn(),
  },
}));

vi.mock('../../services/version.service.js', () => ({
  versionService: mockVersionService,
}));

vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn() },
}));

import { documentVersionRoutes, versionRoutes } from '../../routes/versions.js';

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
  app.register(documentVersionRoutes, { prefix: '/api/documents' });
  app.register(versionRoutes, { prefix: '/api/versions' });
  await app.ready();
  return app;
}

describe('Version Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/documents/:docId/versions returns versions list', async () => {
    const versions = [{ id: 'v-1', version: 1 }, { id: 'v-2', version: 2 }];
    mockVersionService.listByDocument.mockResolvedValue(versions);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/versions' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
  });

  it('POST /api/documents/:docId/versions creates version and returns 201', async () => {
    const version = { id: 'v-1', version: 1, documentId: 'doc-1', message: 'initial' };
    mockVersionService.create.mockResolvedValue(version);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/doc-1/versions',
      payload: { content: '# Hello', message: 'initial' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('v-1');
  });

  it('GET /api/versions/:id returns version', async () => {
    const version = { id: 'v-1', version: 1, content: '# Hello' };
    mockVersionService.getById.mockResolvedValue(version);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/versions/v-1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('v-1');
  });

  it('GET /api/versions/:id returns 404 when not found', async () => {
    mockVersionService.getById.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/versions/nonexistent' });

    expect(res.statusCode).toBe(404);
  });

  it('GET /api/versions/:idA/diff/:idB returns diff result', async () => {
    const diffResult = { added: 5, removed: 2, patch: '...' };
    mockVersionService.diff.mockResolvedValue(diffResult);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/versions/v-1/diff/v-2' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.added).toBe(5);
  });
});
