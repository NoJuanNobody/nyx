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
  it('returns nodes and edges for a document', async () => {
    const mockNodes = [
      {
        id: 'evt-1',
        type: 'doc_edit',
        label: 'Document edited',
        actorName: 'Alice',
        timestamp: '2026-01-01T00:00:00.000Z',
        intent: 'Document content updated',
        driftFlag: true,
        metadata: {},
      },
      {
        id: 'evt-2',
        type: 'ticket_created',
        label: 'Ticket created: Fix login',
        actorName: 'Alice',
        timestamp: '2026-01-02T00:00:00.000Z',
        intent: 'Fix login',
        driftFlag: false,
        metadata: { title: 'Fix login' },
      },
    ];
    const mockEdges = [{ from: 'evt-1', to: 'evt-2' }];

    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue({
      nodes: mockNodes,
      edges: mockEdges,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe('doc-1');
    expect(body.nodes).toEqual(mockNodes);
    expect(body.edges).toEqual(mockEdges);
  });

  it('returns empty nodes and edges when no events exist', async () => {
    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue({
      nodes: [],
      edges: [],
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-empty/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe('doc-empty');
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it('includes drift-flagged nodes in the response', async () => {
    const mockNodes = [
      {
        id: 'evt-1',
        type: 'doc_edit',
        label: 'Document edited',
        actorName: 'Alice',
        timestamp: '2026-01-01T00:00:00.000Z',
        intent: 'Document content updated',
        driftFlag: true,
        metadata: {},
      },
    ];

    vi.mocked(impactGraphService.buildImpactGraph).mockResolvedValue({
      nodes: mockNodes,
      edges: [],
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-drift/impact-graph',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes[0].driftFlag).toBe(true);
  });
});
