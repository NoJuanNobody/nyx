import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    recordEvent: vi.fn().mockResolvedValue({}),
  },
}));

import { mockDb } from '../helpers/setup.js';
import { makeDocument } from '../helpers/factories.js';
import { snapshotService } from '../../services/snapshot.service.js';

describe('Snapshot Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('returns all snapshots when no teamId provided', async () => {
      const snapshot = { id: 'snap-1', documentId: 'doc-1', content: 'content' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockResolvedValue([snapshot]),
      } as any);

      const result = await snapshotService.list();
      expect(result).toEqual([snapshot]);
    });

    it('filters by teamId when provided', async () => {
      const doc = makeDocument({ teamId: 'team-1' });
      const snapshot = { id: 'snap-1', documentId: doc.id, content: 'content' };

      // First select: get team docs
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: doc.id }]),
        }),
      } as any);

      // Second select: get snapshots by doc IDs
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([snapshot]),
        }),
      } as any);

      const result = await snapshotService.list('team-1');
      expect(result).toEqual([snapshot]);
    });

    it('returns empty array when team has no documents', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await snapshotService.list('team-no-docs');
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('fetches docs, inserts snapshots, and returns them', async () => {
      const doc = makeDocument({ id: 'doc-1', content: 'doc content' });
      const snapshot = {
        id: 'snap-1',
        documentId: 'doc-1',
        content: 'doc content',
        externalRef: 'v1.0',
        integrationId: null,
      };

      // Select documents
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      // Insert snapshots
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([snapshot]),
        }),
      } as any);

      const result = await snapshotService.create({
        name: 'v1.0',
        documentIds: ['doc-1'],
      });

      expect(result).toEqual([snapshot]);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('returns empty array when no documents found', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await snapshotService.create({
        name: 'v1.0',
        documentIds: ['nonexistent'],
      });

      expect(result).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns snapshot when found', async () => {
      const snapshot = { id: 'snap-1', documentId: 'doc-1', content: 'content' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([snapshot]),
          }),
        }),
      } as any);

      const result = await snapshotService.getById('snap-1');
      expect(result).toEqual(snapshot);
    });

    it('returns null when not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const result = await snapshotService.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('restore', () => {
    it('updates document content from snapshot', async () => {
      const snapshot = {
        id: 'snap-1',
        documentId: 'doc-1',
        content: 'restored content',
      };

      // getById
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([snapshot]),
          }),
        }),
      } as any);

      // update document
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const result = await snapshotService.restore('snap-1', 'user-1');
      expect(result).toEqual({
        documentId: 'doc-1',
        restoredFrom: 'snap-1',
      });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('throws when snapshot not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      await expect(snapshotService.restore('nonexistent', 'user-1')).rejects.toThrow(
        'Snapshot not found',
      );
    });
  });
});
