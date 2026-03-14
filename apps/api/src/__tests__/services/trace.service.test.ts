import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';

// Mock the db module
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
import { traceService } from '../../services/trace.service.js';

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

describe('traceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildTrace', () => {
    it('returns empty nodes and edges for a document with no events', async () => {
      mockQueryChain([]);

      const result = await traceService.buildTrace('doc-empty');

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('builds nodes from audit events', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: { message: 'Updated intro' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const result = await traceService.buildTrace('doc-1');

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].id).toBe('evt-1');
      expect(result.nodes[0].type).toBe('doc_edit');
      expect(result.nodes[0].label).toBe('Document edited: Updated intro');
      expect(result.nodes[0].actorName).toBe('Alice');
    });

    it('builds edges from parentEventId chains', async () => {
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
          metadata: {},
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]);

      const result = await traceService.buildTrace('doc-1');

      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]).toEqual({ from: 'evt-1', to: 'evt-2' });
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

      const result = await traceService.buildTrace('doc-1');

      expect(result.nodes[0].actorName).toBe('System');
    });
  });

  describe('getTraceSummary', () => {
    it('returns empty message for no events', async () => {
      mockQueryChain([]);

      const summary = await traceService.getTraceSummary('doc-empty');

      expect(summary).toBe('No trace events yet for this document.');
    });

    it('returns numbered summary for events', async () => {
      mockQueryChain([
        {
          id: 'evt-1',
          eventType: 'doc_edit',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: null,
          metadata: {},
          createdAt: new Date('2026-01-15T00:00:00Z'),
        },
        {
          id: 'evt-2',
          eventType: 'ticket_created',
          actorId: 'u1',
          actorName: 'Alice',
          parentEventId: 'evt-1',
          metadata: {},
          createdAt: new Date('2026-01-16T00:00:00Z'),
        },
      ]);

      const summary = await traceService.getTraceSummary('doc-1');

      expect(summary).toContain('2 trace events');
      expect(summary).toContain('Alice');
      expect(summary).toContain('document edited');
      expect(summary).toContain('ticket created');
    });
  });
});
