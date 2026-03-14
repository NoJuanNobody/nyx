import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { auditService } from '../../services/audit.service.js';

function makeAuditEvent(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  };
}

describe('Audit Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordEvent', () => {
    it('inserts audit event and returns it', async () => {
      const event = makeAuditEvent();

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

    it('handles optional fields as null', async () => {
      const event = makeAuditEvent({ actorId: null, documentId: null });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([event]),
        }),
      } as any);

      const result = await auditService.recordEvent({
        teamId: 'team-1',
        eventType: 'snapshot_created',
      });

      expect(result.actorId).toBeNull();
      expect(result.documentId).toBeNull();
    });

    it('supports all audit event types', async () => {
      const eventTypes = [
        'doc_edit', 'snapshot_created', 'ticket_created', 'ticket_updated',
        'code_commit', 'proposal_created', 'proposal_approved', 'proposal_pushed',
        'agent_workflow',
      ] as const;

      for (const eventType of eventTypes) {
        const event = makeAuditEvent({ eventType });

        mockDb.insert.mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([event]),
          }),
        } as any);

        const result = await auditService.recordEvent({ teamId: 'team-1', eventType });
        expect(result.eventType).toBe(eventType);
      }
    });
  });

  describe('getTrailForDocument', () => {
    it('returns events for document', async () => {
      const events = [makeAuditEvent(), makeAuditEvent({ id: 'event-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(events),
            }),
          }),
        }),
      } as any);

      const result = await auditService.getTrailForDocument('doc-1');

      expect(result).toHaveLength(2);
    });

    it('returns empty array when no events found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const result = await auditService.getTrailForDocument('doc-no-events');

      expect(result).toEqual([]);
    });
  });

  describe('getTraceChain', () => {
    it('returns chain of events linked by parentEventId', async () => {
      const event1 = makeAuditEvent({ id: 'event-1', parentEventId: null });
      const event2 = makeAuditEvent({ id: 'event-2', parentEventId: 'event-1' });

      // First call returns event2, second call returns event1
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([event2]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
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

    it('stops walking chain when event not found', async () => {
      const event = makeAuditEvent({ id: 'event-1', parentEventId: 'missing-parent' });

      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([event]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const result = await auditService.getTraceChain('event-1');

      // Should stop at the missing parent
      expect(result).toHaveLength(1);
    });
  });

  describe('getTeamActivity', () => {
    it('returns team events', async () => {
      const events = [makeAuditEvent(), makeAuditEvent({ id: 'event-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(events),
              }),
            }),
          }),
        }),
      } as any);

      const result = await auditService.getTeamActivity('team-1');

      expect(result).toHaveLength(2);
    });

    it('uses default limit of 50 when not specified', async () => {
      const limitMock = vi.fn().mockResolvedValue([]);

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: limitMock,
              }),
            }),
          }),
        }),
      } as any);

      await auditService.getTeamActivity('team-1');

      expect(limitMock).toHaveBeenCalledWith(50);
    });

    it('respects custom limit', async () => {
      const limitMock = vi.fn().mockResolvedValue([]);

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: limitMock,
              }),
            }),
          }),
        }),
      } as any);

      await auditService.getTeamActivity('team-1', 10);

      expect(limitMock).toHaveBeenCalledWith(10);
    });
  });
});
