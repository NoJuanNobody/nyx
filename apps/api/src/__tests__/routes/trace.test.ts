import { describe, it, expect, vi } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';
import { traceRoutes } from '../../routes/trace.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../services/trace.service.js', () => ({
  traceService: {
    buildTrace: vi.fn(),
    getTraceSummary: vi.fn(),
  },
}));

import { traceService } from '../../services/trace.service.js';

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
  app.register(traceRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('GET /api/documents/:documentId/trace', () => {
  it('returns nodes, edges, and summary for a document', async () => {
    const mockNodes = [
      {
        id: 'evt-1',
        type: 'doc_edit',
        label: 'Document edited',
        actorName: 'Test User',
        timestamp: '2026-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'evt-2',
        type: 'ticket_created',
        label: 'Ticket created',
        actorName: 'Test User',
        timestamp: '2026-01-02T00:00:00.000Z',
        metadata: {},
      },
    ];
    const mockEdges = [{ from: 'evt-1', to: 'evt-2' }];

    vi.mocked(traceService.buildTrace).mockResolvedValue({
      nodes: mockNodes,
      edges: mockEdges,
    });
    vi.mocked(traceService.getTraceSummary).mockResolvedValue(
      'This document has 2 trace events.',
    );

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-1/trace',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe('doc-1');
    expect(body.nodes).toEqual(mockNodes);
    expect(body.edges).toEqual(mockEdges);
    expect(body.summary).toBe('This document has 2 trace events.');
  });

  it('returns empty nodes when no events exist', async () => {
    vi.mocked(traceService.buildTrace).mockResolvedValue({
      nodes: [],
      edges: [],
    });
    vi.mocked(traceService.getTraceSummary).mockResolvedValue(
      'No trace events yet for this document.',
    );

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-empty/trace',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe('doc-empty');
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.summary).toBe('No trace events yet for this document.');
  });

  it('returns edges reflecting parentEventId chains', async () => {
    const mockNodes = [
      {
        id: 'evt-1',
        type: 'doc_edit',
        label: 'Document edited',
        actorName: 'Alice',
        timestamp: '2026-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'evt-2',
        type: 'ticket_created',
        label: 'Ticket created',
        actorName: 'Alice',
        timestamp: '2026-01-02T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'evt-3',
        type: 'code_commit',
        label: 'Commit pushed',
        actorName: 'Bob',
        timestamp: '2026-01-03T00:00:00.000Z',
        metadata: {},
      },
    ];
    const mockEdges = [
      { from: 'evt-1', to: 'evt-2' },
      { from: 'evt-2', to: 'evt-3' },
    ];

    vi.mocked(traceService.buildTrace).mockResolvedValue({
      nodes: mockNodes,
      edges: mockEdges,
    });
    vi.mocked(traceService.getTraceSummary).mockResolvedValue('3 events');

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/doc-chain/trace',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.edges).toHaveLength(2);
    expect(body.edges[0]).toEqual({ from: 'evt-1', to: 'evt-2' });
    expect(body.edges[1]).toEqual({ from: 'evt-2', to: 'evt-3' });
  });
});
