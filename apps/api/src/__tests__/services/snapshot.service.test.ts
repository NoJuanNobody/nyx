import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument } from '../helpers/factories.js';
import { snapshotService } from '../../services/snapshot.service.js';

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    recordEvent: vi.fn().mockResolvedValue({}),
  },
}));

function makeSnapshot(overrides?: Record<string, unknown>) {
  return {
    id: 'snap-1',
    documentId: 'doc-1',
    integrationId: null,
    externalRef: 'v1.0',
    content: '# Snapshot content',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('Snapshot Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('returns all snapshots when no teamId provided', async () => {
      const snapshots = [makeSnapshot(), makeSnapshot({ id: 'snap-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockResolvedValue(snapshots),
      } as any);

      const result = await snapshotService.list();

      expect(result).toHaveLength(2);
    });

    it('returns snapshots filtered by teamId', async () => {
      const doc = makeDocument({ teamId: 'team-1' });
      const snapshots = [makeSnapshot()];

      // First select: get doc IDs by teamId
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: doc.id }]),
          }),
        } as any)
        // Second select: get snapshots by docIds
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(snapshots),
          }),
        } as any);

      const result = await snapshotService.list('team-1');

      expect(result).toHaveLength(1);
    });

    it('returns empty array when team has no documents', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await snapshotService.list('empty-team');

      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('creates snapshots for provided document IDs', async () => {
      const docs = [
        makeDocument({ id: 'doc-1', content: '# Doc 1' }),
        makeDocument({ id: 'doc-2', content: '# Doc 2' }),
      ];
      const snapshots = [makeSnapshot(), makeSnapshot({ id: 'snap-2', documentId: 'doc-2' })];

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(docs),
        }),
      } as any);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(snapshots),
        }),
      } as any);

      const result = await snapshotService.create({
        name: 'v1.0',
        documentIds: ['doc-1', 'doc-2'],
      });

      expect(result).toHaveLength(2);
    });

    it('returns empty array when no documents found', async () => {
      mockDb.select.mockReturnValue({
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
    it('returns snapshot by id', async () => {
      const snapshot = makeSnapshot();

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
    it('restores document content from snapshot', async () => {
      const snapshot = makeSnapshot({ content: '# Restored content', documentId: 'doc-1' });

      // getById
      mockDb.select.mockReturnValue({
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

      expect(result).toEqual({ documentId: 'doc-1', restoredFrom: 'snap-1' });
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
