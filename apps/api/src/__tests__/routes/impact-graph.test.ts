import { describe, it, expect, vi } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { impactGraphRoutes } from '../../routes/impact-graph.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/impact-graph.service.js', () => ({
  impactGraphService: {
    buildImpactGraph: vi.fn(),
  },
}));

import { impactGraphService } from '../../services/impact-graph.service.js';

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
  app.register(impactGraphRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('GET /api/documents/:documentId/impact-graph', () => {
  it('returns { documentId, nodes, edges }', async () => {
    const mockGraph = {
      nodes: [
        {
          id: 'evt-1',
          type: 'doc_edit',
          label: 'Document edited',
          actorName: 'Test User',
          timestamp: '2026-01-01T00:00:00.000Z',
          metadata: {},
          intent: 'Updated document content',
          driftFlag: false,
        },
      ],
      edges: [],
    };
    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue(mockGraph);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documentId: 'doc-1', ...mockGraph });
  });

  it('returns empty nodes and edges when document has no events', async () => {
    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue({ nodes: [], edges: [] });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-empty/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ documentId: 'doc-empty', nodes: [], edges: [] });
  });

  it('returns nodes with edges when parentEventId links exist', async () => {
    const mockGraph = {
      nodes: [
        {
          id: 'evt-1',
          type: 'doc_edit',
          label: 'Document edited',
          actorName: 'Alice',
          timestamp: '2026-01-01T00:00:00.000Z',
          metadata: {},
          intent: 'Updated document content',
          driftFlag: false,
        },
        {
          id: 'evt-2',
          type: 'ticket_created',
          label: 'Ticket created: Fix auth',
          actorName: 'Alice',
          timestamp: '2026-01-01T01:00:00.000Z',
          metadata: { title: 'Fix auth' },
          intent: 'Created ticket to track: Fix auth',
          driftFlag: true,
        },
      ],
      edges: [{ from: 'evt-1', to: 'evt-2' }],
    };
    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue(mockGraph);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toEqual({ from: 'evt-1', to: 'evt-2' });
  });
});
