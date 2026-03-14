import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';

vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema.js', () => ({
  auditTrail: {
    id: 'auditTrail.id',
    eventType: 'auditTrail.eventType',
    actorId: 'auditTrail.actorId',
    parentEventId: 'auditTrail.parentEventId',
    metadata: 'auditTrail.metadata',
    createdAt: 'auditTrail.createdAt',
    documentId: 'auditTrail.documentId',
  },
  users: {
    id: 'users.id',
    name: 'users.name',
  },
}));

import { db } from '../../db/index.js';
import { impactGraphService } from '../../services/impact-graph.service.js';

function mockQueryChain(results: unknown[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(results),
  };
  vi.mocked(db.select).mockReturnValue(chain as any);
  return chain;
}

describe('impactGraphService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildImpactGraph', () => {
    it('returns empty nodes and edges for a document with no events', async () => {
      mockQueryChain([]);

      const result = await impactGraphService.buildImpactGraph('doc-empty');

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('builds nodes with intent inferred from metadata title', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'ticket_created',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: { title: 'Implement auth endpoints', provider: 'github' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].intent).toBe('Implement auth endpoints');
    });

    it('builds nodes with intent inferred from commit message', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'code_commit',
          actorId: 'u1',
          actorName: 'Bob',
          parentEventId: null,
          metadata: { commitMessage: 'feat: add JWT auth', sha: 'abc123' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].intent).toBe('feat: add JWT auth');
    });

    it('builds nodes with default intent when metadata has no identifiable field', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].intent).toBe('Document content updated');
    });

    it('builds edges from parentEventId links', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'evt-2',
          eventType: 'ticket_created',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: 'evt-1',
          metadata: { title: 'Fix login' },
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]).toEqual({ from: 'evt-1', to: 'evt-2' });
    });

    it('sets driftFlag=false for code_commit nodes', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'code_commit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: { commitMessage: 'feat: initial commit' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].driftFlag).toBe(false);
    });

    it('sets driftFlag=true when no downstream code_commit within 14 days', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].driftFlag).toBe(true);
    });

    it('sets driftFlag=false when downstream code_commit exists within 14 days', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'ticket_created',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: { title: 'Add feature' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'evt-2',
          eventType: 'code_commit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: 'evt-1',
          metadata: { commitMessage: 'feat: add feature' },
          createdAt: new Date('2026-01-05T00:00:00Z'), // 4 days later — within 14 days
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      const ticketNode = result.nodes.find((n) => n.id === 'evt-1');
      expect(ticketNode?.driftFlag).toBe(false);
    });

    it('returns nodes sorted chronologically', async () => {
      mockQueryChain([
        {
          id: 'evt-2',
          eventType: 'ticket_created',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: 'evt-1',
          metadata: { title: 'Fix bug' },
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].id).toBe('evt-1');
      expect(result.nodes[1].id).toBe('evt-2');
    });

    it('uses "System" as actorName when no user is joined', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'agent_workflow',
          actorId: null,
          actorName: null,
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await impactGraphService.buildImpactGraph('doc-1');

      expect(result.nodes[0].actorName).toBe('System');
    });
  });
});
