import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { auditService } from '../../services/audit.service.js';

describe('Audit Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordEvent', () => {
    it('inserts into auditTrail and returns the event', async () => {
      const event = {
        id: 'event-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: 'user-1',
        documentId: 'doc-1',
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: null,
        metadata: {},
        createdAt: new Date(),
      };

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([event]),
        }),
      } as any);

      const result = await auditService.recordEvent({
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: 'user-1',
        documentId: 'doc-1',
      });

      expect(result).toEqual(event);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('defaults optional fields to null', async () => {
      const event = {
        id: 'event-2',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: null,
        documentId: null,
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: null,
        metadata: {},
        createdAt: new Date(),
      };

      const valuesFn = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([event]),
      });

      mockDb.insert.mockReturnValue({
        values: valuesFn,
      } as any);

      await auditService.recordEvent({
        teamId: 'team-1',
        eventType: 'doc_edit',
      });

      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: null,
          documentId: null,
          snapshotId: null,
          ticketId: null,
          commitSha: null,
          parentEventId: null,
          metadata: {},
        }),
      );
    });
  });

  describe('getTrailForDocument', () => {
    it('selects with leftJoin and returns events', async () => {
      const event = {
        id: 'event-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: 'user-1',
        actorName: 'Test User',
        documentId: 'doc-1',
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: null,
        metadata: {},
        createdAt: new Date(),
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([event]),
            }),
          }),
        }),
      } as any);

      const result = await auditService.getTrailForDocument('doc-1');
      expect(result).toEqual([event]);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('getTraceChain', () => {
    it('walks up parentEventId chain until null', async () => {
      const event2 = {
        id: 'event-2',
        teamId: 'team-1',
        eventType: 'ticket_created',
        actorId: 'user-1',
        actorName: 'Test User',
        documentId: 'doc-1',
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: 'event-1',
        metadata: {},
        createdAt: new Date(),
      };

      const event1 = {
        id: 'event-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: 'user-1',
        actorName: 'Test User',
        documentId: 'doc-1',
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: null,
        metadata: {},
        createdAt: new Date(),
      };

      // First call returns event2 (has parent)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([event2]),
          }),
        }),
      } as any);

      // Second call returns event1 (no parent)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([event1]),
          }),
        }),
      } as any);

      const result = await auditService.getTraceChain('event-2');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('event-2');
      expect(result[1].id).toBe('event-1');
    });

    it('stops when event not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const result = await auditService.getTraceChain('nonexistent');
      expect(result).toHaveLength(0);
    });

    it('stops at 50 events to prevent infinite loops', async () => {
      // Create a chain that would loop forever
      const loopEvent = {
        id: 'event-loop',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: null,
        actorName: null,
        documentId: null,
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: 'event-loop', // points to itself
        metadata: {},
        createdAt: new Date(),
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([loopEvent]),
          }),
        }),
      } as any);

      const result = await auditService.getTraceChain('event-loop');
      // Should stop at 51 (first event + 50 more hits the > 50 guard)
      expect(result.length).toBeLessThanOrEqual(51);
    });
  });

  describe('getTeamActivity', () => {
    it('selects events with leftJoin, where, orderBy, and limit', async () => {
      const event = {
        id: 'event-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        actorId: 'user-1',
        actorName: 'Test User',
        documentId: 'doc-1',
        snapshotId: null,
        ticketId: null,
        commitSha: null,
        parentEventId: null,
        metadata: {},
        createdAt: new Date(),
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([event]),
              }),
            }),
          }),
        }),
      } as any);

      const result = await auditService.getTeamActivity('team-1', 10);
      expect(result).toEqual([event]);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });
});
