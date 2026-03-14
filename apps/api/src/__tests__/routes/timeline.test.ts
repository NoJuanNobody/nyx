import { describe, it, expect, vi } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { timelineRoutes } from '../../routes/timeline.js';

vi.mock('../../services/timeline.service.js', () => ({
  timelineService: {
    getByDocument: vi.fn(),
  },
}));

import { timelineService } from '../../services/timeline.service.js';

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
  app.register(timelineRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

describe('GET /api/documents/:documentId/timeline', () => {
  it('returns { documentId, events }', async () => {
    const mockEvents = [
      { id: 'evt-1', type: 'created', timestamp: '2026-01-01T00:00:00Z' },
    ];
    vi.mocked(timelineService.getByDocument).mockResolvedValue(mockEvents);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/timeline',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documentId: 'doc-1', events: mockEvents });
  });
});
