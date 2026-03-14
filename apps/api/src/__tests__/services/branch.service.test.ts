import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVersionService } = vi.hoisted(() => ({
  mockVersionService: {
    getById: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../services/version.service.js', () => ({
  versionService: mockVersionService,
}));

import { mockDb } from '../helpers/setup.js';
import { makeVersion, makeDocument } from '../helpers/factories.js';
import { branchService } from '../../services/branch.service.js';

describe('Branch Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('gets base version and inserts branch', async () => {
      const baseVersion = makeVersion({ content: 'base content' });
      mockVersionService.getById.mockResolvedValue(baseVersion);

      const branch = {
        id: 'branch-1',
        documentId: 'doc-1',
        name: 'feature-branch',
        baseVersionId: baseVersion.id,
        content: baseVersion.content,
        createdById: 'user-1',
        status: 'draft',
      };

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.create({
        documentId: 'doc-1',
        name: 'feature-branch',
        baseVersionId: baseVersion.id,
        createdById: 'user-1',
      });

      expect(result).toEqual(branch);
      expect(mockVersionService.getById).toHaveBeenCalledWith(baseVersion.id);
    });

    it('throws when base version not found', async () => {
      mockVersionService.getById.mockResolvedValue(null);

      await expect(
        branchService.create({
          documentId: 'doc-1',
          name: 'feature-branch',
          baseVersionId: 'nonexistent',
          createdById: 'user-1',
        }),
      ).rejects.toThrow('Base version not found');
    });
  });

  describe('listByDocument', () => {
    it('selects branches for a document', async () => {
      const branch = { id: 'branch-1', documentId: 'doc-1', name: 'main-branch' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.listByDocument('doc-1');
      expect(result).toEqual([branch]);
    });
  });

  describe('getById', () => {
    it('returns branch when found', async () => {
      const branch = { id: 'branch-1', documentId: 'doc-1', name: 'main-branch' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      const result = await branchService.getById('branch-1');
      expect(result).toEqual(branch);
    });

    it('returns null when not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await branchService.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateContent', () => {
    it('updates branch content and returns updated branch', async () => {
      const updated = { id: 'branch-1', content: 'new content' };

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const result = await branchService.updateContent('branch-1', 'new content');
      expect(result).toEqual(updated);
    });
  });

  describe('approve', () => {
    it('updates status to approved with reviewer', async () => {
      const branch = { id: 'branch-1', status: 'draft', mergedAt: null };
      const approved = { ...branch, status: 'approved', reviewedById: 'reviewer-1' };

      // getById
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      // update
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([approved]),
          }),
        }),
      } as any);

      const result = await branchService.approve('branch-1', 'reviewer-1');
      expect(result.status).toBe('approved');
    });

    it('throws when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(branchService.approve('nonexistent', 'reviewer-1')).rejects.toThrow(
        'Branch not found',
      );
    });

    it('throws when branch already merged', async () => {
      const branch = { id: 'branch-1', status: 'approved', mergedAt: new Date() };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      await expect(branchService.approve('branch-1', 'reviewer-1')).rejects.toThrow(
        'Branch already merged',
      );
    });
  });

  describe('merge', () => {
    it('updates document, creates version, and marks branch merged', async () => {
      const branch = {
        id: 'branch-1',
        documentId: 'doc-1',
        name: 'feature',
        content: 'merged content',
        status: 'approved',
        mergedAt: null,
        baseVersionId: 'v-1',
      };
      const mergedBranch = { ...branch, mergedAt: new Date() };

      // getById
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      // update document
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      // versionService.create
      mockVersionService.create.mockResolvedValue(makeVersion({ version: 2 }));

      // update branch (mark merged)
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mergedBranch]),
          }),
        }),
      } as any);

      const result = await branchService.merge('branch-1', 'user-1');
      expect(result.mergedAt).toBeTruthy();
      expect(mockVersionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          content: 'merged content',
          message: 'Merged branch "feature"',
          createdById: 'user-1',
        }),
      );
    });

    it('throws when branch not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(branchService.merge('nonexistent', 'user-1')).rejects.toThrow(
        'Branch not found',
      );
    });

    it('throws when branch not approved', async () => {
      const branch = { id: 'branch-1', status: 'draft', mergedAt: null };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([branch]),
        }),
      } as any);

      await expect(branchService.merge('branch-1', 'user-1')).rejects.toThrow(
        'Branch must be approved before merging',
      );
    });
  });
});
