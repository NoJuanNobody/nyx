import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { timelineService } from '../../services/timeline.service.js';

describe('Timeline Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getByDocument', () => {
    it('returns timeline events for a document', async () => {
      const event = {
        id: 'tl-1',
        documentId: 'doc-1',
        type: 'version_created',
        payload: { version: 1 },
        actorId: 'user-1',
        createdAt: new Date(),
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([event]),
          }),
        }),
      } as any);

      const result = await timelineService.getByDocument('doc-1');
      expect(result).toEqual([event]);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('returns empty array when no events exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const result = await timelineService.getByDocument('doc-no-events');
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('inserts a timeline event and returns it', async () => {
      const created = {
        id: 'tl-1',
        documentId: 'doc-1',
        type: 'version_created',
        payload: { version: 1 },
        actorId: 'user-1',
        createdAt: new Date(),
      };

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      } as any);

      const result = await timelineService.create({
        documentId: 'doc-1',
        type: 'version_created',
        payload: { version: 1 },
        actorId: 'user-1',
      });

      expect(result).toEqual(created);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('defaults payload to {} and actorId to null', async () => {
      const created = {
        id: 'tl-2',
        documentId: 'doc-1',
        type: 'snapshot_restored',
        payload: {},
        actorId: null,
        createdAt: new Date(),
      };

      const valuesFn = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      });

      mockDb.insert.mockReturnValue({
        values: valuesFn,
      } as any);

      await timelineService.create({
        documentId: 'doc-1',
        type: 'snapshot_restored',
      });

      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {},
          actorId: null,
        }),
      );
    });
  });
});
