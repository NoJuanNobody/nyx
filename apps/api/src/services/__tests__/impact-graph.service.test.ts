import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared chainable mock ────────────────────────────────────────────

function chainable(resolvedValue: unknown = []): unknown {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'from', 'where', 'leftJoin', 'orderBy', 'limit',
    'insert', 'values', 'returning', 'update', 'set', 'delete',
    'innerJoin', 'groupBy', 'having', 'offset',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolvedValue).then(resolve);
  return chain;
}

const mockSelect = vi.fn();

vi.mock('../../db/index.js', () => ({ db: { select: mockSelect } }));
vi.mock('../../db/schema.js', () => ({
  auditTrail: {},
  users: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq-condition'),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const BASE = '2025-01-01T00:00:00Z';
const OLD = '2020-01-01T00:00:00Z'; // > 14 days ago → triggers drift check

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    eventType: 'doc_edit',
    actorName: 'Dev User',
    ticketId: null,
    commitSha: null,
    parentEventId: null,
    metadata: {},
    createdAt: OLD,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('impactGraphService.buildImpactGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty graph when document has no audit events', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it('builds a node for each audit event', async () => {
    const events = [
      makeEvent({ id: 'a', eventType: 'doc_edit', createdAt: BASE }),
      makeEvent({ id: 'b', eventType: 'ticket_created', createdAt: BASE }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].id).toBe('a');
    expect(result.nodes[1].id).toBe('b');
  });

  it('builds edges from parentEventId links', async () => {
    const events = [
      makeEvent({ id: 'a', eventType: 'doc_edit', parentEventId: null, createdAt: BASE }),
      makeEvent({ id: 'b', eventType: 'ticket_created', parentEventId: 'a', createdAt: BASE }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ source: 'a', target: 'b' });
  });

  it('does not create edges for parentEventId pointing to unknown events', async () => {
    const events = [
      makeEvent({ id: 'b', eventType: 'doc_edit', parentEventId: 'unknown-id', createdAt: BASE }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.edges).toHaveLength(0);
  });

  it('sets driftFlag=true for old events without downstream code_commit', async () => {
    const events = [makeEvent({ id: 'a', eventType: 'doc_edit', createdAt: OLD })];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes[0].driftFlag).toBe(true);
  });

  it('sets driftFlag=false when downstream code_commit exists', async () => {
    const events = [
      makeEvent({ id: 'a', eventType: 'doc_edit', parentEventId: null, createdAt: OLD }),
      makeEvent({ id: 'b', eventType: 'code_commit', parentEventId: 'a', createdAt: OLD }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes[0].driftFlag).toBe(false);
    // code_commit nodes are never flagged
    expect(result.nodes[1].driftFlag).toBe(false);
  });

  it('infers intent from event metadata', async () => {
    const events = [
      makeEvent({ id: 'a', eventType: 'doc_edit', metadata: { fields: ['title', 'content'] }, createdAt: BASE }),
      makeEvent({ id: 'b', eventType: 'ticket_created', metadata: { title: 'Fix auth bug' }, createdAt: BASE }),
      makeEvent({ id: 'c', eventType: 'code_commit', commitSha: 'abc1234def', metadata: { message: 'fix: auth' }, createdAt: BASE }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes[0].intent).toBe('Edited fields: title, content');
    expect(result.nodes[1].intent).toBe('Created ticket: Fix auth bug');
    expect(result.nodes[2].intent).toBe('fix: auth');
  });

  it('returns nodes sorted by createdAt (chronological order from DB)', async () => {
    const events = [
      makeEvent({ id: 'a', eventType: 'doc_edit', createdAt: '2025-01-01T00:00:00Z' }),
      makeEvent({ id: 'b', eventType: 'ticket_created', createdAt: '2025-01-02T00:00:00Z' }),
      makeEvent({ id: 'c', eventType: 'code_commit', createdAt: '2025-01-03T00:00:00Z' }),
    ];
    mockSelect.mockReturnValue(chainable(events));

    const { impactGraphService } = await import('../impact-graph.service.js');
    const result = await impactGraphService.buildImpactGraph('doc-1');

    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
});
