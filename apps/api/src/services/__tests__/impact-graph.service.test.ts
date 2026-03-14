import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('impactGraphService.buildImpactGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns empty graph when no events exist', async () => {
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('builds nodes with intent and no driftFlag for code_commit', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: 'evt-1',
                  eventType: 'code_commit',
                  actorName: 'Alice',
                  parentEventId: null,
                  metadata: { message: 'Fix auth bug' },
                  createdAt: now,
                },
              ]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.type).toBe('code_commit');
    expect(node.intent).toBe('Implemented: Fix auth bug');
    expect(node.driftFlag).toBe(false); // code_commit never drifts
    expect(result.edges).toHaveLength(0);
  });

  it('sets driftFlag true for ticket_created with no downstream commit', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: 'evt-1',
                  eventType: 'ticket_created',
                  actorName: 'Alice',
                  parentEventId: null,
                  metadata: { title: 'Implement feature X' },
                  createdAt: now,
                },
              ]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes[0].driftFlag).toBe(true);
  });

  it('sets driftFlag false for ticket_created with downstream commit within 14 days', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-05T00:00:00Z'); // 4 days later — within window
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: 'evt-1',
                  eventType: 'ticket_created',
                  actorName: 'Alice',
                  parentEventId: null,
                  metadata: { title: 'Implement feature X' },
                  createdAt: t0,
                },
                {
                  id: 'evt-2',
                  eventType: 'code_commit',
                  actorName: 'Bob',
                  parentEventId: 'evt-1',
                  metadata: { message: 'feat: implement feature X' },
                  createdAt: t1,
                },
              ]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    const ticketNode = result.nodes.find((n) => n.type === 'ticket_created')!;
    expect(ticketNode.driftFlag).toBe(false);
  });

  it('builds edges from parentEventId links', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-02T00:00:00Z');
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: 'evt-1',
                  eventType: 'doc_edit',
                  actorName: 'Alice',
                  parentEventId: null,
                  metadata: {},
                  createdAt: t0,
                },
                {
                  id: 'evt-2',
                  eventType: 'ticket_created',
                  actorName: 'Alice',
                  parentEventId: 'evt-1',
                  metadata: { title: 'Track changes' },
                  createdAt: t1,
                },
              ]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ from: 'evt-1', to: 'evt-2' });
  });

  it('sorts nodes chronologically', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-03T00:00:00Z');
    const t2 = new Date('2026-01-02T00:00:00Z');
    vi.doMock('../../db/index.js', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              // DB returns in arbitrary order
              where: vi.fn().mockResolvedValue([
                { id: 'evt-b', eventType: 'ticket_created', actorName: 'Alice', parentEventId: 'evt-a', metadata: {}, createdAt: t1 },
                { id: 'evt-a', eventType: 'doc_edit', actorName: 'Alice', parentEventId: null, metadata: {}, createdAt: t0 },
                { id: 'evt-c', eventType: 'code_commit', actorName: 'Bob', parentEventId: 'evt-b', metadata: {}, createdAt: t2 },
              ]),
            }),
          }),
        }),
      },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { DATABASE_URL: 'postgresql://test/test' },
    }));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    // Sorted chronologically: t0 (evt-a), t2 (evt-c), t1 (evt-b)
    expect(result.nodes.map((n) => n.id)).toEqual(['evt-a', 'evt-c', 'evt-b']);
  });
});
