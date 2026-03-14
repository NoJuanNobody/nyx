import { describe, it, expect, vi } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { auditRoutes } from '../../routes/audit.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    getTrailForDocument: vi.fn(),
    getTraceChain: vi.fn(),
    getTeamActivity: vi.fn(),
  },
}));

import { auditService } from '../../services/audit.service.js';

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
  app.register(auditRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('GET /api/documents/:docId/audit-trail', () => {
  it('returns { documentId, events }', async () => {
    const mockEvents = [
      { id: 'evt-1', action: 'document.created', timestamp: '2026-01-01T00:00:00Z' },
    ];
    vi.mocked(auditService.getTrailForDocument).mockResolvedValue(mockEvents as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/audit-trail',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documentId: 'doc-1', events: mockEvents });
  });
});

describe('GET /api/audit-trail/:eventId/trace', () => {
  it('returns { eventId, chain }', async () => {
    const mockChain = [
      { id: 'evt-1', action: 'document.created' },
      { id: 'evt-2', action: 'document.updated' },
    ];
    vi.mocked(auditService.getTraceChain).mockResolvedValue(mockChain as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-trail/evt-1/trace',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ eventId: 'evt-1', chain: mockChain });
  });
});

describe('GET /api/teams/:teamId/activity', () => {
  it('returns { teamId, events }', async () => {
    const mockEvents = [
      { id: 'evt-1', action: 'member.added', timestamp: '2026-01-01T00:00:00Z' },
    ];
    vi.mocked(auditService.getTeamActivity).mockResolvedValue(mockEvents as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams/team-1/activity',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ teamId: 'team-1', events: mockEvents });
  });
});
